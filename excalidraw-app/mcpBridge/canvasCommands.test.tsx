import React from "react";

import { resolvablePromise } from "@excalidraw/common";
import { Excalidraw } from "@excalidraw/excalidraw";
import { act, render } from "@excalidraw/excalidraw/tests/test-utils";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawArrowElement,
  ExcalidrawElement,
  ExcalidrawTextElement,
} from "@excalidraw/element/types";

import { runCanvasCommand } from "./canvasCommands";

import type {
  BridgeRequest,
  CanvasMethod,
  CanvasParamsByMethod,
} from "../../mcp-bridge/src/protocol";

const { h } = window;

let api: ExcalidrawImperativeAPI;

const run = async <M extends CanvasMethod>(
  method: M,
  params: CanvasParamsByMethod[M],
) => {
  let result: unknown;
  await act(async () => {
    result = await runCanvasCommand(api, {
      type: "request",
      id: "test",
      method,
      params,
    } as BridgeRequest);
  });
  return result as any;
};

const live = (id: string) => {
  const element = api.getSceneElementsMapIncludingDeleted().get(id);
  if (!element) {
    throw new Error(`test setup: no element ${id}`);
  }
  return element;
};

const labelOf = (containerId: string) => {
  const label = api
    .getSceneElements()
    .find(
      (element) =>
        element.type === "text" && element.containerId === containerId,
    );
  if (!label) {
    throw new Error(`test setup: no label in ${containerId}`);
  }
  return label as ExcalidrawTextElement;
};

const addBoxesWithArrow = () =>
  run("addElements", {
    elements: [
      {
        type: "rectangle",
        id: "box-a",
        x: 0,
        y: 0,
        width: 200,
        height: 100,
        label: { text: "API" },
      },
      {
        type: "ellipse",
        id: "box-b",
        x: 400,
        y: 0,
        width: 160,
        height: 100,
        backgroundColor: "#a5d8ff",
        fillStyle: "solid",
      },
      {
        type: "arrow",
        id: "a-to-b",
        x: 200,
        y: 50,
        start: { id: "box-a" },
        end: { id: "box-b" },
        label: { text: "calls" },
      },
    ],
  });

