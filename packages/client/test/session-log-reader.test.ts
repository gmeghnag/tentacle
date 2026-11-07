import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ChatMessage } from "@tentacle/core";
import { SessionLog } from "@tentacle/daemon";
import type { LogCursor, LogEntryEnvelope, LogResult } from "@tentacle/protocol";
import { type LogApplied, type LogState, applyLogRead } from "../src/session-log-reader.ts";

// docs/feat/session-log.md — the laptop's reader: validate, project, classify.
// Pages come from the daemon's real `SessionLog` (no hand-written happy path).

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const m = (role: ChatMessage["role"], content: string): ChatMessage => ({ role, content });
const history = (n: number, tag = "m"): ChatMessage[] => [
  m("system", "S"),
  ...Array.from({ length: n - 1 }, (_, i) => m(i % 2 ? "assistant" : "user", `${tag}${i + 1}`)),
];

/** Every page after `after` (one read). */
function pages(log: SessionLog, after?: LogCursor, maxChars = 1 << 20): LogResult[] {
  const out: LogResult[] = [];
  let cursor = after;
  for (;;) {
    const page = log.read(cursor, maxChars, sha256);
    out.push(page);
    const last = page.entries.at(-1);
    if (!page.more || !last) return out;
    cursor = { seq: last.seq, id: last.id };
  }
}

function ok(result: LogApplied | { error: string }): LogApplied {
  if ("error" in result) throw new Error(`refused: ${result.error}`);
  return result;
}

function cold(log: SessionLog): LogState {
  return ok(applyLogRead(null, pages(log), sha256)).state;
}

/** Re-chain a hand-edited page: seq/id/prev from its first entry on, tip = the last. */
function rechain(
  page: LogResult,
  edit: (entries: LogEntryEnvelope[]) => LogEntryEnvelope[],
): LogResult {
  const first = page.entries[0];
  if (!first) throw new Error("empty page");
  let prev = first.prev;
  let seq = first.seq;
  const entries = edit(page.entries.map((e) => ({ ...e }))).map((e) => {
    const out = { ...e, seq, id: `x/${seq}`, ...(prev !== undefined ? { prev } : {}) };
    prev = out.id;
    seq++;
    return out;
  });
  const last = entries.at(-1);
  return { ...page, entries, tip: last ? { seq: last.seq, id: last.id } : page.tip };
}

