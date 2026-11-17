/**
 * S8 of docs/feat/model-artifacts.md — the artifact viewers' isolation, pinned
 * from the SOURCE (the `.tsx` are unimportable from Bun: React Native is Flow),
 * like `header-wiring.test.ts`. The decisions live in `artifact-viewer.ts`
 * (asserted as values in `artifact-viewer.test.ts`); this pins that the
 * components apply them and add nothing that re-opens an escape:
 *  - every `<WebView>` spreads the pure flags, routes navigation through the
 *    pure predicate, and overrides nothing after the spread;
 *  - no bridge (`onMessage`), no injected script, no `onOpenWindow`, no wider
 *    file access, no `Linking` anywhere under `screens/artifacts/`;
 *  - `react-native-webview` is pinned EXACT and imported only by the two viewers.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const APP = join(import.meta.dir, "..");
const DIR = join(APP, "src", "screens", "artifacts");
const read = (path: string) => readFileSync(path, "utf8");
const viewers = readdirSync(DIR).filter((f) => f.endsWith(".tsx"));
const source = (file: string) => read(join(DIR, file));

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

/** Every `.ts`/`.tsx` under `src`, recursively. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sources(join(dir, e.name))
      : /\.tsx?$/.test(e.name)
        ? [join(dir, e.name)]
        : [],
  );
}

describe("artifact viewers: the WebView isolation is the pure module's", () => {
  test("the five viewers and the header exist", () => {
    for (const file of [
      "ImageViewer.tsx",
      "HtmlViewer.tsx",
      "PdfViewer.tsx",
      "MarkdownViewer.tsx",
      "OtherSheet.tsx",
      "ViewerHeader.tsx",
    ]) {
      expect(viewers).toContain(file);
    }
  });

  test("each WebView spreads the flags, uses the predicate, overrides nothing", () => {
    const sites = ["HtmlViewer.tsx", "PdfViewer.tsx"].flatMap((f) => webViews(source(f)));
    expect(sites.length).toBe(2);
    for (const site of sites) {
      expect(site).toContain("source={source}");
      expect(site).toContain("{...flags}");
      expect(site).toContain("onShouldStartLoadWithRequest={(request) => allow(request.url)}");
      const after = site.slice(site.indexOf("{...flags}") + "{...flags}".length);
      // After the spread: only the predicate and the (same) whitelist, copied
      // mutable for the library's type. No isolation flag is re-set.
      // Every line that starts a prop, `name=` OR a bare boolean `name`.
      const props = [...after.matchAll(/^\s+([A-Za-z]\w*)\s*(?:=|$)/gm)].map((m) => m[1]);
      expect(props.sort()).toEqual(["onShouldStartLoadWithRequest", "originWhitelist"]);
      expect(after).toContain("originWhitelist={[...flags.originWhitelist]}");
    }
  });

  test("the predicate and flags come from the pure builders", () => {
    expect(source("HtmlViewer.tsx")).toContain(
      "htmlViewerProps({ body, network, scripts: scripts && runScripts })",
    );
    expect(source("PdfViewer.tsx")).toContain("pdfViewerProps(fileUri)");
    for (const f of ["HtmlViewer.tsx", "PdfViewer.tsx"]) {
      expect(source(f)).toContain("navigationPredicate(data)");
      expect(source(f)).toContain("webViewParts(data)");
    }
  });

  /**
   * Finding 2 of the S8+S9 Review: the fallback must be SWITCHABLE, and the
   * default must be the safe one. Scripts start off (`useState(false)` on the
   * tap, and the pure `viewerFor` never asks for them) and the viewer renders a
   * one-tap control that reaches `javaScriptEnabled` through the builders —
   * never a hard-coded `scripts: true`.
   */
  test("scripts are OFF until the person taps, and the tap is the only switch", () => {
    const html = source("HtmlViewer.tsx");
    expect(html).toContain("const [runScripts, setRunScripts] = useState(false)");
    expect(html).toContain('testID="artifact-scripts-run"');
    expect(html).toContain('"artifact-scripts-off"');
    expect(html).toContain("askScripts");
    // The variable frame must carry BOTH per-open states, or a tap on one
    // reloads away the other.
    expect(html).toMatch(/key=\{`\$\{network \? "online" : "offline"\}-\$\{runScripts \?/);
    // Never a stored setting, and never scripts on without the tap.
    expect(html).not.toMatch(/SecureKV|AsyncStorage|SecureStore/);
    expect(html).not.toContain("scripts: true");
  });

  test("no bridge, no injected script, no window hook, no Linking, no wider file access", () => {
    const banned = [
      "onMessage",
      "injectedJavaScript",
      "onOpenWindow",
      "allowingReadAccessToURL",
      "allowUniversalAccessFromFileURLs",
      "allowFileAccessFromFileURLs",
      "Linking",
      "postMessage",
    ];
    for (const file of viewers) {
      const code = source(file).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      for (const word of banned) {
        expect({ file, word, found: code.includes(word) }).toEqual({ file, word, found: false });
      }
    }
  });

  test("network is per open: state, never a stored setting", () => {
    const html = source("HtmlViewer.tsx");
    expect(html).toContain("useState(false)");
    expect(html).not.toMatch(/SecureKV|AsyncStorage|SecureStore|settings/);
  });

  test("the image viewer zooms natively on the soft dark ground (never pure black)", () => {
    const image = source("ImageViewer.tsx");
    expect(image).toContain("maximumZoomScale={6}");
    expect(image).toContain('"#1F1F1E"');
    expect(image).not.toMatch(/#000\b|#000000|"black"/);
  });
});

describe("react-native-webview: pinned and contained", () => {
  test("pinned EXACT (a new native module = a new dev build; no silent drift)", () => {
    const pkg = JSON.parse(read(join(APP, "package.json"))) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["react-native-webview"]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("imported only by the two isolated viewers", () => {
    const importers = sources(join(APP, "src"))
      .filter((f) => read(f).includes('from "react-native-webview"'))
      .map((f) => f.slice(DIR.length + 1))
      .sort();
    expect(importers).toEqual(["HtmlViewer.tsx", "PdfViewer.tsx"]);
  });

  // docs/fix/mobile-qa-sweep.md bug 2: the body is the pure `viewerBody`'s, and
  // the modal keeps no file check of its own (the one that hid every HTML page).
  test("the modal's body is decided by viewerBody, with no inline file check", () => {
    const modal = source("ArtifactViewerModal.tsx");
    expect(modal).toContain("viewerBody(phase, choice.kind, target)");
    expect(modal).not.toMatch(/fileUri === ""/);
    expect(modal).not.toMatch(/choice\.kind === "(image|pdf|webview|chart|none)"/);
  });
});
