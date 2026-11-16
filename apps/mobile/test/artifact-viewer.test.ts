/**
 * `artifact-viewer.ts` (docs/feat/model-artifacts.md D9, T7.2/T7.3): which viewer
 * a kind gets, the navigation predicate that is the isolation's decision, and the
 * isolated WebView's props as data — asserted as VALUES, because the escapes they
 * close (a link, `window.open`, a cookie read, a bridge, an auto-play) are
 * exactly the ones a `.tsx` would bury untestably.
 */
import { describe, expect, test } from "bun:test";
import { artifactCsp } from "@tentacle/core";
import {
  ARTIFACT_BASE_URL,
  allowNavigation,
  htmlViewerProps,
  networkBarLabel,
  pdfViewerProps,
  viewerFor,
  viewerSubtitle,
  viewerTarget,
} from "../src/artifact-viewer.ts";

const meta = (kind: string) => ({ kind });

describe("viewerFor", () => {
  test("each kind gets its viewer, and scripts follow the owner's decision", () => {
    expect(viewerFor(meta("image"))).toEqual({ kind: "image", scripts: false });
    expect(viewerFor(meta("svg"))).toEqual({ kind: "webview", scripts: true });
    expect(viewerFor(meta("html"))).toEqual({ kind: "webview", scripts: true });
    expect(viewerFor(meta("pdf"))).toEqual({ kind: "pdf", scripts: false });
    expect(viewerFor(meta("markdown"))).toEqual({ kind: "markdown", scripts: false });
    expect(viewerFor(meta("text"))).toEqual({ kind: "text", scripts: false });
  });

  test("an unknown kind from a newer daemon is `none` — shared, never rendered", () => {
    expect(viewerFor(meta("hologram"))).toEqual({ kind: "none", scripts: false });
    expect(viewerFor(meta(""))).toEqual({ kind: "none", scripts: false });
    expect(viewerFor(meta("HTML"))).toEqual({ kind: "none", scripts: false });
  });

  test("a kind named on the prototype is not a kind (no `__proto__` lookup)", () => {
    expect(viewerFor(meta("__proto__")).kind).toBe("none");
    expect(viewerFor(meta("constructor")).kind).toBe("none");
  });
});

describe("allowNavigation", () => {
  test("the initial about:blank is the ONLY allowed load", () => {
    expect(allowNavigation(ARTIFACT_BASE_URL)).toBe(true);
  });

  test("every scheme a page could navigate to is refused", () => {
    for (const url of [
      undefined,
      "",
      "https://evil.example/x",
      "http://10.0.0.1/",
      "data:text/html,<script>fetch('//x')</script>",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "blob:https://evil.example/1",
      "about:blank#x",
      "about:srcdoc",
      "//evil.example/x",
      "  about:blank  ",
      "ABOUT:BLANK",
    ]) {
      expect({ url, allowed: allowNavigation(url) }).toEqual({ url, allowed: false });
    }
  });
});

describe("htmlViewerProps", () => {
  const body = "<h1>hi</h1><script>fetch('https://x')</script>";

  test("the CSP prefix is the FIRST bytes, network off by default", () => {
    const props = htmlViewerProps({ body, network: false, scripts: true });
    expect(props.html).toBe(artifactCsp() + body);
    expect(
      props.html?.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy"'),
    ).toBe(true);
    expect(props.html).toContain("connect-src 'none'");
    expect(props.html).toContain("frame-src 'none'");
    expect(props.html).toContain("form-action 'none'");
    expect(props.html).toContain("base-uri 'none'");
  });

  test("Allow network drops only the network clauses (frames/forms stay closed)", () => {
    const props = htmlViewerProps({ body, network: true, scripts: true });
    expect(props.html).toBe(artifactCsp({ network: true }) + body);
    expect(props.html).toContain("connect-src *");
    expect(props.html).toContain("frame-src 'none'");
    expect(props.html).toContain("form-action 'none'");
    expect(props.html).toContain("base-uri 'none'");
  });

  test("the source is inline html at about:blank, with NO bridge and no file access", () => {
    const props = htmlViewerProps({ body, network: false, scripts: true });
    expect(props.baseUrl).toBe("about:blank");
    expect(props.uri).toBeUndefined();
    expect(Object.keys(props)).not.toContain("onMessage");
    expect(Object.keys(props)).not.toContain("injectedJavaScript");
    expect(props).toMatchObject({
      incognito: true,
      sharedCookiesEnabled: false,
      allowFileAccess: false,
      allowsLinkPreview: false,
      mediaPlaybackRequiresUserAction: true,
      javaScriptCanOpenWindowsAutomatically: false,
      dataDetectorTypes: "none",
    });
  });

  test("scripts are the owner's per-kind decision, not the network bar's", () => {
    expect(htmlViewerProps({ body, network: false, scripts: true }).javaScriptEnabled).toBe(true);
    expect(htmlViewerProps({ body, network: false, scripts: false }).javaScriptEnabled).toBe(false);
    expect(htmlViewerProps({ body, network: true, scripts: false }).javaScriptEnabled).toBe(false);
  });

  test("the props are FROZEN data: no prop object carries a function", () => {
    const props = htmlViewerProps({ body, network: false, scripts: true });
    expect(Object.values(props).some((value) => typeof value === "function")).toBe(false);
  });
});

describe("pdfViewerProps", () => {
  test("a verified cached file uri, scripts OFF, the same isolation", () => {
    const props = pdfViewerProps("file:///cache/artifacts/mbp/abc.pdf");
    expect(props.uri).toBe("file:///cache/artifacts/mbp/abc.pdf");
    expect(props.html).toBeUndefined();
    expect(props.javaScriptEnabled).toBe(false);
    expect(props.baseUrl).toBe("about:blank");
    expect(JSON.stringify(props)).not.toContain("onMessage");
    expect(props).toMatchObject({
      incognito: true,
      sharedCookiesEnabled: false,
      allowFileAccess: false,
      javaScriptCanOpenWindowsAutomatically: false,
    });
  });
});

describe("small viewer words", () => {
  test("the network bar says which state it is in, and that it is not remembered", () => {
    expect(networkBarLabel(false)).toBe("Network off");
    expect(networkBarLabel(true)).toContain("this open only");
  });

  test("the subtitle is the card's own line (one source of truth for both)", () => {
    expect(viewerSubtitle({ line2: "PNG · 1280×720 · 240 KB" })).toBe("PNG · 1280×720 · 240 KB");
  });

  test("viewerTarget carries the meta it was opened for, with its choice", () => {
    const target = viewerTarget({
      artifactId: "a",
      version: 1,
      sha256: "a".repeat(64),
      size: 10,
      mimeType: "text/html",
      kind: "html",
      title: "page",
      callId: "c1",
      createdAt: 1,
    });
    expect(target.meta.artifactId).toBe("a");
    expect(target.choice).toEqual({ kind: "webview", scripts: true });
  });
});
