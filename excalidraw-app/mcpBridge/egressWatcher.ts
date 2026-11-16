import type { EgressEvent } from "../../mcp-bridge/src/protocol";

// Dev-only watcher for network requests from this tab to non-local hosts.
// It sees requests the CSP blocked (`securitypolicyviolation`) and requests
// that actually went out (Resource Timing). It cannot see <link rel=preconnect>
// or DNS prefetches, which is why the block mode strips those from index.html.

type EgressListener = (event: EgressEvent) => void;

const recordedEvents: EgressEvent[] = [];
const listeners = new Set<EgressListener>();
let isInstalled = false;

// values `SecurityPolicyViolationEvent.blockedURI` uses for non-network sources
const NON_NETWORK_BLOCKED_URIS = new Set([
  "",
  "inline",
  "eval",
  "wasm-eval",
  "data",
  "blob",
  "self",
  "trusted-types-policy",
  "trusted-types-sink",
]);
const NON_NETWORK_PROTOCOLS = new Set([
  "data:",
  "blob:",
  "about:",
  // a protocol to compare against, not a URL that is ever navigated to
  // eslint-disable-next-line no-script-url
  "javascript:",
]);

export const isLocalUrl = (rawUrl: string, baseUrl: string): boolean => {
  if (NON_NETWORK_BLOCKED_URIS.has(rawUrl)) {
    return true;
  }
  if (!URL.canParse(rawUrl, baseUrl)) {
    // unparseable means we can't prove it's local: report it
    return false;
  }
  const url = new URL(rawUrl, baseUrl);
  if (NON_NETWORK_PROTOCOLS.has(url.protocol)) {
    return true;
  }
  const { hostname } = url;
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    /^127(\.\d{1,3}){3}$/.test(hostname)
  );
};

const record = (event: EgressEvent) => {
  recordedEvents.push(event);
  if (event.source === "csp-violation" && event.blocked) {
    console.warn("[egress-watcher] blocked a non-local request", event);
  } else {
    console.error("[egress-watcher] non-local request from the app tab", event);
  }
  listeners.forEach((listener) => listener(event));
};

export const installEgressWatcher = (
  ownerWindow: Window & typeof globalThis,
) => {
  if (isInstalled) {
    return;
  }
  isInstalled = true;

  ownerWindow.document.addEventListener("securitypolicyviolation", (event) => {
    if (isLocalUrl(event.blockedURI, ownerWindow.location.href)) {
      return;
    }
    record({
      source: "csp-violation",
      url: event.blockedURI,
      blocked: event.disposition === "enforce",
      detail: event.effectiveDirective,
      timestamp: Date.now(),
    });
  });

  const observer = new ownerWindow.PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (isLocalUrl(entry.name, ownerWindow.location.href)) {
        continue;
      }
      const timing = entry as PerformanceResourceTiming;
      record({
        source: "resource-timing",
        url: entry.name,
        blocked: false,
        detail: timing.initiatorType,
        timing: {
          durationMs: Math.round(timing.duration),
          transferSize: timing.transferSize,
          responseStatus: timing.responseStatus,
        },
        timestamp: Date.now(),
      });
    }
  });
  // buffered: also report requests made before the watcher was installed
  observer.observe({ type: "resource", buffered: true });

  console.info("[egress-watcher] watching for non-local requests");
};

export const getRecordedEgressEvents = (): readonly EgressEvent[] =>
  recordedEvents;

export const subscribeToEgressEvents = (listener: EgressListener) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
