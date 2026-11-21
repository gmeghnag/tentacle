/**
 * Turning image REFS into provider content (docs/feat/attachments-core.md, D6).
 *
 * The history holds refs, never bytes. This module is the one place that reads
 * bytes for a request, and it trusts nothing: a ref's `id` is the sha256 of its
 * bytes, so a source that answers other bytes (a corrupt store, a pod in 2b) is
 * detected and the image is replaced by a visible placeholder — never sent as
 * "some image", never silently dropped.
 *
 * Two caps, not one (review H1). `MAX_IMAGE_BYTES` (15 MiB) is what an ENTRY
 * POINT accepts; a model's own cap is lower and is the one that decides what
 * reaches the wire. An image over it is a 400 for THIS request and for every
 * later turn (the history is resent), so it is checked here, BEFORE any read:
 * the request carries a placeholder naming the image and the model's limit, and
 * the session stays usable.
 *
 * Pure except for `source.read`: selection (`selectInlineIds`), the parts of a
 * message (`userParts`) and the placeholder text are all testable without I/O.
 */
import { createHash } from "node:crypto";
import type { AttachmentRef, ChatMessage, ChatRequest } from "@tentacle/core";
import { attachmentLabel, formatBytes } from "@tentacle/core";
import { MAX_IMAGE_BYTES, isKnownImageType } from "@tentacle/protocol";

/** How many images one request may inline: the last K distinct refs (owner Q4). */
export const MAX_INLINE_IMAGES = 5;

/**
 * How many TOOL-RESULT images one request may inline (docs/feat/pdf-images.md
 * D7, owner Q2): the newest N distinct refs on `role:"tool"` messages — a budget
 * SEPARATE from the user's `MAX_INLINE_IMAGES`, so a PDF read never pushes the
 * user's own pictures out. Overridable per provider (`maxToolImages`).
 */
export const MAX_TOOL_IMAGES = 20;

/**
 * The most raw image bytes a model's wire accepts, by provider.
 *
 * Anthropic documents **5 MB per image** as the limit of the base64 payload,
 * which is 3.75 MiB of raw bytes (`5 MB × 3/4 = 3,932,160`, the figure the
 * owner's answer uses). **TO VERIFY** against the live API: the exact cap and
 * whether it counts raw or base64 bytes. Kept at the documented 3.75 MiB
 * because a wrong cap in the SAFE direction costs a placeholder, while one too
 * high is a 400 on every turn of the session.
 */
export const ANTHROPIC_MAX_IMAGE_BYTES = 3_932_160;

/**
 * The default for an OpenAI-COMPATIBLE endpoint: deliberately conservative,
 * because we cannot know the model behind it (a local llama.cpp may take less
 * than any documented cloud cap). `model.maxImageBytes` raises it.
 */
export const OPENAI_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export type ImagePart = {
  readonly kind: "image";
  readonly mimeType: string;
  readonly base64: string;
};
export type TextPart = { readonly kind: "text"; readonly text: string };

/** `id` → base64 of the VERIFIED bytes. Only what may be inlined. */
export type ResolvedImages = ReadonlyMap<string, string>;

const EMPTY_RESOLVED: ResolvedImages = new Map();

/** What one payload build may inline, and whether the model can see an image at all. */
export interface ImageBuildOptions {
  readonly images: ResolvedImages;
  readonly vision: boolean;
  /**
   * The ids this request SELECTED for inlining: pure, so a message can tell
   * "older than the last K" from "selected but its bytes are missing".
   */
  readonly inlined: ReadonlySet<string>;
  /**
   * The TOOL-result selection (`selectToolImageIds`): id → the ONE tool message
   * that owns its inline slot (the newest carrying it), so a picture read twice
   * is sent once and the count of tool images never exceeds the budget.
   * Absent: no tool image is inlined (every ref gets a reason line).
   */
  readonly toolInlined?: ReadonlyMap<string, ChatMessage>;
  /** The tool budget the selection used, named in the "older" reason line. */
  readonly toolKeep?: number;
  /**
   * This model's per-image cap in raw bytes (`ANTHROPIC_MAX_IMAGE_BYTES` /
   * `OPENAI_MAX_IMAGE_BYTES`, or `model.maxImageBytes`).
   */
  readonly maxImageBytes: number;
}

