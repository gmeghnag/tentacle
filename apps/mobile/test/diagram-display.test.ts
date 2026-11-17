/**
 * docs/feat/model-diagrams.md D6/T6 — the display decisions, pure: the inline
 * box (Owner Q6: 420 pt, then a fade + "tap to zoom"), and the WebView props of
 * the inert display and of the hidden renderer, both built by the artifacts
 * viewer's own `htmlViewerProps` (one isolation, one CSP).
 */
import { describe, expect, test } from "bun:test";
import { artifactCsp } from "@tentacle/core";
import { navigationPredicate } from "../src/artifact-viewer.ts";
import {
  DIAGRAM_INLINE_MAX_HEIGHT,
  diagramA11yActions,
  diagramA11yEffect,
  diagramBlockBody,
  diagramCaption,
  diagramDisplayProps,
  diagramInlineBox,
  diagramRendererProps,
  diagramShare,
  diagramUiWords,
} from "../src/diagram-display.ts";

const SVG = '<svg viewBox="0 0 400 200"><script>alert(1)</script></svg>';

describe("inline box", () => {
  test("fits the width, never upscales, keeps the aspect", () => {
    expect(diagramInlineBox({ svg: SVG, width: 400, height: 200 }, 300)).toEqual({
      width: 300,
      height: 150,
      clipped: false,
    });
    expect(diagramInlineBox({ svg: SVG, width: 120, height: 60 }, 300)).toEqual({
      width: 120,
      height: 60,
      clipped: false,
    });
  });

  test("a tall diagram stops at 420 pt and says it is clipped", () => {
    expect(DIAGRAM_INLINE_MAX_HEIGHT).toBe(420);
    expect(diagramInlineBox({ svg: SVG, width: 300, height: 1200 }, 300)).toEqual({
      width: 300,
      height: 420,
      clipped: true,
    });
    expect(diagramInlineBox({ svg: SVG, width: 300, height: 420 }, 300).clipped).toBe(false);
    // Just above the cap (not only far above it): one point more is already cut.
    expect(diagramInlineBox({ svg: SVG, width: 300, height: 421 }, 300)).toEqual({
      width: 300,
      height: 420,
      clipped: true,
    });
  });

  test("while rendering: a placeholder of an estimated height, never above the cap", () => {
    const box = diagramInlineBox(null, 360);
    expect(box.height).toBeGreaterThan(0);
    expect(box.height).toBeLessThanOrEqual(DIAGRAM_INLINE_MAX_HEIGHT);
    expect(box.clipped).toBe(false);
    expect(diagramInlineBox(null, 2000).height).toBe(DIAGRAM_INLINE_MAX_HEIGHT);
  });
});

describe("the display WebView is inert", () => {
  test("scripts off, offline CSP first, the artifacts flags and predicate", () => {
    const props = diagramDisplayProps(SVG, { background: "#1F1F1E", zoom: false });
    expect(props.javaScriptEnabled).toBe(false);
    expect(props.html?.startsWith(artifactCsp())).toBe(true);
    expect(props.html).toContain(SVG);
    expect(props.incognito).toBe(true);
    expect(props.allowFileAccess).toBe(false);
    expect(props.originWhitelist).toEqual(["*"]);
    const allow = navigationPredicate(props);
    expect(allow("about:blank")).toBe(true);
    expect(allow("https://example.com")).toBe(false);
  });

  test("zoom is the full screen's: inline is not scalable, full screen up to 6×", () => {
    const inline = diagramDisplayProps(SVG, { background: "#FFFFFF", zoom: false }).html ?? "";
    const full = diagramDisplayProps(SVG, { background: "#FFFFFF", zoom: true }).html ?? "";
    expect(inline).toContain("user-scalable=no");
    expect(full).toContain("maximum-scale=6");
    expect(full).toContain("user-scalable=yes");
  });

  test("the background is a colour or nothing (it is spliced into a <style>)", () => {
    const bad = diagramDisplayProps(SVG, { background: "red}</style><script>x()", zoom: false });
    expect(bad.html).not.toContain("x()");
    expect(bad.html).toContain("background:transparent");
    const good = diagramDisplayProps(SVG, { background: "#F2F1EC", zoom: false });
    expect(good.html).toContain("background:#F2F1EC");
  });
});

describe("words, caption, share, VoiceOver", () => {
  test("Italian and English words (the chart's language rule)", () => {
    expect(diagramUiWords("it-IT").diagram).toBe("Diagramma");
    expect(diagramUiWords("it-IT").source).toBe("Sorgente");
    expect(diagramUiWords("it-IT").zoomHint).toBe("tocca per ingrandire");
    expect(diagramUiWords("en-US").source).toBe("Source");
  });

  test("the caption is title · type", () => {
    expect(diagramCaption({ title: "Login", type: "sequenceDiagram" })).toBe(
      "Login · sequenceDiagram",
    );
  });

  test("share: the SVG file when it is on disk, else the source as text", () => {
    expect(diagramShare({ title: "T", source: "flowchart TD" }, "file:///c/d.svg")).toEqual({
      title: "T",
      url: "file:///c/d.svg",
    });
    expect(diagramShare({ title: "T", source: "flowchart TD" }, null)).toEqual({
      title: "T",
      message: "flowchart TD",
    });
  });

  test("VoiceOver: activate opens the diagram, the custom action opens the source", () => {
    const words = diagramUiWords("en");
    expect(diagramA11yActions(words).map((a) => a.name)).toEqual(["activate", "showSource"]);
    expect(diagramA11yEffect("activate")).toBe("diagram");
    expect(diagramA11yEffect("showSource")).toBe("source");
    expect(diagramA11yEffect("magicTap")).toBeNull();
  });
});

describe("the inline body (T6.2: a failed render shows its source, never an error)", () => {
  const render = { svg: SVG, width: 400, height: 200 };

  test("failed (refused or retryable) → the source; a tap opens the Sorgente tab", () => {
    for (const retry of [false, true]) {
      expect(diagramBlockBody({ status: "failed", retry }, 300)).toEqual({
        kind: "source",
        tapTab: "source",
      });
    }
  });

  test("not yet asked or rendering → the placeholder box; a tap opens the diagram", () => {
    for (const state of [undefined, { status: "rendering" } as const]) {
      expect(diagramBlockBody(state, 300)).toEqual({
        kind: "placeholder",
        box: diagramInlineBox(null, 300),
        tapTab: "diagram",
      });
    }
  });

  test("done → the drawing in its inline box", () => {
    expect(diagramBlockBody({ status: "done", render }, 300)).toEqual({
      kind: "drawing",
      render,
      box: { width: 300, height: 150, clipped: false },
      tapTab: "diagram",
    });
  });
});

describe("the renderer WebView", () => {
  test("is the only one with scripts, still offline and under the same CSP", () => {
    const props = diagramRendererProps("<!-- page -->");
    expect(props.javaScriptEnabled).toBe(true);
    expect(props.html).toBe(`${artifactCsp()}<!-- page -->`);
    expect(props.html).toContain("connect-src 'none'");
    expect(navigationPredicate(props)("https://cdn.example")).toBe(false);
  });
});
