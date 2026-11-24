/**
 * `image_view` (docs/feat/image-view.md D5): the model looks at ONE picture a
 * read kept for it. `fs_read` stores a PDF's pictures in the session's store
 * and leaves `[image p.N · W×H · ref <12 hex>]` in the text; this tool picks
 * that picture's `low` (≤ 768 px) or `high` (≤ 1568 px) variant and returns
 * it as the result's single `image` ref. It never reads a byte: the provider
 * does that, once, verified against the id.
 */
import {
  type AttachmentRef,
  type ChatMessage,
  IMAGE_VIEW_TOOL_NAME,
  type ImageDetailSetting,
  TOOL_IMAGE_LOW_EDGE,
  type Tool,
  type ToolContext,
  type ToolImageEntry,
  type ToolImageStore,
  type ToolImageVariant,
  type ToolResult,
  attachmentLabel,
  formatBytes,
  imageRefPrefix,
} from "@tentacle/core";
import { z } from "zod";
// The sentinel of the old-image placeholder (docs/feat/image-old-on-demand.md
// D1), from the ONE constant: the literal never appears in source.
import { PRUNE_SENTINEL } from "./builtins.ts";

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

const DESCRIPTION = `Look at ONE picture a read kept for you: pass the ref from an \`[image p.N · W×H · ref <hex>]\` marker (fs_read of a PDF), from an \`[image <name> · W×H · <format> · ref <hex> · high only]\` marker (fs_read of a PNG/JPEG file), or from a \`${PRUNE_SENTINEL}: image …⟫\` line (a picture the user attached earlier). Use it when a picture matters to the answer (a diagram, a chart, a scanned page); skip logos and decorations. One image per call.`;

const REGENERATE = "fs_read the file again, or ask the user to attach it again";

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

/** `low` asks for a variant a user's own upload never had (docs/feat/image-old-on-demand.md D3). */
const NO_LOW_VARIANT_NOTE = " · no low variant for a user image — sent as attached";

/** A user message's ref, when `prefix` names exactly one of them in this conversation. */
type UserImageHit =
  | { readonly kind: "none" }
  | { readonly kind: "one"; readonly ref: AttachmentRef }
  | { readonly kind: "many"; readonly labels: readonly string[] };

/**
 * The conversation's OWN user images (docs/feat/image-old-on-demand.md D3): the
 * refs on `ctx.history`'s user messages, found by id prefix. Read-only, and only
 * over already-validated refs — a store upload this conversation never carried
 * stays unreachable.
 */
function userImage(history: readonly ChatMessage[] | undefined, prefix: string): UserImageHit {
  const hits = new Map<string, AttachmentRef>();
  for (const message of history ?? []) {
    if (message.role !== "user") {
      continue;
    }
    for (const ref of message.attachments ?? []) {
      if (ref.id.startsWith(prefix)) {
        hits.set(ref.id, ref);
      }
    }
  }
  if (hits.size === 0) {
    return { kind: "none" };
  }
  const [only] = [...hits.values()];
  if (hits.size === 1 && only !== undefined) {
    return { kind: "one", ref: only };
  }
  return { kind: "many", labels: [...hits.values()].map(attachmentLabel) };
}
const HIGH_ONLY_NOTE = " · low is not available for this image yet — sent at high";

/**
 * What to say about the variant choice (docs/feat/image-files.md D4). A picture
 * with `low === high` is either genuinely ≤ `TOOL_IMAGE_LOW_EDGE` (the label
 * "already ≤ 768 px" is then TRUE) or an image file read at `high` only — and
 * calling THAT "already ≤ 768 px" would be a lie.
 */
function highOnly(entry: ToolImageEntry): boolean {
  return (
    entry.low.ref.id === entry.high.ref.id &&
    Math.max(entry.high.width, entry.high.height) > TOOL_IMAGE_LOW_EDGE
  );
}

/**
 * A user's own picture (docs/feat/image-old-on-demand.md D3): no variant exists
 * — user uploads are never downscaled — so `detail` is ignored with a note, and
 * the ref is served as attached. Re-reads nothing: the provider inlines it.
 */
function viewUserImage(
  prefix: string,
  ref: AttachmentRef,
  asked: "low" | "high" | undefined,
  setting: ImageDetailSetting,
  store: ToolImageStore,
): ToolResult {
  if (!store.holds(ref)) {
    return {
      content: `image ${prefix} (${attachmentLabel(ref)}) is no longer held — ask the user to attach it again`,
      isError: true,
    };
  }
  const forced = setting !== "auto";
  // Only an EXPLICIT low asks for a variant a user image never had; the default
  // (no `detail`) is not a request for one, and "sent as attached" already says
  // what the caller gets.
  const note = forced || asked === "low" ? NO_LOW_VARIANT_NOTE : "";
  return {
    content: `${attachmentLabel(ref)} · ${formatBytes(ref.size)} · attached by the user · sent as attached${note}`,
    image: ref,
  };
}

/** The tool's decision, pure over the store (exported for the tests). */
export function viewImage(
  input: ImageViewInput,
  ctx: Pick<ToolContext, "images" | "history">,
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
  const { prefix } = parsed;
  const found = store.resolve(prefix);
  if (found.kind === "ambiguous") {
    return {
      content: `${prefix} names ${found.labels.length} images (${found.labels.join(", ")}) — pass more hex characters of the ref`,
      isError: true,
    };
  }
  if (found.kind === "none") {
    // Not a picture a read kept: maybe the user's own, aged out of the request
    // by the old-image projection — its placeholder carries this ref.
    const user = userImage(ctx.history, prefix);
    if (user.kind === "many") {
      return {
        content: `${prefix} names ${user.labels.length} images (${user.labels.join(", ")}) — pass more hex characters of the ref`,
        isError: true,
      };
    }
    if (user.kind === "one") {
      return viewUserImage(prefix, user.ref, input.detail, setting, store);
    }
    return { content: `no image ${prefix} in this session — ${REGENERATE}`, isError: true };
  }
  const forced = setting !== "auto";
  const detail = forced ? setting : (input.detail ?? "low");
  const { entry } = found;
  const variant: ToolImageVariant = detail === "high" ? entry.high : entry.low;
  if (!store.holds(variant.ref)) {
    return {
      content: `image ${prefix} (${entry.label}) is no longer held — ${REGENERATE}`,
      isError: true,
    };
  }
  const same = highOnly(entry)
    ? HIGH_ONLY_NOTE
    : entry.low.ref.id === entry.high.ref.id
      ? ` · already ≤ ${TOOL_IMAGE_LOW_EDGE} px`
      : "";
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
