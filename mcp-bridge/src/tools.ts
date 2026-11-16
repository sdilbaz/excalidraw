import { writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { summarizeEgress } from "./egressSummary.ts";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { CanvasHub } from "./canvasHub.ts";
import type { ExportImageResult } from "./protocol.ts";

const SKELETON_TYPES = [
  "rectangle",
  "ellipse",
  "diamond",
  "text",
  "arrow",
  "line",
  "frame",
  "stickynote",
] as const;

const BINDABLE_TYPES = ["rectangle", "ellipse", "diamond", "text"] as const;

const styleShape = {
  strokeColor: z.string().optional().describe("CSS color, e.g. #1e1e1e"),
  backgroundColor: z.string().optional().describe("CSS color or 'transparent'"),
  fillStyle: z.enum(["hachure", "cross-hatch", "solid", "zigzag"]).optional(),
  strokeWidth: z.number().positive().optional(),
  strokeStyle: z.enum(["solid", "dashed", "dotted"]).optional(),
  roughness: z
    .number()
    .min(0)
    .max(2)
    .optional()
    .describe("0 = architect, 1 = artist, 2 = cartoonist"),
  opacity: z.number().min(0).max(100).optional(),
};

const labelSchema = z.looseObject({
  text: z.string(),
  fontSize: z.number().positive().optional(),
  textAlign: z.enum(["left", "center", "right"]).optional(),
  verticalAlign: z.enum(["top", "middle", "bottom"]).optional(),
});

const arrowEndSchema = z
  .looseObject({
    id: z
      .string()
      .optional()
      .describe("id of a shape created in the same add_elements call"),
    type: z
      .enum(BINDABLE_TYPES)
      .optional()
      .describe("create a new shape of this type at this end"),
    text: z.string().optional().describe("text, when type is 'text'"),
  })
  .describe(
    "Bind this arrow end to a shape, either by id (same call only) or by creating a new shape",
  );

const skeletonSchema = z
  .looseObject({
    type: z.enum(SKELETON_TYPES),
    id: z
      .string()
      .optional()
      .describe(
        "Optional id. Set it to reference this element from arrow start/end or frame children in the same call.",
      ),
    x: z
      .number()
      .optional()
      .describe("Scene x. Required unless type is frame."),
    y: z
      .number()
      .optional()
      .describe("Scene y. Required unless type is frame."),
    width: z.number().optional(),
    height: z.number().optional(),
    angle: z.number().optional().describe("radians"),
    text: z.string().optional().describe("Required when type is 'text'"),
    fontSize: z.number().positive().optional(),
    label: labelSchema
      .optional()
      .describe("Text centered inside a shape or on an arrow"),
    start: arrowEndSchema.optional(),
    end: arrowEndSchema.optional(),
    points: z
      .array(z.tuple([z.number(), z.number()]))
      .optional()
      .describe(
        "Arrow/line points relative to x,y; first point is [0,0]. Defaults to a 100px horizontal segment.",
      ),
    children: z
      .array(z.string())
      .optional()
      .describe("Frame only: ids of elements (in this call) inside the frame"),
    name: z.string().optional().describe("Frame only: frame title"),
    ...styleShape,
  })
  .superRefine((element, ctx) => {
    if (element.type !== "frame") {
      if (element.x === undefined || element.y === undefined) {
        ctx.addIssue({
          code: "custom",
          message: `${element.type} elements need x and y`,
        });
      }
    } else if (!element.children) {
      ctx.addIssue({ code: "custom", message: "frames need children" });
    }
    if (element.type === "text" && element.text === undefined) {
      ctx.addIssue({ code: "custom", message: "text elements need text" });
    }
  });

const updateSchema = z.strictObject({
  id: z.string(),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  angle: z.number().optional(),
  text: z
    .string()
    .optional()
    .describe(
      "Text elements only (for a shape's label, update the label's id)",
    ),
  fontSize: z.number().positive().optional(),
  locked: z.boolean().optional(),
  link: z.string().nullable().optional(),
  ...styleShape,
});

const jsonResult = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});

