import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "@tentacle/core";
import { projectEntry } from "@tentacle/protocol";
import {
  ENDED_INTERRUPTED_NOTE,
  ENDED_NOT_RUN_NOTE,
  ENDED_TURN_NOTE,
} from "../src/persisted-session.ts";
import {
  SESSION_LOG_VERSION,
  closeAtLoad,
  currentSegment,
  cutHistory,
  entriesThrough,
  entryLines,
  foldThrough,
  headerLine,
  parseLogFile,
  segmentFromMessages,
} from "../src/session-log-file.ts";
import { FakeLog, META, asst, tool, user } from "./support/log-fixture.ts";

// docs/feat/session-log-laptop-store.md §2: the laptop log's pure format —
// header, segments, the shared fold, torn tails, unknown entries, and the
// close of a cut turn at LOAD (W12).

const ID = "s1";
const header = headerLine({ id: ID, ...META });

function parsed(text: string) {
  const result = parseLogFile(text, ID);
  if (!result.ok) throw new Error(result.reason);
  return result;
}

describe("parseLogFile", () => {
  test("header + one segment: the fold, the title, the turn markers", () => {
    const log = new FakeLog("D1");
    const text =
      header +
      entryLines([
        ...log.base([user("a")]),
        log.title("T"),
        log.turnStart("t1"),
        log.msg(asst("b")),
        log.replace(0, user("a2")),
        log.turnEnd("t1"),
      ]);
    const file = parsed(text);
    const seg = currentSegment(file);
    expect(file.header.schemaVersion).toBe(SESSION_LOG_VERSION);
    expect(seg.messages).toEqual([user("a2"), asst("b")]);
    expect(seg.title).toEqual({ text: "T", source: "user" });
    expect(seg.openTurns).toEqual([]);
    expect(file.torn).toBe(0);
  });

  test("W3 a torn last line (no newline) is ignored and counted; the content end is the last newline", () => {
    const log = new FakeLog("D1");
    const good = header + entryLines(log.base([user("a"), asst("b")]));
    const torn = `${JSON.stringify(log.msg(user("c"))).slice(0, 20)}`;
    const file = parsed(good + torn);
    expect(currentSegment(file).messages).toEqual([user("a"), asst("b")]);
    expect(file.torn).toBe(torn.length);
    expect(file.contentEnd).toBe(good.length);
  });

  test("W3 a corrupt MIDDLE line refuses the file (corruption is loud, never skipped)", () => {
    const log = new FakeLog("D1");
    const [b, m1, m2] = log.base([user("a"), asst("b")]);
    const text = `${header}${JSON.stringify(b)}\n{not json\n${JSON.stringify(m1)}\n${JSON.stringify(m2)}\n`;
    const result = parseLogFile(text, ID);
    expect(result.ok ? "loaded" : result.reason).toBe("line 3 is not JSON");
  });

  test("W9 an unknown NON-critical entry is skipped and counted in its segment; an unknown CRITICAL one refuses", () => {
    const log = new FakeLog("D1");
    const entries = log.base([user("a")]);
    const skippable = JSON.stringify({ type: "usage_total", seq: 99, id: "D1/99", ts: 1, n: 5 });
    const ok = parsed(`${header}${entryLines(entries)}${skippable}\n`);
    expect(ok.skipped).toBe(1);
    expect(currentSegment(ok).unknown).toBe(1);
    expect(currentSegment(ok).messages).toEqual([user("a")]);
    const critical = JSON.stringify({ type: "edit", seq: 99, id: "D1/99", ts: 1, critical: true });
    const refused = parseLogFile(`${header}${entryLines(entries)}${critical}\n`, ID);
    expect(refused.ok ? "loaded" : refused.reason).toContain(
      "critical entry of a type this build does not know (edit)",
    );
  });

  test("a note this build cannot read does not refuse the file: the message loads without it (M3)", () => {
    // RED on round 1's build: `message` is CRITICAL, so the unreadable note made
    // the entry malformed and the WHOLE log unloadable (review M3).
    // Mutation: drop `.catch(undefined)` from `note` in protocol/src/session.ts → red.
    const log = new FakeLog("D1");
    const noted = (note: unknown): ChatMessage =>
      ({ role: "user", content: "a", note }) as unknown as ChatMessage;
    const file = parsed(
      header +
        entryLines([
          ...log.base([
            noted({ kind: "User-X" }),
            noted({ kind: "subagent_report", id: "x".repeat(65) }),
          ]),
          log.msg(asst("b")),
        ]),
    );
    const seg = currentSegment(file);
    expect(seg.messages).toEqual([user("a"), user("a"), asst("b")]);
    expect(seg.messages.every((m) => m.note === undefined)).toBe(true);
    expect(file.skipped).toBe(0);
  });

  test("W9 an unknown header schemaVersion refuses the file (never half-loaded)", () => {
    const newer = `${JSON.stringify({ format: "tentacle-session-log", schemaVersion: 2, id: ID, cwd: "/w", model: "m", createdAt: 1 })}\n`;
    const result = parseLogFile(newer + entryLines(new FakeLog("D1").base([user("a")])), ID);
    expect(result.ok ? "loaded" : result.reason).toContain("schemaVersion 2");
  });

  test("the header's id must be the file's; a header-only or empty file has no segment", () => {
    expect(parseLogFile(headerLine({ id: "other", ...META }), ID).ok).toBe(false);
    expect(parseLogFile(header, ID).ok).toBe(false);
    expect(parseLogFile("", ID).ok).toBe(false);
  });

  test("Q13 seq must grow inside a segment; an exact duplicate id is skipped (a stale-lock double append)", () => {
    const log = new FakeLog("D1");
    const entries = log.base([user("a")]);
    const extra = log.msg(asst("b"));
    const dup = parsed(header + entryLines([...entries, extra, extra]));
    expect(dup.duplicates).toBe(1);
    expect(currentSegment(dup).messages).toEqual([user("a"), asst("b")]);
    const back = { ...extra, id: "D1/other", seq: 1 };
    const bad = parseLogFile(header + entryLines([...entries, back]), ID);
    expect(bad.ok ? "loaded" : bad.reason).toContain("does not grow");
  });

  test("a replace past the end or a base short of its messages mid-file refuses; a torn LAST segment is dropped", () => {
    const log = new FakeLog("D1");
    const base = log.base([user("a")]);
    const past = parseLogFile(header + entryLines([...base, log.replace(5, user("x"))]), ID);
    expect(past.ok ? "loaded" : past.reason).toContain("past the end");
    // keepSuperseded: an append of a compaction batch torn after its base.
    const log2 = new FakeLog("D1");
    const first = log2.base([user("a"), asst("b")]);
    const compact = log2.base([user("summary"), asst("c")], "compact");
    const tornBatch = parsed(header + entryLines([...first, ...compact.slice(0, 2)]));
    expect(tornBatch.segments).toHaveLength(1);
    expect(currentSegment(tornBatch).messages).toEqual([user("a"), asst("b")]);
    expect(tornBatch.tornSegment).toBeGreaterThan(0);
  });

  test("lax (the listing) and strict (load) agree on a valid file", () => {
    const log = new FakeLog("D1");
    const text =
      header + entryLines([...log.base([user("a")]), log.title("T"), log.msg(asst("b"))]);
    const lax = parseLogFile(text, ID, { lax: true });
    const strict = parseLogFile(text, ID);
    expect(lax.ok && currentSegment(lax).messages).toEqual(
      strict.ok && currentSegment(strict).messages,
    );
  });

  test("segmentFromMessages mints known types with their fixed critical values, and a chosen title", () => {
    const seg = segmentFromMessages(
      [user("a"), asst("b")],
      { text: "T", source: "user" },
      "laptop-x",
      7,
    );
    expect(seg.map((e) => [e.type, e.critical ?? false])).toEqual([
      ["base", true],
      ["message", true],
      ["message", true],
      ["title", false],
    ]);
    expect(currentSegment(parsed(header + entryLines(seg))).messages).toEqual([
      user("a"),
      asst("b"),
    ]);
  });
});

