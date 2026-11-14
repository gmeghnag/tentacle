/**
 * The `tentacle://pair?…` deep link (docs/feat/mobile-pairing-screen.md 11b.2,
 * Design 6 / Owner Q6, F-P17): pure and React-free, so "is this URL ours, and
 * what does it carry" is decided and tested without a simulator or a `Linking`
 * event.
 *
 * Two rules, and nothing else here:
 * - **Only our exact link shape is accepted:** scheme `tentacle` (any case, as
 *   URL schemes are case-insensitive), host `pair`, no path, no port, no
 *   userinfo, and a non-empty query. A look-alike host
 *   (`tentacle://pair.evil.com`) or a path (`tentacle://pair/x`) is not what
 *   `tentacle pair` prints, so it is ignored rather than guessed at.
 * - **The text is passed through UNCHANGED** (trimmed): the line a QR encodes,
 *   the line a paste carries and the line a deep link delivers are one string,
 *   so the app keeps ONE intake and `parsePairingPayload` stays the only parser.
 *   Validation is deliberately NOT done here — a garbled link yields text, and
 *   the intake refuses it with its own copy (`pair-error-invalid-payload`).
 *
 * **Why a hand-written parser and not `new URL()`:** React Native ships its own
 * `URL` polyfill (`Libraries/Blob/URL.js`) whose `hostname`, `host`, `origin`
 * and `pathname` getters match `^https?:\/\/` ONLY. Under **Hermes** a
 * `tentacle://pair?…` therefore has `hostname === ""` and `pathname === "/"`, so
 * every check below would reject our own link and the app would silently stay on
 * the intake (found empirically: flow `19-deep-link` red, while the same code
 * passed in Bun — Bun has a spec-complete `URL`). Parsing the two prefixes we
 * accept by hand is both Hermes-correct and trivially testable.
 *
 * F-P17 does not live in this module: the returned text only ever enters the
 * same intake as a paste, which stops at `review` and dials nothing until the
 * person taps Pair. That half is pinned in `deep-link.test.ts` against `App.tsx`
 * (which cannot be imported: React Native's sources are Flow).
 */

/** What `tentacle pair` prints, minus the query (`PAIRING_PAYLOAD_PREFIX`, lower-cased). */
const PREFIX = "tentacle://pair";

/**
 * The pairing text a URL carries, or `undefined` when this is not our link.
 * `null`/`undefined` is what `Linking.getInitialURL()` and the `url` event can
 * hand over when there is no URL at all.
 */
export function pairingTextFromUrl(url: string | null | undefined): string | undefined {
  if (url === null || url === undefined) {
    return undefined;
  }
  const text = url.trim();
  if (text === "") {
    return undefined;
  }
  // Scheme and host are case-insensitive (RFC 3986); `tentacle pair` prints them
  // lower-case, and iOS hands the URL through as it was written by the sender.
  if (text.slice(0, PREFIX.length).toLowerCase() !== PREFIX) {
    return undefined;
  }
  // Exactly one thing may follow the host: the query. A path (`/x`), a port
  // (`:4001`), userinfo (`x@pair`) or a longer host (`pair.evil.com`) is a shape
  // `tentacle pair` never prints, so it is not our link.
  const rest = text.slice(PREFIX.length);
  if (!rest.startsWith("?")) {
    return undefined;
  }
  // `tentacle://pair?` alone carries nothing to pair with.
  if (rest.length === 1) {
    return undefined;
  }
  return text;
}
