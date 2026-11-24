/**
 * `image_view` (docs/feat/image-view.md D5): the model looks at ONE picture a
 * read kept for it. `fs_read` stores a PDF's pictures in the session's store
 * and leaves `[image p.N · W×H · ref <12 hex>]` in the text; this tool picks
 * that picture's `low` (≤ 768 px) or `high` (≤ 1568 px) variant and returns
 * it as the result's single `image` ref. It never reads a byte: the provider
 * does that, once, verified against the id.
 */
import {
  IMAGE_VIEW_TOOL_NAME,
  type ImageDetailSetting,
  TOOL_IMAGE_LOW_EDGE,
  type Tool,
  type ToolContext,
  type ToolImageVariant,
  type ToolResult,
  formatBytes,
  imageRefPrefix,
} from "@tentacle/core";
import { z } from "zod";

/** The ref a marker shows: hex, `sha256:` allowed — bounded, so an ask has nothing long to cut. */
const refField = z
  .string()
  .max(71)
  .regex(/^(sha256:)?[0-9a-fA-F]+$/)
  .describe("The 12 hex characters after `ref` in an [image …] marker of a read.");

const detailField = z
  .enum(["low", "high"])
  .optional()
  .describe(
    '"low" (default, ≤ 768 px) for a picture\'s overall content; "high" (≤ 1568 px) for small text, dense tables or fine detail.',
  );

export type ImageViewInput = { readonly ref: string; readonly detail?: "low" | "high" };

const DESCRIPTION =
  "Look at ONE picture a read kept for you: pass the ref from an `[image p.N · W×H · ref <hex>]` marker (fs_read of a PDF). Use it when a picture matters to the answer (a diagram, a chart, a scanned page); skip logos and decorations. One image per call.";

const REGENERATE = "fs_read the file again (same pages) to get a fresh ref";

/**
 * The tool, its schema shaped by `model.imageDetail` (D6): `auto` offers
 * `detail`; a forced `low`/`high` offers no choice, and a stale `detail` in a
 * call is ignored with one note.
 */
export function createImageViewTool(setting: ImageDetailSetting = "auto"): Tool<ImageViewInput> {
  // Forced: `detail` is not advertised, but a stale one (a model that
  // remembers the option) passes through to be ignored with a note.
  const inputSchema =
    setting === "auto"
      ? z.object({ ref: refField, detail: detailField })
      : z.object({ ref: refField }).passthrough();
  return {
    name: IMAGE_VIEW_TOOL_NAME,
    description:
      setting === "auto"
        ? DESCRIPTION
        : `${DESCRIPTION} Pictures are sent at ${setting} detail (a setting).`,
    inputSchema: inputSchema as unknown as z.ZodType<ImageViewInput>,
    permission: "none",
    // Reads the store's index only: any number of views run together.
    concurrency: () => [{ mode: "read", resource: "tool-images" }],
    async execute(input, ctx): Promise<ToolResult> {
      return viewImage(input, ctx, setting);
    },
  };
}

/** The tool's decision, pure over the store (exported for the tests). */
export function viewImage(
  input: ImageViewInput,
  ctx: Pick<ToolContext, "images">,
  setting: ImageDetailSetting,
): ToolResult {
  const store = ctx.images;
  if (store === undefined) {
    return { content: "image_view is not available in this session", isError: true };
  }
  const parsed = imageRefPrefix(input.ref);
  if ("refused" in parsed) {
    return { content: parsed.refused, isError: true };
  }
  const found = store.resolve(parsed.prefix);
  if (found.kind === "none") {
    return { content: `no image ${parsed.prefix} in this session — ${REGENERATE}`, isError: true };
  }
  if (found.kind === "ambiguous") {
    return {
      content: `${parsed.prefix} names ${found.labels.length} images (${found.labels.join(", ")}) — pass more hex characters of the ref`,
      isError: true,
    };
  }
  const forced = setting !== "auto";
  const detail = forced ? setting : (input.detail ?? "low");
  const { entry } = found;
  const variant: ToolImageVariant = detail === "high" ? entry.high : entry.low;
  if (!store.holds(variant.ref)) {
    return {
      content: `image ${parsed.prefix} (${entry.label}) is no longer held — ${REGENERATE}`,
      isError: true,
    };
  }
  const same =
    entry.low.ref.id === entry.high.ref.id ? ` · already ≤ ${TOOL_IMAGE_LOW_EDGE} px` : "";
  const stale: unknown = input.detail;
  const note =
    forced && stale !== undefined && stale !== setting
      ? ` · detail is set to ${setting} (a setting); the call's detail was ignored`
      : "";
  return {
    content: `${entry.label} · ${variant.width}×${variant.height} · ${detail} · ${formatBytes(variant.ref.size)}${same}${note}`,
    image: variant.ref,
  };
}
