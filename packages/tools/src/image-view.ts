/**
 * `image_view` (docs/feat/image-view.md D5): the model looks at ONE picture a
 * read kept for it. `fs_read` stores a PDF's pictures in the session's store
 * and leaves `[image p.N · W×H · ref <12 hex>]` in the text; this tool picks
 * that picture's `low` (≤ 768 px) or `high` (≤ 1568 px) variant and returns
 * it as the result's single `image` ref, reading no byte: the provider does
 * that, once, verified against the id.
 *
 * Two calls DO read (docs/feat/image-region-png.md D4/D5): a `region` of a
 * PNG, and `low` of a PNG kept at `high` only. They decode the picture here,
 * on the side that holds the store, and keep the result as a new one.
 */
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { deflateSync, inflate } from "node:zlib";
import {
  type AttachmentRef,
  type ChatMessage,
  DEFAULT_PDF_IMAGE_LIMITS,
  IMAGE_VIEW_TOOL_NAME,
  type ImageDetailSetting,
  type ImageRegion,
  type Inflate,
  MAX_IMAGE_BYTES,
  TOOL_IMAGE_LOW_EDGE,
  type Tool,
  type ToolContext,
  type ToolImageEntry,
  type ToolImageStore,
  type ToolImageVariant,
  type ToolResult,
  attachmentLabel,
  decodePng,
  formatBytes,
  imageRefPrefix,
  readPngHeader,
  regionBox,
  renderRegion,
  sanitizeAttachmentName,
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

const fraction = z.number().max(1);

const regionField = z
  .object({
    left: fraction.min(0),
    top: fraction.min(0),
    width: fraction.positive(),
    height: fraction.positive(),
  })
  .optional()
  .describe("A part of a PNG picture to zoom into, each number a fraction 0–1 of its size.");

export type ImageViewInput = {
  readonly ref: string;
  readonly detail?: "low" | "high";
  readonly region?: ImageRegion;
};

const DESCRIPTION = `Look at ONE picture a read kept for you: pass the ref from an \`[image p.N · W×H · ref <hex>]\` marker (fs_read of a PDF), from an \`[image <name> · W×H · <format> · ref <hex> · high only]\` marker (fs_read of a PNG/JPEG file), or from a \`${PRUNE_SENTINEL}: image …⟫\` line (a picture the user attached earlier). Use it when a picture matters to the answer (a diagram, a chart, a scanned page); skip logos and decorations. One image per call. \`region\` zooms into part of a PNG picture: fractions 0–1 of its size, e.g. \`{left:0.5, top:0, width:0.5, height:0.5}\` = the top-right quarter; the part is sent at up to the detail's size, never enlarged.`;

const REGENERATE = "fs_read the file again, or ask the user to attach it again";

/** `node:zlib`, bound here: `@tentacle/core` stays `node:`-free. Inflate runs off the JS thread. */
const inflateAsync = promisify(inflate);
/** A `Buffer` as the plain bytes it is: a view, never a copy (these are the big buffers). */
const bytesOf = (b: Buffer): Uint8Array => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
const inflatePng: Inflate = async (bytes, maxOutputLength) =>
  bytesOf(await inflateAsync(bytes, { maxOutputLength }));

/** Runs one job after the other; a failed job does not stop the next. */
type Slot = <T>(job: () => Promise<T>) => Promise<T>;

function oneAtATime(): Slot {
  let last: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const run = last.then(job);
    last = run.catch(() => undefined);
    return run;
  };
}

export interface ImageViewOptions {
  /** The model's per-image byte cap: what a decoded picture is re-encoded under. */
  readonly maxImageBytes?: number;
}

/**
 * The tool, its schema shaped by `model.imageDetail` (D6): `auto` offers
 * `detail`; a forced `low`/`high` offers no choice, and a stale `detail` in a
 * call is ignored with one note.
 */