describe("runCanvasCommand", () => {
  beforeEach(async () => {
    const apiPromise = resolvablePromise<ExcalidrawImperativeAPI>();
    await render(
      <Excalidraw
        onExcalidrawAPI={(value) => {
          if (value) {
            apiPromise.resolve(value);
          }
        }}
      />,
    );
    api = await apiPromise;
  });

  describe("addElements", () => {
    it("creates shapes, labels and a bound arrow with the given ids", async () => {
      const result = await addBoxesWithArrow();

      const createdIds = result.created.map(
        (element: { id: string }) => element.id,
      );
      expect(createdIds).toEqual(
        expect.arrayContaining(["box-a", "box-b", "a-to-b"]),
      );
      // two labels: the rectangle's and the arrow's
      expect(
        result.created.filter(
          (element: { containerId?: string }) => element.containerId,
        ),
      ).toHaveLength(2);

      const arrow = live("a-to-b") as ExcalidrawArrowElement;
      expect(arrow.startBinding?.elementId).toBe("box-a");
      expect(arrow.endBinding?.elementId).toBe("box-b");
      expect(labelOf("box-a").originalText).toBe("API");
      expect(live("box-b").backgroundColor).toBe("#a5d8ff");
    });

    it("adds to existing elements instead of replacing them", async () => {
      await run("addElements", {
        elements: [{ type: "rectangle", id: "first", x: 0, y: 0 }],
      });
      await run("addElements", {
        elements: [{ type: "text", id: "second", x: 0, y: 200, text: "hi" }],
      });

      expect(api.getSceneElements().map((element) => element.id)).toEqual([
        "first",
        "second",
      ]);
    });

    it("is one undoable step", async () => {
      await addBoxesWithArrow();
      const elementCount = api.getSceneElements().length;
      expect(elementCount).toBeGreaterThan(3);

      await act(async () => {
        h.app.actionManager.executeAction(
          h.app.actionManager.actions.undo,
          "api",
        );
      });

      expect(api.getSceneElements()).toHaveLength(0);
    });

    it.each([
      ["an id already on the canvas", "taken"],
      ["the id of a deleted element", "deleted-one"],
    ])("rejects %s", async (_, id) => {
      await run("addElements", {
        elements: [
          { type: "rectangle", id: "taken", x: 0, y: 0 },
          { type: "rectangle", id: "deleted-one", x: 0, y: 0 },
        ],
      });
      await run("deleteElements", { ids: ["deleted-one"] });

      await expect(
        run("addElements", { elements: [{ type: "ellipse", id, x: 1, y: 1 }] }),
      ).rejects.toThrow(/already used on the canvas/);
    });
  });

  describe("getScene", () => {
    it("summarizes elements, bindings and the viewport", async () => {
      await addBoxesWithArrow();

      const scene = await run("getScene", {});

      const box = scene.elements.find(
        (element: ExcalidrawElement) => element.id === "box-a",
      );
      expect(box).toMatchObject({
        type: "rectangle",
        x: 0,
        y: 0,
        width: 200,
        height: 100,
      });
      expect(box.boundElements).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "text" })]),
      );
      const arrow = scene.elements.find(
        (element: ExcalidrawElement) => element.id === "a-to-b",
      );
      expect(arrow).toMatchObject({
        startBindingId: "box-a",
        endBindingId: "box-b",
      });
      expect(scene.raw).toBeUndefined();
      expect(scene.appState).toMatchObject({
        selectedElementIds: [],
        zoom: 1,
      });
    });

    it("includes full element JSON when includeRaw is set", async () => {
      await run("addElements", {
        elements: [{ type: "rectangle", id: "r", x: 0, y: 0 }],
      });

      const scene = await run("getScene", { includeRaw: true });

      expect(scene.raw[0]).toMatchObject({
        id: "r",
        version: expect.any(Number),
      });
    });

    it("leaves deleted elements out", async () => {
      await addBoxesWithArrow();
      await run("deleteElements", { ids: ["box-b"] });

      const scene = await run("getScene", {});

      expect(
        scene.elements.map((element: ExcalidrawElement) => element.id),
      ).not.toContain("box-b");
    });
  });

  describe("updateElements", () => {
    it("moves a shape and keeps its label inside it", async () => {
      await addBoxesWithArrow();
      const labelBefore = labelOf("box-a");

      await run("updateElements", {
        updates: [{ id: "box-a", x: 100, y: 300 }],
      });

      const labelAfter = labelOf("box-a");
      expect(live("box-a")).toMatchObject({ x: 100, y: 300 });
      expect(labelAfter.x - labelBefore.x).toBeCloseTo(100);
      expect(labelAfter.y - labelBefore.y).toBeCloseTo(300);
    });

    it("re-centres the label when the shape is resized", async () => {
      await addBoxesWithArrow();

      await run("updateElements", {
        updates: [{ id: "box-a", width: 400, height: 300 }],
      });

      const label = labelOf("box-a");
      const labelCentreX = label.x + label.width / 2;
      const labelCentreY = label.y + label.height / 2;
      expect(labelCentreX).toBeCloseTo(200, 0);
      expect(labelCentreY).toBeCloseTo(150, 0);
    });

    it("changes text and re-measures it", async () => {
      await run("addElements", {
        elements: [{ type: "text", id: "t", x: 0, y: 0, text: "hi" }],
      });
      const widthBefore = live("t").width;

      await run("updateElements", {
        updates: [{ id: "t", text: "a much longer piece of text" }],
      });

      const text = live("t") as ExcalidrawTextElement;
      expect(text.originalText).toBe("a much longer piece of text");
      expect(text.text).toBe("a much longer piece of text");
      expect(text.width).toBeGreaterThan(widthBefore);
    });

    it("applies style changes to several elements in one step", async () => {
      await addBoxesWithArrow();

      await run("updateElements", {
        updates: [
          { id: "box-a", strokeColor: "#e03131", strokeStyle: "dashed" },
          { id: "box-b", opacity: 50, locked: true },
        ],
      });

      expect(live("box-a")).toMatchObject({
        strokeColor: "#e03131",
        strokeStyle: "dashed",
      });
      expect(live("box-b")).toMatchObject({ opacity: 50, locked: true });
    });

    it.each([
      [
        "an unknown id",
        [{ id: "missing", x: 1 }],
        /No element on the canvas with id: missing/,
      ],
      [
        "a property that can't be updated",
        [{ id: "box-a", isDeleted: true }],
        /Cannot update isDeleted/,
      ],
      [
        "text on a shape",
        [{ id: "box-a", text: "nope" }],
        /can only be set on text elements/,
      ],
    ])("rejects %s and changes nothing", async (_, updates, message) => {
      await addBoxesWithArrow();
      const before = api.getSceneElementsIncludingDeleted();

      await expect(run("updateElements", { updates })).rejects.toThrow(message);

      expect(api.getSceneElementsIncludingDeleted()).toEqual(before);
    });
  });

  describe("deleteElements / clearScene", () => {
    it("deletes a shape together with its label", async () => {
      await addBoxesWithArrow();
      const labelId = labelOf("box-a").id;

      const result = await run("deleteElements", { ids: ["box-a"] });

      expect(result.deletedIds).toEqual(["box-a", labelId]);
      expect(live("box-a").isDeleted).toBe(true);
      expect(live(labelId).isDeleted).toBe(true);
    });

    it("rejects unknown and already deleted ids", async () => {
      await addBoxesWithArrow();
      await run("deleteElements", { ids: ["box-b"] });

      await expect(
        run("deleteElements", { ids: ["box-a", "box-b", "ghost"] }),
      ).rejects.toThrow(/No element on the canvas with id: box-b, ghost/);
      expect(live("box-a").isDeleted).toBe(false);
    });

    it("clears every element", async () => {
      await addBoxesWithArrow();
      const count = api.getSceneElements().length;

      const result = await run("clearScene", {});

      expect(result.deletedCount).toBe(count);
      expect(api.getSceneElements()).toHaveLength(0);
    });
  });

  describe("zoomToFit", () => {
    it("fits all elements, or the given ones", async () => {
      await addBoxesWithArrow();

      expect(await run("zoomToFit", {})).toEqual({
        fittedElementCount: api.getSceneElements().length,
      });
      expect(await run("zoomToFit", { ids: ["box-a"] })).toEqual({
        fittedElementCount: 1,
      });
    });

    it("rejects an empty canvas", async () => {
      await expect(run("zoomToFit", {})).rejects.toThrow(/canvas is empty/);
    });
  });

  describe("exportImage", () => {
    it("exports the scene as SVG", async () => {
      await addBoxesWithArrow();

      const result = await run("exportImage", { format: "svg" });

      expect(result.format).toBe("svg");
      expect(result.mimeType).toBe("image/svg+xml");
      expect(result.svg).toMatch(/^<svg/);
    });

    it("exports only the given elements", async () => {
      await addBoxesWithArrow();

      const all = await run("exportImage", { format: "svg" });
      const one = await run("exportImage", { format: "svg", ids: ["box-b"] });

      expect(one.svg.length).toBeLessThan(all.svg.length);
    });

    it("rejects an empty canvas", async () => {
      await expect(run("exportImage", { format: "svg" })).rejects.toThrow(
        /canvas is empty/,
      );
    });
  });
});
