import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { resolve } from "node:path";

import { getIfServing } from "./httpProbe.ts";

import type { ChildProcess } from "node:child_process";

import type { Logger } from "./logger.ts";

// <title> of excalidraw-app/index.html; tells our dev server apart from
// whatever else might be listening on the port
const APP_MARKER = "<title>Excalidraw";

export type DevServer = {
  url: string;
  /** false when an already running dev server (e.g. `yarn start`) is reused */
  owned: boolean;
  /** resolves once the app is being served; rejects if the server dies */
  ready: Promise<void>;
  /** resolves if a dev server this process started exits; never for reused */
  exited: Promise<void>;
  stop: () => Promise<void>;
};

type ProbeResult = "ours" | "other" | "down";

export const probeDevServer = async (url: string): Promise<ProbeResult> => {
  const response = await getIfServing(url);
  if (!response) {
    return "down";
  }
  return response.status === 200 && response.body.includes(APP_MARKER)
    ? "ours"
    : "other";
};

export type DevServerOptions = {
  port: number;
  repoRoot: string;
  logFile: string;
  logger: Logger;
  /** overrides the vite command (tests); the port is not appended */
  command?: string[];
  startupTimeoutMs: number;
};

const waitUntilServing = async (
  url: string,
  child: ChildProcess,
  timeoutMs: number,
) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Dev server exited (code ${child.exitCode}, signal ${child.signalCode}) before serving ${url}`,
      );
    }
    const state = await probeDevServer(url);
    if (state === "ours") {
      return;
    }
    if (state === "other") {
      throw new Error(`${url} is serving something other than Excalidraw`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Dev server did not serve ${url} within ${timeoutMs}ms`);
};

/**
 * Reuses a dev server already serving the app on `port`, or starts vite.
 * Fails if the port is taken by something else rather than moving to another
 * port, since the bridge only accepts the canvas from this exact origin.
 */
export const startDevServer = async (
  options: DevServerOptions,
): Promise<DevServer> => {
  const { logger, port } = options;
  const url = `http://localhost:${port}/`;

  const existing = await probeDevServer(url);
  if (existing === "ours") {
    logger.info("reusing the dev server that is already running", { url });
    return {
      url,
      owned: false,
      ready: Promise.resolve(),
      exited: new Promise<void>(() => undefined),
      stop: async () => undefined,
    };
  }
  if (existing === "other") {
    throw new Error(
      `Port ${port} is in use by something that isn't the Excalidraw dev server`,
    );
  }

  const [file, ...args] = options.command ?? [
    process.execPath,
    resolve(options.repoRoot, "node_modules/vite/bin/vite.js"),
    "--port",
    String(port),
    "--strictPort",
  ];
  const output = openSync(options.logFile, "a");
  const child = spawn(file, args, {
    cwd: resolve(options.repoRoot, "excalidraw-app"),
    // BROWSER=none: vite.config.mts sets `open: true`; the bridge opens the
    // tab itself when an agent needs it
    env: { ...process.env, BROWSER: "none" },
    stdio: ["ignore", output, output],
    // own process group, so stop() also ends anything vite spawned
    detached: true,
  });
  logger.info("started dev server", {
    url,
    pid: child.pid,
    logFile: options.logFile,
  });

  const ready = waitUntilServing(url, child, options.startupTimeoutMs);
  const exited = new Promise<void>((resolveExit) =>
    child.once("exit", (code, signal) => {
      logger.info("dev server exited", { pid: child.pid, code, signal });
      resolveExit();
    }),
  );

  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    process.kill(-child.pid!, "SIGTERM");
    await exited;
  };

  return { url, owned: true, ready, exited, stop };
};

/** Opens a URL in the default browser (macOS and Linux). */
export const openInBrowser = async (
  url: string,
  command: string[] | null,
): Promise<void> => {
  const [file, ...args] = command ?? [
    process.platform === "darwin" ? "open" : "xdg-open",
  ];
  if (
    !command &&
    process.platform !== "darwin" &&
    process.platform !== "linux"
  ) {
    throw new Error(`Opening a browser isn't supported on ${process.platform}`);
  }
  const child = spawn(file, [...args, url], { stdio: "ignore" });
  const code = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", resolveExit);
  });
  if (code !== 0) {
    throw new Error(`"${file}" exited with code ${code} opening ${url}`);
  }
};
