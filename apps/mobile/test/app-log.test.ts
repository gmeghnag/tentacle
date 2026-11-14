/**
 * `app-log.ts` — redaction at write time (docs/feat/mobile-lock.md D7, Tests).
 *
 * The CANARY suite is the point: each test plants one secret in a field that the
 * app really feeds (a dialled URL with `?token=`, a ws close `reason`, a client
 * error `message`), exports, and asserts the secret is not in the text. The ring
 * bound, the rotation header and the unknown-version rule are covered too.
 */
import { describe, expect, test } from "bun:test";
import {
  type AppLogEntry,
  FIELD_MAX,
  createAppLog,
  entriesToText,
  errorShape,
  exportFileName,
  exportText,
  fieldValue,
  redact,
  shortId,
} from "../src/app-log.ts";

const TOKEN = "CANARYTOKEN0123456789abcdef";
const BEARER = "CANARYBEARERKEY0123456789";
const HEX_KEY = "9f2c1a4b7e6d80315c9a2b4e6f8d0a1c";
const B64URL_KEY = "Zm9vYmFyLUNBTkFSWS1rZXktMDEyMzQ1Njc4OQ";
const PROMPT = "CANARY-PROMPT tell me the deploy secret";
const TITLE = "CANARY-TITLE refactor the auth layer";
const COMPUTER = "CANARY-COMPUTER-MacBook";

function harness(capacity = 500) {
  let clock = 1_700_000_000_000;
  const log = createAppLog({ now: () => clock, capacity });
  return {
    log,
    advance(ms: number) {
      clock += ms;
    },
    now: () => clock,
  };
}

/** Every text a person could see after sharing the export. */
function sharedText(entries: readonly AppLogEntry[]): string {
  return exportText(
    {
      appVersion: "1.2.3",
      build: "45",
      osVersion: "26.5",
      deviceModel: "iPhone17,1",
      exportedAt: 1_700_000_500_000,
      droppedEntries: 0,
    },
    entries,
  );
}

describe("canaries — no secret survives into the export (F16)", () => {
  // `redact()` is still the guard for every value a caller DOES pass: `fieldValue`
  // runs it, so a secret in a field is scrubbed before the entry exists. (Since
  // finding 2 the call sites pass no daemon prose at all — the tests below prove
  // that — so these three keep the scrub itself pinned for the fields that remain.)
  test("a dialled URL keeps host:port and loses the token query (P3)", () => {
    // Exactly what ws-channel.ts builds on iOS: the token IS the query.
    const clean = redact(`ws://127.0.0.1:8787/e2e?token=${TOKEN}&device=phone`);
    expect(clean).not.toContain(TOKEN);
    expect(clean).not.toContain("token=");
    // The one thing the export MAY name (Owner Q8) is still there.
    expect(clean).toContain("ws://127.0.0.1:8787");
  });

  test("a URL's userinfo, path, query and fragment all go", () => {
    const clean = redact(`wss://user:pw@example.local:9000/secret/path?token=${TOKEN}#frag`);
    expect(clean).not.toContain(TOKEN);
    expect(clean).not.toContain("pw@");
    expect(clean).not.toContain("/secret/path");
    expect(clean).not.toContain("#frag");
    expect(clean).toContain("wss://example.local:9000");
  });

  test("a Bearer header, a 32-hex key and a base64url key all go", () => {
    expect(redact(`handshake failed: Authorization: Bearer ${BEARER}`)).not.toContain(BEARER);
    expect(redact(`reason=${HEX_KEY}`)).not.toContain(HEX_KEY);
    expect(redact(`reason ${B64URL_KEY}`)).not.toContain(B64URL_KEY);
  });

  test("daemon prose is not logged at all: an error is its CLASS and its code (F16)", () => {
    const h = harness();
    // The three shapes the app really logs. Each one used to be passed as free
    // `detail` text, so redaction alone had to catch it — and could not: prose is
    // prose, so a title or a prompt fragment survived up to 160 chars (review
    // round 1, finding 2, where the plan's own canary test was weakened instead).
    h.log.log("error", "client-error", {
      ...errorShape(new Error(`${PROMPT} ${TITLE} ${COMPUTER}`)),
    });
    h.log.log("warn", "ws-close", { code: 1006 });
    h.log.log("error", "ws-error", {
      ...errorShape(
        new TypeError(`WebSocket connection to 'wss://h:1/${TITLE}?token=${TOKEN}' failed`),
      ),
    });
    h.log.log("warn", "link-status", {
      cover: "failed",
      ...errorShape(new Error(`${COMPUTER} could not enable the cover`)),
    });
    const text = sharedText(h.log.entries());
    for (const canary of [PROMPT, TITLE, COMPUTER, TOKEN]) {
      expect(text).not.toContain(canary);
    }
    // Non-vacuity: the entries are there, carrying the CLASS and the close CODE
    // (a shared file with no failure in it would pass the negatives trivially).
    expect(text).toContain("client-error error=Error");
    expect(text).toContain("ws-error error=TypeError");
    expect(text).toContain("ws-close code=1006");
    expect(text).toContain("cover=failed");
  });

  test("`errorShape` names a class, never a message, and a non-Error throw is `Error`", () => {
    expect(errorShape(new Error(PROMPT))).toEqual({ error: "Error" });
    const rpc = Object.assign(new Error(TITLE), { name: "RpcError", code: -32000 });
    expect(errorShape(rpc)).toEqual({ error: "RpcError", code: -32000 });
    // A hostile name (a pod build some other way) is not identifier-shaped.
    expect(errorShape(Object.assign(new Error("x"), { name: `${TITLE} ${COMPUTER}` }))).toEqual({
      error: "Error",
    });
    expect(errorShape(`${PROMPT} ${TITLE}`)).toEqual({ error: "Error" });
  });

  test("a long title passed in `fields` is redacted and capped, not trusted", () => {
    const h = harness();
    const long = `${TITLE} — and then some more of the same title to go past the cap`;
    h.log.log("info", "link-status", { title: long });
    const field = String(h.log.entries()[0]?.fields.title);
    expect(field.length).toBeLessThanOrEqual(FIELD_MAX);
    expect(field).not.toBe(long);
  });

  test("a short enum in `fields` passes through unchanged (the useful case)", () => {
    const h = harness();
    h.log.log("info", "link-status", { state: "up", attempts: 2, resumed: true });
    expect(h.log.entries()[0]?.fields).toEqual({ state: "up", attempts: 2, resumed: true });
  });

  test("redact is idempotent and safe on text with no URL at all", () => {
    expect(redact("nothing secret here")).toBe("nothing secret here");
    expect(redact(redact(`?token=${TOKEN}`))).toBe(redact(`?token=${TOKEN}`));
  });
});

