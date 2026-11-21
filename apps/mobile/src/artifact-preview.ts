/**
 * The transcript's file PREVIEW cards (docs/feat/mobile-file-preview-cards.md,
 * owner's variant A "band on top"): which preview a presented file gets, the
 * band's height before any byte arrives, what each state draws, and the first
 * lines of a markdown / text file. Pure and React-free; `TranscriptRow.tsx`'s
 * `ArtifactCardRow` only maps `PreviewCardView` to elements.
 *
 * The bytes are made ON THE PHONE (`artifact-preview-source.ts`, QuickLook via
 * `modules/tentacle-preview`) and travel through the existing thumbnail driver
 * (`thumbnails.ts`): visible rows only, bounded, cancelled off screen.
 */
import { type ArtifactCardView, artifactCard } from "@tentacle/core";
import { type ArtifactKind, type ArtifactMeta, artifactKindOf } from "@tentacle/protocol";
import { kindSymbol } from "./gallery-layout.ts";
import { type MdBlock, flatten, parse } from "./markdown.ts";
import type { ArtifactPreview, ThumbnailState } from "./thumbnails.ts";
import type { IconName } from "./ui/Icon.tsx";

/**
 * The largest file whose preview is fetched unopened (the approved mockup's
 * 5 MiB, extending Owner Q6's 1 MiB image line to every previewable kind).
 */
export const PREVIEW_MAX_BYTES = 5 * 1024 * 1024;

/** A page / lines / symbol band's fixed height, in points. */
export const BAND_HEIGHT = 150;

/** An image band follows the image's proportions, within these bounds. */
export const IMAGE_BAND_MIN = 120;
export const IMAGE_BAND_MAX = 240;

/** Lines a markdown / text band shows (it is cut at the band's edge anyway). */
export const PREVIEW_LINES = 8;

/** Bytes of a markdown / text file the preview keeps (enough for 8 lines). */
export const PREVIEW_TEXT_BYTES = 4096;

/** A QuickLook page is asked for at the band's width and 1.5× it (a page's shape). */
export const PAGE_ASPECT = 1.5;

/**
 * Where a card's preview comes from: the image's own file, a QuickLook page,
 * lines the app draws, or nothing (a chart has its own row; `other` is shared,
 * never rendered).
 */
export type PreviewSource = "image" | "page" | "lines" | "none";

export function previewSource(meta: ArtifactMeta): PreviewSource {
  switch (artifactKindOf(meta)) {
    case "image":
      return "image";
    case "pdf":
    case "html":
    case "svg":
      return "page";
    case "markdown":
    case "text":
      return "lines";
    default:
      return "none";
  }
}

/** Whether the driver should fetch this card's bytes (`visibleRefs`' rule). */
export function wantsPreview(meta: ArtifactMeta): boolean {
  return previewSource(meta) !== "none" && meta.size <= PREVIEW_MAX_BYTES;
}

/**
 * One SF Symbol per kind — the gallery's own table (`gallery-layout.ts`), so a
 * file looks the same in the transcript and in Artifacts. Its shape is the cue;
 * the kind is also WRITTEN in line 2 (never meaning by hue alone).
 */
export function previewSymbol(kind: ArtifactKind): IconName {
  return kindSymbol(kind);
}

/**
 * The band's height, from the META alone — so it never changes when the bytes
 * arrive: an image's from its declared size (clamped), everything else fixed.
 */
export function bandHeight(meta: ArtifactMeta, width: number): number {
  if (previewSource(meta) === "image" && meta.width && meta.height) {
    const natural = Math.round((width * meta.height) / meta.width);
    return Math.min(IMAGE_BAND_MAX, Math.max(IMAGE_BAND_MIN, natural));
  }
  return BAND_HEIGHT;
}

/** One card's preview, as the driver's state says. */
export type PreviewStatus =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly preview: ArtifactPreview }
  | { readonly kind: "failed" }
  | { readonly kind: "gone" };

export function previewStatus(state: ThumbnailState, meta: ArtifactMeta): PreviewStatus {
  const id = meta.sha256;
  if (state.gone?.includes(id) === true) {
    return { kind: "gone" };
  }
  const thumb = state.loaded.find((entry) => entry.id === id);
  if (thumb !== undefined) {
    // A thumb with no preview is an image's own file (the sent-photo source).
    const preview: ArtifactPreview = thumb.preview ?? {
      kind: "picture",
      uri: thumb.uri,
      ...(meta.width === undefined ? {} : { width: meta.width }),
      ...(meta.height === undefined ? {} : { height: meta.height }),
    };
    return { kind: "ready", preview };
  }
  // Too big (or not previewable) is known up front: the symbol, never a band
  // that loads forever.
  if (!wantsPreview(meta) || state.failed.includes(id)) {
    return { kind: "failed" };
  }
  return { kind: "loading" };
}

export type PreviewLineStyle = "heading" | "body" | "bullet" | "mono";

export interface PreviewLine {
  readonly style: PreviewLineStyle;
  readonly text: string;
}

const EMPTY_LINES: readonly PreviewLine[] = [{ style: "body", text: "(empty)" }];

