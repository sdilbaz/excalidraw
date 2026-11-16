import type { EgressEvent } from "./protocol.ts";

export type EgressSummary = {
  totalEvents: number;
  uniqueUrls: number;
  /** URLs the local-only CSP refused at least once */
  blockedUrlCount: number;
  /**
   * URLs that showed up in Resource Timing without a matching CSP violation:
   * these requests may have reached the network. Should be empty.
   */
  possiblyUnblockedUrls: string[];
  byHost: Record<
    string,
    { cspViolations: number; resourceTimings: number; directives: string[] }
  >;
};

const hostOf = (url: string) =>
  URL.canParse(url) ? new URL(url).host : `(unparseable) ${url}`;

/**
 * Chrome reports a CSP-blocked request twice: a `securitypolicyviolation`
 * event and a zero-byte Resource Timing entry. Cross-origin timing entries
 * don't expose enough to tell "blocked" from "sent", so a timing entry counts
 * as blocked only when the same URL also produced a CSP violation.
 */
export const summarizeEgress = (
  events: readonly EgressEvent[],
): EgressSummary => {
  const cspBlockedUrls = new Set<string>();
  const timedUrls = new Set<string>();
  const byHost: EgressSummary["byHost"] = {};

  for (const event of events) {
    const host = hostOf(event.url);
    const hostSummary = (byHost[host] ??= {
      cspViolations: 0,
      resourceTimings: 0,
      directives: [],
    });

    if (event.source === "csp-violation") {
      hostSummary.cspViolations += 1;
      if (event.blocked) {
        cspBlockedUrls.add(event.url);
      }
      if (event.detail && !hostSummary.directives.includes(event.detail)) {
        hostSummary.directives.push(event.detail);
      }
    } else {
      hostSummary.resourceTimings += 1;
      timedUrls.add(event.url);
    }
  }

  return {
    totalEvents: events.length,
    uniqueUrls: new Set(events.map((event) => event.url)).size,
    blockedUrlCount: cspBlockedUrls.size,
    possiblyUnblockedUrls: [...timedUrls].filter(
      (url) => !cspBlockedUrls.has(url),
    ),
    byHost,
  };
};
