/**
 * How a rendered diagram is shown (docs/feat/model-diagrams.md D6, mockups 1A/3A/4A),
 * pure: the inline box and the two WebViews' props.
 *
 * Owner Q2a: the hidden renderer is the ONLY WebView with scripts; the display
 * is the artifacts viewer's isolation with scripts off (`htmlViewerProps`, so
 * one CSP and one flag set), so even a hostile SVG is inert there.
 */
import { type WebViewPropsData, htmlViewerProps } from "./artifact-viewer.ts";
import { chartLang } from "./chart-hero.ts";
import type { DiagramRender } from "./diagram-cache.ts";

/** Owner Q6: a diagram taller than this inline is cut, faded, and opens full screen. */
export const DIAGRAM_INLINE_MAX_HEIGHT = 420;

/** The placeholder's aspect while a render is on its way (a hairline, no spinner). */
const PLACEHOLDER_ASPECT = 0.5;

export interface DiagramInlineBox {
  readonly width: number;
  readonly height: number;
  /** Taller than the cap: the row fades the bottom and offers full screen. */
  readonly clipped: boolean;
}

/** The inline box for a render (or `null` while rendering) in `available` points. */
export function diagramInlineBox(
  render: DiagramRender | null,
  available: number,
): DiagramInlineBox {
  if (render === null) {
    const height = Math.round(Math.min(available * PLACEHOLDER_ASPECT, DIAGRAM_INLINE_MAX_HEIGHT));
    return { width: available, height, clipped: false };
  }
  // Never upscale: a small diagram stays its own size (mermaid's `max-width`).
  const width = Math.min(available, render.width);
  const natural = (width * render.height) / render.width;
  const clipped = natural > DIAGRAM_INLINE_MAX_HEIGHT;
  return {
    width: Math.round(width),
    height: Math.round(clipped ? DIAGRAM_INLINE_MAX_HEIGHT : natural),
    clipped,
  };
}

/** A palette colour, or `transparent` (the value is spliced into a `<style>`). */
function cssColor(value: string): string {
  return /^#[0-9A-Fa-f]{3,8}$/.test(value) ? value : "transparent";
}

export interface DiagramDisplayOptions {
  /** The page colour behind the drawing (no card: the conversation background). */
  readonly background: string;
  /** Full screen: pinch up to 6× and double-tap. Inline: a fixed picture. */
  readonly zoom: boolean;
}

/** The inert display: CSP first, scripts OFF, no bridge, the artifacts predicate. */
export function diagramDisplayProps(svg: string, options: DiagramDisplayOptions): WebViewPropsData {
  const viewport = options.zoom
    ? "width=device-width, initial-scale=1, maximum-scale=6, user-scalable=yes"
    : "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no";
  const style = `html,body{margin:0;padding:0;background:${cssColor(options.background)}}svg{display:block;margin:0 auto;width:100%;height:auto}`;
  const body = `<meta name="viewport" content="${viewport}"><style>${style}</style>${svg}`;
  return htmlViewerProps({ body, network: false, scripts: false });
}

/** The hidden renderer: our generated page, offline, scripts ON (mermaid needs them). */
export function diagramRendererProps(page: string): WebViewPropsData {
  return htmlViewerProps({ body: page, network: false, scripts: true });
}

const UI = {
  it: {
    diagram: "Diagramma",
    source: "Sorgente",
    share: "Condividi",
    copySource: "Copia sorgente",
    close: "Chiudi",
    zoomHint: "tocca per ingrandire",
    open: "Apri a schermo intero",
    showSource: "Mostra sorgente",
  },
  en: {
    diagram: "Diagram",
    source: "Source",
    share: "Share",
    copySource: "Copy source",
    close: "Close",
    zoomHint: "tap to zoom",
    open: "Open full screen",
    showSource: "Show source",
  },
} as const;

export type DiagramUiWords = (typeof UI)["it" | "en"];

/** The words of the diagram UI, in the chart's language rule (it, else en). */
export function diagramUiWords(locale: string): DiagramUiWords {
  return UI[chartLang(locale)];
}

/** The caption above a diagram (mockup 1A): `title · type`, mono, centred. */
export function diagramCaption(view: { readonly title: string; readonly type: string }): string {
  return `${view.title} · ${view.type}`;
}

export type DiagramShareContent =
  | { readonly title: string; readonly url: string }
  | { readonly title: string; readonly message: string };

/** What Share sends: the rendered SVG file when it is on disk, else the source text. */
export function diagramShare(
  view: { readonly title: string; readonly source: string },
  fileUri: string | null,
): DiagramShareContent {
  return fileUri === null
    ? { title: view.title, message: view.source }
    : { title: view.title, url: fileUri };
}

/** VoiceOver: one element; activate opens it, a custom action opens its source. */
export function diagramA11yActions(
  words: DiagramUiWords,
): readonly { readonly name: string; readonly label: string }[] {
  return [
    { name: "activate", label: words.open },
    { name: "showSource", label: words.showSource },
  ];
}

/** Which full-screen tab an accessibility action opens, or `null` (not ours). */
export function diagramA11yEffect(action: string): "diagram" | "source" | null {
  if (action === "activate") return "diagram";
  if (action === "showSource") return "source";
  return null;
}
