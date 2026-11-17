/**
 * docs/feat/model-diagrams.md D6/T6.1 — the diagram WebViews' isolation, pinned
 * from the SOURCE (the `.tsx` are unimportable from Bun: React Native is Flow),
 * the `artifact-viewers-wiring.test.ts` pattern. Owner Q2a:
 *  - the display (`DiagramView`) is inert: scripts off through the pure
 *    `diagramDisplayProps`, no bridge, no injected script;
 *  - the hidden `DiagramRenderer` is the ONLY WebView with `onMessage`, and it
 *    hands the data to the service, which validates it (`parseDiagramReply`);
 *  - every WebView spreads the pure flags and routes navigation through the
 *    artifacts predicate, overriding nothing after the spread;
 *  - the transcript branches `diagram` calls into the diagram row, and the
 *    session screen mounts the one renderer.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const read = (path: string) => readFileSync(join(SRC, path), "utf8");
const code = (path: string) => read(path).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sources(join(dir, e.name))
      : /\.tsx?$/.test(e.name)
        ? [relative(SRC, join(dir, e.name))]
        : [],
  );
}

/** Every `<WebView …/>` element in a source, verbatim. */
function webViews(text: string): string[] {
  const out: string[] = [];
  let at = text.indexOf("<WebView");
  while (at !== -1) {
    const end = text.indexOf("/>", at);
    expect(end).toBeGreaterThan(at);
    out.push(text.slice(at, end));
    at = text.indexOf("<WebView", end);
  }
  return out;
}

const RENDERER = "ui/diagram/DiagramRenderer.tsx";
const DISPLAY = "ui/diagram/DiagramView.tsx";
const DIAGRAM_UI = [
  RENDERER,
  DISPLAY,
  "ui/diagram/DiagramBlock.tsx",
  "ui/diagram/DiagramFullScreen.tsx",
];

describe("diagram WebViews: one renderer with a bridge, an inert display", () => {
  test("the display's props are the pure inert ones (scripts off)", () => {
    expect(code(DISPLAY)).toContain(
      "diagramDisplayProps(p.svg, { background: p.background, zoom: p.zoom })",
    );
    const display = code("diagram-display.ts");
    expect(display).toContain("return htmlViewerProps({ body, network: false, scripts: false });");
    expect(display).toContain(
      "return htmlViewerProps({ body: page, network: false, scripts: true });",
    );
    // Scripts ON appears exactly once in the module: the renderer's builder.
    expect(display.match(/scripts: true/g)?.length).toBe(1);
    expect(code(RENDERER)).toContain("diagramRendererProps(page)");
  });

  test("each WebView spreads the flags, uses the predicate, overrides nothing", () => {
    for (const file of [RENDERER, DISPLAY]) {
      const sites = webViews(code(file));
      expect(sites.length).toBe(1);
      for (const site of sites) {
        expect(site).toContain("source={source}");
        expect(site).toContain("{...flags}");
        expect(site).toMatch(
          /onShouldStartLoadWithRequest=\{\(request(: \{ url: string \})?\) => allow\(request\.url\)\}/,
        );
        const after = site.slice(site.indexOf("{...flags}") + "{...flags}".length);
        const props = [...after.matchAll(/^\s+([A-Za-z]\w*)\s*(?:=|$)/gm)].map((m) => m[1]);
        expect(props.sort()).toEqual(["onShouldStartLoadWithRequest", "originWhitelist"]);
      }
      expect(code(file)).toContain("navigationPredicate(data)");
      expect(code(file)).toContain("webViewParts(data)");
    }
  });

  test("only the renderer has onMessage, and it goes to the validating service", () => {
    const withBridge = sources(SRC).filter((f) => code(f).includes("onMessage"));
    expect(withBridge).toEqual([RENDERER]);
    expect(code(RENDERER)).toContain("diagramRenderService.receive(event.nativeEvent.data)");
    expect(code("diagram-render-service.ts")).toContain(
      "parseDiagramReply(raw, new Set([inFlight.id]))",
    );
  });

  test("no injected script, window hook, Linking or wider file access in the diagram UI", () => {
    const banned = [
      "injectedJavaScript",
      "onOpenWindow",
      "allowingReadAccessToURL",
      "allowUniversalAccessFromFileURLs",
      "allowFileAccessFromFileURLs",
      "Linking",
      "postMessage",
    ];
    for (const file of DIAGRAM_UI) {
      for (const word of banned) {
        expect({ file, word, found: code(file).includes(word) }).toEqual({
          file,
          word,
          found: false,
        });
      }
    }
    // The display and the full screen never reach the renderer's bridge at all.
    for (const file of [DISPLAY, "ui/diagram/DiagramFullScreen.tsx"]) {
      expect(code(file)).not.toMatch(/onMessage|injectJavaScript|diagramRenderService/);
    }
  });

  test("the renderer is asked only through the request script (the source as JSON)", () => {
    expect(code("diagram-render-service.ts")).toContain("port.inject(renderRequestScript({");
    expect(code(RENDERER)).toContain("inject: (script) => view.current?.injectJavaScript(script)");
  });

  test("the transcript branches diagram calls; the session screen mounts one renderer", () => {
    const row = code("screens/transcript/TranscriptRow.tsx");
    expect(row).toContain(
      "if (props.row.name === DIAGRAM_TOOL) return <DiagramRowView {...props} />;",
    );
    expect(row).toContain("if (view === null) {\n    return <ToolRowView {...props} />;");
    const screen = code("screens/SessionScreen.tsx");
    expect(screen.match(/<DiagramRenderer \/>/g)?.length).toBe(1);
  });
});
