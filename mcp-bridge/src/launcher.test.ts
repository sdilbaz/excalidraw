// End to end: the real launcher and daemon run as child processes, with a
// stand-in dev server and a stand-in for opening the browser.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { probeDevServer } from "./devServer.ts";
import {
  connectFakeCanvas,
  getFreePort,
  okReply,
  waitFor,
} from "./testHelpers.ts";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { BridgeHealth } from "./protocol.ts";

const SRC = import.meta.dirname;
const FIXTURES = join(SRC, "testFixtures");
const IDLE_MS = 1500;

const fetchHealth = async (port: number): Promise<BridgeHealth | null> => {
  try {
    return (await (
      await fetch(`http://127.0.0.1:${port}/health`)
    ).json()) as BridgeHealth;
  } catch (error) {
    // refused: nothing listening; reset: the daemon closed mid-request
    const code = (error as { cause?: { code?: string } }).cause?.code;
    if (code === "ECONNREFUSED" || code === "ECONNRESET") {
      return null;
    }
    throw error;
  }
};

describe("launcher + daemon", () => {
  let runDir: string;
  let bridgePort: number;
  let devPort: number;
  let openedFile: string;
  const clients: Client[] = [];
  const cleanups: (() => void)[] = [];

  const env = () => ({
    ...(process.env as Record<string, string>),
    MCP_BRIDGE_PORT: String(bridgePort),
    MCP_BRIDGE_DEV_PORT: String(devPort),
    MCP_BRIDGE_RUN_DIR: runDir,
    MCP_BRIDGE_IDLE_MS: String(IDLE_MS),
    MCP_BRIDGE_RECONNECT_GRACE_MS: "100",
    MCP_BRIDGE_CANVAS_WAIT_MS: "10000",
    MCP_BRIDGE_DEV_COMMAND: JSON.stringify([
      process.execPath,
      join(FIXTURES, "fakeDevServer.mjs"),
      String(devPort),
    ]),
    MCP_BRIDGE_OPEN_COMMAND: JSON.stringify([
      process.execPath,
      join(FIXTURES, "recordOpen.mjs"),
      openedFile,
    ]),
    LOG_LEVEL: "debug",
  });

  const connectAgent = async () => {
    const client = new Client({ name: "agent", version: "0" });
    clients.push(client);
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [resolve(SRC, "launcher.ts")],
        env: env(),
        stderr: "ignore",
      }),
    );
    return client;
  };

  const daemonLog = () => readFileSync(join(runDir, "daemon.log"), "utf8");

  beforeEach(async () => {
    runDir = mkdtempSync(join(tmpdir(), "mcp-bridge-launcher-"));
    openedFile = join(runDir, "opened.txt");
    bridgePort = await getFreePort();
    devPort = await getFreePort();
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      await client.close();
    }
    // never leave a daemon behind, even when a test fails
    const health = await fetchHealth(bridgePort);
    if (health) {
      process.kill(health.pid, "SIGTERM");
      await waitFor(
        async () => !(await fetchHealth(bridgePort)),
        5000,
        "daemon exit",
      );
    }
    cleanups.splice(0).forEach((cleanup) => cleanup());
    rmSync(runDir, { recursive: true, force: true });
  });

  it("starts the daemon on demand, shares it, opens the app, and stops when idle", async () => {
    expect(await fetchHealth(bridgePort)).toBeNull();

    // first agent: starts the daemon and the dev server
    const first = await connectAgent();
    const health = await fetchHealth(bridgePort);
    expect(health).toMatchObject({ ok: true, leases: 1 });
    await waitFor(
      async () =>
        (await probeDevServer(`http://localhost:${devPort}/`)) === "ours",
      10_000,
      "dev server",
    );

    // no tab yet: the first tool call opens the app and waits for it
    const pending = first.callTool({ name: "get_scene", arguments: {} });
    await waitFor(() => existsSync(openedFile), 10_000, "app opened");
    expect(readFileSync(openedFile, "utf8").trim()).toBe(
      `http://localhost:${devPort}/`,
    );
    const canvas = await connectFakeCanvas(
      `ws://127.0.0.1:${bridgePort}/canvas`,
      `http://localhost:${devPort}`,
      okReply({ elements: [], from: "fake canvas" }),
    );
    cleanups.push(() => canvas.socket.close());
    const result = (await pending) as CallToolResult;
    expect(result.isError).toBeFalsy();
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("fake canvas"),
    });

    // second agent: reuses the same daemon
    const second = await connectAgent();
    expect(await fetchHealth(bridgePort)).toMatchObject({
      pid: health!.pid,
      leases: 2,
    });
    expect(
      (
        (await second.callTool({
          name: "get_scene",
          arguments: {},
        })) as CallToolResult
      ).isError,
    ).toBeFalsy();
    expect(daemonLog().match(/"daemon started"/g)).toHaveLength(1);

    // both agents gone: the daemon and its dev server stop after the idle time
    await clients
      .splice(0)
      .reduce(
        (previous, client) => previous.then(() => client.close()),
        Promise.resolve(),
      );
    await waitFor(
      async () =>
        (await fetchHealth(bridgePort))?.leases === 0 ||
        !(await fetchHealth(bridgePort)),
      5000,
      "leases released",
    );
    await waitFor(
      async () => !(await fetchHealth(bridgePort)),
      IDLE_MS + 5000,
      "daemon idle shutdown",
    );
    await waitFor(
      async () =>
        (await probeDevServer(`http://localhost:${devPort}/`)) === "down",
      5000,
      "dev server stopped",
    );
    expect(daemonLog()).toMatch(/"reason":"idle"/);
  }, 40_000);

  it("reuses a dev server that is already running instead of starting one", async () => {
    const existing = spawn(process.execPath, [
      join(FIXTURES, "fakeDevServer.mjs"),
      String(devPort),
    ]);
    cleanups.push(() => existing.kill());
    await waitFor(
      async () =>
        (await probeDevServer(`http://localhost:${devPort}/`)) === "ours",
      5000,
      "existing dev server",
    );

    await connectAgent();

    await waitFor(
      () => /reusing the dev server/.test(daemonLog()),
      5000,
      "reuse log",
    );
    expect(daemonLog()).not.toMatch(/started dev server/);
  }, 20_000);

  it("fails loudly when the dev port is taken by something else", async () => {
    const other = spawn(process.execPath, [
      join(FIXTURES, "otherServer.mjs"),
      String(devPort),
    ]);
    cleanups.push(() => other.kill());
    await waitFor(
      async () =>
        (await probeDevServer(`http://localhost:${devPort}/`)) === "other",
      5000,
      "other server",
    );

    const client = new Client({ name: "agent", version: "0" });
    const closed = new Promise<void>((resolveClosed) => {
      client.onclose = () => resolveClosed();
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve(SRC, "launcher.ts")],
      env: env(),
      stderr: "ignore",
    });
    // the launcher may exit before or after the handshake completes
    const connected = client.connect(transport).then(
      () => "connected",
      () => "failed",
    );

    await Promise.race([
      closed,
      connected.then((state) => state === "failed" && undefined),
    ]);
    await waitFor(
      async () => !(await fetchHealth(bridgePort)),
      10_000,
      "daemon exit",
    );
    expect(daemonLog()).toMatch(/isn't the Excalidraw dev server/);
    await client.close();
  }, 20_000);
});
