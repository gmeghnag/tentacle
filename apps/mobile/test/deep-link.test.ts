/**
 * The `tentacle://pair?` deep link (docs/feat/mobile-pairing-screen.md 11b.2,
 * Design 6 / Owner Q6, F-P17): pure, React-free, so "which URL is ours and what
 * it carries" is decided and tested without a simulator or a `Linking` event.
 *
 * The security property is NOT in this module: a link only produces TEXT, which
 * enters the same intake as a paste and therefore stops at `review` (nothing is
 * dialled until the person confirms). The wiring's half of that property is
 * pinned by `pairing-wiring-guards`-style source checks at the bottom of this
 * file, because `App.tsx` imports React Native (Flow) and cannot be imported.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePairingPayload } from "@tentacle/protocol";
import { pairingTextFromUrl } from "../src/deep-link.ts";

/** The line `tentacle pair` prints, i.e. what its QR encodes. */
const PAYLOAD =
  "tentacle://pair?v=1&k=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&n=MacBook&c=ABCDEFGHJK&a=ws%3A%2F%2F127.0.0.1%3A4001%2Fe2e";

describe("pairingTextFromUrl: only OUR pairing link is accepted", () => {
  test("the payload line itself is accepted, unchanged (mutation: rebuild from parts → red)", () => {
    // Unchanged is the property: it is exactly what `parsePairingPayload`
    // accepts, so the deep link and a paste are one path (`deep-link` never
    // re-encodes, and a re-encode could disagree with the printed line).
    expect(pairingTextFromUrl(PAYLOAD)).toBe(PAYLOAD);
    // And it really is a payload (the load-bearing check, as an assertion).
    expect(parsePairingPayload(PAYLOAD).ok).toBe(true);
  });

  test("surrounding whitespace is trimmed, not carried into the params", () => {
    expect(pairingTextFromUrl(`  ${PAYLOAD}\n`)).toBe(PAYLOAD);
  });

  test("another scheme is ignored (`https`, the browser's own pair page)", () => {
    expect(pairingTextFromUrl("https://evil.example/pair?v=1&k=x")).toBeUndefined();
    expect(pairingTextFromUrl(PAYLOAD.replace("tentacle://", "http://"))).toBeUndefined();
  });

  test("another NON-special scheme on our host is ignored too (mutation: drop the scheme check → red)", () => {
    // `http(s)` would also be caught by the empty-path rule (a special scheme
    // normalises its path to "/"), so it cannot prove the scheme check. A
    // non-special one keeps `pathname === ""`, which is exactly the case where
    // the scheme is the ONLY thing telling the two apart.
    expect(pairingTextFromUrl(PAYLOAD.replace("tentacle://", "tentacles://"))).toBeUndefined();
    expect(pairingTextFromUrl(PAYLOAD.replace("tentacle://", "tentacl://"))).toBeUndefined();
  });

  test("another host on our scheme is ignored", () => {
    expect(pairingTextFromUrl("tentacle://other?v=1&k=x")).toBeUndefined();
    // A look-alike host: passes a naive `startsWith("tentacle://pair")`.
    expect(pairingTextFromUrl(PAYLOAD.replace("//pair?", "//pair.evil.com?"))).toBeUndefined();
  });

  test("a path, a port or userinfo is ignored (not the shape `tentacle pair` prints)", () => {
    expect(pairingTextFromUrl(PAYLOAD.replace("//pair?", "//pair/x?"))).toBeUndefined();
    expect(pairingTextFromUrl(PAYLOAD.replace("//pair?", "//pair:4001?"))).toBeUndefined();
    expect(pairingTextFromUrl(PAYLOAD.replace("//pair?", "//x@pair?"))).toBeUndefined();
  });

  test("no query at all is ignored (nothing to pair with)", () => {
    expect(pairingTextFromUrl("tentacle://pair")).toBeUndefined();
    expect(pairingTextFromUrl("tentacle://pair?")).toBeUndefined();
  });

  test("nothing (no URL at all) is ignored, never a crash", () => {
    expect(pairingTextFromUrl(undefined)).toBeUndefined();
    expect(pairingTextFromUrl(null)).toBeUndefined();
    expect(pairingTextFromUrl("")).toBeUndefined();
    expect(pairingTextFromUrl("not a url")).toBeUndefined();
  });

  test("a well-shaped link with a GARBLED payload still yields text (the intake refuses it)", () => {
    // The link's job is transport, not validation: the refusal copy is the
    // intake's (`pair-error-invalid-payload`), so one path decides.
    const garbled = "tentacle://pair?v=1&k=nope";
    expect(pairingTextFromUrl(garbled)).toBe(garbled);
    expect(parsePairingPayload(garbled).ok).toBe(false);
  });

  test("it does NOT depend on `URL` (mutation: parse with `new URL` → red under Hermes)", () => {
    // THE bug this test exists for: React Native's `URL` polyfill
    // (`Libraries/Blob/URL.js`) matches `^https?:\/\/` only, so under Hermes our
    // own link has `hostname === ""` and `pathname === "/"`. A parser built on
    // `new URL` is therefore right in Bun and WRONG on the phone (flow
    // `19-deep-link` found it). The module must not read `URL` at all...
    const source = readFileSync(join(import.meta.dir, "..", "src", "deep-link.ts"), "utf8");
    // Comments legitimately discuss `new URL()` (that is where the bug is
    // explained), so only non-comment lines count as "reading URL".
    const code = source
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join("\n");
    expect(/\bnew URL\s*\(/.test(code)).toBe(false);
    // ... and the property is pinned where it broke: with RN's getters, our own
    // link is unrecognisable, so any `URL`-based gate rejects it.
    const rnUrl = (value: string): { hostname: string; pathname: string } => ({
      hostname: /^https?:\/\/(?:[^@]+@)?([^:/?#]+)/.exec(value)?.[1] ?? "",
      pathname: /^https?:\/\/[^/]+(\/[^?#]*)?/.exec(value)?.[1] ?? "/",
    });
    const underHermes = rnUrl(PAYLOAD);
    expect(underHermes).toEqual({ hostname: "", pathname: "/" });
    // The gate we ship accepts it anyway — the whole point.
    expect(pairingTextFromUrl(PAYLOAD)).toBe(PAYLOAD);
  });

  test("a non-special scheme with the same tail is still rejected (no scheme-agnostic match)", () => {
    // The prefix is matched INCLUDING the scheme, so `xtentacle://pair?…` and
    // `tentacle://pair` on another host prefix cannot slip through.
    expect(pairingTextFromUrl(`x${PAYLOAD}`)).toBeUndefined();
    expect(pairingTextFromUrl(PAYLOAD.replace("tentacle://", "tentacles://"))).toBeUndefined();
  });

  test("the scheme and host are matched case-insensitively (RFC 3986), the query is not touched", () => {
    // A sender (or a QR generator) may upper-case the scheme; iOS delivers it as
    // written. `tentacle pair` prints lower case, and the text we return is the
    // ORIGINAL, because `parsePairingPayload` is the only parser (its prefix
    // match is case-SENSITIVE, so an upper-cased scheme is refused there with
    // its own copy rather than silently rewritten here).
    expect(pairingTextFromUrl(`TENTACLE://PAIR?${PAYLOAD.split("?")[1]}`)).toBeDefined();
    expect(pairingTextFromUrl(`Tentacle://Pair?${PAYLOAD.split("?")[1]}`)).toBeDefined();
  });
});

/**
 * F-P17's other half, in the wiring: a link enters the intake and NEVER dials.
 * `App.tsx` cannot be imported (React Native's sources are Flow), so the
 * decisions are tested in the pure modules and only the call site is pinned here
 * — the precedent `pairing-wiring-guards.test.ts` sets.
 */
describe("the wiring a deep link must not get wrong (F-P17)", () => {
  const app = readFileSync(join(import.meta.dir, "..", "App.tsx"), "utf8");

  test("the Linking handler stores the link's TEXT and dispatches no dial (mutation: auto-confirm → red)", () => {
    // The handler is the effect that registers the `url` listener.
    const at = app.indexOf('Linking.addEventListener("url"');
    expect(at).toBeGreaterThan(-1);
    const handler = app.slice(app.lastIndexOf("useEffect", at), app.indexOf("}, [", at));
    // It routes the text to `Pair` ...
    expect(handler).toContain("pairingTextFromUrl");
    expect(handler).toContain('navigate("Pair"');
    // ... and never confirms a pairing itself (the human's tap is the only way).
    expect(handler).not.toContain('type: "confirm"');
    expect(handler).not.toContain("runPairing");
  });

  test("the link's text reaches the SAME intake as a paste (one path), and never dials (mutation: auto-confirm → red)", () => {
    // The `Pair` screen takes the text as a route param and submits it through
    // the reducer's own `submit`, which only PARSES (nothing is dialled).
    const pair = app.slice(
      app.indexOf("function PairRoute("),
      app.indexOf("function findExisting("),
    );
    expect(pair).toContain("linkText");
    expect(pair).toContain('type: "submit"');
    // The link's own effect is the place a "pair by itself" bug would live: it
    // may hand the text to the intake and nothing else.
    const at = pair.indexOf("linkText === undefined");
    expect(at).toBeGreaterThan(-1);
    const effect = pair.slice(at, pair.indexOf("}, [linkText", at));
    expect(effect).toContain('dispatch({ type: "text", text: linkText })');
    expect(effect).toContain("submit(linkText)");
    // F-P17: no confirm, no runner — the person's tap is the only dial.
    expect(effect).not.toContain('type: "confirm"');
    expect(effect).not.toContain("runPairing");
    // Applied ONCE per link text: `submit` changes identity with every state
    // change, so without the guard a later `failed` state re-submits the link's
    // payload and bounces the person back to the review card.
    expect(effect).toContain("handledLink.current === linkText");
  });

  test("a link that beats the navigator is PARKED and replayed, never dropped (mutation: route only → red)", () => {
    // The cold-start defect (drift 4): `App` renders a spinner until the store is
    // read, so `navigationRef.isReady()` is false when `getInitialURL()` resolves
    // and a plain `navigate` is a silent no-op. The decision itself is
    // `pending-link.ts` (tested there); this pins that `App.tsx` USES it.
    expect(app).toContain("handlePairingText(text, navigationRef.isReady())");
    expect(app).toContain("setPendingLink(decision.text)");
    expect(app).toContain("takePendingLink(pendingLink, navigationRef.isReady())");
    // The replay must be wired to the container's readiness, not to a timer.
    expect(app).toContain("onReady={replayPendingLink}");
    // And the parked link is cleared as it is taken: a re-render must not
    // re-submit it (the same bounce the once-per-link guard prevents).
    const replay = app.slice(
      app.indexOf("const replayPendingLink"),
      app.indexOf("}, [replayPendingLink", app.indexOf("const replayPendingLink")),
    );
    expect(replay).toContain("setPendingLink(undefined)");
  });
});