describe("W12 closeAtLoad: a cut turn is closed when the file is LOADED (Q11)", () => {
  /** A segment with an open turn whose assistant called c1, c2, c3; `started` calls began. */
  function openTurn(started: string[], answered: string[] = []) {
    const log = new FakeLog("D1");
    const entries = [
      ...log.base([user("go")]),
      log.turnStart("t1"),
      log.msg(asst("", ["c1", "c2", "c3"])),
      ...started.map((c) => log.callStarted(c)),
      ...answered.map((c) => log.msg(tool(c))),
    ];
    return currentSegment(parsed(header + entryLines(entries)));
  }

  test("call_started → Interrupted, the rest → Not run, then the ended-turn note (= today's cutHistory)", () => {
    // Mutation: ignore `call_started` (pass an empty set) → c1 reads "Not run".
    const seg = openTurn(["c1", "c2"], ["c1"]);
    const closed = closeAtLoad(seg);
    expect(closed).toEqual(cutHistory(seg.messages, new Set(["c1", "c2"])));
    expect(closed.slice(3).map((m) => [m.toolCallId, m.content])).toEqual([
      ["c2", ENDED_INTERRUPTED_NOTE],
      ["c3", ENDED_NOT_RUN_NOTE],
      [undefined, ENDED_TURN_NOTE],
    ]);
  });

  test("a turn open at a prompt (nothing answered yet) ends on the note, never the bare prompt", () => {
    const log = new FakeLog("D1");
    const seg = currentSegment(
      parsed(header + entryLines([...log.base([]), log.turnStart("t1"), log.msg(user("go"))])),
    );
    expect(closeAtLoad(seg)).toEqual([user("go"), { role: "assistant", content: ENDED_TURN_NOTE }]);
  });

  test("a CLOSED turn is returned as it is, even on a tool result (raw)", () => {
    const log = new FakeLog("D1");
    const entries = [
      ...log.base([user("go")]),
      log.turnStart("t1"),
      log.msg(asst("", ["c1"])),
      log.msg(tool("c1")),
      log.turnEnd("t1"),
    ];
    const seg = currentSegment(parsed(header + entryLines(entries)));
    expect(closeAtLoad(seg)).toBe(seg.messages);
  });

  test("a turn open across a base (base.turn: a context reset mid-turn) is still open", () => {
    const log = new FakeLog("D1");
    const entries = [
      ...log.base([user("FRESH")], "context_reset", "t1"),
      log.msg(asst("", ["c9"])),
    ];
    const seg = currentSegment(parsed(header + entryLines(entries)));
    expect(seg.openTurns).toEqual(["t1"]);
    expect(closeAtLoad(seg).at(-2)).toEqual(tool("c9", ENDED_NOT_RUN_NOTE));
  });

  test("safety net: no open turn but a trailing unanswered call → the reload's rule", () => {
    const log = new FakeLog("D1");
    const seg = currentSegment(
      parsed(header + entryLines(log.base([user("go"), asst("", ["c1", "c2"])]))),
    );
    expect(closeAtLoad(seg)).toEqual(cutHistory(seg.messages, null));
  });
});

