/**
 * The queue-diagnosis trace (docs/fix/mobile-queued-stuck.md): what one `qtrace`
 * line may contain, and what it must NOT.
 *
 * The export is a file a person shares (`app-log.ts` D7/F16), so the negatives
 * are the point of this suite: no text, no long id, no daemon prose — only ids
 * (8 characters), counts and short enums. The last test is the NON-VACUITY check
 * the fix depends on: a report that no longer lists a row must be readable as
 * exactly that, because "the frame was applied and the row stayed" and "the frame
 * never came" have to be told apart in a capture.
 */
import { describe, expect, test } from "bun:test";
import { type AppLogEntry, createAppLog, entriesToText } from "../src/app-log.ts";
import { QTRACE, TRACE_IDS_MAX, queueTrace, traceLine } from "../src/queue-trace.ts";

const SID = "session-0123456789abcdef";
/** A 40-character daemon-ish id: the SHAPE a shared log must reduce. */
const LONG_ID = "0123456789abcdef0123456789abcdef01234567";

describe("one line per event, greppable and time-stamped", () => {
  test("every line carries the kind, the session and the event name", () => {
    const line = traceLine(SID, { kind: "turn-start", turnId: LONG_ID, own: true });
    expect(line.kind).toBe(QTRACE);
    expect(line.kind).toBe("qtrace");
    expect(line.fields.s).toBe("session-");
    expect(line.fields.ev).toBe("turn-start");
    expect(line.fields.turn).toBe("01234567");
    expect(line.fields.own).toBe(true);
  });

  test("through the log, one entry is one `ISO … qtrace …` line", () => {
    const log = createAppLog({ now: () => 1_700_000_000_000, capacity: 50 });
    const trace = queueTrace(SID, log);
    trace({ kind: "link", state: "down" });
    const text = entriesToText(log.entries());
    expect(text).toBe("2023-11-14T22:13:20.000Z info qtrace s=session- ev=link state=down");
  });
});

describe("a `queued` report: the ids it LISTED and the count", () => {
  test("every listed id is named, 8 characters, with the entry count", () => {
    const line = traceLine(SID, {
      kind: "queued-received",
      source: "live",
      entries: [LONG_ID, "row-b", "row-c"],
      returned: 2,
    });
    expect(line.fields).toEqual({
      s: "session-",
      ev: "queued-received",
      src: "live",
      n: 3,
      id0: "01234567",
      id1: "row-b",
      id2: "row-c",
      returned: 2,
    });
  });

  test("an EMPTY report is visible as empty: the frame that clears a row", () => {
    // The load-bearing case. A row leaves the phone's list only on a report that
    // no longer lists it (`compose-queue.ts` `shownRows`), so "n=0 here, then
    // rows=[]" is the healthy path and "no line at all" is a lost frame.
    const line = traceLine(SID, {
      kind: "queued-received",
      source: "live",
      entries: [],
      returned: 0,
    });
    expect(line.fields.n).toBe(0);
    expect(line.fields.id0).toBeUndefined();
    expect(line.fields.returned).toBe(0);
  });

  test("a long list is capped and its overflow COUNTED, never truncated silently", () => {
    const ids = Array.from({ length: TRACE_IDS_MAX + 4 }, (_, i) => `row-${i}`);
    const line = traceLine(SID, {
      kind: "queued-received",
      source: "replay",
      entries: ids,
      returned: 0,
    });
    expect(line.fields.n).toBe(TRACE_IDS_MAX + 4);
    expect(line.fields[`id${TRACE_IDS_MAX - 1}`]).toBe(`row-${TRACE_IDS_MAX - 1}`);
    expect(line.fields[`id${TRACE_IDS_MAX}`]).toBeUndefined();
    expect(line.fields.more).toBe(4);
  });

  test("the source says WHERE the report came from (the second half of the diagnosis)", () => {
    for (const source of ["live", "replay", "current", "snapshot"] as const) {
      expect(
        traceLine(SID, { kind: "queued-received", source, entries: [], returned: 0 }).fields.src,
      ).toBe(source);
    }
  });
});

