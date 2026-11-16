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

/**
 * How the hub brings up a canvas when a request arrives and no app tab is
 * connected. Without one, such requests fail immediately.
 */
export type CanvasOpener = {
  /** e.g. waits for the dev server, then opens the app URL in a browser */
  openCanvas: () => Promise<void>;
  /** how long to let an already open tab reconnect before opening a new one */
  reconnectGraceMs: number;
  /** total time a request waits for a canvas to connect */
  waitMs: number;
  /** don't open another tab within this long of the previous one */
  minReopenIntervalMs: number;
};

export type CanvasHubOptions = {
  logger: Logger;
  requestTimeoutMs: number;
  opener?: CanvasOpener;
  /** called on every request, for idle tracking */
  onActivity?: () => void;
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
  private readonly opener: CanvasOpener | undefined;
  private readonly onActivity: () => void;
  private readonly attachWaiters = new Set<(socket: WebSocket) => void>();
  private lastOpenedAt = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly egressEvents: EgressEvent[] = [];
  private readonly egressHostsSeen = new Set<string>();
  private socket: WebSocket | null = null;
  private pageUrl: string | null = null;
  private connectedAt: Date | null = null;

  constructor(options: CanvasHubOptions) {
    this.logger = options.logger;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.opener = options.opener;
    this.onActivity = options.onActivity ?? (() => undefined);
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
    for (const resolveWaiter of this.attachWaiters) {
      resolveWaiter(socket);
    }
    this.attachWaiters.clear();

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

  async request<M extends CanvasMethod>(
    method: M,
    params: CanvasParamsByMethod[M],
  ): Promise<unknown> {
    this.onActivity();
    const socket = await this.getOrOpenCanvas();
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

  /** Resolves with the socket of the next tab to connect, or null on timeout. */
  private nextAttach(timeoutMs: number): Promise<WebSocket | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.attachWaiters.delete(onAttach);
        resolve(null);
      }, timeoutMs);
      const onAttach = (socket: WebSocket) => {
        clearTimeout(timer);
        resolve(socket);
      };
      this.attachWaiters.add(onAttach);
    });
  }

  private async getOrOpenCanvas(): Promise<WebSocket> {
    if (this.socket) {
      return this.socket;
    }
    const opener = this.opener;
    if (!opener) {
      throw new Error(
        "No Excalidraw canvas is connected to the bridge. Start the app with `yarn start` (with VITE_APP_MCP_BRIDGE_URL set) and open it in a browser tab.",
      );
    }

    const startedAt = Date.now();
    // a tab left open from an earlier bridge run reconnects on its own
    const reconnected = await this.nextAttach(opener.reconnectGraceMs);
    if (reconnected) {
      return reconnected;
    }

    if (Date.now() - this.lastOpenedAt >= opener.minReopenIntervalMs) {
      this.lastOpenedAt = Date.now();
      this.logger.info("no canvas connected; opening the app in a browser");
      await opener.openCanvas();
    }

    const remainingMs = opener.waitMs - (Date.now() - startedAt);
    const opened =
      this.socket ?? (await this.nextAttach(Math.max(remainingMs, 0)));
    if (!opened) {
      throw new Error(
        `No Excalidraw canvas connected within ${Math.round(
          opener.waitMs / 1000,
        )}s after opening the app in a browser. Check that the browser tab loaded, and see the bridge daemon log.`,
      );
    }
    return opened;
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
