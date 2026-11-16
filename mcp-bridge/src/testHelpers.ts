// Shared helpers for the bridge's tests (not used at runtime).

import { createServer } from "node:net";

import { WebSocket } from "ws";

import type { AddressInfo } from "node:net";

import type { BridgeRequest, CanvasMessage } from "./protocol.ts";

export type CanvasHandler = (request: BridgeRequest) => CanvasMessage | null;

export const okReply =
  (result: unknown): CanvasHandler =>
  (request) => ({ type: "response", id: request.id, ok: true, result });

/** A stand-in for the app tab: answers bridge requests with `handler`. */
export const connectFakeCanvas = async (
  canvasUrl: string,
  origin: string,
  handler: CanvasHandler,
) => {
  const socket = new WebSocket(canvasUrl, { origin });
  const received: BridgeRequest[] = [];
  socket.on("message", (data) => {
    const request = JSON.parse(String(data)) as BridgeRequest;
    received.push(request);
    const reply = handler(request);
    if (reply) {
      socket.send(JSON.stringify(reply));
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify({ type: "hello", pageUrl: `${origin}/` } as CanvasMessage),
  );
  return { socket, received };
};

export const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
  label = "condition",
) => {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/** A port that was free a moment ago (the OS picks it). */
export const getFreePort = async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
};