describe("the rest of the timeline", () => {
  test("turn start and turn end name the turn; the outcome is the fold's own word", () => {
    expect(
      traceLine(SID, { kind: "turn-end", turnId: LONG_ID, outcome: "interrupted" }).fields,
    ).toMatchObject({ ev: "turn-end", turn: "01234567", outcome: "interrupted" });
    // A `turn_end` that closes no bracket has no id to name.
    expect(traceLine(SID, { kind: "turn-end", turnId: null, outcome: "ended" }).fields.turn).toBe(
      "-",
    );
  });

  test("attach, resync, link and history are distinguished by `ev` and `state`", () => {
    expect(traceLine(SID, { kind: "attach", state: "start", reopen: true }).fields).toMatchObject({
      ev: "attach",
      state: "start",
      reopen: true,
    });
    // A typed failure reason is a short enum (`session-controller.ts`), not prose.
    const failed = traceLine(SID, {
      kind: "attach",
      state: "fail",
      reopen: false,
      reason: "archived",
    });
    expect(failed.fields.why).toBe("archived");
    expect(failed.level).toBe("warn");
    expect(traceLine(SID, { kind: "resync", state: "start" }).fields.state).toBe("start");
    expect(traceLine(SID, { kind: "link", state: "down" }).fields.state).toBe("down");
    expect(traceLine(SID, { kind: "history", reason: null, messages: 12 }).fields).toMatchObject({
      ev: "history",
      reason: "none",
      msgs: 12,
    });
  });

  test("a compose act names the LOCAL row it minted; a cancel names the turn", () => {
    expect(traceLine(SID, { kind: "compose", act: "enqueue", row: LONG_ID }).fields).toMatchObject({
      act: "enqueue",
      row: "01234567",
    });
    expect(traceLine(SID, { kind: "cancel", turnId: LONG_ID, own: true }).fields).toMatchObject({
      ev: "cancel",
      turn: "01234567",
      own: true,
    });
  });

  test("a `lost: N` batch is a WARNING with the count (never silent)", () => {
    const line = traceLine(SID, { kind: "batch-lost", lost: 3 });
    expect(line.level).toBe("warn");
    expect(line.fields.lost).toBe(3);
  });

  test("the shown rows name their own ids, under the act they followed", () => {
    const line = traceLine(SID, {
      kind: "rows",
      where: "after-queued-live",
      ids: [LONG_ID, "row-b"],
    });
    expect(line.fields).toEqual({
      s: "session-",
      ev: "rows",
      where: "after-queued-live",
      n: 2,
      id0: "01234567",
      id1: "row-b",
    });
  });
});

describe("what a shared log may NOT contain (app-log D7/F16)", () => {
  test("no row text: an event has no free-text field at all", () => {
    const text = entriesToText(
      [
        traceLine(SID, { kind: "compose", act: "enqueue", row: "r1" }),
        traceLine(SID, { kind: "queued-received", source: "live", entries: ["r1"], returned: 0 }),
      ].map(
        (line, i): AppLogEntry => ({
          t: 1_700_000_000_000 + i,
          level: line.level,
          kind: line.kind,
          fields: line.fields,
        }),
      ),
    );
    // Non-vacuity first: the lines ARE there.
    expect(text).toContain("act=enqueue");
    expect(text).toContain("ev=queued-received");
    // A row id is 8 characters and is the ONLY thing naming a row.
    expect(text).toContain("id0=r1");
  });

  test("a long id is shortened to 8 characters, never carried whole", () => {
    const line = traceLine(SID, { kind: "turn-start", turnId: LONG_ID, own: false });
    expect(line.fields.turn).toBe("01234567");
    expect(JSON.stringify(line.fields)).not.toContain(LONG_ID);
  });

  test("an empty id says `-` rather than an empty field", () => {
    expect(traceLine(SID, { kind: "compose", act: "enqueue", row: "" }).fields.row).toBe("-");
  });
});
