import { summarizeEgress } from "./egressSummary.ts";

import type { EgressEvent } from "./protocol.ts";

const violation = (url: string, directive = "font-src"): EgressEvent => ({
  source: "csp-violation",
  url,
  blocked: true,
  detail: directive,
  timestamp: 0,
});

const timing = (url: string, durationMs = 0): EgressEvent => ({
  source: "resource-timing",
  url,
  blocked: false,
  detail: "css",
  timing: { durationMs, transferSize: 0, responseStatus: 0 },
  timestamp: 0,
});

describe("summarizeEgress", () => {
  it("is empty for no events", () => {
    expect(summarizeEgress([])).toEqual({
      totalEvents: 0,
      uniqueUrls: 0,
      blockedUrlCount: 0,
      possiblyUnblockedUrls: [],
      byHost: {},
    });
  });

  it("treats a timing entry with a matching CSP violation as blocked, in either order", () => {
    const font = "https://esm.sh/font-a.woff2";
    const other = "https://esm.sh/font-b.woff2";

    const summary = summarizeEgress([
      timing(font),
      violation(font),
      violation(other),
      timing(other),
    ]);

    expect(summary.possiblyUnblockedUrls).toEqual([]);
    expect(summary.blockedUrlCount).toBe(2);
    expect(summary.byHost["esm.sh"]).toEqual({
      cspViolations: 2,
      resourceTimings: 2,
      directives: ["font-src"],
    });
  });

  it("flags timing entries with no CSP violation as possibly sent", () => {
    const summary = summarizeEgress([
      violation("https://esm.sh/blocked.woff2"),
      timing("https://json.excalidraw.com/api/v2/", 120),
    ]);

    expect(summary.possiblyUnblockedUrls).toEqual([
      "https://json.excalidraw.com/api/v2/",
    ]);
  });

  it("does not count a report-only violation as blocked", () => {
    const url = "https://esm.sh/report-only.woff2";
    const summary = summarizeEgress([
      { ...violation(url), blocked: false },
      timing(url),
    ]);

    expect(summary.blockedUrlCount).toBe(0);
    expect(summary.possiblyUnblockedUrls).toEqual([url]);
  });

  it("groups by host and collects directives", () => {
    const summary = summarizeEgress([
      violation("https://fonts.gstatic.com/a", "font-src"),
      violation("https://json-dev.excalidraw.com/api", "connect-src"),
      violation("https://json-dev.excalidraw.com/api/2", "img-src"),
    ]);

    expect(Object.keys(summary.byHost).sort()).toEqual([
      "fonts.gstatic.com",
      "json-dev.excalidraw.com",
    ]);
    expect(summary.byHost["json-dev.excalidraw.com"].directives).toEqual([
      "connect-src",
      "img-src",
    ]);
    expect(summary.uniqueUrls).toBe(3);
  });
});