export function createImageViewTool(
  setting: ImageDetailSetting = "auto",
  options: ImageViewOptions = {},
): Tool<ImageViewInput> {
  // Forced: `detail` is not advertised, but a stale one (a model that
  // remembers the option) passes through to be ignored with a note.
  const inputSchema =
    setting === "auto"
      ? z.object({ ref: refField, detail: detailField, region: regionField })
      : z.object({ ref: refField, region: regionField }).passthrough();
  const maxBytes = Math.min(options.maxImageBytes ?? MAX_IMAGE_BYTES, MAX_IMAGE_BYTES);
  // A decode may hold `MAX_PNG_DECODE_BYTES`: one at a time. `concurrency`
  // below keeps a region alone in its batch; this also covers D5's `low`, which
  // the input alone cannot tell apart from a view that reads nothing.
  const slot = oneAtATime();
  return {
    name: IMAGE_VIEW_TOOL_NAME,
    description:
      setting === "auto"
        ? DESCRIPTION
        : `${DESCRIPTION} Pictures are sent at ${setting} detail (a setting).`,
    inputSchema: inputSchema as unknown as z.ZodType<ImageViewInput>,
    permission: "none",
    // A plain view reads the store's index only: any number run together. A
    // region also claims the one decode slot.
    concurrency: (input) =>
      (input as Partial<ImageViewInput> | null | undefined)?.region === undefined
        ? [{ mode: "read", resource: "tool-images" }]
        : [
            { mode: "read", resource: "tool-images" },
            { mode: "write", resource: "image-decode" },
          ],
    async execute(input, ctx): Promise<ToolResult> {
      const call = pickPicture(input, ctx, setting);
      if (call.kind !== "result" && (input.region !== undefined || needsDownscale(call))) {
        return viewDecoded(call, input, setting, maxBytes, slot);
      }
      return serve(call, input.detail, setting);
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

/** A picture the call named (held or not), with the detail it resolves to. */
type Named = {
  readonly store: ToolImageStore;
  readonly prefix: string;
  readonly detail: "low" | "high";
} & (
  | { readonly kind: "entry"; readonly entry: ToolImageEntry }
  | { readonly kind: "user"; readonly ref: AttachmentRef }
);

type Picked = Named | { readonly kind: "result"; readonly result: ToolResult };

const refusal = (content: string): ToolResult => ({ content, isError: true });
const refused = (content: string): Picked => ({ kind: "result", result: refusal(content) });

/** Which picture the call names — or the error that ends it. Reads no byte. */
function pickPicture(
  input: ImageViewInput,
  ctx: Pick<ToolContext, "images" | "history">,
  setting: ImageDetailSetting,
): Picked {
  const store = ctx.images;
  if (store === undefined) {
    return refused("image_view is not available in this session");
  }
  const parsed = imageRefPrefix(input.ref);
  if ("refused" in parsed) {
    return refused(parsed.refused);
  }
  const { prefix } = parsed;
  const detail = setting !== "auto" ? setting : (input.detail ?? "low");
  const found = store.resolve(prefix);
  if (found.kind === "ambiguous") {
    return refused(
      `${prefix} names ${found.labels.length} images (${found.labels.join(", ")}) — pass more hex characters of the ref`,
    );
  }
  if (found.kind === "found") {
    return { kind: "entry", store, prefix, detail, entry: found.entry };
  }
  // Not a picture a read kept: maybe the user's own, aged out of the request
  // by the old-image projection — its placeholder carries this ref.
  const user = userImage(ctx.history, prefix);
  if (user.kind === "many") {
    return refused(
      `${prefix} names ${user.labels.length} images (${user.labels.join(", ")}) — pass more hex characters of the ref`,
    );
  }
  if (user.kind === "one") {
    return { kind: "user", store, prefix, detail, ref: user.ref };
  }
  return refused(`no image ${prefix} in this session — ${REGENERATE}`);
}

/** The error for a picture whose bytes the store no longer has. */
function gone(named: Named): ToolResult {
  return refusal(
    named.kind === "entry"
      ? `image ${named.prefix} (${named.entry.label}) is no longer held — ${REGENERATE}`
      : `image ${named.prefix} (${attachmentLabel(named.ref)}) is no longer held — ask the user to attach it again`,
  );
}

function staleDetailNote(asked: unknown, setting: ImageDetailSetting): string {
  return setting !== "auto" && asked !== undefined && asked !== setting
    ? ` · detail is set to ${setting} (a setting); the call's detail was ignored`
    : "";
}

/** A call that sends a stored picture as it is. */
function serve(
  call: Picked,
  asked: "low" | "high" | undefined,
  setting: ImageDetailSetting,
): ToolResult {
  if (call.kind === "result") {
    return call.result;
  }
  if (call.kind === "user") {
    return viewUserImage(call.prefix, call.ref, asked, setting, call.store);
  }
  const { entry, detail } = call;
  const variant: ToolImageVariant = detail === "high" ? entry.high : entry.low;
  if (!call.store.holds(variant.ref)) {
    return gone(call);
  }
  const same = highOnly(entry)
    ? HIGH_ONLY_NOTE
    : entry.low.ref.id === entry.high.ref.id
      ? ` · already ≤ ${TOOL_IMAGE_LOW_EDGE} px`
      : "";
  return {
    content: `${entry.label} · ${variant.width}×${variant.height} · ${detail} · ${formatBytes(variant.ref.size)}${same}${staleDetailNote(asked, setting)}`,
    image: variant.ref,
  };
}

/** The decision for a call that decodes nothing, pure over the store (exported for the tests). */
export function viewImage(
  input: ImageViewInput,
  ctx: Pick<ToolContext, "images" | "history">,
  setting: ImageDetailSetting,
): ToolResult {
  return serve(pickPicture(input, ctx, setting), input.detail, setting);
}

/** D5: `low` of a PNG kept at `high` only is decoded and downscaled. */
function needsDownscale(named: Named): boolean {
  return (
    named.kind === "entry" &&
    named.detail === "low" &&
    highOnly(named.entry) &&
    named.entry.high.ref.mimeType === "image/png"
  );
}

/**
 * Decode the named picture, take one part of it (all of it with no `region`) at
 * up to the detail's size, and keep that as a picture of its own, so that its
 * own id views it again.
 */
async function viewDecoded(
  named: Named,
  input: ImageViewInput,
  setting: ImageDetailSetting,
  maxBytes: number,
  slot: Slot,
): Promise<ToolResult> {
  const { store, detail } = named;
  const { region } = input;
  // The most pixels we keep (O2); a user's own upload has no variants.
  const source = named.kind === "entry" ? named.entry.high.ref : named.ref;
  const label = named.kind === "entry" ? named.entry.label : (named.ref.name ?? "image");
  if (source.mimeType !== "image/png") {
    const format = source.mimeType.replace("image/", "").toUpperCase();
    return refusal(
      `region needs a PNG picture; this one is ${format} (JPEG regions come later) — call image_view without region`,
    );
  }
  if (!store.holds(source)) {
    return gone(named);
  }
  const made = await slot(async () => {
    const bytes = await store.read(source);
    if (bytes === null) {
      return { result: gone(named) };
    }
    const fail = (why: string) => ({ result: refusal(`${label}: ${why}`) });
    const header = readPngHeader(bytes);
    if ("refused" in header) {
      return fail(header.refused);
    }
    // Judged from the header: a part that shows nothing decodes nothing.
    const box =
      region === undefined
        ? { x: 0, y: 0, width: header.width, height: header.height, clamped: false }
        : regionBox(region, header.width, header.height);
    if ("refused" in box) {
      return fail(box.refused);
    }
    const decoded = await decodePng(bytes, inflatePng);
    if ("refused" in decoded) {
      return fail(decoded.refused);
    }
    const rendered = renderRegion({
      decoded,
      box,
      maxEdge: detail === "low" ? TOOL_IMAGE_LOW_EDGE : DEFAULT_PDF_IMAGE_LIMITS.maxEdge,
      maxBytes,
      deflate: (raw) => bytesOf(deflateSync(raw)),
    });
    if ("refused" in rendered) {
      return fail(rendered.refused);
    }
    return { rendered, box, source: `${header.width}×${header.height}` };
  });
  if (made.result !== undefined) {
    return made.result;
  }
  const { rendered, box } = made;
  const entry = await store.putTool({
    variants: { high: { bytes: rendered.png, width: rendered.width, height: rendered.height } },
    mimeType: "image/png",
    label: sanitizeAttachmentName(`${label} region`) ?? "region",
  });
  if ("refused" in entry) {
    return refusal(`the region was not kept: ${entry.refused}`);
  }
  // The store may answer with a picture it already had, where these very bytes
  // are the LOW variant: send the ref whose id is theirs.
  const id = createHash("sha256").update(rendered.png).digest("hex");
  const { ref } = entry.low.ref.id === id ? entry.low : entry.high;
  const size = `${rendered.width}×${rendered.height}`;
  const what =
    region === undefined
      ? size
      : `region ${box.x},${box.y} ${box.width}×${box.height} of ${made.source} · sent ${size}`;
  const clamped = box.clamped ? " · clamped to the picture's edge" : "";
  const scaled = rendered.scaledForBytes ? " · scaled down to fit the image limit" : "";
  return {
    content: `${label} · ${what} · ${detail} · ${formatBytes(ref.size)}${clamped}${scaled}${staleDetailNote(input.detail, setting)}`,
    image: ref,
  };
}
