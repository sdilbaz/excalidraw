import { Socket } from "node:net";

import type { Logger } from "./logger.ts";

// Temporary guard for the local-only integration phase: refuses any outbound
// TCP connection (plain, TLS, fetch/undici — all go through Socket) to a
// non-loopback host. Unix sockets and named pipes are allowed.

const LOOPBACK_HOSTS = new Set([
  "localhost",
  "::1",
  "[::1]",
  "0:0:0:0:0:0:0:1",
]);

export const isLoopbackHost = (host: string): boolean =>
  LOOPBACK_HOSTS.has(host.toLowerCase()) ||
  /^127(\.\d{1,3}){3}$/.test(host) ||
  /^::ffff:127(\.\d{1,3}){3}$/i.test(host);

type ConnectTarget = { path: string } | { host: string };

// Mirrors the argument shapes Socket#connect accepts: an internal
// normalized [options, cb] array, an options object, (port, host?) or (path).
const resolveConnectTarget = (args: unknown[]): ConnectTarget => {
  const [first, second] = args;
  const options = Array.isArray(first) ? first[0] : first;

  if (typeof options === "object" && options !== null) {
    const { path, host } = options as { path?: string; host?: string };
    if (typeof path === "string") {
      return { path };
    }
    return { host: host ?? "localhost" };
  }
  if (typeof options === "string" && Number.isNaN(Number(options))) {
    return { path: options };
  }
  return { host: typeof second === "string" ? second : "localhost" };
};

export class EgressBlockedError extends Error {
  constructor(host: string) {
    super(
      `Outbound connection to "${host}" blocked: the bridge runs with MCP_BRIDGE_BLOCK_EGRESS=true`,
    );
    this.name = "EgressBlockedError";
  }
}

/** Returns a function that removes the guard (used by tests). */
export const installEgressBlock = (logger: Logger): (() => void) => {
  const originalConnect = Socket.prototype.connect;

  Socket.prototype.connect = function guardedConnect(
    this: Socket,
    ...args: unknown[]
  ) {
    const target = resolveConnectTarget(args);
    if ("host" in target && !isLoopbackHost(target.host)) {
      const error = new EgressBlockedError(target.host);
      logger.error("blocked outbound connection", {
        host: target.host,
        stack: error.stack,
      });
      throw error;
    }
    return (originalConnect as (...connectArgs: unknown[]) => Socket).apply(
      this,
      args,
    );
  } as typeof Socket.prototype.connect;

  logger.info(
    "egress block installed: non-loopback TCP connections will throw",
  );

  return () => {
    Socket.prototype.connect = originalConnect;
  };
};