export const createMcpServer = (hub: CanvasHub): McpServer => {
  const server = new McpServer({
    name: "excalidraw-local",
    version: "0.1.0",
  });

  server.registerTool(
    "get_scene",
    {
      title: "Read the canvas",
      description:
        "Returns the non-deleted elements on the local Excalidraw canvas (simplified: id, type, position, size, text, bindings, style) plus the current selection and viewport. Set includeRaw for the full element JSON.",
      inputSchema: {
        includeRaw: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ includeRaw }) =>
      jsonResult(await hub.request("getScene", { includeRaw })),
  );

  server.registerTool(
    "add_elements",
    {
      title: "Add elements",
      description:
        "Adds shapes, text, arrows, lines, sticky notes and frames to the canvas as one undoable step. Use `label` for text inside a shape or on an arrow. Arrows bind to shapes through start/end, which can only reference ids created in the same call. Binding does not route the arrow: place x,y on the start shape's edge and give `points` ending on the target's edge (e.g. a downward arrow: points [[0,0],[0,120]]); without points an arrow is a 100px horizontal stub. Ids you set must be new to the canvas, including ids of deleted elements (deleted elements are kept for undo, e.g. after clear_scene). Returns the created element ids, including generated label ids.",
      inputSchema: {
        elements: z.array(skeletonSchema).min(1),
      },
    },
    async ({ elements }) =>
      jsonResult(await hub.request("addElements", { elements })),
  );

  server.registerTool(
    "update_elements",
    {
      title: "Update elements",
      description:
        "Changes position, size, style, text or lock state of existing elements by id, as one undoable step. Moving a shape moves its label too; arrows bound to it are not re-routed. Unknown ids are an error.",
      inputSchema: {
        updates: z.array(updateSchema).min(1),
      },
    },
    async ({ updates }) =>
      jsonResult(await hub.request("updateElements", { updates })),
  );

  server.registerTool(
    "delete_elements",
    {
      title: "Delete elements",
      description:
        "Deletes elements by id (with their labels) as one undoable step. Unknown ids are an error.",
      inputSchema: {
        ids: z.array(z.string()).min(1),
      },
      annotations: { destructiveHint: true },
    },
    async ({ ids }) => jsonResult(await hub.request("deleteElements", { ids })),
  );

  server.registerTool(
    "clear_scene",
    {
      title: "Clear the canvas",
      description:
        "Deletes every element on the canvas as one undoable step (Ctrl/Cmd+Z in the app restores it).",
      inputSchema: {},
      annotations: { destructiveHint: true },
    },
    async () => jsonResult(await hub.request("clearScene", {})),
  );

  server.registerTool(
    "zoom_to_fit",
    {
      title: "Zoom to fit",
      description:
        "Scrolls and zooms the app's viewport to show the given elements, or everything when ids is omitted.",
      inputSchema: {
        ids: z.array(z.string()).min(1).optional(),
      },
    },
    async ({ ids }) => jsonResult(await hub.request("zoomToFit", { ids })),
  );

  server.registerTool(
    "export_image",
    {
      title: "Export image",
      description:
        "Renders the canvas (or the given elements) to PNG or SVG inside the local app. Returns the image, or writes it to outputPath (absolute) when given.",
      inputSchema: {
        format: z.enum(["png", "svg"]),
        ids: z.array(z.string()).min(1).optional(),
        withBackground: z.boolean().optional().describe("default true"),
        darkMode: z.boolean().optional(),
        scale: z.number().positive().max(4).optional(),
        padding: z.number().min(0).optional(),
        outputPath: z
          .string()
          .refine(isAbsolute, "outputPath must be an absolute path")
          .optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ outputPath, ...params }): Promise<CallToolResult> => {
      const image = (await hub.request(
        "exportImage",
        params,
      )) as ExportImageResult;

      if (outputPath) {
        const bytes =
          image.format === "png"
            ? Buffer.from(image.base64, "base64")
            : Buffer.from(image.svg, "utf8");
        await writeFile(outputPath, bytes);
        return jsonResult({
          outputPath,
          format: image.format,
          bytes: bytes.length,
        });
      }

      if (image.format === "png") {
        return {
          content: [
            { type: "image", data: image.base64, mimeType: image.mimeType },
          ],
        };
      }
      return { content: [{ type: "text", text: image.svg }] };
    },
  );

  server.registerTool(
    "bridge_status",
    {
      title: "Bridge status",
      description:
        "Shows whether an app tab is connected and summarizes outbound (non-local) requests the app tab attempted, per the dev-only egress watcher. `egress.summary.possiblyUnblockedUrls` lists requests that may have reached the network; it should be empty.",
      inputSchema: {
        recentEventCount: z
          .number()
          .int()
          .min(0)
          .max(500)
          .optional()
          .describe(
            "how many of the latest raw events to include (default 20)",
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ recentEventCount = 20 }) => {
      const events = hub.getEgressEvents();
      return jsonResult({
        canvas: hub.status(),
        egress: {
          summary: summarizeEgress(events),
          recentEvents: recentEventCount ? events.slice(-recentEventCount) : [],
        },
      });
    },
  );

  return server;
};
