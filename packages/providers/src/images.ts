/**
 * Turning image REFS into provider content (docs/feat/attachments-core.md, D6).
 *
 * The history holds refs, never bytes. This module is the one place that reads
 * bytes for a request, and it trusts nothing: a ref's `id` is the sha256 of its
 * bytes, so a source that answers other bytes (a corrupt store, a pod in 2b) is
 * detected and the image is replaced by a visible placeholder — never sent as
 * "some image", never silently dropped.
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
}

/** No bytes, vision assumed: what every existing `buildPayload` caller gets. */
export const NO_IMAGES: ImageBuildOptions = {
  images: EMPTY_RESOLVED,
  vision: true,
  inlined: new Set(),
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

/** True when this ref could ever be inlined, before any read. */
function sendable(ref: AttachmentRef): boolean {
  return isKnownImageType(ref.mimeType) && ref.size <= MAX_IMAGE_BYTES;
}

/**
 * Read and verify the bytes of the refs `selectInlineIds` chose. No source, or
 * nothing selected, reads nothing. A ref whose bytes are absent (`null`), the
 * wrong length or the wrong sha256 is LEFT OUT (its placeholder says so). Each
 * distinct id is read ONCE. A source that throws propagates: the stream rejects
 * before any provider sees a partial request, and the history keeps its refs so
 * a retry works.
 */
export async function resolveImages(
  req: ChatRequest,
  keep: number = MAX_INLINE_IMAGES,
): Promise<ResolvedImages> {
  const source = req.attachments;
  if (source === undefined) {
    return EMPTY_RESOLVED;
  }
  const selected = selectInlineIds(req.messages, keep);
  if (selected.size === 0) {
    return EMPTY_RESOLVED;
  }
  const refs = new Map<string, AttachmentRef>();
  for (const message of req.messages) {
    if (message.role !== "user") {
      continue;
    }
    for (const ref of message.attachments ?? []) {
      if (selected.has(ref.id) && sendable(ref) && !refs.has(ref.id)) {
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
  images: ResolvedImages,
  vision: boolean,
  inlined: ReadonlySet<string>,
): string {
  const label = attachmentLabel(ref);
  if (!vision) {
    return `[image omitted: this model does not take images — ${label}]`;
  }
  if (!isKnownImageType(ref.mimeType)) {
    return `[image omitted: unsupported type ${ref.mimeType} — ${label}]`;
  }
  if (ref.size > MAX_IMAGE_BYTES) {
    return `[image omitted: ${formatBytes(ref.size)} is over the ${formatBytes(MAX_IMAGE_BYTES)} limit — ${label}]`;
  }
  if (!inlined.has(ref.id)) {
    return `[image omitted: only the last ${MAX_INLINE_IMAGES} images are sent — ${label}]`;
  }
  if (!images.has(ref.id)) {
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
export function userParts(
  m: ChatMessage,
  images: ResolvedImages,
  vision: boolean,
  inlined: ReadonlySet<string>,
): (ImagePart | TextPart)[] {
  const parts: (ImagePart | TextPart)[] = [];
  for (const ref of m.attachments ?? []) {
    const base64 = images.get(ref.id);
    if (base64 !== undefined && vision && isKnownImageType(ref.mimeType)) {
      parts.push({ kind: "image", mimeType: ref.mimeType, base64 });
      continue;
    }
    const text = placeholder(ref, images, vision, inlined);
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
 * A NON-user message that carries refs (only a pod could send one): never
 * inlined — a ref is only ever inlined from a USER message — so each one says
 * "unavailable" (or the more specific reason), and none are silent.
 */
export function strayRefsText(
  m: ChatMessage,
  vision = true,
  images: ResolvedImages = EMPTY_RESOLVED,
): string {
  const refs = m.attachments ?? [];
  if (refs.length === 0) {
    return "";
  }
  // Its own ids count as "selected", so the reason shown is the true one
  // (unavailable), never the "only the last K" one meant for an older user ref.
  const own = new Set(refs.map((ref) => ref.id));
  const lines = refs.map((ref) => placeholder(ref, images, vision, own)).filter((l) => l !== "");
  return lines.length === 0 ? "" : `\n${lines.join("\n")}`;
}
