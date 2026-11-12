/**
 * Why a candidate could not be attached, and what to say about it
 * (docs/feat/attachments-tui-detect.md).
 *
 * Every one of these is a sentence a person can act on: it names the file and
 * what to do about it. A refusal is NEVER silent (AGENTS §8 "a silent drop is a
 * bug") and never leaves a half-attached image behind — the caller checks
 * before it appends anything.
 *
 * Pure: the texts, and nothing else. `formatBytes` and both caps come from core
 * (which re-exports the protocol's, so there is ONE `MAX_IMAGE_BYTES`), and a
 * size reads the same in a refusal as in a provider's placeholder.
 */
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_IMAGE_BYTES, formatBytes } from "@tentacle/core";

/** A path that could not become an attachment, and why. */
export type AttachRefusal =
  | { readonly reason: "not-found"; readonly path: string }
  | { readonly reason: "directory"; readonly path: string }
  | { readonly reason: "not-file"; readonly path: string }
  | { readonly reason: "duplicate"; readonly path: string }
  | { readonly reason: "unreadable"; readonly path: string }
  | { readonly reason: "empty"; readonly path: string }
  | { readonly reason: "too-large"; readonly path: string; readonly size: number }
  | { readonly reason: "heic"; readonly path: string }
  | { readonly reason: "not-image"; readonly path: string }
  | { readonly reason: "too-many"; readonly count: number };

/** A refusal as the one line the TUI shows (`StatusLine`/a notice row). */
export function refusalText(refusal: AttachRefusal): string {
  switch (refusal.reason) {
    case "not-found":
      return `cannot attach ${refusal.path}: no such file`;
    case "directory":
      return `cannot attach ${refusal.path}: it is a directory, not an image file`;
    case "not-file":
      return `cannot attach ${refusal.path}: it is not a regular file`;
    case "duplicate":
      return `${refusal.path}: this image is already attached`;
    case "unreadable":
      return `cannot attach ${refusal.path}: the file could not be read`;
    case "empty":
      return `cannot attach ${refusal.path}: the file is empty (0 bytes)`;
    case "too-large":
      return `cannot attach ${refusal.path}: ${formatBytes(refusal.size)} is over the ${formatBytes(
        MAX_IMAGE_BYTES,
      )} limit`;
    case "heic":
      return `cannot attach ${refusal.path}: HEIC/HEIF images are not supported yet — export it as PNG or JPEG first (macOS: sips -s format png "${refusal.path}" --out out.png)`;
    case "not-image":
      return `cannot attach ${refusal.path}: it is not a PNG, JPEG, GIF or WebP image`;
    case "too-many":
      return `cannot attach more than ${MAX_ATTACHMENTS_PER_MESSAGE} images per message (${refusal.count} were given)`;
  }
}
