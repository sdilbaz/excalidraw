// Wire protocol between the bridge server (Node) and the Excalidraw dev app
// (browser). Imported by both sides, so this file must stay dependency-free
// and use only erasable TypeScript syntax (Node runs it with type stripping).

export const DEFAULT_BRIDGE_HOST = "127.0.0.1";
export const DEFAULT_BRIDGE_PORT = 3050;
export const CANVAS_WS_PATH = "/canvas";
export const MCP_HTTP_PATH = "/mcp";
/** JSON status for launchers deciding whether a daemon is already running */
export const HEALTH_PATH = "/health";
/** held open by each launcher; the daemon stays up while any is open */
export const LEASE_PATH = "/lease";

export type BridgeHealth = {
  ok: true;
  pid: number;
  leases: number;
  canvas: { connected: boolean; pageUrl: string | null };
};

export type CanvasMethod =
  | "getScene"
  | "addElements"
  | "updateElements"
  | "deleteElements"
  | "clearScene"
  | "zoomToFit"
  | "exportImage";

export type GetSceneParams = { includeRaw?: boolean };

export type AddElementsParams = {
  /** `ExcalidrawElementSkeleton`s, as accepted by `convertToExcalidrawElements` */
  elements: ReadonlyArray<Record<string, unknown>>;
};

export type ElementUpdate = { id: string } & Record<string, unknown>;
export type UpdateElementsParams = { updates: ReadonlyArray<ElementUpdate> };

export type DeleteElementsParams = { ids: ReadonlyArray<string> };

export type ClearSceneParams = Record<string, never>;

export type ZoomToFitParams = { ids?: ReadonlyArray<string> };

export type ExportImageParams = {
  format: "png" | "svg";
  ids?: ReadonlyArray<string>;
  withBackground?: boolean;
  darkMode?: boolean;
  scale?: number;
  padding?: number;
};

export type ExportImageResult =
  | { format: "png"; mimeType: "image/png"; base64: string }
  | { format: "svg"; mimeType: "image/svg+xml"; svg: string };

export type CanvasParamsByMethod = {
  getScene: GetSceneParams;
  addElements: AddElementsParams;
  updateElements: UpdateElementsParams;
  deleteElements: DeleteElementsParams;
  clearScene: ClearSceneParams;
  zoomToFit: ZoomToFitParams;
  exportImage: ExportImageParams;
};

/** bridge -> canvas */
export type BridgeRequest = {
  [M in CanvasMethod]: {
    type: "request";
    id: string;
    method: M;
    params: CanvasParamsByMethod[M];
  };
}[CanvasMethod];

/** canvas -> bridge */
export type CanvasResponse =
  | { type: "response"; id: string; ok: true; result: unknown }
  | {
      type: "response";
      id: string;
      ok: false;
      error: { message: string; stack?: string };
    };

/**
 * A network request from the app tab to a non-local host, seen by the
 * dev-only egress watcher. `blocked` is true when the local-only CSP stopped
 * it; Resource Timing entries can't tell, so they are always `false` (see
 * mcp-bridge/src/egressSummary.ts for how the two are matched up).
 */
export type EgressEvent = {
  source: "csp-violation" | "resource-timing";
  url: string;
  blocked: boolean;
  /** CSP directive, or the Resource Timing initiator type */
  detail?: string;
  /** Resource Timing only; all zero for blocked or opaque cross-origin loads */
  timing?: { durationMs: number; transferSize: number; responseStatus: number };
  timestamp: number;
};

export type CanvasHello = { type: "hello"; pageUrl: string };
export type CanvasEgressReport = { type: "egress"; events: EgressEvent[] };

export type CanvasMessage = CanvasResponse | CanvasHello | CanvasEgressReport;
