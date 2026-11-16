// End to end: the real launcher and daemon run as child processes, with a
// stand-in dev server and a stand-in for opening the browser.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { probeDevServer } from "./devServer.ts";
import { getIfServing } from "./httpProbe.ts";
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
  const response = await getIfServing(`http://127.0.0.1:${port}/health`);
  return response ? (JSON.parse(response.body) as BridgeHealth) : null;
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

  /** Plays the browser: connects a fake canvas once the app is "opened". */
  const connectCanvasWhenOpened = async () => {
    await waitFor(() => existsSync(openedFile), 10_000, "app opened");
    const canvas = await connectFakeCanvas(
      `ws://127.0.0.1:${bridgePort}/canvas`,
      `http://localhost:${devPort}`,
      okReply({ elements: [] }),
    );
    cleanups.push(() => canvas.socket.close());
  };

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

    // first agent: starts the daemon, but not the dev server yet
    const first = await connectAgent();
    const health = await fetchHealth(bridgePort);
    expect(health).toMatchObject({ ok: true, leases: 1 });
    expect(await probeDevServer(`http://localhost:${devPort}/`)).toBe("down");

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
    // the tool call started the dev server
    expect(await probeDevServer(`http://localhost:${devPort}/`)).toBe("ours");

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

    const agent = await connectAgent();
    const pending = agent.callTool({ name: "get_scene", arguments: {} });
    await connectCanvasWhenOpened();

    expect(((await pending) as CallToolResult).isError).toBeFalsy();
    expect(daemonLog()).toMatch(/reusing the dev server/);
    expect(daemonLog()).not.toMatch(/started dev server/);
  }, 20_000);

  it("reports a taken dev port as a tool error and keeps the daemon up", async () => {
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

    const agent = await connectAgent();

    const result = (await agent.callTool({
      name: "get_scene",
      arguments: {},
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(
      /isn't the Excalidraw dev server/,
    );
    // the daemon stays up for other tools and retries on the next call
    expect(await fetchHealth(bridgePort)).toMatchObject({ leases: 1 });
  }, 20_000);
});