describe("C1–C4 — classification against the held copy", () => {
  test("C1 a linear tail is applied onto the held copy (replace, append, title)", () => {
    const log = new SessionLog("inc-1");
    const h = history(5);
    log.start(h, "create");
    log.title({ text: "first", source: "auto" });
    const held = cold(log);
    h[0] = m("system", "S2");
    h.push(m("user", "more"));
    log.commit(h, h.length);
    log.title({ text: "named", source: "user" });
    const applied = ok(applyLogRead(held, pages(log, held.head), sha256));
    expect(applied.outcome).toBe("linear");
    expect(applied.state.messages).toEqual(h);
    expect(applied.title).toEqual({ text: "named", source: "user" });
    expect(applied.entries.map((e) => e.type)).toEqual(["replace", "message", "title"]);
    // Nothing new: an empty read, the same state object.
    const again = ok(applyLogRead(applied.state, pages(log, applied.state.head), sha256));
    expect(again.state).toBe(applied.state);
    expect(again.entries).toEqual([]);
  });

  test("C2 rebased within the same incarnation (two compactions behind): adopted, `gap`", () => {
    const log = new SessionLog("inc-1");
    const h = history(4);
    log.start(h, "create");
    const held = cold(log);
    h.splice(0, h.length, m("system", "S"), m("user", "SUMMARY 1"));
    log.replaced(h, "compact");
    h.splice(0, h.length, m("system", "S"), m("user", "SUMMARY 2"));
    log.replaced(h, "compact");
    const read = pages(log, held.head);
    expect(read[0]?.rebased).toBe(true);
    const applied = ok(applyLogRead(held, read, sha256));
    expect(applied.outcome).toBe("rebased");
    expect(applied.gap).toBe(true);
    expect(applied.aside).toBeUndefined();
    expect(applied.state.messages).toEqual(h);
  });

  test("C3 a daemon reseeded from THIS head continues; the F1 scenario (reseeded from an older head) is a FORK, set aside", () => {
    // Mutation: classify any rebased read as a continuation → no aside in the F1 case.
    const d1 = new SessionLog("D1");
    const h = history(48);
    d1.start(h, "create");
    const b = cold(d1); // TUI B holds 48
    h.push(m("user", "49"), m("assistant", "50"));
    d1.commit(h, h.length);
    const a = ok(applyLogRead(b, pages(d1, b.head), sha256)).state; // TUI A holds 50
    expect(a.messages).toHaveLength(50);

    // D1 dies. A reseeds D2 from its own head: a continuation, no aside.
    const fromA = new SessionLog("D2a");
    fromA.start(a.messages, "seed", a.head);
    const cont = ok(applyLogRead(a, pages(fromA, a.head), sha256));
    expect(cont.outcome).toBe("reseed");
    expect(cont.aside).toBeUndefined();

    // F1: B reseeds D2 at 48, which runs one more round; A reads D2.
    const d2 = new SessionLog("D2");
    const fromB = b.messages.slice();
    d2.start(fromB, "seed", b.head);
    fromB.push(m("user", "51 (D2)"));
    d2.commit(fromB, fromB.length);
    const fork = ok(applyLogRead(a, pages(d2, a.head), sha256));
    expect(fork.outcome).toBe("fork");
    expect(fork.aside).toEqual(a.messages); // A's copy, whole — never spliced
    expect(fork.state.messages).toEqual(fromB); // D2's lineage adopted
    expect(fork.state.messages.map((x) => x.content)).not.toContain("50");
  });

  test("C4 a new lineage (a serve reload): equal or extending → adopted; a strict prefix or divergent → fork", () => {
    const d1 = new SessionLog("D1");
    const h = history(6);
    d1.start(h, "create");
    const held = cold(d1);
    const reload = (msgs: ChatMessage[]) => {
      const d = new SessionLog(crypto.randomUUID());
      d.start(msgs, "reload");
      return ok(applyLogRead(held, pages(d, held.head), sha256));
    };
    expect(reload(h.slice()).outcome).toBe("adopt");
    expect(reload([...h, m("user", "more")]).outcome).toBe("adopt");
    const prefix = reload(h.slice(0, 4));
    expect(prefix.outcome).toBe("fork");
    expect(prefix.aside).toEqual(h);
    const divergent = h.slice();
    divergent[3] = m("assistant", "other");
    expect(reload(divergent).outcome).toBe("fork");
  });
});

