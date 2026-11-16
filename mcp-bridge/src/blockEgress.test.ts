import { Socket, connect, createServer } from "node:net";

import {
  EgressBlockedError,
  installEgressBlock,
  isLoopbackHost,
} from "./blockEgress.ts";
import { createLogger } from "./logger.ts";

import type { AddressInfo, Server } from "node:net";

describe("isLoopbackHost", () => {
  it.each([
    ["localhost", true],
    ["LOCALHOST", true],
    ["127.0.0.1", true],
    ["127.1.2.3", true],
    ["::1", true],
    ["[::1]", true],
    ["::ffff:127.0.0.1", true],
    ["0.0.0.0", false],
    ["10.0.0.1", false],
    ["192.168.1.1", false],
    ["excalidraw.com", false],
    ["localhost.evil.example", false],
    ["127.0.0.1.evil.example", false],
  ])("%s -> %s", (host, expected) => {
    expect(isLoopbackHost(host)).toBe(expected);
  });
});

describe("installEgressBlock", () => {
  const originalConnect = Socket.prototype.connect;
  const logLines: string[] = [];
  let uninstall: () => void;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    logLines.length = 0;
    server = createServer((socket) => socket.end());
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    port = (server.address() as AddressInfo).port;
    uninstall = installEgressBlock(
      createLogger("debug", (line) => logLines.push(line)),
    );
  });

  afterEach(async () => {
    uninstall();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it.each([
    ["options object", () => connect({ host: "excalidraw.com", port: 443 })],
    ["port and host", () => connect(443, "93.184.216.34")],
  ])("throws for a non-loopback host given as %s", (_, open) => {
    expect(open).toThrow(EgressBlockedError);
    expect(logLines.some((line) => line.includes("blocked outbound"))).toBe(
      true,
    );
  });

  it("rejects fetch to a non-loopback host", async () => {
    const error = await fetch("http://excalidraw.com/").catch(
      (fetchError: unknown) => fetchError,
    );
    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).cause).toBeInstanceOf(EgressBlockedError);
  });

  it.each([["127.0.0.1"], ["localhost"]])(
    "allows connecting to %s",
    async (host) => {
      const socket = connect({ host, port });
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", () => resolve());
        socket.once("error", reject);
      });
      socket.destroy();
    },
  );

  it("restores the original Socket#connect when uninstalled", () => {
    const guarded = Socket.prototype.connect;
    uninstall();
    expect(Socket.prototype.connect).not.toBe(guarded);
    expect(Socket.prototype.connect).toBe(originalConnect);
    // reinstall so afterEach's uninstall stays balanced
    uninstall = installEgressBlock(createLogger("error", () => undefined));
  });
});
