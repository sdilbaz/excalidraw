import {
  computeBoundTextPosition,
  convertToExcalidrawElements,
  getBoundTextElementId,
  isArrowElement,
  isFrameLikeElement,
  isLinearElement,
  isTextElement,
  newElementWith,
  refreshTextDimensions,
} from "@excalidraw/element";
import { CaptureUpdateAction } from "@excalidraw/element";
import { cleanAppStateForExport } from "@excalidraw/excalidraw/appState";
import { exportScene } from "@excalidraw/excalidraw/scene/export";
import { THEME } from "@excalidraw/common";

import type {
  ExcalidrawElement,
  ExcalidrawTextContainer,
  ExcalidrawTextElement,
  ExcalidrawTextElementWithContainer,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";
import type { ExcalidrawElementSkeleton } from "@excalidraw/element";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import type {
  AddElementsParams,
  BridgeRequest,
  DeleteElementsParams,
  ElementUpdate,
  ExportImageParams,
  ExportImageResult,
  GetSceneParams,
  UpdateElementsParams,
  ZoomToFitParams,
} from "../../mcp-bridge/src/protocol";

// Mirrors the bridge's update schema; checked here too because the canvas
// must not trust that every caller went through the bridge's validation.
const UPDATABLE_PROPS = new Set([
  "x",
  "y",
  "width",
  "height",
  "angle",
  "text",
  "fontSize",
  "locked",
  "link",
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "opacity",
]);
const TEXT_ONLY_PROPS = new Set(["text", "fontSize"]);
const CONTAINER_LAYOUT_PROPS = new Set(["x", "y", "width", "height", "angle"]);

const round = (value: number) => Math.round(value * 100) / 100;

export const summarizeElement = (element: ExcalidrawElement) => ({
  id: element.id,
  type: element.type,
  x: round(element.x),
  y: round(element.y),
  width: round(element.width),
  height: round(element.height),
  angle: element.angle,
  strokeColor: element.strokeColor,
  backgroundColor: element.backgroundColor,
  fillStyle: element.fillStyle,
  strokeStyle: element.strokeStyle,
  strokeWidth: element.strokeWidth,
  opacity: element.opacity,
  locked: element.locked,
  link: element.link,
  groupIds: element.groupIds,
  frameId: element.frameId,
  boundElements:
    element.boundElements?.map(({ id, type }) => ({ id, type })) ?? [],
  ...(isTextElement(element) && {
    text: element.originalText,
    fontSize: element.fontSize,
    containerId: element.containerId,
  }),
  ...(isLinearElement(element) && {
    points: element.points.map(([px, py]) => [round(px), round(py)]),
    startBindingId: element.startBinding?.elementId ?? null,
    endBindingId: element.endBinding?.elementId ?? null,
  }),
  ...(isFrameLikeElement(element) && { name: element.name }),
});

const requireLiveElements = (
  api: ExcalidrawImperativeAPI,
  ids: readonly string[],
): ExcalidrawElement[] => {
  const elementsMap = api.getSceneElementsMapIncludingDeleted();
  const missing: string[] = [];
  const found: ExcalidrawElement[] = [];
  for (const id of ids) {
    const element = elementsMap.get(id);
    if (!element || element.isDeleted) {
      missing.push(id);
    } else {
      found.push(element);
    }
  }
  if (missing.length) {
    throw new Error(`No element on the canvas with id: ${missing.join(", ")}`);
  }
  return found;
};

const getScene = (api: ExcalidrawImperativeAPI, params: GetSceneParams) => {
  const elements = api.getSceneElements();
  const appState = api.getAppState();
  return {
    elements: elements.map(summarizeElement),
    ...(params.includeRaw && { raw: elements }),
    appState: {
      selectedElementIds: Object.keys(appState.selectedElementIds),
      viewBackgroundColor: appState.viewBackgroundColor,
      theme: appState.theme,
      zoom: appState.zoom.value,
      scrollX: round(appState.scrollX),
      scrollY: round(appState.scrollY),
      viewportWidth: appState.width,
      viewportHeight: appState.height,
    },
  };
};

const addElements = (
  api: ExcalidrawImperativeAPI,
  params: AddElementsParams,
) => {
  const sceneElements = api.getSceneElementsIncludingDeleted();
  const existingIds = new Set(sceneElements.map((element) => element.id));
  const collidingIds = params.elements
    .map((skeleton) => skeleton.id)
    .filter(
      (id): id is string => typeof id === "string" && existingIds.has(id),
    );
  if (collidingIds.length) {
    throw new Error(
      `Element ids already used on the canvas (ids must be unique, including deleted elements): ${collidingIds.join(
        ", ",
      )}`,
    );
  }

  // ids are kept so callers can bind arrows/frames to the ids they chose;
  // elements without an id still get a random one
  const created = convertToExcalidrawElements(
    params.elements as unknown as ExcalidrawElementSkeleton[],
    { regenerateIds: false },
  );

  api.updateScene({
    elements: [...sceneElements, ...created],
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });

  return {
    created: created.map((element) => ({
      id: element.id,
      type: element.type,
      ...(isTextElement(element) &&
        element.containerId && { containerId: element.containerId }),
    })),
  };
};

const validateUpdate = (update: ElementUpdate, element: ExcalidrawElement) => {
  const { id, ...patch } = update;
  const unknownProps = Object.keys(patch).filter(
    (prop) => !UPDATABLE_PROPS.has(prop),
  );
  if (unknownProps.length) {
    throw new Error(
      `Cannot update ${unknownProps.join(", ")} on "${id}". Updatable: ${[
        ...UPDATABLE_PROPS,
      ].join(", ")}`,
    );
  }
  const textProps = Object.keys(patch).filter((prop) =>
    TEXT_ONLY_PROPS.has(prop),
  );
  if (textProps.length && !isTextElement(element)) {
    throw new Error(
      `"${id}" is a ${element.type}; ${textProps.join(
        ", ",
      )} can only be set on text elements (update the label's own id for a shape's label)`,
    );
  }
  return patch;
};

const relayoutText = (
  text: ExcalidrawTextElement,
  elementsMap: Map<string, ExcalidrawElement>,
): ExcalidrawTextElement => {
  const container = text.containerId
    ? (elementsMap.get(text.containerId) as ExcalidrawTextContainer | undefined)
    : undefined;
  const dimensions = refreshTextDimensions(
    text,
    container ?? null,
    elementsMap,
  );
  let next = dimensions ? newElementWith(text, dimensions) : text;
  if (container && !isArrowElement(container)) {
    next = newElementWith(next, {
      ...computeBoundTextPosition(
        container,
        next as ExcalidrawTextElementWithContainer,
        elementsMap,
      ),
      angle: container.angle,
    });
  }
  return next;
};

const updateElements = (
  api: ExcalidrawImperativeAPI,
  params: UpdateElementsParams,
) => {
  const targets = requireLiveElements(
    api,
    params.updates.map((update) => update.id),
  );
  const nextById = new Map<string, ExcalidrawElement>(
    api
      .getSceneElementsIncludingDeleted()
      .map((element) => [element.id, element]),
  );
  const textsToRelayout = new Set<string>();

  params.updates.forEach((update, index) => {
    const element = targets[index];
    const patch = validateUpdate(update, element);
    const textPatch =
      typeof patch.text === "string" ? { originalText: patch.text } : {};
    nextById.set(
      element.id,
      newElementWith(element, {
        ...patch,
        ...textPatch,
      } as Partial<ExcalidrawElement>),
    );

    if (isTextElement(element)) {
      textsToRelayout.add(element.id);
    }
    // a shape's label follows its container's position, size and rotation
    const boundTextId = getBoundTextElementId(element);
    if (
      boundTextId &&
      Object.keys(patch).some((prop) => CONTAINER_LAYOUT_PROPS.has(prop))
    ) {
      textsToRelayout.add(boundTextId);
    }
  });

  for (const textId of textsToRelayout) {
    const text = nextById.get(textId);
    if (text && isTextElement(text) && !text.isDeleted) {
      nextById.set(textId, relayoutText(text, nextById));
    }
  }

  api.updateScene({
    elements: [...nextById.values()],
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });

  return { updatedIds: targets.map((element) => element.id) };
};

const markDeleted = (
  api: ExcalidrawImperativeAPI,
  elementsToDelete: readonly ExcalidrawElement[],
) => {
  const deleteIds = new Set(elementsToDelete.map((element) => element.id));
  // labels go with their shapes
  for (const element of elementsToDelete) {
    const boundTextId = getBoundTextElementId(element);
    if (boundTextId) {
      deleteIds.add(boundTextId);
    }
  }

  api.updateScene({
    elements: api
      .getSceneElementsIncludingDeleted()
      .map((element) =>
        deleteIds.has(element.id) && !element.isDeleted
          ? newElementWith(element, { isDeleted: true })
          : element,
      ),
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  return [...deleteIds];
};

const deleteElements = (
  api: ExcalidrawImperativeAPI,
  params: DeleteElementsParams,
) => ({
  deletedIds: markDeleted(api, requireLiveElements(api, params.ids)),
});

const clearScene = (api: ExcalidrawImperativeAPI) => ({
  deletedCount: markDeleted(api, api.getSceneElements()).length,
});

const zoomToFit = (api: ExcalidrawImperativeAPI, params: ZoomToFitParams) => {
  const elements = params.ids
    ? requireLiveElements(api, params.ids)
    : api.getSceneElements();
  if (!elements.length) {
    throw new Error("The canvas is empty; there is nothing to zoom to");
  }
  api.setViewport({ target: elements, fit: "scale-down", animation: true });
  return { fittedElementCount: elements.length };
};

const blobToBase64 = async (blob: Blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  // chunked so large images don't exceed the argument limit of fromCharCode
  const CHUNK = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
};

const exportImage = async (
  api: ExcalidrawImperativeAPI,
  params: ExportImageParams,
): Promise<ExportImageResult> => {
  const elements: readonly NonDeletedExcalidrawElement[] = params.ids
    ? (requireLiveElements(api, params.ids) as NonDeletedExcalidrawElement[])
    : api.getSceneElements();
  if (!elements.length) {
    throw new Error("The canvas is empty; there is nothing to export");
  }

  const data = {
    elements,
    appState: cleanAppStateForExport(api.getAppState()),
    files: api.getFiles(),
  };
  const config = {
    theme: params.darkMode ? THEME.DARK : THEME.LIGHT,
    // `false` = transparent; undefined = the scene's background color
    canvasBackgroundColor:
      params.withBackground === false ? (false as const) : undefined,
    padding: params.padding,
    scale: params.scale,
  };

  if (params.format === "svg") {
    const svg = await exportScene({ type: "svg", data, config });
    return { format: "svg", mimeType: "image/svg+xml", svg: svg.outerHTML };
  }
  const blob = await exportScene({ type: "png", data, config });
  return {
    format: "png",
    mimeType: "image/png",
    base64: await blobToBase64(blob),
  };
};

/** Runs one bridge request against the editor and returns its JSON result. */
export const runCanvasCommand = async (
  api: ExcalidrawImperativeAPI,
  request: BridgeRequest,
): Promise<unknown> => {
  switch (request.method) {
    case "getScene":
      return getScene(api, request.params);
    case "addElements":
      return addElements(api, request.params);
    case "updateElements":
      return updateElements(api, request.params);
    case "deleteElements":
      return deleteElements(api, request.params);
    case "clearScene":
      return clearScene(api);
    case "zoomToFit":
      return zoomToFit(api, request.params);
    case "exportImage":
      return exportImage(api, request.params);
    default: {
      const unknownRequest: never = request;
      throw new Error(
        `Unknown canvas method: ${JSON.stringify(unknownRequest)}`,
      );
    }
  }
};
