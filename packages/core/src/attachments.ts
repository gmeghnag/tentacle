/**
 * Image refs: entry-point checks and the labels a placeholder shows
 * (docs/feat/attachments-core.md, D4).
 *
 * Pure, React-free, no I/O. Everything here is about a REF (id, type, size,
 * name); bytes live behind an `AttachmentSource`, and only a provider that
 * actually sends an image ever reads them.
 */
import {
  ATTACHMENT_NAME_RE,
  type AttachmentRef,
  AttachmentsSchema,
  IMAGE_MIME_TYPES,
  MAX_IMAGE_BYTES,
  isKnownImageType,
} from "@tentacle/protocol";

// The bounds are decided in the protocol (the wire's source of truth, and where
// the schema enforces them); re-exported here because an entry point that must
// refuse a ref needs them and the packages doing that depend on core.
export {
  ATTACHMENT_NAME_RE,
  IMAGE_MIME_TYPES,
  type ImageMimeType,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_IMAGE_BYTES,
} from "@tentacle/protocol";
/** A ref an entry point refuses (too big, wrong type, duplicate id, malformed). */
export class InvalidAttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAttachmentError";
  }
}

/** How many characters of a ref's name a placeholder shows at most. */
const LABEL_NAME_MAX_CHARS = 80;

/** Most characters a ref's `name` may carry (the wire's bound, `AttachmentRefSchema.name`). */
export const ATTACHMENT_NAME_MAX_CHARS = 255;

/**
 * A ref's `name` from a raw file name: every character the wire REFUSES removed
 * by the wire's OWN rule (`ATTACHMENT_NAME_RE`, the regex
 * `AttachmentRefSchema.name` enforces — imported, never copied, so the entry
 * point and the wire cannot drift), capped to the wire's length, and
 * `undefined` when nothing usable is left.
 *
 * The failure this prevents: a name with a C1 control character (NEL `\u0085`, a
 * CSI `\u009b`) passed a narrower local filter and then threw at
 * `checkAttachmentRefs`, refusing the WHOLE message instead of one image.
 */
export function sanitizeAttachmentName(raw: string): string | undefined {
  // `for…of` walks code POINTS, so neither the filter nor the cap can split a
  // surrogate pair (a UTF-16 `slice` at 255 left half an emoji behind:
  // `254×"a" + 😀` came out ending in a lone high surrogate). The budget is
  // UTF-16 units, because that is what the wire's `.max(255)` counts — so a name
  // of astral characters is cut SHORTER, never over the wire's bound.
  let kept = "";
  for (const char of raw) {
    if (!ATTACHMENT_NAME_RE.test(char)) {
      continue;
    }
    const extended = kept + char;
    if (extended.length > ATTACHMENT_NAME_MAX_CHARS) {
      break;
    }
    kept = extended;
  }
  return kept === "" ? undefined : kept;
}

/**
 * Refuse `refs` unless every one is sendable: the schema's bounds (at least one,
 * at most `MAX_ATTACHMENTS_PER_MESSAGE`, a sha256 id, `image/*`), a type every
 * provider accepts, at most `MAX_IMAGE_BYTES` of raw bytes, and no repeated id.
 * Throws `InvalidAttachmentError` — callers check BEFORE they push anything, so
 * a refusal never leaves a half-written history.
 */
export function checkAttachmentRefs(refs: readonly AttachmentRef[]): void {
  const parsed = AttachmentsSchema.safeParse(refs);
  if (!parsed.success) {
    throw new InvalidAttachmentError(
      `invalid image references: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  const seen = new Set<string>();
  for (const ref of refs) {
    const label = attachmentLabel(ref);
    if (!isKnownImageType(ref.mimeType)) {
      throw new InvalidAttachmentError(
        `${label}: unsupported image type ${ref.mimeType} (supported: ${IMAGE_MIME_TYPES.join(", ")})`,
      );
    }
    if (ref.size > MAX_IMAGE_BYTES) {
      throw new InvalidAttachmentError(
        `${label}: ${formatBytes(ref.size)} is over the ${formatBytes(MAX_IMAGE_BYTES)} limit`,
      );
    }
    if (seen.has(ref.id)) {
      throw new InvalidAttachmentError(`${label}: the same image is attached twice`);
    }
    seen.add(ref.id);
  }
}

/** Bytes as a person reads them: `15 MB`, `590 KB`, `12 B` (one decimal at most). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb < 10 ? round1(kb) : Math.round(kb)} KB`;
  }
  const mb = kb / 1024;
  return `${mb < 10 ? round1(mb) : Math.round(mb)} MB`;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * What one image costs the context window, per ref, when counted heuristically:
 * about a 1568-px image, rounded UP so a budget never underestimates
 * (`token-counter.ts`'s contract). The real provider counts its own way
 * (`countTokens`); this is the fallback.
 */
export const IMAGE_TOKEN_ESTIMATE = 1600;

/**
 * How a ref reads to a person and in a placeholder: `name` when it has one
 * (capped, control characters already excluded by the schema), else its MIME
 * type — then the first 12 hex of its sha256, so two images never look alike.
 */
export function attachmentLabel(ref: {
  readonly id: string;
  readonly mimeType: string;
  readonly name?: string;
}): string {
  const base = ref.name !== undefined && ref.name !== "" ? ref.name : ref.mimeType;
  const name =
    base.length > LABEL_NAME_MAX_CHARS ? `${base.slice(0, LABEL_NAME_MAX_CHARS)}…` : base;
  return `${name} sha256:${ref.id.slice(0, 12)}`;
}
