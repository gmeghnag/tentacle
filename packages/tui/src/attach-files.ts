/**
 * Path candidates → image refs, at the one edge that touches the disk
 * (docs/feat/attachments-tui-detect.md).
 *
 * Everything a claim rests on is decided in PURE modules — what a type IS
 * (`image-sniff.ts`), which tokens are paths (`attach-candidates.ts`), what a
 * refusal says (`attach-refusal.ts`). This file only reads bytes, and it does so
 * through an injected `FileProbe`, so every failure mode (missing, directory,
 * unreadable, empty, over the cap, not an image, HEIC) is testable with a fake
 * and no real file system.
 *
 * The caps are the WIRE's, not re-declared here: `MAX_IMAGE_BYTES` (15 MiB,
 * owner override) and `MAX_ATTACHMENTS_PER_MESSAGE` come from the protocol
 * through core, so the TUI cannot accept something `checkAttachmentRefs` (and
 * with it `Session.send`) would refuse. Nothing is ever attached silently and a
 * refusal never leaves a half-built ref: a caller appends only `ok` items.
 */
import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { type AttachmentRef, MAX_ATTACHMENTS_PER_MESSAGE, MAX_IMAGE_BYTES } from "@tentacle/core";
import { type AttachRefusal, refusalText } from "./attach-refusal.ts";
import { IMAGE_HEAD_BYTES, sniffImageType } from "./image-sniff.ts";

/** What `stat` says about a path, in the terms a refusal needs. */
export interface ProbedStat {
  readonly kind: "file" | "directory" | "other";
  readonly size: number;
}

/**
 * The file-system seam. `stat` returns null for a path that does not exist and
 * throws for another failure; `read` returns AT MOST `maxBytes` (fewer at EOF)
 * and throws when the file cannot be read.
 */
export interface FileProbe {
  stat(path: string): Promise<ProbedStat | null>;
  read(path: string, maxBytes: number): Promise<Uint8Array>;
}

/** An image that passed every check: its ref, its bytes, and where it came from. */
export interface AttachedImage {
  readonly path: string;
  readonly ref: AttachmentRef;
  readonly bytes: Uint8Array;
}

export type InspectResult =
  | { readonly ok: true; readonly image: AttachedImage }
  | { readonly ok: false; readonly refusal: AttachRefusal };

/** The last path segment, for a `/a/b.png`, `C:\a\b.png` and a `file:` decoded path alike. */
export function baseName(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut === -1 ? trimmed : trimmed.slice(cut + 1);
}

/** Most characters a ref's `name` may carry (the wire's bound, `AttachmentRefSchema.name`). */
const NAME_MAX_CHARS = 255;

/**
 * A display name a ref accepts: the basename without control characters, capped.
 * `undefined` when nothing usable is left — a name is display only, so dropping
 * it is honest, while a control character would break a placeholder line.
 */
export function refName(path: string): string | undefined {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips control bytes from a file name
  const cleaned = baseName(path).replace(/[\u0000-\u001f\u007f]/g, "");
  if (cleaned === "") {
    return undefined;
  }
  return cleaned.length > NAME_MAX_CHARS ? cleaned.slice(0, NAME_MAX_CHARS) : cleaned;
}

/** The sha256 of `bytes`, lowercase hex — a ref's `id` (content-addressed). */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Read one candidate and decide. Order matters: cheap refusals first (existence,
 * kind, size), so a 4 GB file or a dropped folder costs one `stat` and nothing
 * else, and a NON-image costs one small head read rather than a full one.
 */
