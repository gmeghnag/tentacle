/**
 * The hidden diagram renderer's page (docs/feat/model-diagrams.md D6, Owner Q2a):
 * the bundled mermaid + a small driver, and the one script the app injects per
 * render. Pure — the generator (`scripts/gen-diagram-renderer.ts`) writes the
 * page, the app loads it under `artifactCsp()` (prepended at load by
 * `htmlViewerProps`, so the CSP is the document's first bytes).
 *
 * The driver answers each request with EXACTLY one message of the shape
 * `diagram-bridge.ts` accepts. The request reaches it as a JSON literal — the
 * model's source is data, never spliced into code.
 */

/** The page, relative to the repo root (the generator writes it, a test pins it). */
export const RENDERER_PAGE_PATH = "apps/mobile/assets/diagram/renderer.html";

/** The driver's entry point on `window`. */
export const RENDERER_GLOBAL = "__tentacleDiagram";

/** The root `<svg …>` tag's `viewBox` (the root's own: the match is anchored). */
const VIEWBOX = /^\s*<svg\b[^>]*?\sviewBox="([^"]*)"/i;

/** The drawing's size from its root `viewBox`, or `null` (missing, not 4 numbers, ≤ 0). */
export function svgViewBoxSize(svg: string): { width: number; height: number } | null {
  const match = VIEWBOX.exec(svg);
  const parts = (match?.[1] ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const [, , width, height] = parts;
  if (parts.length !== 4 || width === undefined || height === undefined) return null;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}

/**
 * The driver (ES2017, runs in WKWebView): a serial queue, one `mermaid.render`
 * per request, one answer per request. A refusal carries jison's 1-based
 * `hash.loc.first_line` when there is one, else 0; the size is the root viewBox
 * (the same pattern as {@link svgViewBoxSize}).
 */
export const DIAGRAM_DRIVER = `(function () {
  var bridge = window.ReactNativeWebView;
  var VIEWBOX = new RegExp(${JSON.stringify(VIEWBOX.source)}, "i");
  var queue = Promise.resolve();
  var seq = 0;
  function post(message) { bridge.postMessage(JSON.stringify(message)); }
  function lineOf(error) {
    var loc = error && error.hash && error.hash.loc;
    var line = loc && loc.first_line;
    return typeof line === "number" && line >= 0 && line % 1 === 0 ? line : 0;
  }
  function sentence(error) {
    var text = String((error && error.message) || error || "");
    return text.split("\\n")[0] || "Mermaid could not draw this";
  }
  function sizeOf(svg) {
    var match = VIEWBOX.exec(svg);
    var parts = match ? match[1].trim().split(/[\\s,]+/).map(Number) : [];
    if (parts.length !== 4 || !(parts[2] > 0) || !(parts[3] > 0)) return null;
    if (!isFinite(parts[2]) || !isFinite(parts[3])) return null;
    return parts;
  }
  function draw(req) {
    seq += 1;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      themeVariables: req.variables,
      fontFamily: req.variables.fontFamily,
      maxEdges: 500
    });
    return Promise.resolve()
      .then(function () { return mermaid.render("tentacle-d" + seq, req.source); })
      .then(function (out) {
        var svg = String((out && out.svg) || "");
        var size = sizeOf(svg);
        if (size === null) {
          post({ id: req.id, ok: false, line: 0, message: "the drawing has no size" });
          return;
        }
        post({ id: req.id, ok: true, svg: svg, w: size[2], h: size[3] });
      }, function (error) {
        post({ id: req.id, ok: false, line: lineOf(error), message: sentence(error) });
      });
  }
  window[${JSON.stringify(RENDERER_GLOBAL)}] = function (req) {
    queue = queue.then(function () { return draw(req); }, function () { return draw(req); });
  };
})();`;

/** What the app asks the renderer for: an id it will accept the answer of. */
export interface DiagramRenderRequest {
  readonly id: string;
  /** The canonical source (the lint's own form). */
  readonly source: string;
  /** Mermaid `themeVariables` (`diagram-theme.ts`). */
  readonly variables: Readonly<Record<string, string>>;
}

/**
 * The script `injectJavaScript` runs: one call with the request as a JSON
 * literal (quotes, backslashes and line separators escaped by `JSON.stringify`),
 * ending in `true` as react-native-webview asks.
 */
export function renderRequestScript(req: DiagramRenderRequest): string {
  const data = { id: req.id, source: req.source, variables: req.variables };
  return `window[${JSON.stringify(RENDERER_GLOBAL)}](${JSON.stringify(data)});true;`;
}

const HEADER = /^<!-- tentacle diagram renderer · mermaid ([0-9A-Za-z.+-]+) ·/;

/** The mermaid version the page was generated from (its header), or `null`. */
export function rendererPageVersion(page: string): string | null {
  return HEADER.exec(page)?.[1] ?? null;
}

/**
 * The page: header (version), the library, the driver. A library that could end
 * (or re-open) its `<script>` element is refused: rewriting minified code to
 * escape it is a bet on its grammar, and mermaid 11 has no such sequence.
 */
export function rendererPage(lib: { readonly js: string; readonly version: string }): string {
  if (/<\/?script/i.test(lib.js)) {
    throw new Error("the mermaid bundle contains a <script> tag sequence; refusing to inline it");
  }
  if (!/^[0-9A-Za-z.+-]+$/.test(lib.version)) {
    throw new Error(`not a version: ${lib.version}`);
  }
  return [
    `<!-- tentacle diagram renderer · mermaid ${lib.version} · generated by apps/mobile/scripts/gen-diagram-renderer.ts — do not edit -->`,
    '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>',
    `<script>${lib.js}</script>`,
    `<script>${DIAGRAM_DRIVER}</script>`,
    "</body></html>",
    "",
  ].join("\n");
}
