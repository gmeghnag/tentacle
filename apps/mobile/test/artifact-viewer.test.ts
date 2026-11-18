/**
 * `artifact-viewer.ts` (docs/feat/model-artifacts.md D9, T7.2/T7.3): which viewer
 * a kind gets, the navigation predicate that is the isolation's decision, and the
 * isolated WebView's props as data — asserted as VALUES, because the escapes they
 * close (a link, `window.open`, a cookie read, a bridge, an auto-play) are
 * exactly the ones a `.tsx` would bury untestably.
 */
import { describe, expect, test } from "bun:test";
import { artifactCsp } from "@tentacle/core";
import { viewerText } from "../src/artifact-open.ts";
import {
  ARTIFACT_BASE_URL,
  allowNavigation,
  htmlViewerProps,
  navigationPredicate,
  networkBarLabel,
  pdfViewerProps,
  scriptsBarLabel,
  viewerFor,
  viewerSubtitle,
  viewerTarget,
  webViewParts,
} from "../src/artifact-viewer.ts";

const meta = (kind: string) => ({ kind });

describe("viewerFor", () => {
  test("each kind gets its viewer; scripts are OFF, and the tap follows the kind", () => {
    expect(viewerFor(meta("image"))).toEqual({
      kind: "image",
      scripts: false,
      canRunScripts: false,
    });
    expect(viewerFor(meta("svg"))).toEqual({
      kind: "webview",
      scripts: false,
      canRunScripts: true,
    });
    expect(viewerFor(meta("html"))).toEqual({
      kind: "webview",
      scripts: false,
      canRunScripts: true,
    });
    expect(viewerFor(meta("pdf"))).toEqual({ kind: "pdf", scripts: false, canRunScripts: false });
    expect(viewerFor(meta("markdown"))).toEqual({
      kind: "markdown",
      scripts: false,
      canRunScripts: false,
    });
    expect(viewerFor(meta("text"))).toEqual({ kind: "text", scripts: false, canRunScripts: false });
  });

  test("an unknown kind from a newer daemon is `none` — shared, never rendered", () => {
    expect(viewerFor(meta("hologram"))).toEqual({
      kind: "none",
      scripts: false,
      canRunScripts: false,
    });
    expect(viewerFor(meta(""))).toEqual({ kind: "none", scripts: false, canRunScripts: false });
    expect(viewerFor(meta("HTML"))).toEqual({ kind: "none", scripts: false, canRunScripts: false });
  });

  test("a kind named on the prototype is not a kind (no `__proto__` lookup)", () => {
    expect(viewerFor(meta("__proto__")).kind).toBe("none");
    expect(viewerFor(meta("constructor")).kind).toBe("none");
  });

  test("`chart` is its OWN viewer — not `none`, not a file kind (T8.1/C8)", () => {
    // The bytes are the spec JSON, so the artifact opens as the full-screen
    // chart (ArtifactViewerModal's branch), never Share-only and never a PDF/
    // image uri: a chart this build cannot draw is still `chart`, and the
    // component decides what to say about it.
    expect(viewerFor(meta("chart"))).toEqual({
      kind: "chart",
      scripts: false,
      canRunScripts: false,
    });
    expect(viewerText(viewerFor(meta("chart")).kind, new TextEncoder().encode("{}"))).toBe("{}");
  });

  /**
   * Owner Q5's pre-decided FALLBACK (S8+S9 Review finding 2): the escape suite
   * that would justify scripts-on has not run, and CSP does not govern
   * `RTCPeerConnection`, so a hostile page gets a DNS beacon for free. Scripts
   * must therefore be OFF by default while the viewer still OFFERS the tap —
   * the two halves finding 2 says were missing (hard-coded on, no control).
   */
  test("the fallback ships: scripts OFF by default, the tap available", () => {
    for (const kind of ["html", "svg", "pdf", "image", "markdown", "text", "other"]) {
      expect({ kind, scripts: viewerFor(meta(kind)).scripts }).toEqual({ kind, scripts: false });
    }
    // Only a WebView kind offers it (a PDF is rendered by the platform).
    expect(viewerFor(meta("html")).canRunScripts).toBe(true);
    expect(viewerFor(meta("svg")).canRunScripts).toBe(true);
    expect(viewerFor(meta("pdf")).canRunScripts).toBe(false);
    // And the props follow the tap, never the kind alone.
    expect(htmlViewerProps({ body: "<p>", network: false, scripts: false }).javaScriptEnabled).toBe(
      false,
    );
  });

  test("the scripts bar says what is true now, and that nothing is remembered", () => {
    expect(scriptsBarLabel(false)).toBe("Scripts off");
    expect(scriptsBarLabel(true)).toBe("Scripts on · this open only");
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
    expect(target.choice).toEqual({ kind: "webview", scripts: false, canRunScripts: true });
  });
});

