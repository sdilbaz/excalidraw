import { randomUUID } from "node:crypto";

import type { WebSocket } from "ws";

import type { Logger } from "./logger.ts";
import type {
  BridgeRequest,
  CanvasMethod,
  CanvasMessage,
  CanvasParamsByMethod,
  EgressEvent,
} from "./protocol.ts";

/** Error reported by the app tab while running a command. */
export class CanvasCommandError extends Error {
  readonly canvasStack: string | undefined;

  constructor(message: string, canvasStack: string | undefined) {
    super(message);
    this.name = "CanvasCommandError";
    this.canvasStack = canvasStack;
  }
}

type PendingRequest = {
  method: CanvasMethod;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export type CanvasStatus = {
  connected: boolean;
  pageUrl: string | null;
  connectedAt: string | null;
};

// close code from the private-use range (4000-4999)
const REPLACED_CLOSE_CODE = 4000;

/**
 * Holds the single active app-tab connection and correlates requests sent to
 * it with their responses. The newest tab to connect wins, so the canvas
 * Claude edits is always the one the user opened last.
 */
export class CanvasHub {
  private readonly logger: Logger;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly egressEvents: EgressEvent[] = [];
  private readonly egressHostsSeen = new Set<string>();
  private socket: WebSocket | null = null;
  private pageUrl: string | null = null;
  private connectedAt: Date | null = null;

  constructor(logger: Logger, requestTimeoutMs: number) {
    this.logger = logger;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  attach(socket: WebSocket, origin: string): void {
    const previous = this.socket;
    if (previous) {
      this.logger.warn("replacing connected canvas with a newer tab", {
        previousPageUrl: this.pageUrl,
        origin,
      });
      // detach first so the old socket's close handler sees it is no longer
      // current and doesn't tear down the new connection
      this.detach(new Error("Canvas was replaced by a newer tab"));
      previous.close(REPLACED_CLOSE_CODE, "replaced by a newer tab");
    }

    this.socket = socket;
    this.connectedAt = new Date();
    this.pageUrl = null;
    this.logger.info("canvas connected", { origin });

    socket.on("message", (data) => this.handleMessage(socket, data));
    socket.on("close", (code, reason) => {
      if (this.socket !== socket) {
        return;
      }
      this.logger.info("canvas disconnected", {
        code,
        reason: reason.toString(),
      });
      this.detach(new Error("Canvas disconnected before responding"));
    });
    socket.on("error", (error) => {
      this.logger.error("canvas socket error", { error });
    });
  }

  status(): CanvasStatus {
    return {
      connected: this.socket !== null,
      pageUrl: this.pageUrl,
      connectedAt: this.connectedAt?.toISOString() ?? null,
    };
  }

  getEgressEvents(): readonly EgressEvent[] {
    return this.egressEvents;
  }

  request<M extends CanvasMethod>(
    method: M,
    params: CanvasParamsByMethod[M],
  ): Promise<unknown> {
    const socket = this.socket;
    if (!socket) {
      return Promise.reject(
        new Error(
          "No Excalidraw canvas is connected to the bridge. Start the app with `yarn start` (with VITE_APP_MCP_BRIDGE_URL set) and open it in a browser tab.",
        ),
      );
    }

    const id = randomUUID();
    const message = { type: "request", id, method, params } as BridgeRequest;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Canvas did not respond to "${method}" within ${this.requestTimeoutMs}ms`,
          ),
        );
      }, this.requestTimeoutMs);

      this.pending.set(id, { method, resolve, reject, timer });
      this.logger.debug("sending canvas request", { id, method });
      socket.send(JSON.stringify(message));
    });
  }

  close(): void {
    const socket = this.socket;
    this.detach(new Error("Bridge is shutting down"));
    socket?.close(1001, "bridge shutting down");
  }

  private detach(reason: Error): void {
    this.socket = null;
    this.pageUrl = null;
    this.connectedAt = null;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(reason);
      this.pending.delete(id);
    }
  }

  private handleMessage(socket: WebSocket, data: unknown): void {
    if (this.socket !== socket) {
      return;
    }
    // a malformed message means the app and bridge disagree on the protocol;
    // let JSON.parse throw so it surfaces in the logs with its stack
    const message = JSON.parse(String(data)) as CanvasMessage;

    switch (message.type) {
      case "hello": {
        this.pageUrl = message.pageUrl;
        this.logger.info("canvas identified", { pageUrl: message.pageUrl });
        return;
      }
      case "egress": {
        for (const event of message.events) {
          this.egressEvents.push(event);
          this.logger.debug("app tab outbound request", { ...event });
          const host = URL.canParse(event.url)
            ? new URL(event.url).host
            : event.url;
          if (!this.egressHostsSeen.has(host)) {
            this.egressHostsSeen.add(host);
            this.logger.warn(
              "app tab tried to reach a new non-local host (see bridge_status)",
              { host, firstUrl: event.url, source: event.source },
            );
          }
        }
        return;
      }
      case "response": {
        const pending = this.pending.get(message.id);
        if (!pending) {
          this.logger.warn("response for unknown or timed-out request", {
            id: message.id,
          });
          return;
        }
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.ok) {
          this.logger.debug("canvas request succeeded", {
            id: message.id,
            method: pending.method,
          });
          pending.resolve(message.result);
        } else {
          pending.reject(
            new CanvasCommandError(message.error.message, message.error.stack),
          );
        }
        return;
      }
      default: {
        const unknownType: never = message;
        throw new Error(
          `Unknown canvas message: ${JSON.stringify(unknownType)}`,
        );
      }
    }
  }
}
