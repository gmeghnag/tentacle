import { artifactCsp } from "@tentacle/core";
/**
 * Which viewer an artifact opens in, and the isolated WebView's props as DATA
 * (docs/feat/model-artifacts.md D9, T7.2/T7.3).
 *
 * This module is the security decision, so it is pure and asserted here rather
 * than in a `.tsx` the harness cannot import (AGENTS §7):
 *
 * 1. **The navigation predicate.** A WebView showing pod-supplied HTML may load
 *    exactly ONE thing: the initial `about:blank` the html source is seeded at.
 *    Every other scheme — `https:`, `data:`, `file:`, `javascript:`, `blob:`,
 *    even another `about:` — is refused, so a link, a `window.open`, a
 *    `target=_blank`, a meta refresh or a form post cannot navigate the viewer
 *    anywhere. T8's escape suite proves it end to end; this function is the
 *    decision it rests on.
 * 2. **No bridge.** `onMessage` is what makes `window.ReactNativeWebView` exist,
 *    so the props carry no handler at all — a page cannot call into the app.
 * 3. **Scripts per kind, network per open.** Scripts follow the OWNER's decision
 *    (Q5: on, gated by the escape suite) for HTML/SVG; a PDF is rendered by the
 *    platform with scripts OFF (nothing in a PDF needs them).
 */
import { type ArtifactKind, type ArtifactMeta, artifactKindOf } from "@tentacle/protocol";

/** The one URL the viewer may sit on: the initial html source's own base. */
export const ARTIFACT_BASE_URL = "about:blank";

/** Which viewer renders an artifact. `none` = only Share/save (kind `other`). */
export type ViewerKind = "image" | "webview" | "pdf" | "markdown" | "text" | "none";

export interface ViewerChoice {
  readonly kind: ViewerKind;
  /**
   * Scripts run in the WebView **right now**. `false` for every kind today: the
   * Owner Q5 gate turned on the escape suite (T8.1), and CSP cannot block
   * `RTCPeerConnection` — so the pre-decided FALLBACK is what ships: scripts OFF,
   * with the viewer's own one-tap "Run scripts" (per open, never remembered).
   * Flip this to `canRunScripts` only once that suite shows zero hits.
   */
  readonly scripts: boolean;
  /**
   * Whether this kind COULD run scripts, i.e. whether the viewer offers the
   * "Run scripts" tap. `false` for a PDF (the platform renders it; nothing in a
   * PDF needs them) and for every non-WebView kind.
   */
  readonly canRunScripts: boolean;
}

const VIEWER: Readonly<Record<ArtifactKind, ViewerKind>> = {
  image: "image",
  svg: "webview",
  html: "webview",
  pdf: "pdf",
  markdown: "markdown",
  text: "text",
  other: "none",
};

/**
 * The viewer for a card's kind: an unknown wire kind is `other`, whose viewer is
 * `none` — a kind this build does not know is SHARED, never rendered.
 */
/**
 * The viewer for a card's kind: an unknown wire kind is `other`, whose viewer is
 * `none` — a kind this build does not know is SHARED, never rendered.
 *
 * Scripts are OFF, and the viewer offers "Run scripts" (Owner Q5's fallback):
 * the escape suite that would justify the primary (scripts on, network off) has
 * not run, and WebRTC — which CSP does not govern — is a beacon a hostile page
 * gets for free. A person who wants an interactive page taps once; nothing is
 * remembered.
 */
export function viewerFor(meta: { readonly kind: string }): ViewerChoice {
  const kind = artifactKindOf(meta);
  const viewer = VIEWER[kind];
  return { kind: viewer, scripts: false, canRunScripts: viewer === "webview" };
}

/**
 * May the WebView navigate to `url`? Only the initial `about:blank` load. Both
 * the requested URL and the one it is asked from are checked: a page that
 * navigates itself nowhere is still refused unless it STAYS on `about:blank`.
 */
export function allowNavigation(url: string | undefined): boolean {
  return url === ARTIFACT_BASE_URL;
}

/**
 * The props the isolated WebView gets, as data (the component spreads them).
 * Two variants: an HTML/SVG artifact (inline `source.html`, CSP-prefixed) and a
 * PDF (a `file:` uri of the verified cached copy, scripts off).
 *
 * The flags are the isolation itself — each one closes a documented escape
 * (T8's fixture list):
 * - `incognito` + `sharedCookiesEnabled: false`: no cookie/storage read or write,
 *   and nothing persists to the next open;
 * - `allowFileAccess: false` + `allowingReadAccessToURL` absent: a page cannot
 *   read another local file;
 * - `javaScriptCanOpenWindowsAutomatically: false` + the predicate above: no
 *   `window.open`, no `target=_blank`;
 * - `dataDetectorTypes: "none"`: a phone number is not turned into a live link;
 * - `allowsLinkPreview: false`: a long-press cannot raise a system preview;
 * - `mediaPlaybackRequiresUserAction`: a page cannot auto-play audio/video;
 * - no `onMessage` and no `injectedJavaScript`: no bridge, no injected script.
 */
