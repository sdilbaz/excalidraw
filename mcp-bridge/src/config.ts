import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { DEFAULT_BRIDGE_PORT } from "./protocol.ts";

/** The monorepo root (this file is mcp-bridge/src/config.ts). */
export const REPO_ROOT = resolve(import.meta.dirname, "../..");

/**
 * Folder for daemon and dev-server logs: mcp-bridge/.run (git-ignored), or
 * MCP_BRIDGE_RUN_DIR (tests).
 */
export const ensureRunDir = (): string => {
  const runDir =
    process.env.MCP_BRIDGE_RUN_DIR || resolve(REPO_ROOT, "mcp-bridge/.run");
  mkdirSync(runDir, { recursive: true });
  return runDir;
};

export const parseBooleanEnv = (name: string): boolean => {
  const value = process.env[name];
  if (value === undefined || value === "" || value === "false") {
    return false;
  }
  if (value === "true") {
    return true;
  }
  throw new Error(`${name} must be "true" or "false", got "${value}"`);
};

export const parseIntegerEnv = (name: string, fallback: number): number => {
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

/** A command given as a JSON array of strings, e.g. ["node", "server.js"]. */
export const parseCommandEnv = (name: string): string[] | null => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return null;
  }
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every((part) => typeof part === "string")
  ) {
    throw new Error(`${name} must be a JSON array of strings, got ${value}`);
  }
  return parsed;
};

export const bridgePort = () =>
  parseIntegerEnv("MCP_BRIDGE_PORT", DEFAULT_BRIDGE_PORT);

export const devServerPort = () => parseIntegerEnv("MCP_BRIDGE_DEV_PORT", 3001);

export const canvasOriginsFor = (devPort: number) => [
  `http://localhost:${devPort}`,
  `http://127.0.0.1:${devPort}`,
];