function blockLines(block: MdBlock, out: PreviewLine[]): void {
  switch (block.kind) {
    case "heading":
      out.push({ style: "heading", text: flatten(block.children) });
      return;
    case "paragraph":
      out.push({ style: "body", text: flatten(block.children) });
      return;
    case "list":
      for (const item of block.items) {
        const first = item[0];
        const text =
          first === undefined
            ? ""
            : first.kind === "paragraph" || first.kind === "heading"
              ? flatten(first.children)
              : "";
        out.push({ style: "bullet", text });
      }
      return;
    case "code":
      for (const line of block.text.split("\n")) {
        out.push({ style: "mono", text: line });
      }
      return;
    case "table":
      out.push({ style: "mono", text: block.header.join("  ") });
      return;
    case "quote":
      for (const child of block.children) {
        blockLines(child, out);
      }
      return;
    case "literal":
      out.push({ style: "body", text: block.text });
      return;
    case "rule":
      return;
  }
}

/**
 * The first lines of a markdown or text file, as the band draws them: markdown
 * through the transcript's own parser (headings, paragraphs, bullets; inline
 * marks dropped), text as mono lines. Blank lines are skipped, at most
 * `PREVIEW_LINES`; an empty file says so (never an empty box).
 */
export function previewLines(kind: "markdown" | "text", text: string): readonly PreviewLine[] {
  const out: PreviewLine[] = [];
  if (kind === "markdown") {
    const parsed = parse(text);
    if (parsed.kind === "blocks") {
      for (const block of parsed.blocks) {
        blockLines(block, out);
        if (out.length >= PREVIEW_LINES) {
          break;
        }
      }
    } else {
      for (const line of parsed.shown.split("\n")) {
        out.push({ style: "body", text: line });
      }
    }
  } else {
    for (const line of text.split("\n")) {
      out.push({ style: "mono", text: line });
    }
  }
  const lines = out
    .map((line) => ({ style: line.style, text: line.text.trimEnd() }))
    .filter((line) => line.text.trim() !== "")
    .slice(0, PREVIEW_LINES);
  return lines.length === 0 ? EMPTY_LINES : lines;
}

/** What the band holds. */
export type BandFill =
  | { readonly kind: "loading" }
  | { readonly kind: "symbol" }
  /** An image, `cover`-centred in the band. */
  | { readonly kind: "picture"; readonly uri: string; readonly align: "cover" }
  /** A page drawn at the band's width, its TOP at the band's top (`drawnHeight` tall). */
  | {
      readonly kind: "picture";
      readonly uri: string;
      readonly align: "top";
      readonly drawnHeight: number;
    }
  | { readonly kind: "lines"; readonly lines: readonly PreviewLine[] };

export interface PreviewCardView {
  /** Core's card (title, line 2 with the page count, action). */
  readonly card: ArtifactCardView;
  /** The kind's symbol, in the meta row (and the band, while it has no pixels). */
  readonly symbol: IconName;
  /** The band above the meta row, or `null` (gone, or a kind with no preview). */
  readonly band: { readonly height: number; readonly fill: BandFill } | null;
  /** Gone: the title and symbol step back; the words "no longer available" say why. */
  readonly dim: boolean;
  /** `chevron` opens, `share` shares (`other`), `null` nothing to do. */
  readonly trailing: "chevron" | "share" | null;
  readonly disabled: boolean;
  readonly a11yLabel: string;
}

function readyFill(meta: ArtifactMeta, preview: ArtifactPreview, width: number): BandFill {
  if (preview.kind === "lines") {
    const kind = artifactKindOf(meta) === "markdown" ? "markdown" : "text";
    return { kind: "lines", lines: previewLines(kind, preview.text) };
  }
  if (previewSource(meta) === "image") {
    return { kind: "picture", uri: preview.uri, align: "cover" };
  }
  // A page: drawn at the band's width, cut at its bottom. Without a size, the
  // page shape QuickLook was asked for.
  const ratio = preview.width && preview.height ? preview.height / preview.width : PAGE_ASPECT;
  return {
    kind: "picture",
    uri: preview.uri,
    align: "top",
    drawnHeight: Math.round(width * ratio),
  };
}

/**
 * The whole card for one presented file in one state. `width` is the band's
 * (the row's width), so a page's drawn height can be computed here.
 */
export function previewCardView(
  meta: ArtifactMeta,
  status: PreviewStatus,
  width: number,
  options: { readonly origin?: "local" | "pod" } = {},
): PreviewCardView {
  const pages =
    status.kind === "ready" && status.preview.kind === "picture" ? status.preview.pages : undefined;
  const card = artifactCard(meta, {
    ...(status.kind === "gone" ? { state: "unavailable" as const } : {}),
    ...(options.origin === undefined ? {} : { origin: options.origin }),
    ...(pages === undefined ? {} : { pages }),
  });
  const symbol = previewSymbol(card.kind);
  const a11yLabel = `${card.title}, ${card.line2}`;
  if (status.kind === "gone") {
    return { card, symbol, band: null, dim: true, trailing: null, disabled: true, a11yLabel };
  }
  const trailing: PreviewCardView["trailing"] =
    card.action === "save" ? "share" : card.action === "open" ? "chevron" : null;
  const base = { card, symbol, dim: false, trailing, disabled: trailing === null, a11yLabel };
  if (previewSource(meta) === "none") {
    return { ...base, band: null };
  }
  const height = bandHeight(meta, width);
  const fill: BandFill =
    status.kind === "loading"
      ? { kind: "loading" }
      : status.kind === "failed"
        ? { kind: "symbol" }
        : readyFill(meta, status.preview, width);
  return { ...base, band: { height, fill } };
}
