// Background process started on demand by launcher.ts: runs the bridge and
// the Excalidraw dev server, opens the app when an agent needs a canvas, and
// exits once no launcher has held a lease for MCP_BRIDGE_IDLE_MINUTES.
//
// Port 3050 doubles as the lock: if another daemon already holds it, this one
// exits straight away, so concurrent launchers can't start two.

import { resolve } from "node:path";

import { installEgressBlock } from "./blockEgress.ts";
import {
  REPO_ROOT,
  bridgePort,
  canvasOriginsFor,
  devServerPort,
  ensureRunDir,
  parseBooleanEnv,
  parseCommandEnv,
  parseIntegerEnv,
} from "./config.ts";
import { openInBrowser, startDevServer } from "./devServer.ts";
import { createLogger, parseLogLevel } from "./logger.ts";
import { DEFAULT_BRIDGE_HOST } from "./protocol.ts";
import { startBridgeServer } from "./server.ts";

import type { DevServer } from "./devServer.ts";
import type { BridgeServer } from "./server.ts";

const logger = createLogger(parseLogLevel(process.env.LOG_LEVEL));

if (parseBooleanEnv("MCP_BRIDGE_BLOCK_EGRESS")) {
  installEgressBlock(logger);
}

const runDir = ensureRunDir();
const devPort = devServerPort();
// MCP_BRIDGE_IDLE_MS takes precedence (tests); minutes is the documented knob
const idleMs = parseIntegerEnv(
  "MCP_BRIDGE_IDLE_MS",
  parseIntegerEnv("MCP_BRIDGE_IDLE_MINUTES", 30) * 60_000,
);
const openCommand = parseCommandEnv("MCP_BRIDGE_OPEN_COMMAND");

let bridge: BridgeServer | null = null;
let devServer: DevServer | null = null;
let shuttingDown = false;

const shutdown = async (reason: string, exitCode: number) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info("daemon shutting down", { reason });
  await bridge?.close();
  await devServer?.stop();
  process.exit(exitCode);
};

// resolved once the dev server has been started or found, so a request that
// arrives first still waits for it before opening the app
let resolveDevServer: (server: DevServer) => void;
const devServerStarted = new Promise<DevServer>((resolveStarted) => {
  resolveDevServer = resolveStarted;
});

try {
  bridge = await startBridgeServer({
    host: DEFAULT_BRIDGE_HOST,
    port: bridgePort(),
    allowedCanvasOrigins: canvasOriginsFor(devPort),
    requestTimeoutMs: parseIntegerEnv("MCP_BRIDGE_REQUEST_TIMEOUT_MS", 30_000),
    logger,
    opener: {
      openCanvas: async () => {
        const server = await devServerStarted;
        await server.ready;
        await openInBrowser(server.url, openCommand);
      },
      reconnectGraceMs: parseIntegerEnv("MCP_BRIDGE_RECONNECT_GRACE_MS", 4_000),
      waitMs: parseIntegerEnv("MCP_BRIDGE_CANVAS_WAIT_MS", 90_000),
      minReopenIntervalMs: 20_000,
    },
    idle: { idleMs, onIdle: () => void shutdown("idle", 0) },
  });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
    logger.info("another bridge already holds the port; exiting", {
      port: bridgePort(),
    });
    process.exit(0);
  }
  throw error;
}

logger.info("daemon started", {
  pid: process.pid,
  mcpUrl: bridge.mcpUrl,
  idleMinutes: idleMs / 60_000,
});

process.on("SIGINT", () => void shutdown("SIGINT", 0));
process.on("SIGTERM", () => void shutdown("SIGTERM", 0));

try {
  devServer = await startDevServer({
    port: devPort,
    repoRoot: REPO_ROOT,
    logFile: resolve(runDir, "dev-server.log"),
    logger,
    command: parseCommandEnv("MCP_BRIDGE_DEV_COMMAND") ?? undefined,
    startupTimeoutMs: parseIntegerEnv(
      "MCP_BRIDGE_DEV_STARTUP_TIMEOUT_MS",
      180_000,
    ),
  });
  resolveDevServer!(devServer);
  void devServer.exited.then(() => shutdown("dev server exited", 1));
  await devServer.ready;
  logger.info("dev server ready", { url: devServer.url });
} catch (error) {
  // without the app there is nothing for agents to edit: fail loudly, which
  // also drops every launcher's lease so their sessions report the failure
  logger.error("dev server failed", { error });
  await shutdown("dev server failed", 1);
}
