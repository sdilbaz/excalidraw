import { request as httpRequest } from "node:http";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createLogger } from "./logger.ts";
import { startBridgeServer } from "./server.ts";
import { connectFakeCanvas, okReply, waitFor } from "./testHelpers.ts";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { CanvasOpener } from "./canvasHub.ts";
import type { BridgeServer } from "./server.ts";

const ORIGIN = "http://localhost:3001";
const logger = createLogger("error", () => undefined);

const textOf = (result: CallToolResult) =>
  result.content
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("");

describe("bridge lifecycle", () => {
  let bridge: BridgeServer;
  let client: Client | null;
  const sockets: { close: () => void }[] = [];
  const onIdle = vi.fn();

  const start = async (
    overrides: Partial<CanvasOpener> | null,
    idleMs = 60_000,
  ) => {
    bridge = await startBridgeServer({
      host: "127.0.0.1",
      port: 0,
      allowedCanvasOrigins: [ORIGIN],
      requestTimeoutMs: 1000,
      logger,
      opener: overrides
        ? {
            openCanvas: async () => undefined,
            reconnectGraceMs: 50,
            waitMs: 1000,
            minReopenIntervalMs: 0,
            ...overrides,
          }
        : undefined,
      idle: { idleMs, onIdle },
    });
    client = new Client({ name: "lifecycle-test", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(bridge.mcpUrl)),
    );
  };

  const canvas = async () => {
    const fake = await connectFakeCanvas(
      bridge.canvasUrl,
      ORIGIN,
      okReply({ elements: [] }),
    );
    sockets.push(fake.socket);
    return fake;
  };

  const getScene = async () =>
    (await client!.callTool({
      name: "get_scene",
      arguments: {},
    })) as CallToolResult;

  afterEach(async () => {
    sockets.splice(0).forEach((socket) => socket.close());
    await client?.close();
    client = null;
    await bridge.close();
    onIdle.mockReset();
  });

  describe("auto-opening the canvas", () => {
    it("opens the app when no tab is connected and runs the request once one connects", async () => {
      const openCanvas = vi.fn(async () => {
        await canvas();
      });
      await start({ openCanvas });

      const result = await getScene();

      expect(result.isError).toBeFalsy();
      expect(JSON.parse(textOf(result))).toEqual({ elements: [] });
      expect(openCanvas).toHaveBeenCalledTimes(1);
    });

    it("lets a tab that is already open reconnect instead of opening another", async () => {
      const openCanvas = vi.fn(async () => undefined);
      await start({ openCanvas, reconnectGraceMs: 2000 });

      const pending = getScene();
      setTimeout(() => void canvas(), 100);
      const result = await pending;

      expect(result.isError).toBeFalsy();
      expect(openCanvas).not.toHaveBeenCalled();
    });

    it("does not open anything while a tab is connected", async () => {
      const openCanvas = vi.fn(async () => undefined);
      await start({ openCanvas });
      await canvas();

      expect((await getScene()).isError).toBeFalsy();
      expect(openCanvas).not.toHaveBeenCalled();
    });

    it("fails with a clear error when no tab connects in time", async () => {
      await start({ openCanvas: async () => undefined, waitMs: 300 });

      const result = await getScene();

      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/No Excalidraw canvas connected within/);
    });

    it("reports a failure to open the app", async () => {
      await start({
        openCanvas: async () => {
          throw new Error("dev server exited (code 1)");
        },
      });

      const result = await getScene();

      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/dev server exited \(code 1\)/);
    });

    it("doesn't open another tab within the reopen interval", async () => {
      const openCanvas = vi.fn(async () => undefined);
      await start({ openCanvas, waitMs: 200, minReopenIntervalMs: 60_000 });

      await getScene();
      await getScene();

      expect(openCanvas).toHaveBeenCalledTimes(1);
    });

    it("fails straight away without an opener", async () => {
      await start(null);

      const result = await getScene();

      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/No Excalidraw canvas is connected/);
    });
  });

  describe("health and leases", () => {
    const get = (path: string, headers: Record<string, string> = {}) =>
      new Promise<{ status: number; body: string; close: () => void }>(
        (resolve, reject) => {
          const req = httpRequest(
            {
              host: "127.0.0.1",
              port: bridge.port,
              path,
              headers,
              agent: false,
            },
            (res) => {
              let body = "";
              res.on("data", (chunk) => {
                body += chunk;
                // a lease never ends; hand it back as soon as it's held
                resolve({
                  status: res.statusCode ?? 0,
                  body,
                  close: () => req.destroy(),
                });
              });
              res.on("end", () =>
                resolve({
                  status: res.statusCode ?? 0,
                  body,
                  close: () => undefined,
                }),
              );
            },
          );
          req.on("error", reject);
          req.end();
        },
      );

    const health = async () => JSON.parse((await get("/health")).body);

    it("reports pid, leases and canvas state", async () => {
      await start(null);
      await canvas();
      await waitFor(() => bridge.hub.status().pageUrl !== null);

      expect(await health()).toEqual({
        ok: true,
        pid: process.pid,
        leases: 0,
        canvas: { connected: true, pageUrl: `${ORIGIN}/` },
      });
    });

    it("counts leases while they're held", async () => {
      await start(null);

      const first = await get("/lease");
      const second = await get("/lease");
      expect(first.status).toBe(200);
      expect((await health()).leases).toBe(2);

      first.close();
      await waitFor(async () => (await health()).leases === 1);
      second.close();
      await waitFor(async () => (await health()).leases === 0);
    });

    it.each(["/health", "/lease"])(
      "refuses %s from a browser origin",
      async (path) => {
        await start(null);
        const response = await get(path, { origin: "https://evil.example" });
        expect(response.status).toBe(403);
      },
    );

    it("shuts down only after the last lease is released and the idle time passes", async () => {
      await start(null, 300);
      const lease = await get("/lease");

      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(onIdle).not.toHaveBeenCalled();

      lease.close();
      await waitFor(() => onIdle.mock.calls.length === 1, 2000, "onIdle");
    });

    it("keeps an unleased bridge up while it is being used", async () => {
      await start(null, 400);
      await canvas();

      for (let i = 0; i < 4; i++) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        await getScene();
      }
      expect(onIdle).not.toHaveBeenCalled();
    });
  });
});
