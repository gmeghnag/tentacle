/**
 * The preview cards' thumbnail PORT (docs/feat/mobile-file-preview-cards.md):
 * how one card's preview is made on the phone, with every effect injected so the
 * order of the steps — and what each failure becomes — is unit-tested.
 *
 * Per card (`ImageRef.artifact` carries its meta):
 * 1. a preview this phone already made (kept beside the cache) → shown at once,
 *    offline included;
 * 2. else the version's file: the cache's copy, or the session handle's verified
 *    read written through the cache's ONE writer (the 200 MB cap sees it);
 * 3. then by kind: an image IS its file; a PDF / HTML / SVG page is QuickLook's
 *    thumbnail (+ a PDF's page count); a markdown / text file keeps its first
 *    bytes, which the app draws. Steps 3's results are kept (step 1 next time).
 *
 * A daemon that says the bytes are gone (`ArtifactUnavailable`, `unknown` /
 * `evicted`) → `"gone"` (the card reads "no longer available"); anything else
 * that fails → `null` (the band keeps the kind's symbol). Never a throw.
 */
import { type ArtifactMeta, DomainErrorCode } from "@tentacle/protocol";
import { PAGE_ASPECT, PREVIEW_TEXT_BYTES, previewSource } from "./artifact-preview.ts";
import type { ArtifactPreview, Thumbnail, ThumbnailSource } from "./thumbnails.ts";

/** The sha256 a card's `ImageRef.id` is (the meta's content hash, not a title). */
const SHA_RE = /^[0-9a-f]{64}$/;

export interface PreviewNative {
  /** QuickLook's thumbnail of `fileUri`, fitted in `w × h` pt, written to `outUri` (px size back). */
  thumbnail(
    fileUri: string,
    outUri: string,
    widthPt: number,
    heightPt: number,
  ): Promise<{ readonly width: number; readonly height: number }>;
  /** A PDF's page count, or null. */
  pdfPageCount(fileUri: string): number | null;
}

/** Where made previews are kept (beside the cache; dropped with it on unpair). */
export interface PreviewStore {
  load(meta: ArtifactMeta, key: string): ArtifactPreview | null;
  save(meta: ArtifactMeta, key: string, preview: ArtifactPreview): void;
  /** The `file:` uri a page image for this version + key is written to. */
  imageUri(meta: ArtifactMeta, key: string): string;
}

export interface PreviewSourceDeps {
  /** The session handle's verified read (absent before the attach). */
  readonly read: (
    meta: ArtifactMeta,
    options: { readonly signal: AbortSignal },
  ) => Promise<Uint8Array>;
  /** The cache's copy of a version, or null. */
  readonly cached: (meta: ArtifactMeta) => string | null;
  /** Keep bytes through the cache's one writer; its uri, or null when not kept. */
  readonly put: (meta: ArtifactMeta, bytes: Uint8Array) => string | null;
  readonly store: PreviewStore;
  /** null on a build without the native module: pages then keep their symbol. */
  readonly native: PreviewNative | null;
  /** Up to `maxBytes` of a local file, as text. */
  readonly readText: (uri: string, maxBytes: number) => string;
  /** The band's width in points (the row's width). */
  readonly width: number;
}

/** Whether a read failed because the daemon no longer has the bytes. */
export function isGoneError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { code, data } = error as { code?: unknown; data?: unknown };
  if (code !== DomainErrorCode.ArtifactUnavailable) {
    return false;
  }
  const reason =
    typeof data === "object" && data !== null ? (data as { reason?: unknown }).reason : undefined;
  // `store_failed` is the daemon's disk, not the artifact: it may read next time.
  return reason === "unknown" || reason === "evicted";
}

/**
 * A kept preview, read back from its JSON: only the two shapes this build
 * writes, anything else is treated as absent (and remade).
 */
export function parseStoredPreview(text: string): ArtifactPreview | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const v = value as Record<string, unknown>;
  if (v.kind === "lines" && typeof v.text === "string") {
    return { kind: "lines", text: v.text };
  }
  if (v.kind === "picture" && typeof v.uri === "string" && v.uri.startsWith("file:")) {
    const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x > 0;
    return {
      kind: "picture",
      uri: v.uri,
      ...(num(v.width) ? { width: v.width } : {}),
      ...(num(v.height) ? { height: v.height } : {}),
      ...(num(v.pages) && Number.isInteger(v.pages) ? { pages: v.pages } : {}),
    };
  }
  return null;
}

/** The size a kept page preview was made for (a rotated / other phone remakes it). */
export function previewKey(width: number): string {
  return `w${Math.round(width)}`;
}

export function createArtifactPreviewSource(deps: PreviewSourceDeps): ThumbnailSource {
  const key = previewKey(deps.width);
  return {
    async fetch(ref, signal) {
      const meta = ref.artifact;
      if (meta === undefined || !SHA_RE.test(ref.id) || meta.sha256 !== ref.id) {
        return null;
      }
      const source = previewSource(meta);
      if (source === "none") {
        return null;
      }
      const done = (preview: ArtifactPreview): Thumbnail => ({
        id: ref.id,
        uri: preview.kind === "picture" ? preview.uri : "",
        preview,
      });
      try {
        // 1. Made before: shown at once, with no dial (offline too).
        if (source !== "image") {
          const kept = deps.store.load(meta, key);
          if (kept !== null) {
            return done(kept);
          }
        }
        // 2. The version's file.
        let fileUri = deps.cached(meta);
        if (fileUri === null) {
          let bytes: Uint8Array;
          try {
            bytes = await deps.read(meta, { signal });
          } catch (error) {
            return isGoneError(error) ? "gone" : null;
          }
          if (signal.aborted) {
            return null;
          }
          fileUri = deps.put(meta, bytes);
          if (fileUri === null) {
            return null;
          }
        }
        // 3. By kind.
        if (source === "image") {
          return done({
            kind: "picture",
            uri: fileUri,
            ...(meta.width === undefined ? {} : { width: meta.width }),
            ...(meta.height === undefined ? {} : { height: meta.height }),
          });
        }
        if (source === "lines") {
          const preview: ArtifactPreview = {
            kind: "lines",
            text: deps.readText(fileUri, PREVIEW_TEXT_BYTES),
          };
          deps.store.save(meta, key, preview);
          return done(preview);
        }
        if (deps.native === null) {
          return null;
        }
        const out = deps.store.imageUri(meta, key);
        const size = await deps.native.thumbnail(
          fileUri,
          out,
          deps.width,
          Math.round(deps.width * PAGE_ASPECT),
        );
        if (signal.aborted) {
          return null;
        }
        const pages = meta.kind === "pdf" ? deps.native.pdfPageCount(fileUri) : null;
        const preview: ArtifactPreview = {
          kind: "picture",
          uri: out,
          width: size.width,
          height: size.height,
          ...(pages !== null && pages > 0 ? { pages } : {}),
        };
        deps.store.save(meta, key, preview);
        return done(preview);
      } catch {
        // QuickLook refused (an icon only, a broken file), a disk error: the band
        // keeps the kind's symbol. Never a throw at the driver.
        return null;
      }
    },
  };
}
