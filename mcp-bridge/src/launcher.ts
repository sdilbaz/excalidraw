// stdio MCP server that agents (Claude Code, Claude Desktop, ...) run as a
// command. It starts the bridge daemon (bridge + dev server) if none is
// running, holds a lease that keeps the daemon alive for as long as this
// process lives, and relays MCP messages between stdio and the daemon's HTTP
// endpoint. Logs go to stderr; stdout carries the MCP protocol.

import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { resolve } from "node:path";

import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { bridgePort, ensureRunDir, parseIntegerEnv } from "./config.ts";
import { createLogger, parseLogLevel } from "./logger.ts";
import {
  DEFAULT_BRIDGE_HOST,
  HEALTH_PATH,
  LEASE_PATH,
  MCP_HTTP_PATH,
} from "./protocol.ts";

import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import type { BridgeHealth } from "./protocol.ts";

const logger = createLogger(parseLogLevel(process.env.LOG_LEVEL));
const port = bridgePort();
const baseUrl = `http://${DEFAULT_BRIDGE_HOST}:${port}`;
const daemonStartTimeoutMs = parseIntegerEnv(
  "MCP_BRIDGE_DAEMON_START_TIMEOUT_MS",
  30_000,
);

// refused: nothing is listening; reset: the server closed while answering
// (e.g. it is shutting down). Either way it isn't serving.
const NOT_SERVING_CODES = new Set(["ECONNREFUSED", "ECONNRESET"]);
const isNotServing = (error: unknown) =>
  error instanceof TypeError &&
  NOT_SERVING_CODES.has(
    (error.cause as { code?: string } | undefined)?.code ?? "",
  );

const fetchHealth = async (): Promise<BridgeHealth | null> => {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${HEALTH_PATH}`);
  } catch (error) {
    if (isNotServing(error)) {
      return null;
    }
    throw error;
  }
  if (!response.ok) {
    throw new Error(
      `Port ${port} answered ${response.status} on ${HEALTH_PATH}; is something other than the bridge using it?`,
    );
  }
  return (await response.json()) as BridgeHealth;
};

const ensureDaemon = async (): Promise<void> => {
  const health = await fetchHealth();
  if (health) {
    logger.info("using running bridge daemon", { pid: health.pid });
    return;
  }

  const logFile = resolve(ensureRunDir(), "daemon.log");
  const output = openSync(logFile, "a");
  const daemon = spawn(
    process.execPath,
    [resolve(import.meta.dirname, "daemon.ts")],
    {
      detached: true,
      stdio: ["ignore", output, output],
      env: process.env,
    },
  );
  // the daemon outlives this launcher; other launchers share it
  daemon.unref();
  logger.info("started bridge daemon", { pid: daemon.pid, logFile });
  let daemonExit: string | null = null;
  daemon.once("exit", (code, signal) => {
    daemonExit = `code ${code}, signal ${signal}`;
  });

  const deadline = Date.now() + daemonStartTimeoutMs;
  while (Date.now() < deadline) {
    // healthy also covers a concurrent launcher's daemon having won the port
    if (await fetchHealth()) {
      return;
    }
    if (daemonExit) {
      throw new Error(
        `Bridge daemon exited (${daemonExit}) before it was ready; see ${logFile}`,
      );
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  throw new Error(
    `Bridge daemon did not come up on port ${port} within ${daemonStartTimeoutMs}ms; see ${logFile}`,
  );
};

/** Resolves once the lease is held; exits the process when it is lost. */
const holdLease = () =>
  new Promise<void>((resolveHeld, reject) => {
    const req = httpRequest(
      { host: DEFAULT_BRIDGE_HOST, port, path: LEASE_PATH, agent: false },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Lease request failed with ${res.statusCode}`));
          return;
        }
        res.resume();
        res.once("close", () => {
          logger.error(
            "lost the lease: the bridge daemon stopped; exiting so the client reports the server as down",
          );
          process.exit(1);
        });
        resolveHeld();
      },
    );
    req.on("error", reject);
    req.end();
  });

const relay = async () => {
  const stdio = new StdioServerTransport();
  const upstream = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}${MCP_HTTP_PATH}`),
  );
  let initializeRequestId: string | number | undefined;

  stdio.onmessage = (message: JSONRPCMessage) => {
    if (
      "method" in message &&
      message.method === "initialize" &&
      "id" in message
    ) {
      initializeRequestId = message.id;
    }
    upstream.send(message).catch((error: unknown) => {
      logger.error("forwarding to the bridge daemon failed", { error });
      // answer requests so the client isn't left waiting forever
      if ("method" in message && "id" in message) {
        void stdio.send({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32603,
            message: `Bridge daemon unreachable: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        });
      }
    });
  };

  upstream.onmessage = (message: JSONRPCMessage) => {
    if (
      "id" in message &&
      message.id === initializeRequestId &&
      "result" in message
    ) {
      // later requests carry the negotiated version in a header
      upstream.setProtocolVersion(
        (message.result as { protocolVersion: string }).protocolVersion,
      );
    }
    void stdio.send(message);
  };

  stdio.onerror = (error) => logger.error("stdio error", { error });
  upstream.onerror = (error) =>
    logger.error("bridge connection error", { error });

  const exit = async () => {
    // ends this session on the daemon right away instead of leaving it open
    if (upstream.sessionId) {
      await upstream.terminateSession();
    }
    process.exit(0);
  };
  process.stdin.once("end", () => void exit());
  stdio.onclose = () => void exit();

  await upstream.start();
  await stdio.start();
};

try {
  await ensureDaemon();
  await holdLease();
  await relay();
  logger.info("launcher relaying MCP over stdio", { bridge: baseUrl });
} catch (error) {
  logger.error("launcher failed to start", { error });
  process.exit(1);
}