export async function inspectPath(probe: FileProbe, path: string): Promise<InspectResult> {
  const refuse = (refusal: AttachRefusal): InspectResult => ({ ok: false, refusal });
  let info: ProbedStat | null;
  try {
    info = await probe.stat(path);
  } catch {
    return refuse({ reason: "unreadable", path });
  }
  if (info === null) {
    return refuse({ reason: "not-found", path });
  }
  if (info.kind === "directory") {
    return refuse({ reason: "directory", path });
  }
  // A fifo/device/socket is never an image, and reading one can block forever —
  // refuse it by kind, so a dropped special file cannot hang the TUI.
  if (info.kind === "other") {
    return refuse({ reason: "not-file", path });
  }
  if (info.size === 0) {
    return refuse({ reason: "empty", path });
  }
  if (info.size > MAX_IMAGE_BYTES) {
    return refuse({ reason: "too-large", path, size: info.size });
  }
  let head: Uint8Array;
  try {
    head = await probe.read(path, IMAGE_HEAD_BYTES);
  } catch {
    return refuse({ reason: "unreadable", path });
  }
  const sniffed = sniffImageType(head);
  if (sniffed.kind === "heic") {
    // Only the flavours that need a conversion land here (sub-task 6 does it).
    return refuse({ reason: "heic", path });
  }
  if (sniffed.kind !== "image") {
    return refuse({ reason: "not-image", path });
  }
  let bytes: Uint8Array;
  try {
    // One byte past the cap: a file that grew since `stat` is caught, not read
    // whole into memory.
    bytes = await probe.read(path, MAX_IMAGE_BYTES + 1);
  } catch {
    return refuse({ reason: "unreadable", path });
  }
  if (bytes.length === 0) {
    return refuse({ reason: "empty", path });
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    return refuse({ reason: "too-large", path, size: bytes.length });
  }
  const ref: AttachmentRef = {
    id: sha256Hex(bytes),
    mimeType: sniffed.mimeType,
    size: bytes.length,
    ...nameField(refName(path)),
  };
  return { ok: true, image: { path, ref, bytes } };
}

/** `{ name }` only when there is one: an absent key, never `name: undefined`. */
function nameField(name: string | undefined): { name?: string } {
  return name === undefined ? {} : { name };
}

/** What a batch of candidates produced: the images that passed, and why the rest did not. */
export interface CollectedAttachments {
  readonly images: readonly AttachedImage[];
  readonly refusals: readonly AttachRefusal[];
}

/** The refs of `images`, ready for `Session.send`. */
export function refsOf(collected: CollectedAttachments): AttachmentRef[] {
  return collected.images.map((image) => image.ref);
}

/** Every refusal as the line the TUI shows, in the order the candidates came. */
export function refusalLines(collected: CollectedAttachments): string[] {
  return collected.refusals.map(refusalText);
}

/**
 * Inspect every candidate, keeping the ones that pass.
 *
 * The per-message cap is enforced here, at the point a candidate WOULD be added
 * (`MAX_ATTACHMENTS_PER_MESSAGE`, the wire's own constant): the first
 * `MAX_ATTACHMENTS_PER_MESSAGE` images stay, and the 6th is refused with a text
 * naming the cap. A file already collected is refused as a duplicate rather than
 * silently dropped or attached twice (the wire refuses a repeated id).
 */
export async function collectAttachments(
  probe: FileProbe,
  paths: readonly string[],
): Promise<CollectedAttachments> {
  const images: AttachedImage[] = [];
  const refusals: AttachRefusal[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const result = await inspectPath(probe, path);
    if (!result.ok) {
      refusals.push(result.refusal);
      continue;
    }
    if (images.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
      refusals.push({ reason: "too-many", count: images.length + 1 });
      continue;
    }
    if (seen.has(result.image.ref.id)) {
      refusals.push({ reason: "duplicate", path });
      continue;
    }
    seen.add(result.image.ref.id);
    images.push(result.image);
  }
  return { images, refusals };
}

/** The one place a real file system is read: `attach-files`' production probe. */
export function nodeFileProbe(): FileProbe {
  return {
    async stat(path) {
      try {
        const info = await stat(path);
        const kind = info.isFile() ? "file" : info.isDirectory() ? "directory" : "other";
        return { kind, size: Number(info.size) };
      } catch (error) {
        if (isMissing(error)) {
          return null;
        }
        throw error;
      }
    },
    async read(path, maxBytes) {
      const handle = await open(path, "r");
      try {
        const buffer = new Uint8Array(maxBytes);
        const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
        return buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    },
  };
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