describe("the ring (Owner Q7: bounded)", () => {
  test("the capacity bound drops the OLDEST and counts what it dropped", () => {
    const h = harness(3);
    for (let i = 0; i < 5; i += 1) {
      h.advance(1);
      h.log.log("info", "timing", { i });
    }
    expect(h.log.entries().map((entry) => entry.fields.i)).toEqual([2, 3, 4]);
    expect(h.log.dropped()).toBe(2);
  });

  test("entries come back oldest first, as a COPY (a caller cannot mutate the ring)", () => {
    const h = harness();
    h.log.log("info", "timing", { i: 0 });
    const first = h.log.entries() as AppLogEntry[];
    // A copy: truncating it must not shorten the ring (readonly in the type,
    // so the mutation needs the cast — which is the point of the assertion).
    first.length = 0;
    expect(h.log.entries()).toHaveLength(1);
  });

  test("the export reports how many entries the ring had dropped", () => {
    const h = harness(2);
    for (let i = 0; i < 4; i += 1) {
      h.log.log("info", "timing", { i });
    }
    const text = exportText(
      {
        appVersion: "1.0.0",
        build: "1",
        osVersion: "26.5",
        deviceModel: "iPhone17,1",
        exportedAt: 1,
        droppedEntries: h.log.dropped(),
      },
      h.log.entries(),
    );
    expect(text).toContain("dropped: 2 (ring bound)");
  });
});

describe("the export text (D7, F17)", () => {
  test("a header with app/OS/device facts and no names", () => {
    const h = harness();
    h.log.log("info", "ws-open", { address: "127.0.0.1:8787" });
    const text = sharedText(h.log.entries());
    expect(text).toContain("app: 1.2.3 (build 45)");
    expect(text).toContain("os: iOS 26.5");
    expect(text).toContain("device: iPhone17,1");
    expect(text).toContain("entries: 1");
    expect(text).not.toContain(COMPUTER);
  });

  test("F17: an EMPTY log still exports a valid header-only file", () => {
    const text = sharedText([]);
    expect(text).toContain("tentacle app log");
    expect(text).toContain("entries: 0");
  });

  test("one line per entry, ISO time first", () => {
    const h = harness();
    h.log.log("info", "lock", { delay: "5m" });
    h.log.log("info", "unlock");
    const lines = entriesToText(h.log.entries()).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z info lock delay=5m$/);
    expect(lines[1]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z info unlock$/);
  });

  test("the file name is a UTC stamp with no device name (Owner Q8)", () => {
    const name = exportFileName(1_700_000_000_000);
    expect(name).toBe("tentacle-logs-2023-11-14T22-13-20-000Z.txt");
  });
});

describe("helpers", () => {
  test("shortId is the first 8 characters (Owner Q8)", () => {
    expect(shortId("0123456789abcdef")).toBe("01234567");
    expect(shortId("abc")).toBe("abc");
  });

  test("fieldValue keeps numbers and booleans, redacts long strings", () => {
    expect(fieldValue(7)).toBe(7);
    expect(fieldValue(false)).toBe(false);
    expect(fieldValue("running")).toBe("running");
    expect(fieldValue(HEX_KEY)).not.toContain(HEX_KEY);
  });
});
