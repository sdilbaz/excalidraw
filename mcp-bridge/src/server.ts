import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { WebSocketServer } from "ws";

import { CanvasHub } from "./canvasHub.ts";
import { IdleMonitor } from "./idleMonitor.ts";
import {
  CANVAS_WS_PATH,
  HEALTH_PATH,
  LEASE_PATH,
  MCP_HTTP_PATH,
} from "./protocol.ts";
import { createMcpServer } from "./tools.ts";

import type { AddressInfo } from "node:net";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import type { CanvasOpener } from "./canvasHub.ts";
import type { Logger } from "./logger.ts";
import type { BridgeHealth } from "./protocol.ts";

const MAX_BODY_BYTES = 10 * 1024 * 1024;

export type BridgeServerOptions = {
  host: string;
  /** 0 picks a free port (tests) */
  port: number;
  /** page origins allowed to connect as the canvas, e.g. http://localhost:3001 */
  allowedCanvasOrigins: readonly string[];
  requestTimeoutMs: number;
  logger: Logger;
  /** opens the app when a request arrives with no canvas connected */
  opener?: CanvasOpener;
  /** shut down after this long with no leases and no activity */
  idle?: { idleMs: number; onIdle: () => void };
};

export type BridgeServer = {
  hub: CanvasHub;
  httpServer: Server;
  port: number;
  mcpUrl: string;
  canvasUrl: string;
  close: () => Promise<void>;
};

const sendJsonRpcError = (
  res: ServerResponse,
  httpStatus: number,
  code: number,
  message: string,
) => {
  res.writeHead(httpStatus, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }),
  );
};

const readJsonBody = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      throw new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

export const startBridgeServer = async (
  options: BridgeServerOptions,
): Promise<BridgeServer> => {
  const { logger } = options;
  const idleMonitor = options.idle
    ? new IdleMonitor(options.idle.idleMs, () => {
        logger.info("idle: no leases or activity, shutting down", {
          idleMs: options.idle?.idleMs,
        });
        options.idle?.onIdle();
      })
    : null;
  const hub = new CanvasHub({
    logger,
    requestTimeoutMs: options.requestTimeoutMs,
    opener: options.opener,
    onActivity: () => idleMonitor?.touch(),
  });
  const transports = new Map<string, StreamableHTTPServerTransport>();
  // filled in once listening, since the port may be assigned by the OS
  let allowedHosts: Set<string> = new Set();

  // Rejects DNS-rebinding attempts: a page on another site that resolves its
  // own hostname to 127.0.0.1 still sends its own Host header.
  const isAllowedHost = (req: IncomingMessage) =>
    req.headers.host !== undefined && allowedHosts.has(req.headers.host);

  const handleMcpRequest = async (
    req: IncomingMessage,
    res: ServerResponse,
  ) => {
    // MCP clients (Claude Code) are not browsers and send no Origin header;
    // refusing any Origin keeps web pages from calling the tools
    if (req.headers.origin !== undefined) {
      logger.warn("rejected MCP request from a browser origin", {
        origin: req.headers.origin,
      });
      sendJsonRpcError(res, 403, -32000, "Browser origins are not allowed");
      return;
    }

    const sessionIdHeader = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sessionIdHeader)
      ? sessionIdHeader[0]
      : sessionIdHeader;

    if (sessionId !== undefined) {
      const transport = transports.get(sessionId);
      if (!transport) {
        sendJsonRpcError(res, 404, -32001, `Unknown MCP session ${sessionId}`);
        return;
      }
      const body = req.method === "POST" ? await readJsonBody(req) : undefined;
      await transport.handleRequest(req, res, body);
      return;
    }

    if (req.method !== "POST") {
      sendJsonRpcError(res, 400, -32000, "Missing mcp-session-id header");
      return;
    }

    const body = await readJsonBody(req);
    if (!isInitializeRequest(body)) {
      sendJsonRpcError(
        res,
        400,
        -32000,
        "First request of a session must be initialize",
      );
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSessionId) => {
        transports.set(newSessionId, transport);
        logger.info("MCP session opened", { sessionId: newSessionId });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        transports.delete(transport.sessionId);
        logger.info("MCP session closed", { sessionId: transport.sessionId });
      }
    };
    const mcpServer = createMcpServer(hub);
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  const handleHealth = (res: ServerResponse) => {
    const status = hub.status();
    const health: BridgeHealth = {
      ok: true,
      pid: process.pid,
      leases: idleMonitor?.leaseCount ?? 0,
      canvas: { connected: status.connected, pageUrl: status.pageUrl },
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(health));
  };

  // The response stays open for the life of the launcher process; the OS
  // closes the socket when that process exits, however it exits.
  const handleLease = (req: IncomingMessage, res: ServerResponse) => {
    idleMonitor?.acquire();
    logger.info("lease acquired", { leases: idleMonitor?.leaseCount });
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.write("lease held\n");
    req.socket.setKeepAlive(true);
    res.on("close", () => {
      idleMonitor?.release();
      logger.info("lease released", { leases: idleMonitor?.leaseCount });
    });
  };

  const httpServer = createServer((req, res) => {
    if (!isAllowedHost(req)) {
      logger.warn("rejected request with unexpected Host header", {
        host: req.headers.host,
      });
      res.writeHead(403).end("Forbidden host");
      return;
    }

    const { pathname } = new URL(req.url ?? "/", "http://placeholder");
    if (pathname !== MCP_HTTP_PATH) {
      if (pathname === HEALTH_PATH || pathname === LEASE_PATH) {
        // only local processes, never web pages
        if (req.headers.origin !== undefined || req.method !== "GET") {
          res.writeHead(403).end("Forbidden");
          return;
        }
        if (pathname === HEALTH_PATH) {
          handleHealth(res);
        } else {
          handleLease(req, res);
        }
        return;
      }
      res.writeHead(404).end("Not found");
      return;
    }

    idleMonitor?.touch();

    handleMcpRequest(req, res).catch((error: unknown) => {
      logger.error("MCP request failed", { error });
      if (!res.headersSent) {
        const message = error instanceof Error ? error.message : String(error);
        sendJsonRpcError(
          res,
          error instanceof SyntaxError ? 400 : 500,
          -32603,
          message,
        );
      } else {
        res.end();
      }
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url ?? "/", "http://placeholder");
    const origin = req.headers.origin;

    const rejection = !isAllowedHost(req)
      ? "unexpected Host header"
      : pathname !== CANVAS_WS_PATH
      ? "unknown path"
      : origin === undefined || !options.allowedCanvasOrigins.includes(origin)
      ? "origin not allowed"
      : null;

    if (rejection) {
      logger.warn("rejected canvas connection", {
        reason: rejection,
        origin,
        host: req.headers.host,
        pathname,
      });
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => hub.attach(ws, origin!));
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, options.host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const { port } = httpServer.address() as AddressInfo;
  allowedHosts = new Set([
    `${options.host}:${port}`,
    `localhost:${port}`,
    `127.0.0.1:${port}`,
  ]);

  const close = async () => {
    idleMonitor?.stop();
    hub.close();
    await Promise.all(
      [...transports.values()].map((transport) => transport.close()),
    );
    transports.clear();
    wss.close();
    httpServer.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      httpServer.close((error) => (error ? reject(error) : resolve())),
    );
  };

  return {
    hub,
    httpServer,
    port,
    mcpUrl: `http://${options.host}:${port}${MCP_HTTP_PATH}`,
    canvasUrl: `ws://${options.host}:${port}${CANVAS_WS_PATH}`,
    close,
  };
};
