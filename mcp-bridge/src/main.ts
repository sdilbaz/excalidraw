import { installEgressBlock } from "./blockEgress.ts";
import { createLogger, parseLogLevel } from "./logger.ts";
import { DEFAULT_BRIDGE_HOST, DEFAULT_BRIDGE_PORT } from "./protocol.ts";
import { startBridgeServer } from "./server.ts";

const DEFAULT_CANVAS_ORIGINS = [
  "http://localhost:3001",
  "http://127.0.0.1:3001",
];
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

const parseBooleanEnv = (name: string): boolean => {
  const value = process.env[name];
  if (value === undefined || value === "" || value === "false") {
    return false;
  }
  if (value === "true") {
    return true;
  }
  throw new Error(`${name} must be "true" or "false", got "${value}"`);
};

const parseIntegerEnv = (name: string, fallback: number): number => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${value}"`);
  }
  return parsed;
};

const logger = createLogger(parseLogLevel(process.env.LOG_LEVEL));

if (parseBooleanEnv("MCP_BRIDGE_BLOCK_EGRESS")) {
  installEgressBlock(logger);
}

const allowedCanvasOrigins = process.env.MCP_BRIDGE_ALLOWED_ORIGINS
  ? process.env.MCP_BRIDGE_ALLOWED_ORIGINS.split(",").map((origin) =>
      origin.trim(),
    )
  : DEFAULT_CANVAS_ORIGINS;

const bridge = await startBridgeServer({
  host: DEFAULT_BRIDGE_HOST,
  port: parseIntegerEnv("MCP_BRIDGE_PORT", DEFAULT_BRIDGE_PORT),
  allowedCanvasOrigins,
  requestTimeoutMs: parseIntegerEnv(
    "MCP_BRIDGE_REQUEST_TIMEOUT_MS",
    DEFAULT_REQUEST_TIMEOUT_MS,
  ),
  logger,
});

logger.info("bridge listening", {
  mcpUrl: bridge.mcpUrl,
  canvasUrl: bridge.canvasUrl,
  allowedCanvasOrigins,
  pid: process.pid,
});

const shutdown = (signal: string) => {
  logger.info("shutting down", { signal });
  bridge.close().then(
    () => process.exit(0),
    (error: unknown) => {
      logger.error("shutdown failed", { error });
      process.exit(1);
    },
  );
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
