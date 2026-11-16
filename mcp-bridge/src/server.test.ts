import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebSocket } from "ws";

import { createLogger } from "./logger.ts";
import { startBridgeServer } from "./server.ts";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { BridgeServer } from "./server.ts";
import type { BridgeRequest, CanvasMessage, EgressEvent } from "./protocol.ts";

const CANVAS_ORIGIN = "http://localhost:3001";
const REQUEST_TIMEOUT_MS = 300;

// Bridge logs are captured instead of printed, and asserted on where useful.
const logLines: string[] = [];
const logger = createLogger("debug", (line) => logLines.push(line));

type CanvasHandler = (request: BridgeRequest) => CanvasMessage | null;

/** A stand-in for the app tab: answers bridge requests with `handler`. */
const connectFakeCanvas = async (
  bridge: BridgeServer,
  handler: CanvasHandler,
  origin = CANVAS_ORIGIN,
) => {
  const socket = new WebSocket(bridge.canvasUrl, { origin });
  const received: BridgeRequest[] = [];
  socket.on("message", (data) => {
    const request = JSON.parse(String(data)) as BridgeRequest;
    received.push(request);
    const reply = handler(request);
    if (reply) {
      socket.send(JSON.stringify(reply));
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify({ type: "hello", pageUrl: `${origin}/` } as CanvasMessage),
  );
  return { socket, received };
};

const okReply =
  (result: unknown): CanvasHandler =>
  (request) => ({ type: "response", id: request.id, ok: true, result });

const connectClient = async (bridge: BridgeServer) => {
  const client = new Client({ name: "bridge-test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(bridge.mcpUrl)),
  );
  return client;
};

const callTool = async (
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
) => (await client.callTool({ name, arguments: args })) as CallToolResult;

const textOf = (result: CallToolResult) =>
  result.content
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("\n");

const waitFor = async (predicate: () => boolean, timeoutMs = 2000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** Raw HTTP request so tests can forge Host/Origin headers. */
const rawRequest = (
  bridge: BridgeServer,
  headers: Record<string, string>,
  path = "/mcp",
) =>
  new Promise<number>((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: bridge.port,
        path,
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end("{}");
  });

/** Resolves with the HTTP status of a refused upgrade, or "open". */
const tryCanvasConnection = (url: string, origin?: string) =>
  new Promise<number | "open">((resolve, reject) => {
    const socket = new WebSocket(url, origin ? { origin } : {});
    socket.once("open", () => {
      socket.close();
      resolve("open");
    });
    socket.once("unexpected-response", (_req, res) =>
      resolve(res.statusCode ?? 0),
    );
    socket.once("error", (error) => {
      // ws emits "error" after "unexpected-response"; only fail on others
      if (!/Unexpected server response/.test(error.message)) {
        reject(error);
      }
    });
  });

describe("mcp-bridge server", () => {
  let bridge: BridgeServer;
  let client: Client;
  const openSockets: WebSocket[] = [];

  beforeEach(async () => {
    logLines.length = 0;
    bridge = await startBridgeServer({
      host: "127.0.0.1",
      port: 0,
      allowedCanvasOrigins: [CANVAS_ORIGIN],
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      logger,
    });
    client = await connectClient(bridge);
  });

  afterEach(async () => {
    openSockets.forEach((socket) => socket.close());
    openSockets.length = 0;
    await client.close();
    await bridge.close();
  });

  const fakeCanvas = async (handler: CanvasHandler, origin?: string) => {
    const canvas = await connectFakeCanvas(bridge, handler, origin);
    openSockets.push(canvas.socket);
    await waitFor(() => bridge.hub.status().pageUrl !== null);
    return canvas;
  };

  it("lists every canvas tool", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "add_elements",
      "bridge_status",
      "clear_scene",
      "delete_elements",
      "export_image",
      "get_scene",
      "update_elements",
      "zoom_to_fit",
    ]);
  });

  it("returns a tool error when no canvas is connected", async () => {
    const result = await callTool(client, "get_scene");
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/No Excalidraw canvas is connected/);
  });

  it.each([
    ["get_scene", { includeRaw: true }, "getScene", { includeRaw: true }],
    [
      "add_elements",
      { elements: [{ type: "rectangle", x: 1, y: 2, label: { text: "A" } }] },
      "addElements",
      { elements: [{ type: "rectangle", x: 1, y: 2, label: { text: "A" } }] },
    ],
    [
      "update_elements",
      { updates: [{ id: "a", x: 5, strokeColor: "#ff0000" }] },
      "updateElements",
      { updates: [{ id: "a", x: 5, strokeColor: "#ff0000" }] },
    ],
    [
      "delete_elements",
      { ids: ["a", "b"] },
      "deleteElements",
      { ids: ["a", "b"] },
    ],
    ["clear_scene", {}, "clearScene", {}],
    ["zoom_to_fit", {}, "zoomToFit", {}],
    ["zoom_to_fit", { ids: ["a"] }, "zoomToFit", { ids: ["a"] }],
  ])(
    "%s forwards %j to the canvas as %s",
    async (tool, args, expectedMethod, expectedParams) => {
      const canvas = await fakeCanvas(okReply({ echoed: true }));

      const result = await callTool(client, tool, args);

      expect(result.isError).toBeFalsy();
      expect(JSON.parse(textOf(result))).toEqual({ echoed: true });
      expect(canvas.received).toHaveLength(1);
      expect(canvas.received[0].method).toBe(expectedMethod);
      expect(canvas.received[0].params).toEqual(expectedParams);
    },
  );

  it.each([
    ["rectangle without coordinates", { elements: [{ type: "rectangle" }] }],
    ["text without text", { elements: [{ type: "text", x: 0, y: 0 }] }],
    ["frame without children", { elements: [{ type: "frame" }] }],
    ["unknown element type", { elements: [{ type: "blob", x: 0, y: 0 }] }],
    ["empty element list", { elements: [] }],
  ])(
    "rejects add_elements with %s before reaching the canvas",
    async (_, args) => {
      const canvas = await fakeCanvas(okReply({}));

      const result = await callTool(client, "add_elements", args);

      expect(result.isError).toBe(true);
      expect(canvas.received).toHaveLength(0);
    },
  );

  it("rejects update_elements with a property that can't be updated", async () => {
    const canvas = await fakeCanvas(okReply({}));

    const result = await callTool(client, "update_elements", {
      updates: [{ id: "a", isDeleted: true }],
    });

    expect(result.isError).toBe(true);
    expect(canvas.received).toHaveLength(0);
  });

  it("surfaces an error thrown in the app tab as a tool error", async () => {
    await fakeCanvas((request) => ({
      type: "response",
      id: request.id,
      ok: false,
      error: {
        message: "No element on the canvas with id: nope",
        stack: "at x",
      },
    }));

    const result = await callTool(client, "delete_elements", { ids: ["nope"] });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/No element on the canvas with id: nope/);
  });

  it("times out when the canvas never answers", async () => {
    await fakeCanvas(() => null);

    const result = await callTool(client, "get_scene");

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(
      /did not respond to "getScene" within 300ms/,
    );
  });

  it("returns a PNG export as image content", async () => {
    await fakeCanvas(
      okReply({ format: "png", mimeType: "image/png", base64: "iVBORw0KGgo=" }),
    );

    const result = await callTool(client, "export_image", { format: "png" });

    expect(result.content).toEqual([
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
    ]);
  });

  it("returns an SVG export as text", async () => {
    await fakeCanvas(
      okReply({ format: "svg", mimeType: "image/svg+xml", svg: "<svg></svg>" }),
    );

    const result = await callTool(client, "export_image", { format: "svg" });

    expect(textOf(result)).toBe("<svg></svg>");
  });

  it("writes an export to outputPath without forwarding the path to the canvas", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcp-bridge-test-"));
    try {
      const canvas = await fakeCanvas(
        okReply({ format: "png", mimeType: "image/png", base64: "AAEC" }),
      );
      const outputPath = join(directory, "out.png");

      const result = await callTool(client, "export_image", {
        format: "png",
        scale: 2,
        outputPath,
      });

      expect(JSON.parse(textOf(result))).toEqual({
        outputPath,
        format: "png",
        bytes: 3,
      });
      expect([...(await readFile(outputPath))]).toEqual([0, 1, 2]);
      expect(canvas.received[0].params).toEqual({ format: "png", scale: 2 });
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  it("rejects a relative outputPath", async () => {
    await fakeCanvas(okReply({}));

    const result = await callTool(client, "export_image", {
      format: "png",
      outputPath: "out.png",
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/absolute path/);
  });

  it("hands the canvas to the newest tab and fails requests pending on the old one", async () => {
    const first = await fakeCanvas(() => null);
    const pending = callTool(client, "get_scene");
    await waitFor(() => first.received.length === 1);

    const closeCode = new Promise<number>((resolve) =>
      first.socket.once("close", (code) => resolve(code)),
    );
    const second = await fakeCanvas(okReply({ from: "second" }), CANVAS_ORIGIN);

    const pendingResult = await pending;
    expect(pendingResult.isError).toBe(true);
    expect(textOf(pendingResult)).toMatch(/replaced by a newer tab/);
    expect(await closeCode).toBe(4000);

    const result = await callTool(client, "get_scene");
    expect(JSON.parse(textOf(result))).toEqual({ from: "second" });
    expect(second.received).toHaveLength(1);
  });

  it("reports egress events from the app tab in bridge_status", async () => {
    const canvas = await fakeCanvas(okReply({}));
    const event: EgressEvent = {
      source: "csp-violation",
      url: "https://json-dev.excalidraw.com/api/v2/post/",
      blocked: true,
      detail: "connect-src",
      timestamp: 1,
    };
    canvas.socket.send(JSON.stringify({ type: "egress", events: [event] }));
    await waitFor(() => bridge.hub.getEgressEvents().length === 1);

    const status = JSON.parse(textOf(await callTool(client, "bridge_status")));

    expect(status.canvas).toMatchObject({
      connected: true,
      pageUrl: `${CANVAS_ORIGIN}/`,
    });
    expect(status.egress.summary).toMatchObject({
      totalEvents: 1,
      blockedUrlCount: 1,
      possiblyUnblockedUrls: [],
    });
    expect(status.egress.recentEvents).toEqual([event]);
    expect(logLines.some((line) => line.includes("new non-local host"))).toBe(
      true,
    );
  });

  describe("connection guards", () => {
    it.each([
      ["a foreign origin", "https://evil.example", "/canvas"],
      ["no origin", undefined, "/canvas"],
      ["an unknown path", CANVAS_ORIGIN, "/other"],
    ])("refuses a canvas connection with %s", async (_, origin, path) => {
      const status = await tryCanvasConnection(
        `ws://127.0.0.1:${bridge.port}${path}`,
        origin,
      );
      expect(status).toBe(403);
      expect(bridge.hub.status().connected).toBe(false);
    });

    it("refuses a canvas connection with a forged Host header", async () => {
      const status = await new Promise<number | "open">((resolve) => {
        const socket = new WebSocket(bridge.canvasUrl, {
          origin: CANVAS_ORIGIN,
          headers: { host: "evil.example" },
        });
        socket.once("open", () => resolve("open"));
        socket.once("unexpected-response", (_req, res) =>
          resolve(res.statusCode ?? 0),
        );
        socket.once("error", () => undefined);
      });
      expect(status).toBe(403);
    });

    it("refuses MCP requests from a browser origin", async () => {
      expect(await rawRequest(bridge, { origin: "https://evil.example" })).toBe(
        403,
      );
    });

    it("refuses MCP requests with a forged Host header", async () => {
      expect(await rawRequest(bridge, { host: "evil.example" })).toBe(403);
    });

    it("returns 404 outside the MCP path", async () => {
      expect(await rawRequest(bridge, {}, "/elsewhere")).toBe(404);
    });
  });
});
