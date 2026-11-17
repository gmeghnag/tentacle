/**
 * The Content-Security-Policy every HTML/SVG artifact is wrapped in, on the Mac
 * (a CSP-prefixed temp copy opened in the browser) and on the phone (the
 * isolated WebView's `source.html`) — ONE string, so both ends block the same
 * things (docs/feat/model-artifacts.md D8/D9).
 *
 * Network OFF (default): scripts and inline styles run, but nothing leaves the
 * device — no fetch/XHR/WebSocket (`connect-src`), no remote image/font/style/
 * script, no frames, no form posts, no `<base>`. Images are `data:`/`blob:`
 * only. Network ON (an explicit per-open "Allow"): sub-resources and fetch may
 * reach the network; frames, form posts and `<base>` stay closed (navigation is
 * the viewer's job to refuse, not the page's to request).
 *
 * The prefix is prepended, so it is the document's FIRST bytes: a page's own
 * `<meta>` CSP can only add a second policy (both are enforced), never relax
 * this one. Residual: CSP does not govern WebRTC; the phone's escape suite
 * decides the scripts default (owner Q5), the Mac's browser is best effort.
 */

export interface ArtifactCspOptions {
  /** Allow sub-resources and fetch to reach the network. Default false. */
  readonly network?: boolean;
}

const OFFLINE: readonly string[] = [
  "default-src 'none'",
  "img-src data: blob:",
  "style-src 'unsafe-inline'",
  "font-src data:",
  "script-src 'unsafe-inline'",
  "connect-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
];

const ONLINE: readonly string[] = [
  "default-src 'none'",
  "img-src * data: blob:",
  "style-src * 'unsafe-inline'",
  "font-src * data:",
  "script-src * 'unsafe-inline'",
  "connect-src *",
  "media-src * data: blob:",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
];

/** The policy text (no quotes inside: it lives in `content="…"`). */
export function artifactCspPolicy(options: ArtifactCspOptions = {}): string {
  return (options.network === true ? ONLINE : OFFLINE).join("; ");
}

/** The prefix: a doctype and the CSP `<meta>`, to put BEFORE the artifact's bytes. */
export function artifactCsp(options: ArtifactCspOptions = {}): string {
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${artifactCspPolicy(options)}">`;
}

/** `body` with the CSP prefix as its first bytes. */
export function wrapArtifactHtml(body: string, options: ArtifactCspOptions = {}): string {
  return artifactCsp(options) + body;
}
