import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";

import "../excalidraw-app/sentry";

import ExcalidrawApp from "./App";
import { installEgressWatcher } from "./mcpBridge/egressWatcher";

// the entry's JavaScript and CSS loaded and ran (`scripts/stats/perf.mjs`)
performance.mark("excalidraw:app-start");

window.__EXCALIDRAW_SHA__ = import.meta.env.VITE_APP_GIT_SHA;
const rootElement = document.getElementById("root")!;

// dev-only: report requests to non-local hosts (see mcpBridge/egressWatcher)
if (import.meta.env.DEV && import.meta.env.VITE_APP_EGRESS_WATCH === "true") {
  installEgressWatcher(
    rootElement.ownerDocument.defaultView as Window & typeof globalThis,
  );
}
const root = createRoot(rootElement);
registerSW();
root.render(
  <StrictMode>
    <ExcalidrawApp />
  </StrictMode>,
);