describe("C5–C7 — a pod is not trusted (F4)", () => {
  function base() {
    const log = new SessionLog("inc-1");
    const h = history(3);
    log.start(h, "create");
    const held = cold(log);
    h.push(m("user", "next"));
    log.commit(h, h.length);
    const [page] = pages(log, held.head);
    if (!page) throw new Error("no page");
    return { held, page, h };
  }

  test("C5 an unknown NON-critical entry is dropped: absent from the projection AND from `entries`", () => {
    // Mutation: keep unknown entries in `entries` → this fails.
    const { held, page, h } = base();
    const planted = rechain(page, (es) => [
      {
        type: "pod_note",
        seq: 0,
        id: "",
        ts: 1,
        payload: "for a future build",
      } as LogEntryEnvelope,
      ...es,
    ]);
    const applied = ok(applyLogRead(held, [planted], sha256));
    expect(applied.state.messages).toEqual(h);
    expect(applied.entries.map((e) => e.type)).toEqual(["message"]);
    expect(JSON.stringify(applied.entries)).not.toContain("future");
  });

  test("C5b a known entry keeps only its known fields (re-serialized, never verbatim)", () => {
    const { held, page } = base();
    const planted = rechain(page, (es) => es.map((e) => ({ ...e, smuggled: "x" })));
    const applied = ok(applyLogRead(held, [planted], sha256));
    expect(JSON.stringify(applied.entries)).not.toContain("smuggled");
  });

  test("C6 an unknown CRITICAL entry refuses the read; the held state is untouched", () => {
    const { held, page } = base();
    const before = JSON.stringify(held);
    const planted = rechain(page, (es) => [
      ...es,
      { type: "fold", seq: 0, id: "", ts: 1, critical: true } as LogEntryEnvelope,
    ]);
    const result = applyLogRead(held, [planted], sha256);
    expect("error" in result && result.error).toContain(
      "critical entry of a type this build does not know (fold)",
    );
    expect(JSON.stringify(held)).toBe(before);
  });

  test("C7 every malformed case refuses the whole read", () => {
    const { held, page } = base();
    const refused = (p: LogResult, h: LogState | null = held) =>
      "error" in applyLogRead(h, [p], sha256);
    // A dangling `prev` / a seq gap (the chain).
    expect(refused({ ...page, entries: page.entries.map((e) => ({ ...e, prev: "nope" })) })).toBe(
      true,
    );
    expect(refused({ ...page, entries: page.entries.map((e) => ({ ...e, seq: e.seq + 5 })) })).toBe(
      true,
    );
    // A replace past the end; a truncate that grows.
    expect(
      refused(
        rechain(
          page,
          () =>
            [
              {
                type: "replace",
                seq: 0,
                id: "",
                ts: 1,
                critical: true,
                index: 99,
                message: m("user", "x"),
              },
            ] as LogEntryEnvelope[],
        ),
      ),
    ).toBe(true);
    expect(
      refused(
        rechain(
          page,
          () =>
            [
              { type: "truncate", seq: 0, id: "", ts: 1, critical: true, length: 99 },
            ] as LogEntryEnvelope[],
        ),
      ),
    ).toBe(true);
    // A base that does not get its `count` messages.
    expect(
      refused(
        rechain(
          page,
          () =>
            [
              {
                type: "base",
                seq: 0,
                id: "",
                ts: 1,
                critical: true,
                inc: "i",
                reason: "seed",
                count: 3,
              },
              {
                type: "message",
                seq: 0,
                id: "",
                ts: 1,
                critical: true,
                message: m("user", "only one"),
              },
            ] as LogEntryEnvelope[],
        ),
      ),
    ).toBe(true);
    // A known type with a bad payload; a critical type sent as skippable.
    expect(
      refused(
        rechain(page, (es) => es.map((e) => ({ ...e, message: { role: "robot", content: 1 } }))),
      ),
    ).toBe(true);
    expect(refused(rechain(page, (es) => es.map((e) => ({ ...e, critical: false }))))).toBe(true);
    // A cold read that does not start at a base; a tip that is not the last entry.
    expect(refused(page, null)).toBe(true);
    expect(refused({ ...page, tip: { seq: 999, id: "x/999" } })).toBe(true);
    // An incomplete read; a later page rebased.
    expect(refused({ ...page, more: true })).toBe(true);
    expect(
      "error" in
        applyLogRead(
          held,
          [
            { ...page, more: true },
            { ...page, rebased: true },
          ],
          sha256,
        ),
    ).toBe(true);
  });
});

describe("C8 — a checkpoint that disagrees is reported as drift (F2)", () => {
  test("a right digest passes; a wrong count or digest is `drift`", () => {
    const log = new SessionLog("inc-1");
    const h = history(4);
    log.start(h, "create");
    log.checkpoint();
    const good = ok(applyLogRead(null, pages(log), sha256));
    expect(good.drift).toBeUndefined();
    const [page] = pages(log);
    if (!page) throw new Error("no page");
    const lie = {
      ...page,
      entries: page.entries.map((e) =>
        e.type === "checkpoint" ? { ...e, digest: "0".repeat(64) } : e,
      ),
    };
    expect(ok(applyLogRead(null, [lie], sha256)).drift).toEqual({ seq: 6 });
    const short = {
      ...page,
      entries: page.entries.map((e) => (e.type === "checkpoint" ? { ...e, count: 3 } : e)),
    };
    expect(ok(applyLogRead(null, [short], sha256)).drift).toBeDefined();
  });
});