export interface WebViewPropsData {
  /** Inline html (html/svg only) with the CSP prefix as its first bytes. */
  readonly html?: string;
  /** A `file:` uri of the verified cached copy (pdf only). */
  readonly uri?: string;
  readonly baseUrl: string;
  readonly javaScriptEnabled: boolean;
  readonly incognito: true;
  readonly sharedCookiesEnabled: false;
  readonly allowFileAccess: false;
  readonly allowsLinkPreview: false;
  readonly mediaPlaybackRequiresUserAction: true;
  readonly javaScriptCanOpenWindowsAutomatically: false;
  readonly dataDetectorTypes: "none";
  /**
   * `["*"]`: every URL passes the wrapper's origin check and reaches
   * `navigationPredicate`. Any narrower list makes `react-native-webview` hand a
   * non-matching URL (`sms:`, `tel:`, another app's scheme) to `Linking.openURL`
   * BEFORE the predicate runs — a way out of the sandbox (S8).
   */
  readonly originWhitelist: readonly ["*"];
}

export interface HtmlViewerOptions {
  /** The artifact's bytes as text (the store's own decode). */
  readonly body: string;
  /** The per-open "Allow network" (Owner Q5b: never remembered). */
  readonly network: boolean;
  readonly scripts: boolean;
}

/** The props for an HTML/SVG artifact: CSP-wrapped, network per open. */
export function htmlViewerProps(options: HtmlViewerOptions): WebViewPropsData {
  return {
    html: artifactCsp({ network: options.network }) + options.body,
    baseUrl: ARTIFACT_BASE_URL,
    javaScriptEnabled: options.scripts,
    incognito: true,
    sharedCookiesEnabled: false,
    allowFileAccess: false,
    allowsLinkPreview: false,
    mediaPlaybackRequiresUserAction: true,
    javaScriptCanOpenWindowsAutomatically: false,
    dataDetectorTypes: "none",
    originWhitelist: ["*"],
  };
}

/** The props for a PDF: the platform renders it; scripts never run. */
export function pdfViewerProps(uri: string): WebViewPropsData {
  return {
    uri,
    baseUrl: ARTIFACT_BASE_URL,
    javaScriptEnabled: false,
    incognito: true,
    sharedCookiesEnabled: false,
    allowFileAccess: false,
    allowsLinkPreview: false,
    mediaPlaybackRequiresUserAction: true,
    javaScriptCanOpenWindowsAutomatically: false,
    dataDetectorTypes: "none",
    originWhitelist: ["*"],
  };
}

/**
 * The predicate a viewer's `onShouldStartLoadWithRequest` applies: the viewer
 * may load exactly its OWN initial source — `about:blank` for inline html, the
 * cached file's uri for a PDF — and nothing else, ever (S8: a PDF's first load
 * is its `file:` uri, which `allowNavigation` alone would refuse).
 */
export function navigationPredicate(props: WebViewPropsData): (url: string | undefined) => boolean {
  const initial = props.uri ?? ARTIFACT_BASE_URL;
  return (url) => url === initial;
}

/**
 * The props data split into the WebView's `source` and its flags (the component
 * spreads `flags` verbatim). Inline html keeps its `about:blank` base; a PDF is
 * its file uri alone (`allowingReadAccessToURL` stays unset, so iOS grants read
 * access to that ONE file, `RNCWebViewImpl.m` `loadFileURL`).
 */
export function webViewParts(props: WebViewPropsData): {
  readonly source: { readonly html: string; readonly baseUrl: string } | { readonly uri: string };
  readonly flags: Omit<WebViewPropsData, "html" | "uri" | "baseUrl">;
} {
  const { html, uri, baseUrl, ...flags } = props;
  if (html !== undefined) {
    return { source: { html, baseUrl }, flags };
  }
  return { source: { uri: uri ?? baseUrl }, flags };
}

/** The viewer's header subtitle: the card's type-and-size line, unchanged. */
export function viewerSubtitle(card: { readonly line2: string }): string {
  return card.line2;
}

/** What the network bar says (the HTML/SVG viewer's one control). */
export function networkBarLabel(network: boolean): string {
  return network ? "Network on · this open only" : "Network off";
}

/**
 * What the scripts bar says (Owner Q5's fallback control): the page is inert
 * until a person asks, and the ask is for THIS open alone.
 */
export function scriptsBarLabel(scripts: boolean): string {
  return scripts ? "Scripts on · this open only" : "Scripts off";
}

/** The meta a viewer is opened FOR: the version under the tap, never re-resolved. */
export interface ViewerTarget {
  readonly meta: ArtifactMeta;
  readonly choice: ViewerChoice;
}

export function viewerTarget(meta: ArtifactMeta): ViewerTarget {
  return { meta, choice: viewerFor(meta) };
}