/** No bytes, vision assumed: what every existing `buildPayload` caller gets. */
export const NO_IMAGES: ImageBuildOptions = {
  images: EMPTY_RESOLVED,
  vision: true,
  inlined: new Set(),
  maxImageBytes: MAX_IMAGE_BYTES,
};

/**
 * The ids this request will inline: the newest `keep` DISTINCT refs on USER
 * messages, walked newest-first. Pure, so a provider can tell "older, not
 * selected" from "selected but unavailable" — two different placeholders.
 */
export function selectInlineIds(
  messages: readonly ChatMessage[],
  keep: number = MAX_INLINE_IMAGES,
): Set<string> {
  const chosen = new Set<string>();
  if (keep <= 0) {
    return chosen;
  }
  for (let at = messages.length - 1; at >= 0 && chosen.size < keep; at--) {
    const message = messages[at];
    if (message?.role !== "user") {
      continue;
    }
    const refs = message.attachments ?? [];
    for (let k = refs.length - 1; k >= 0 && chosen.size < keep; k--) {
      const ref = refs[k];
      if (ref !== undefined) {
        chosen.add(ref.id);
      }
    }
  }
  return chosen;
}

/**
 * The tool-result images this request will inline: the newest `keep` DISTINCT
 * refs on TOOL messages, walked newest-first, each mapped to the newest tool
 * message carrying it (its one inline slot). Separate from `selectInlineIds`:
 * the two budgets never share a slot.
 */
export function selectToolImageIds(
  messages: readonly ChatMessage[],
  keep: number = MAX_TOOL_IMAGES,
): Map<string, ChatMessage> {
  const chosen = new Map<string, ChatMessage>();
  if (keep <= 0) {
    return chosen;
  }
  for (let at = messages.length - 1; at >= 0 && chosen.size < keep; at--) {
    const message = messages[at];
    if (message?.role !== "tool") {
      continue;
    }
    const refs = message.attachments ?? [];
    for (let k = refs.length - 1; k >= 0 && chosen.size < keep; k--) {
      const ref = refs[k];
      if (ref !== undefined && !chosen.has(ref.id)) {
        chosen.set(ref.id, message);
      }
    }
  }
  return chosen;
}

/** True when this ref could ever be inlined, before any read (`max` = the model's cap). */
function sendable(ref: AttachmentRef, max: number): boolean {
  return isKnownImageType(ref.mimeType) && ref.size <= Math.min(max, MAX_IMAGE_BYTES);
}

/** The cap that decides: the model's, never above the entry point's own bound. */
export function effectiveMaxImageBytes(max: number): number {
  return Math.min(max, MAX_IMAGE_BYTES);
}

/** The providers whose vision defaults differ (P6). */
export type VisionProvider = "anthropic" | "openai";

export interface ImageLimitsOptions {
  /** `model.images`: unset keeps the provider's own default. */
  readonly images?: boolean;
  /** `model.maxImageBytes`: this model's per-image cap in raw bytes. */
  readonly maxImageBytes?: number;
}

/**
 * What a model can take, from ONE place (docs/feat/attachments-prompt.md D4).
 *
 * Both providers derive their `vision` and cap from here, and so does the
 * daemon's advertised `agentCapabilities.images` — so the capability cannot
 * disagree with what the provider actually does. `maxBytes` is the effective
 * cap (`effectiveMaxImageBytes`), so a caller that advertises it and refuses
 * above it can never refuse an image the provider would have sent.
 */
export function imageLimits(
  provider: VisionProvider,
  options: ImageLimitsOptions,
): { readonly vision: boolean; readonly maxBytes: number } {
  const fallback = provider === "anthropic" ? ANTHROPIC_MAX_IMAGE_BYTES : OPENAI_MAX_IMAGE_BYTES;
  return {
    vision: options.images ?? provider === "anthropic",
    maxBytes: effectiveMaxImageBytes(options.maxImageBytes ?? fallback),
  };
}

/** The tool-image budget of a provider config (`maxToolImages`, default `MAX_TOOL_IMAGES`). */
export function toolImageBudget(maxToolImages: number | undefined): number {
  return Math.max(0, Math.floor(maxToolImages ?? MAX_TOOL_IMAGES));
}

/**
 * The image options of one request, for either provider: no vision reads
 * NOTHING (the refs still reach the model as reason lines); with vision, the
 * user selection and the tool selection are resolved together, each id once.
 */
