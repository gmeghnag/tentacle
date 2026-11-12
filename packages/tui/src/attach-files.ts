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
 *
 * **One read decides everything.** A candidate is opened ONCE; its bytes are
 * read to EOF (bounded by the cap) and BOTH the sniff and the ref come from that
 * one buffer, so a type can never describe bytes other than the ones sent.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import {
  type AttachmentRef,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_IMAGE_BYTES,
  sanitizeAttachmentName,
} from "@tentacle/core";
import type { CandidateText } from "./attach-candidates.ts";
import { type AttachRefusal, refusalMeansText, refusalText } from "./attach-refusal.ts";
import { sniffImageType } from "./image-sniff.ts";

/**
 * What the probe learned about an OPEN handle, in the terms a refusal needs.
 * `directory` and `other` (a fifo, a device, a socket) are refused unread:
 * reading a special file can block forever, and a directory is not an image.
 */
export interface ProbedFile {
  readonly kind: "file" | "directory" | "other";
  readonly size: number;
  /** Every byte of the file, in ONE buffer read to EOF (at most `cap + 1` bytes). */
  readonly bytes: Uint8Array;
}

/**
 * The file-system seam: ONE call, ONE open. It returns `null` when the path does
 * not exist (or is a directory, which is not a file to read), throws when it
 * cannot be opened, and otherwise reports the handle's own kind, size and bytes.
 *
 * One call on purpose — a `stat` then a `read` would let the path change between
 * them (a swap, a rewrite, a fifo) and hand back a type that does not describe
 * the bytes actually sent.
 */
