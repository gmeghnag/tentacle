/**
 * docs/feat/model-diagrams.md D6/T6 — the hidden renderer's page and driver,
 * pure. The driver is plain JS that runs inside the WebView; here it runs in Bun
 * against a fake `mermaid` and a fake bridge, so its message shape is checked
 * against the app's own validator (`parseDiagramReply`), not against a copy.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDiagramReply } from "../src/diagram-bridge.ts";
import {
  DIAGRAM_DRIVER,
  RENDERER_GLOBAL,
  RENDERER_PAGE_PATH,
  renderRequestScript,
  rendererPage,
  rendererPageVersion,
  svgViewBoxSize,
} from "../src/diagram-renderer-page.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320.5 180"><g/></svg>';

interface FakeWindow {
  ReactNativeWebView: { postMessage(data: string): void };
  [key: string]: unknown;
}

/** Run the driver with a fake mermaid; return the window and the posted messages. */
function runDriver(render: (id: string, source: string) => Promise<{ svg: string }>) {
  const posted: unknown[] = [];
  const configs: unknown[] = [];
  const window: FakeWindow = {
    ReactNativeWebView: { postMessage: (data: string) => posted.push(JSON.parse(data)) },
  };
  const mermaid = { initialize: (c: unknown) => configs.push(c), render };
  new Function("window", "mermaid", DIAGRAM_DRIVER)(window, mermaid);
  const draw = window[RENDERER_GLOBAL] as (req: unknown) => void;
  return { posted, configs, draw };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the driver: one request, one answer of the bridge's shape", () => {
  test("a drawn diagram answers {id, ok, svg, w, h} that the bridge accepts", async () => {
    const { posted, configs, draw } = runDriver(async () => ({ svg: SVG }));
    draw({ id: "r1", source: "flowchart TD\nA-->B", variables: { fontFamily: "Menlo" } });
    await settle();
    expect(posted).toEqual([{ id: "r1", ok: true, svg: SVG, w: 320.5, h: 180 }]);
    expect(parseDiagramReply(posted[0], new Set(["r1"]))).not.toBeNull();
    expect(configs[0]).toMatchObject({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      themeVariables: { fontFamily: "Menlo" },
    });
  });

  test("a mermaid refusal answers {id, ok:false, line, message} with jison's line", async () => {
    const { posted, draw } = runDriver(async () => {
      throw Object.assign(new Error("Parse error on line 3:\n...A --> C(x"), {
        hash: { loc: { first_line: 3 } },
      });
    });
    draw({ id: "r2", source: "x", variables: {} });
    await settle();
    expect(posted).toEqual([{ id: "r2", ok: false, line: 3, message: "Parse error on line 3:" }]);
    expect(parseDiagramReply(posted[0], new Set(["r2"]))).not.toBeNull();
  });

  test("an error with no line (or a thrown non-Error) answers line 0 and a sentence", async () => {
    const { posted, draw } = runDriver(async () => {
      throw "boom";
    });
    draw({ id: "r3", source: "x", variables: {} });
    await settle();
    expect(posted).toEqual([{ id: "r3", ok: false, line: 0, message: "boom" }]);
  });

  test("an SVG without a viewBox is a refusal, never a size the app guesses", async () => {
    const { posted, draw } = runDriver(async () => ({ svg: "<svg><g/></svg>" }));
    draw({ id: "r4", source: "x", variables: {} });
    await settle();
    expect(posted).toEqual([{ id: "r4", ok: false, line: 0, message: "the drawing has no size" }]);
  });

  test("requests are drawn one at a time, in order", async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const { posted, draw } = runDriver(
      (id, source) =>
        new Promise((resolve) => {
          order.push(source);
          if (source === "first") release = () => resolve({ svg: SVG });
          else resolve({ svg: SVG });
        }),
    );
    draw({ id: "a", source: "first", variables: {} });
    draw({ id: "b", source: "second", variables: {} });
    await settle();
    expect(order).toEqual(["first"]);
    release();
    await settle();
    await settle();
    expect(order).toEqual(["first", "second"]);
    expect(posted.map((m) => (m as { id: string }).id)).toEqual(["a", "b"]);
  });
});

describe("the request script: the source is data, never code", () => {
  test("a hostile source reaches the driver byte-for-byte", () => {
    const source = 'flowchart TD\nA["x"]);alert(1);//</script> `${y}`\\';
    const req = { id: "k", source, variables: { fontFamily: 'Menlo, "x"' } };
    let got: unknown;
    const window = {
      [RENDERER_GLOBAL]: (r: unknown) => {
        got = r;
      },
    };
    const script = renderRequestScript(req);
    new Function("window", script)(window);
    expect(got).toEqual(req);
    // injectJavaScript wants the script's completion value to be a primitive.
    expect(script.endsWith(";true;")).toBe(true);
  });
});

describe("the page", () => {
  test("library, then driver; the version is in the header", () => {
    const page = rendererPage({ js: "var mermaid={};", version: "11.17.2" });
    expect(rendererPageVersion(page)).toBe("11.17.2");
    expect(page.indexOf("var mermaid={};")).toBeLessThan(page.indexOf(DIAGRAM_DRIVER));
    expect(page).not.toMatch(/<meta http-equiv/i); // the CSP is the app's prefix, at load
  });

  test("a library that could close its <script> is refused, not rewritten", () => {
    expect(() => rendererPage({ js: 'x="</script>"', version: "1.0.0" })).toThrow();
    expect(() => rendererPage({ js: 'x="<SCRIPT"', version: "1.0.0" })).toThrow();
    expect(() => rendererPage({ js: "x", version: "1.0.0 -->" })).toThrow();
  });

  test("viewBox sizes: the root's own, finite and positive, or null", () => {
    expect(svgViewBoxSize(SVG)).toEqual({ width: 320.5, height: 180 });
    expect(svgViewBoxSize('<svg viewBox="0,0,10,20"/>')).toEqual({ width: 10, height: 20 });
    expect(svgViewBoxSize('<svg viewBox="0 0 0 20"></svg>')).toBeNull();
    expect(svgViewBoxSize('<svg viewBox="0 0 NaN 20"></svg>')).toBeNull();
    expect(svgViewBoxSize('<svg><svg viewBox="0 0 5 5"/></svg>')).toBeNull();
  });
});

describe("the generated asset (T2.6, the phone's half of the one-version pin)", () => {
  const committed = readFileSync(join(ROOT, RENDERER_PAGE_PATH), "utf8");
  const tools = JSON.parse(readFileSync(join(ROOT, "packages/tools/package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };

  test("its mermaid is the daemon's exact pin", () => {
    expect(rendererPageVersion(committed)).toBe(tools.dependencies.mermaid ?? "missing");
  });

  test("it is the generator's output for the installed mermaid (never hand-edited)", () => {
    const dir = join(ROOT, "packages/tools/node_modules/mermaid");
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string };
    const js = readFileSync(join(dir, "dist/mermaid.min.js"), "utf8");
    const fresh = rendererPage({ js, version: pkg.version });
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    expect(sha(committed)).toBe(sha(fresh));
  });
});