describe("entriesThrough (docs/feat/subagent-ledger-log.md §3)", () => {
  test("the segment's entries from its base THROUGH `head`, on the same terms as foldThrough", () => {
    // RED on main: the function does not exist (the serve reload has no way to
    // cut the entries it derives its notes from at the sidecar's head).
    // Mutation: return the whole segment regardless of `head` → a marker after
    // `logHead` (a write whose sidecar did not land) would be derived from, FM 17 → red.
    const log = new FakeLog("D1");
    const entries = [
      ...log.base([user("a"), asst("b")]),
      log.turnStart("t1"),
      log.subagentBackground("sa-1"),
      log.subagentEnd("sa-1", "R"),
      log.turnEnd("t1"),
    ];
    const p = parsed(header + entryLines(entries));
    const head = entries[3];
    if (head === undefined) throw new Error("no entry");
    const cut = entriesThrough(p, { seq: head.seq, id: head.id });
    expect(cut?.map((e) => e.type)).toEqual(["base", "message", "message", "turn_start"]);
    // The whole segment, at its last entry.
    const last = entries.at(-1);
    if (last === undefined) throw new Error("no entry");
    expect(entriesThrough(p, { seq: last.seq, id: last.id })?.length).toBe(entries.length);
  });

  test("null on the same terms as foldThrough: an unknown id, a stale seq, a head inside a base's owed messages", () => {
    const log = new FakeLog("D1");
    const entries = [...log.base([user("a"), asst("b")]), log.subagentBackground("sa-1")];
    const p = parsed(header + entryLines(entries));
    expect(entriesThrough(p, { seq: 9, id: "D1/9" })).toBeNull();
    const known = entries[1];
    if (known === undefined) throw new Error("no entry");
    expect(entriesThrough(p, { seq: known.seq + 1, id: known.id })).toBeNull();
    // `base` owes 2 messages: index 0..count are no capture point.
    expect(entriesThrough(p, { seq: known.seq, id: known.id })).toBeNull();
    // And foldThrough agrees, entry for entry.
    const ok = entries[2];
    if (ok === undefined) throw new Error("no entry");
    const head = { seq: ok.seq, id: ok.id };
    expect(foldThrough(p, head)).toEqual(
      (entriesThrough(p, head) ?? []).reduce<ChatMessage[]>((list, e) => {
        projectEntry(list, e, (m) => m as ChatMessage);
        return list;
      }, []),
    );
  });
});