describe("fix round 1 — M1 (root) and L1 (a reseed must carry the held copy)", () => {
  function heldOf(): { held: LogState; h: ChatMessage[] } {
    const d1 = new SessionLog("D1");
    const h = history(3);
    d1.start(h, "create");
    return { held: cold(d1), h };
  }

  test("I3 + compaction before the read → no aside: an honest reseed whose seed segment was compacted away is a `reseed` + `gap`", () => {
    // RED before the fix: the read is rebased from `base{compact}` (inc D2, not
    // linked to the held head) → classified `fork` with an aside.
    const { held, h } = heldOf();
    const d2 = new SessionLog("D2");
    d2.start(h, "seed", held.head);
    d2.replaced([m("system", "S"), m("user", "SUMMARY")], "compact");
    const read = pages(d2, held.head);
    expect(read[0]?.rebased).toBe(true);
    const applied = ok(applyLogRead(held, read, sha256));
    expect(applied.outcome).toBe("reseed");
    expect(applied.aside).toBeUndefined();
    expect(applied.gap).toBe(true);
    expect(applied.state.messages.map((x) => x.content)).toEqual(["S", "SUMMARY"]);
  });

  test("two compactions after the reseed (both retained segments gone): still a `reseed` + `gap`, no aside", () => {
    const { held, h } = heldOf();
    const d2 = new SessionLog("D2");
    d2.start(h, "seed", held.head);
    d2.replaced([m("system", "S"), m("user", "SUMMARY 1")], "compact");
    d2.replaced([m("system", "S"), m("user", "SUMMARY 2")], "compact");
    const read = pages(d2, held.head);
    expect(read[0]?.rebased).toBe(true);
    expect(read[0]?.root).toEqual(held.head);
    const applied = ok(applyLogRead(held, read, sha256));
    expect(applied.outcome).toBe("reseed");
    expect(applied.aside).toBeUndefined();
    expect(applied.gap).toBe(true);
  });

  test("a daemon that never linked to our head has another `root`: a compacted new lineage stays a fork", () => {
    const { held, h } = heldOf();
    const other = new SessionLog("DX");
    other.start(h, "seed", { seq: held.head.seq - 1, id: "elsewhere/1" });
    other.replaced([m("system", "S"), m("user", "SUMMARY")], "compact");
    const applied = ok(applyLogRead(held, pages(other, held.head), sha256));
    expect(applied.outcome).toBe("fork");
    expect(applied.aside).toEqual(held.messages);
  });

  test("L1 a forged `base.prev` = our head with other content is a fork (the seed segment must equal the held copy)", () => {
    // RED before the fix: classified `reseed`, the held copy replaced with no aside.
    const { held } = heldOf();
    const forged = new SessionLog("EVIL");
    forged.start([m("user", "forged")], "seed", held.head);
    const applied = ok(applyLogRead(held, pages(forged, held.head), sha256));
    expect(applied.outcome).toBe("fork");
    expect(applied.aside).toEqual(held.messages);
    expect(applied.state.messages.map((x) => x.content)).toEqual(["forged"]);
  });

  test("an honest reseed (seed segment = held copy) stays `reseed`, also when it already grew", () => {
    const { held, h } = heldOf();
    const same = new SessionLog("D2");
    same.start(h, "seed", held.head);
    expect(ok(applyLogRead(held, pages(same, held.head), sha256)).outcome).toBe("reseed");
    const plus = new SessionLog("D3");
    plus.start(h, "seed", held.head);
    plus.commit([...h, m("user", "next")], h.length + 1);
    const applied = ok(applyLogRead(held, pages(plus, held.head), sha256));
    expect(applied.outcome).toBe("reseed");
    expect(applied.state.messages).toHaveLength(h.length + 1);
  });
});
