import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  type ChatMessage,
  type WorkUnit,
  unifyTurn,
  unitEndBody,
  unitsFromSegment,
} from "@tentacle/core";
import {
  type KnownLogEntry,
  KnownLogEntrySchema,
  UNIT_END_ID_MAX_CHARS,
  UNIT_END_WORD_MAX_CHARS,
} from "@tentacle/protocol";
import { currentSegment, entryLines, headerLine, parseLogFile } from "../src/session-log-file.ts";
import { SessionLog } from "../src/session-log.ts";
import { META } from "./support/log-fixture.ts";

// docs/feat/a2a.md, Unification §2 / slice S1: the daemon's `unit_end` writer,
// its round trip through the on-disk log, and an older reader skipping it.

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const ID = "s1";

/** A segment cut by a compaction that carries one ended turn, as S2's carry will write it. */
function carriedLog(ended: WorkUnit): { log: SessionLog; entries: KnownLogEntry[] } {
  let clock = 100;
  const log = new SessionLog("inc", () => clock++);
  const messages: ChatMessage[] = [{ role: "user", content: "hello" }];
  log.start(messages, "create");
  log.turnStart(ended.id);
  messages.push({ role: "assistant", content: "done: 42" });
  log.commit(messages, messages.length);
  log.turnEnd(ended.id, "end_turn");
  const compacted: ChatMessage[] = [{ role: "user", content: "summary" }];
  log.replaced(compacted, "compact");
  log.commit(compacted, compacted.length);
  log.unitEnd(unitEndBody(ended));
  return { log, entries: log.since().slots.map((slot) => log.materialize(slot, sha256)) };
}

const turn: WorkUnit = unifyTurn({
  turnId: "task-1",
  stopReason: "end_turn",
  startedAt: 101,
  endedAt: 104,
  result: "done: 42",
});

describe("SessionLog.unitEnd", () => {
  test("writes a NON-critical `unit_end` entry a reader parses", () => {
    const { entries } = carriedLog(turn);
    const last = entries.at(-1);
    expect(last?.type).toBe("unit_end");
    if (last?.type !== "unit_end") return;
    expect(last.critical).toBe(false);
    expect(last.unitId).toBe("task-1");
    expect(last.seq).toBeGreaterThan(1);
    expect(KnownLogEntrySchema.safeParse(last).success).toBe(true);
  });

  test("round trip: the disk log gives back the identical unit", () => {
    const { entries } = carriedLog(turn);
    const parsed = parseLogFile(headerLine({ id: ID, ...META }) + entryLines(entries), ID);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.skipped).toBe(0);
    const units = unitsFromSegment(currentSegment(parsed).entries);
    expect(units.ended).toEqual([turn]);
    expect(units.open).toEqual([]);
  });

  test("an older reader (that does not know `unit_end`) skips it and projects the same history", () => {
    const { entries } = carriedLog(turn);
    const text = headerLine({ id: ID, ...META }) + entryLines(entries);
    // What an older build sees: a type it does not know, not critical.
    const older = text.replace('"type":"unit_end"', '"type":"unit_end_from_the_future"');
    expect(older).not.toBe(text);
    const now = parseLogFile(text, ID);
    const then = parseLogFile(older, ID);
    expect(now.ok && then.ok).toBe(true);
    if (!now.ok || !then.ok) return;
    expect(then.skipped).toBe(1);
    expect(currentSegment(then).messages).toEqual(currentSegment(now).messages);
    expect(currentSegment(now).messages).toEqual([{ role: "user", content: "summary" }]);
  });
});

describe("unitEndBody (the emitter) caps and judges", () => {
  test("an over-long id and native word are cut to the entry's bounds", () => {
    const long: WorkUnit = {
      kind: "workflow",
      id: "w".repeat(UNIT_END_ID_MAX_CHARS + 50),
      state: "failed",
      native: `stopped:${"z".repeat(UNIT_END_WORD_MAX_CHARS)}`,
      endedAt: 9,
    };
    const body = unitEndBody(long);
    expect(body.unitId.length).toBe(UNIT_END_ID_MAX_CHARS);
    expect(body.native.length).toBe(UNIT_END_WORD_MAX_CHARS);
    const log = new SessionLog("inc", () => 1);
    log.start([], "create");
    log.unitEnd(body);
    const last = log.since().slots.at(-1);
    expect(last !== undefined && KnownLogEntrySchema.safeParse(last.entry).success).toBe(true);
  });

  test("a body the schema refuses throws, never reaches the log", () => {
    const bad: WorkUnit = { ...turn, origin: "o".repeat(129) };
    expect(() => unitEndBody(bad)).toThrow(/unit_end: refusing to log an invalid entry \(origin/);
    const fractional: WorkUnit = { ...turn, endedAt: 1.5 };
    expect(() => unitEndBody(fractional)).toThrow(/endedAt/);
  });
});