/**
 * S8 (docs/feat/model-artifacts.md): two gaps found when wiring the real
 * `react-native-webview` 14.0.1.
 *  1. Its JS wrapper hands every URL that FAILS `originWhitelist` (default
 *     `["http://*", "https://*"]`) to `Linking.openURL` BEFORE our predicate runs
 *     (`WebViewShared.tsx` `createOnShouldStartLoadWithRequest`): a page setting
 *     `location = "sms:…?body=<secret>"` or another app's scheme would leave the
 *     sandbox. `["*"]` makes every URL reach the predicate, which refuses it.
 *  2. A PDF's first load is its own `file:` uri, not `about:blank`: the predicate
 *     must allow exactly the initial source of THAT viewer, nothing else.
 */
describe("S8: every navigation reaches the predicate", () => {
  test("originWhitelist is the catch-all, so the wrapper never calls Linking.openURL", () => {
    expect(htmlViewerProps({ body: "x", network: false, scripts: true }).originWhitelist).toEqual([
      "*",
    ]);
    expect(pdfViewerProps("file:///c/a.pdf").originWhitelist).toEqual(["*"]);
  });

  test("an html viewer may sit only on about:blank (network on or off)", () => {
    const refused = ["sms:1?body=s", "tel:1", "mailto:a@b", "tentacle://x", "https://e.x"];
    for (const network of [false, true]) {
      const allow = navigationPredicate(htmlViewerProps({ body: "x", network, scripts: true }));
      expect(allow(ARTIFACT_BASE_URL)).toBe(true);
      for (const url of [...refused, "file:///c/a.pdf", undefined]) {
        expect(allow(url)).toBe(false);
      }
    }
  });

  test("a pdf viewer may load exactly its own cached file, nothing else", () => {
    const uri = "file:///cache/artifacts/c1/ab12";
    const allow = navigationPredicate(pdfViewerProps(uri));
    expect(allow(uri)).toBe(true);
    const refused = [ARTIFACT_BASE_URL, `${uri}x`, "file:///cache/artifacts/c1/other"];
    for (const url of [...refused, "https://e.x", "sms:1", undefined]) {
      expect(allow(url)).toBe(false);
    }
  });
});

describe("S8: webViewParts (what the component spreads)", () => {
  test("html: inline source at about:blank; the flags carry the isolation, no source", () => {
    const data = htmlViewerProps({ body: "<p>", network: false, scripts: true });
    const { source, flags } = webViewParts(data);
    expect(source).toEqual({
      html: `${artifactCsp({ network: false })}<p>`,
      baseUrl: ARTIFACT_BASE_URL,
    });
    expect(Object.keys(flags).sort()).toEqual(
      [
        "allowFileAccess",
        "allowsLinkPreview",
        "dataDetectorTypes",
        "incognito",
        "javaScriptCanOpenWindowsAutomatically",
        "javaScriptEnabled",
        "mediaPlaybackRequiresUserAction",
        "originWhitelist",
        "sharedCookiesEnabled",
      ].sort(),
    );
    expect(flags.incognito).toBe(true);
    expect(flags.originWhitelist).toEqual(["*"]);
  });

  test("pdf: the file uri alone (no about:blank base), scripts off", () => {
    const { source, flags } = webViewParts(pdfViewerProps("file:///c/a"));
    expect(source).toEqual({ uri: "file:///c/a" });
    expect(flags.javaScriptEnabled).toBe(false);
  });
});