export async function buildImageOptions(
  request: ChatRequest,
  limits: { readonly vision: boolean; readonly maxBytes: number },
  toolKeep: number = MAX_TOOL_IMAGES,
): Promise<ImageBuildOptions> {
  const { vision, maxBytes: maxImageBytes } = limits;
  const inlined = selectInlineIds(request.messages);
  const toolInlined = selectToolImageIds(request.messages, toolKeep);
  const images = vision
    ? await resolveImages(request, MAX_INLINE_IMAGES, maxImageBytes, toolKeep)
    : EMPTY_RESOLVED;
  return { images, vision, inlined, toolInlined, toolKeep, maxImageBytes };
}

/**
 * Read and verify the bytes of the refs `selectInlineIds` chose. No source, or
 * nothing selected, reads nothing. A ref whose bytes are absent (`null`), the
 * wrong length or the wrong sha256 is LEFT OUT (its placeholder says so). Each
 * distinct id is read ONCE. A source that throws propagates: the stream rejects
 * before any provider sees a partial request, and the history keeps its refs so
 * a retry works.
 *
 * `maxImageBytes` is the MODEL's cap: an image over it is never read
 * (`sendable`), so a request can never be built around an image the endpoint
 * would 400 on every turn of the session.
 */
export async function resolveImages(
  req: ChatRequest,
  keep: number = MAX_INLINE_IMAGES,
  maxImageBytes: number = MAX_IMAGE_BYTES,
  toolKeep = 0,
): Promise<ResolvedImages> {
  const source = req.attachments;
  if (source === undefined) {
    return EMPTY_RESOLVED;
  }
  // Two selections, one read per id: the user's K and the tool results' own N.
  const userSelected = selectInlineIds(req.messages, keep);
  const toolSelected = selectToolImageIds(req.messages, toolKeep);
  if (userSelected.size === 0 && toolSelected.size === 0) {
    return EMPTY_RESOLVED;
  }
  const max = effectiveMaxImageBytes(maxImageBytes);
  const refs = new Map<string, AttachmentRef>();
  for (const message of req.messages) {
    const selected =
      message.role === "user" ? userSelected : message.role === "tool" ? toolSelected : undefined;
    if (selected === undefined) {
      continue;
    }
    for (const ref of message.attachments ?? []) {
      if (selected.has(ref.id) && sendable(ref, max) && !refs.has(ref.id)) {
        refs.set(ref.id, ref);
      }
    }
  }
  const resolved = new Map<string, string>();
  for (const [id, ref] of refs) {
    const bytes = await source.read(ref, req.signal);
    if (bytes === null || bytes.length !== ref.size) {
      continue;
    }
    if (createHash("sha256").update(bytes).digest("hex") !== ref.id) {
      continue;
    }
    resolved.set(id, Buffer.from(bytes).toString("base64"));
  }
  return resolved;
}

/**
 * The one placeholder a ref gets, in the ref's own slot. Order matters: "this
 * model has no vision" is about the endpoint, not about the image, so it wins.
 */
function placeholder(
  ref: AttachmentRef,
  options: Pick<ImageBuildOptions, "images" | "vision" | "inlined" | "maxImageBytes">,
  older = `only the last ${MAX_INLINE_IMAGES} images are sent`,
): string {
  const label = attachmentLabel(ref);
  if (!options.vision) {
    return `[image omitted: this model does not take images — ${label}]`;
  }
  if (!isKnownImageType(ref.mimeType)) {
    return `[image omitted: unsupported type ${ref.mimeType} — ${label}]`;
  }
  const max = effectiveMaxImageBytes(options.maxImageBytes);
  if (ref.size > max) {
    // The MODEL's cap when it is the binding one (the entry point already
    // refused anything over `MAX_IMAGE_BYTES`, but a request may be built from
    // history a bigger build wrote), named as such so the fix is obvious.
    const which = max < MAX_IMAGE_BYTES ? "this model's" : "the";
    return `[image omitted: ${formatBytes(ref.size)} is over ${which} ${formatBytes(max)} limit — ${label}]`;
  }
  if (!options.inlined.has(ref.id)) {
    return `[image omitted: ${older} — ${label}]`;
  }
  if (!options.images.has(ref.id)) {
    return `[image unavailable — ${label}]`;
  }
  return "";
}

/**
 * A user message's parts: IMAGES FIRST (parent D10: images before text, so a
 * model reads the picture then the question), then its text if non-empty. A ref
 * that cannot be sent becomes a text part in its slot, so the model (and the
 * transcript) always sees that something was attached.
 */
