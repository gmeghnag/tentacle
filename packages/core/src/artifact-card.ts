/**
 * The artifact card's view-model — ONE pure function both frontends render
 * (docs/feat/model-artifacts.md D7): the TUI's two-line card and the phone's
 * band row map these fields to elements and own only colours and spacing.
 *
 * React-free and I/O-free (the app imports `@tentacle/core` too).
 */
import { type ArtifactKind, type ArtifactMeta, artifactKindOf } from "@tentacle/protocol";

export type ArtifactCardState = "ready" | "unavailable";

/**
 * `open` — a viewer may show it; `save` — kind `other`: saved/shared, NEVER
 * handed to an opener (a `.command` would run); `none` — it cannot be read.
 */
export type ArtifactCardAction = "open" | "save" | "none";

export interface ArtifactCardView {
  /** The narrowed kind (an unknown wire kind is `other`). */
  readonly kind: ArtifactKind;
  /** One text glyph per kind, for text frontends. */
  readonly glyph: string;
  readonly title: string;
  /** `"PNG · 1280×720 · 240 KB"`, `"HTML page · 14 KB · v2 · from the pod"`. */
  readonly line2: string;
  readonly action: ArtifactCardAction;
  readonly state: ArtifactCardState;
}

export interface ArtifactCardOptions {
  /** `unavailable`: evicted from a memory daemon, or unreadable. Default `ready`. */
  readonly state?: ArtifactCardState;
  /** `pod`: presented by an untrusted pod daemon (TUI pod runtimes). Default `local`. */
  readonly origin?: "local" | "pod";
  /**
   * A PDF's page count, when the frontend has counted it (the phone, from its
   * own copy: docs/feat/mobile-file-preview-cards.md). Display only; ignored
   * for any other kind and for anything but a positive whole number.
   */
  readonly pages?: number;
}

const GLYPH: Readonly<Record<ArtifactKind, string>> = {
  image: "▣",
  svg: "◇",
  html: "◈",
  pdf: "▤",
  markdown: "¶",
  text: "≡",
  chart: "◱",
  other: "▢",
};

const KIND_LABEL: Readonly<Record<Exclude<ArtifactKind, "image" | "other">, string>> = {
  svg: "SVG",
  html: "HTML page",
  pdf: "PDF",
  markdown: "Markdown",
  text: "Text",
  chart: "Chart",
};

const MIME_LABEL: Readonly<Record<string, string>> = {
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/gif": "GIF",
  "image/webp": "WebP",
  "image/heic": "HEIC",
  "application/zip": "ZIP",
  "application/gzip": "GZIP",
};

/** A size the way the Files app shows it: decimal units, KB whole, MB one decimal. */
export function formatArtifactSize(bytes: number): string {
  if (bytes < 1000) {
    return `${bytes} B`;
  }
  const kb = Math.round(bytes / 1000);
  if (kb < 1000) {
    return `${kb} KB`;
  }
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** An `other` label from the source's extension (display only: 1–5 alphanumerics), else `File`. */
function extensionLabel(source: string | undefined): string {
  const name = source?.split(/[\\/]/).at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1) : "";
  return /^[a-z0-9]{1,5}$/i.test(ext) ? ext.toUpperCase() : "File";
}

function typeLabel(kind: ArtifactKind, meta: ArtifactMeta): string {
  const byMime = MIME_LABEL[meta.mimeType];
  if (kind === "image") {
    return byMime ?? "Image";
  }
  if (kind === "other") {
    return byMime ?? extensionLabel(meta.source);
  }
  return KIND_LABEL[kind];
}

export function artifactCard(
  meta: ArtifactMeta,
  options: ArtifactCardOptions = {},
): ArtifactCardView {
  const kind = artifactKindOf(meta);
  const state = options.state ?? "ready";
  const parts = [typeLabel(kind, meta)];
  const pages = options.pages;
  if (kind === "pdf" && pages !== undefined && Number.isInteger(pages) && pages > 0) {
    parts.push(pages === 1 ? "1 page" : `${pages} pages`);
  }
  if (kind === "image" && meta.width !== undefined && meta.height !== undefined) {
    parts.push(`${meta.width}×${meta.height}`);
  }
  parts.push(formatArtifactSize(meta.size));
  if (meta.version > 1) {
    parts.push(`v${meta.version}`);
  }
  if (options.origin === "pod") {
    parts.push("from the pod");
  }
  if (state === "unavailable") {
    parts.push("no longer available");
  }
  const action: ArtifactCardAction =
    state === "unavailable" ? "none" : kind === "other" ? "save" : "open";
  return { kind, glyph: GLYPH[kind], title: meta.title, line2: parts.join(" · "), action, state };
}