export interface FileProbe {
  read(path: string, cap: number): Promise<ProbedFile | null>;
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

/**
 * A display name a ref accepts, or `undefined` when nothing usable is left. The
 * RULE is the wire's: `sanitizeAttachmentName` (core) applies the very regex
 * `AttachmentRefSchema.name` enforces — imported, never copied, so this entry
 * point cannot hand `Session.send` a name it would throw on.
 */
export function refName(path: string): string | undefined {
  return sanitizeAttachmentName(baseName(path));
}

/** The sha256 of `bytes`, lowercase hex — a ref's `id` (content-addressed). */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Read one candidate and decide, from ONE open and ONE buffer.
 *
 * The bytes are the only evidence: the type is sniffed from the very buffer the
 * ref's `id` and `size` describe, so "the media type comes from the bytes" holds
 * for the bytes that are actually sent. The head is not read separately — a
 * 15 MiB ceiling (owner Q4) makes one full read cheaper than two opens and a
 * class of TOCTOU bug.
 */
export async function inspectPath(probe: FileProbe, path: string): Promise<InspectResult> {
  const refuse = (refusal: AttachRefusal): InspectResult => ({ ok: false, refusal });
  let file: ProbedFile | null;
  try {
    // ONE byte past the cap: a file that grew past it is caught, not buffered.
    file = await probe.read(path, MAX_IMAGE_BYTES + 1);
  } catch {
    return refuse({ reason: "unreadable", path });
  }
  if (file === null) {
    return refuse({ reason: "not-found", path });
  }
  // A fifo/device/socket carries no bytes to sniff — refused by the HANDLE's
  // kind, so nothing is ever read from one; a directory is not an image.
  if (file.kind === "other") {
    return refuse({ reason: "not-file", path });
  }
  if (file.kind === "directory") {
    return refuse({ reason: "directory", path });
  }
  const bytes = file.bytes;
  if (bytes.length === 0) {
    return refuse({ reason: "empty", path });
  }
  // The sniff comes BEFORE the cap so a refusal can say what it is about: an
  // image that is too large is `too-large`, and a 4 GB video is `not-image`
  // (the bytes decide, and only the first ones need to be right).
  const sniffed = sniffImageType(bytes);
  if (sniffed.kind === "heic") {
    // Only the flavours that need a conversion land here (sub-task 6 does it).
    return refuse({ reason: "heic", path });
  }
  if (sniffed.kind !== "image") {
    return refuse({ reason: "not-image", path });
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    return refuse({ reason: "too-large", path, size: Math.max(file.size, bytes.length) });
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

/** Where a candidate ended up: an image, a refusal, or an image the cap left out. */
export type CandidateOutcome =
  | { readonly kind: "image"; readonly image: AttachedImage }
  | { readonly kind: "refused"; readonly refusal: AttachRefusal }
  /** A real image that the per-message cap left out (counted in the ONE `too-many`). */
  | { readonly kind: "over-cap" };

/** What a batch of candidates produced: the images that passed, and why the rest did not. */
export interface CollectedAttachments {
  readonly images: readonly AttachedImage[];
  readonly refusals: readonly AttachRefusal[];
  /**
   * Every candidate in the order given, with its disposition — so a caller can
   * decide per candidate (3b turns the whole paste into text when none of them
   * became an image).
   */
  readonly outcomes: readonly CandidateOutcome[];
}

/** The refs of `images`, ready for `Session.send`. */
export function refsOf(collected: CollectedAttachments): AttachmentRef[] {
  return collected.images.map((image) => image.ref);
}

/** Every refusal as the line the TUI shows, in the order the candidates came. */
export function refusalLines(collected: CollectedAttachments): string[] {
  return collected.refusals.map(refusalText);
}

/** Options for `collectAttachments`: what the pending message already holds. */
export interface CollectOptions {
  /**
   * The refs of the images ALREADY attached to this message (3b's chips). The
   * cap and the duplicate check hold for the whole MESSAGE, not one paste, so
   * two pastes of three images cannot reach `checkAttachmentRefs` with six.
   */
  readonly existing?: readonly AttachmentRef[];
}

/** Nothing to collect: no images, no refusals, no outcomes. */
export const NOTHING_COLLECTED: CollectedAttachments = { images: [], refusals: [], outcomes: [] };

/**
 * Inspect every candidate, keeping the ones that pass.
 *
 * The per-message cap (`MAX_ATTACHMENTS_PER_MESSAGE`, the wire's own constant)
 * and the duplicate check are counted against `existing` TOO — the chips a
 * message already carries — so what this returns ALWAYS composes with them into
 * something `checkAttachmentRefs` accepts. A candidate over the cap is left out
 * and reported as ONE refusal for the whole paste (naming how many were
 * dropped), never one refusal per file.
 */
export async function collectAttachments(
  probe: FileProbe,
  paths: readonly string[],
  options: CollectOptions = {},
): Promise<CollectedAttachments> {
  const existing = options.existing ?? [];
  const kept = existing.length;
  const ids = new Set(existing.map((ref) => ref.id));
  const images: AttachedImage[] = [];
  const refusals: AttachRefusal[] = [];
  const outcomes: CandidateOutcome[] = [];
  let wouldHold = kept;
  let dropped = 0;
  for (const path of paths) {
    const result = await inspectPath(probe, path);
    if (!result.ok) {
      refusals.push(result.refusal);
      outcomes.push({ kind: "refused", refusal: result.refusal });
      continue;
    }
    const duplicate = ids.has(result.image.ref.id);
    if (duplicate) {
      // Its own sentence, and it does NOT count toward the message's total: a
      // repeat of an attached image is a repeat, not a 6th image.
      const refusal: AttachRefusal = { reason: "duplicate", path };
      refusals.push(refusal);
      outcomes.push({ kind: "refused", refusal });
      continue;
    }
    if (wouldHold >= MAX_ATTACHMENTS_PER_MESSAGE) {
      // Counted, not announced one by one: a rejected candidate still counts
      // toward the total, so the reply is ONE sentence about the whole paste.
      wouldHold += 1;
      dropped += 1;
      outcomes.push({ kind: "over-cap" });
      continue;
    }
    wouldHold += 1;
    ids.add(result.image.ref.id);
    images.push(result.image);
    outcomes.push({ kind: "image", image: result.image });
  }
  if (dropped > 0) {
    refusals.push({ reason: "too-many", count: wouldHold, dropped });
  }
  return { images, refusals, outcomes };
}

/**
 * What a paste BECOMES — the one decision 3b consumes, so the rule "only image
 * paths" is decided (and tested) here, not re-derived in a component.
 *
 * Three variants, and each means ONE thing to 3b:
 *
 * - `attachments` — at least one candidate became an image: attach these refs,
 *   and SHOW the refusals beside them (a HEIC, a duplicate, the cap) so nothing
 *   is dropped silently.
 * - `text` — plain text, and nothing was ever an image: a sentence, a slash
 *   command, a dragged source file, an empty paste. INSERT the text, and show
 *   nothing ("not a PNG" is not an error for a file the user only mentioned).
 *   `text` never carries a refusal — a refusal means something WAS an image.
 * - `refused` — images were found and NONE could be attached: an over-cap PNG,
 *   a HEIC, a re-dropped duplicate, a failed `/attach`. Show every refusal and
 *   do NOT insert the text: putting a path back into the prompt after a failed
 *   `/attach /nope.png` would hand the literal command to the model.
 */
export type AttachmentDecision =
  | {
      readonly kind: "attachments";
      readonly refs: readonly AttachmentRef[];
      readonly images: readonly AttachedImage[];
      readonly refusals: readonly AttachRefusal[];
    }
  | { readonly kind: "text" }
  | { readonly kind: "refused"; readonly refusals: readonly AttachRefusal[] };

/** Options for `attachPaths`/`decideAttachment`. */
export interface DecideOptions extends CollectOptions {
  /**
   * The user SAID "a file" (`/attach <path…>`): then every failure is a
   * refusal the TUI shows. Absent, a candidate whose BYTES are not an image
   * means the paste was never an attachment (owner Q3 (a)).
   */
  readonly explicit?: boolean;
}

/**
 * The paste rule (owner Q3 (a)): a pasted/dropped TEXT becomes attachments ONLY
 * when every candidate is a regular file whose BYTES are an image. One missing
 * path, one directory, one source file, one slash command and the WHOLE paste
 * stays plain text — nothing is dropped, and nothing is refused at the user for
 * a file they were only mentioning.
 *
 * A candidate that IS an image by its bytes never collapses the paste: it is
 * attached, or its failure (`heic`, `too-large`, `duplicate`, the cap) is a
 * refusal the caller shows beside the images that did pass — so a pasted
 * `shot.png` + `IMG.HEIC` attaches the PNG and says why the HEIC did not.
 *
 * `explicit` (`/attach <path…>`) shows EVERY failure: there the user said "a
 * file", so a missing one is an error worth a sentence.
 */
export async function attachPaths(
  probe: FileProbe,
  paths: readonly string[],
  options: DecideOptions = {},
): Promise<AttachmentDecision> {
  if (paths.length === 0) {
    return { kind: "text" };
  }
  const collected = await collectAttachments(probe, paths, options);
  const shown =
    options.explicit === true
      ? collected.refusals
      : collected.refusals.filter((refusal) => !refusalMeansText(refusal));
  // A candidate whose bytes are NOT an image means the paste was never an
  // attachment (a sentence, a dragged source file): the whole paste stays text
  // and no refusal is shown for it.
  if (options.explicit !== true && collected.refusals.some(refusalMeansText)) {
    return { kind: "text" };
  }
  if (collected.images.length === 0) {
    // Images were found (that is the only way not to be `text` by now: every
    // candidate was an image, or `explicit` was set) and none could be attached.
    return { kind: "refused", refusals: shown };
  }
  return {
    kind: "attachments",
    refs: refsOf(collected),
    images: collected.images,
    refusals: shown,
  };
}

/**
 * The same decision from the PURE candidate (`attachmentCandidateText`'s
 * result): `{kind:"text"}` — a sentence, an empty paste — is text without
 * touching the disk, so prose never costs a `stat`.
 */
export async function decideAttachment(
  probe: FileProbe,
  candidate: CandidateText,
  options: DecideOptions = {},
): Promise<AttachmentDecision> {
  if (candidate.kind === "text") {
    return { kind: "text" };
  }
  return attachPaths(probe, candidate.paths, options);
}

/**
 * The one method `readToEof` needs of an open handle, so the short-read loop is
 * testable with a fake (a real handle only short-reads on a FUSE/network mount).
 */
export interface ByteReader {
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ readonly bytesRead: number }>;
}

/**
 * The one place a real file system is read: `attach-files`' production probe.
 *
 * One `open`, then everything from the HANDLE: `fstat` for the kind and the size
 * (so a path that became a fifo after any earlier look is never read) and one
 * read loop to EOF bounded by `cap`, so a short read (a network/FUSE mount, a
 * file that grew) is never mistaken for a whole file.
 */
export function nodeFileProbe(): FileProbe {
  return {
    async read(path, cap) {
      let handle: Awaited<ReturnType<typeof open>>;
      try {
        // `O_NONBLOCK`: opening a fifo would otherwise block the render thread
        // forever before we could ask the handle what it is.
        handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
      } catch (error) {
        if (isMissing(error)) {
          return null;
        }
        // Linux answers EISDIR at open; macOS opens it and fails at read.
        if (isDirectoryError(error)) {
          return { kind: "directory", size: 0, bytes: new Uint8Array(0) };
        }
        throw error;
      }
      try {
        const info = await handle.stat();
        if (info.isDirectory()) {
          return { kind: "directory", size: Number(info.size), bytes: new Uint8Array(0) };
        }
        if (!info.isFile()) {
          return { kind: "other", size: Number(info.size), bytes: new Uint8Array(0) };
        }
        const bytes = await readToEof(handle, cap);
        return { kind: "file", size: Number(info.size), bytes };
      } finally {
        await handle.close();
      }
    },
  };
}

/** Read `handle` from EOF or `cap` bytes, whichever comes first (never one short read). */
export async function readToEof(handle: ByteReader, cap: number): Promise<Uint8Array> {
  const buffer = new Uint8Array(cap);
  let filled = 0;
  while (filled < cap) {
    const { bytesRead } = await handle.read(buffer, filled, cap - filled, filled);
    if (bytesRead === 0) {
      break;
    }
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function isDirectoryError(error: unknown): boolean {
  // Linux answers EISDIR; macOS opens a directory read-only and fails at read.
  const code = (error as { code?: unknown } | null)?.code;
  return code === "EISDIR";
}
