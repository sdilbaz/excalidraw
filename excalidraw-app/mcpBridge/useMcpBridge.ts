import { useEffect } from "react";

import { isDevEnv } from "@excalidraw/common";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { runCanvasCommand } from "./canvasCommands";
import {
  getRecordedEgressEvents,
  subscribeToEgressEvents,
} from "./egressWatcher";

import type {
  BridgeRequest,
  CanvasMessage,
} from "../../mcp-bridge/src/protocol";

const INITIAL_RECONNECT_DELAY_MS = 1_000;
// short, so a tab left open reconnects within the bridge's 4s grace period
const MAX_RECONNECT_DELAY_MS = 3_000;
// sent by the bridge when a newer tab takes over (see mcp-bridge canvasHub)
const REPLACED_CLOSE_CODE = 4000;

/**
 * Dev-only: connects this tab to the local MCP bridge (mcp-bridge/) so Claude
 * sessions can read and edit the canvas. Off unless VITE_APP_MCP_BRIDGE_URL
 * is set, and never active in production builds.
 */
export const useMcpBridge = (
  excalidrawAPI: ExcalidrawImperativeAPI | null,
  ownerWindow: Window & typeof globalThis,
) => {
  useEffect(() => {
    const bridgeUrl = import.meta.env.VITE_APP_MCP_BRIDGE_URL;
    if (!excalidrawAPI || !isDevEnv() || !bridgeUrl) {
      return;
    }

    let socket: WebSocket | null = null;
    let reconnectTimer: number | undefined;
    let reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
    let disposed = false;
    // index into the recorded egress events up to which the bridge has them
    let egressSentCount = 0;

    const send = (target: WebSocket, message: CanvasMessage) => {
      target.send(JSON.stringify(message));
    };

    const flushEgressEvents = () => {
      const events = getRecordedEgressEvents();
      if (!socket || socket.readyState !== socket.OPEN) {
        return;
      }
      if (events.length > egressSentCount) {
        send(socket, {
          type: "egress",
          events: events.slice(egressSentCount),
        });
        egressSentCount = events.length;
      }
    };
    const unsubscribeEgress = subscribeToEgressEvents(flushEgressEvents);

    const handleRequest = (target: WebSocket, request: BridgeRequest) => {
      runCanvasCommand(excalidrawAPI, request).then(
        (result) =>
          send(target, { type: "response", id: request.id, ok: true, result }),
        (error: unknown) => {
          console.error(
            `[mcp-bridge] "${request.method}" failed`,
            request.params,
            error,
          );
          const normalized =
            error instanceof Error ? error : new Error(String(error));
          send(target, {
            type: "response",
            id: request.id,
            ok: false,
            error: { message: normalized.message, stack: normalized.stack },
          });
        },
      );
    };

    const connect = () => {
      const ws = new ownerWindow.WebSocket(bridgeUrl);
      socket = ws;

      ws.addEventListener("open", () => {
        reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
        console.info("[mcp-bridge] connected", bridgeUrl);
        send(ws, { type: "hello", pageUrl: ownerWindow.location.href });
        // resend the full history: a restarted bridge starts out empty, and
        // its summary de-duplicates by URL
        egressSentCount = 0;
        flushEgressEvents();
      });

      ws.addEventListener("message", (event) => {
        handleRequest(ws, JSON.parse(String(event.data)) as BridgeRequest);
      });

      ws.addEventListener("close", (event) => {
        if (disposed || socket !== ws) {
          return;
        }
        socket = null;
        if (event.code === REPLACED_CLOSE_CODE) {
          // reconnecting would steal the canvas back from the newer tab
          console.warn(
            "[mcp-bridge] another tab took over the bridge; reload this tab to reconnect it",
          );
          return;
        }
        console.info(
          `[mcp-bridge] not connected, retrying in ${reconnectDelay}ms`,
        );
        reconnectTimer = ownerWindow.setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
      });
    };

    connect();

    return () => {
      disposed = true;
      unsubscribeEgress();
      ownerWindow.clearTimeout(reconnectTimer);
      socket?.close(1000, "editor unmounted");
      socket = null;
    };
  }, [excalidrawAPI, ownerWindow]);
};