export function userParts(m: ChatMessage, options: ImageBuildOptions): (ImagePart | TextPart)[] {
  const parts: (ImagePart | TextPart)[] = [];
  for (const ref of m.attachments ?? []) {
    // `images` also holds the TOOL selection's bytes: only the user's own
    // selection may inline here, so tool refs never widen the user's K.
    const base64 = options.inlined.has(ref.id) ? options.images.get(ref.id) : undefined;
    if (base64 !== undefined && options.vision && isKnownImageType(ref.mimeType)) {
      parts.push({ kind: "image", mimeType: ref.mimeType, base64 });
      continue;
    }
    const text = placeholder(ref, options);
    if (text !== "") {
      parts.push({ kind: "text", text });
    }
  }
  if (m.content !== "") {
    parts.push({ kind: "text", text: m.content });
  }
  return parts;
}

/**
 * A TOOL message's images (docs/feat/pdf-images.md D7): the inlined ones, in
 * ref order, and one reason LINE per ref that is not — never a silent drop. An
 * image is inlined only from bytes `resolveImages` verified AND only in the one
 * tool message that owns its slot (`toolInlined`), so the count of tool images
 * in a request never exceeds the tool budget. A model without vision gets ONE
 * line for the whole result, not one per image.
 */
export function toolResultImages(
  m: ChatMessage,
  options: ImageBuildOptions,
): { readonly images: (ImagePart & { readonly label: string })[]; readonly lines: string[] } {
  const refs = m.attachments ?? [];
  if (refs.length === 0) {
    return { images: [], lines: [] };
  }
  if (!options.vision) {
    const n = refs.length;
    return {
      images: [],
      lines: [
        `[${n} image${n === 1 ? "" : "s"} in this result not sent: this model does not take images]`,
      ],
    };
  }
  const toolInlined = options.toolInlined ?? new Map<string, ChatMessage>();
  const keep = options.toolKeep ?? 0;
  const images: (ImagePart & { readonly label: string })[] = [];
  const lines: string[] = [];
  const sent = new Set<string>();
  const selected = new Set(toolInlined.keys());
  for (const ref of refs) {
    const owner = toolInlined.get(ref.id);
    if (owner !== undefined && owner !== m) {
      lines.push(
        `[image omitted: the same image is in a newer tool result — ${attachmentLabel(ref)}]`,
      );
      continue;
    }
    const base64 = owner === m && !sent.has(ref.id) ? options.images.get(ref.id) : undefined;
    if (base64 !== undefined && isKnownImageType(ref.mimeType)) {
      sent.add(ref.id);
      images.push({ kind: "image", mimeType: ref.mimeType, base64, label: attachmentLabel(ref) });
      continue;
    }
    if (sent.has(ref.id)) {
      continue; // the same image twice in ONE result: sent once, nothing lost
    }
    const text = placeholder(
      ref,
      { ...options, inlined: selected },
      `only the newest ${keep} tool-result images are sent (read it again to see it)`,
    );
    if (text !== "") {
      lines.push(text);
    }
  }
  return { images, lines };
}

/**
 * The text of a tool message whose images do NOT travel inside it (the
 * OpenAI-compatible wire, where a tool message is text only): its content plus
 * one reason line per ref not inlined (`toolResultImages`).
 */
export function toolResultText(content: string, lines: readonly string[]): string {
  if (lines.length === 0) {
    return content;
  }
  return content === "" ? lines.join("\n") : `${content}\n${lines.join("\n")}`;
}

/**
 * An ASSISTANT/SYSTEM message that carries refs (only a pod could send one): never
 * inlined — a ref is only ever inlined from a user or tool message — so each one says
 * "unavailable" (or the more specific reason), and none are silent.
 */
export function strayRefsText(m: ChatMessage, options: Omit<ImageBuildOptions, "inlined">): string {
  const refs = m.attachments ?? [];
  if (refs.length === 0) {
    return "";
  }
  // Its own ids count as "selected", so the reason shown is the true one
  // (unavailable), never the "only the last K" one meant for an older user ref.
  const own = new Set(refs.map((ref) => ref.id));
  const lines = refs
    .map((ref) => placeholder(ref, { ...options, inlined: own }))
    .filter((l) => l !== "");
  return lines.length === 0 ? "" : `\n${lines.join("\n")}`;
}
