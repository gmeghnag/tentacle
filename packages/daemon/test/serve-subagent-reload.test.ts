import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "@tentacle/core";
import type { KnownLogEntry } from "@tentacle/protocol";
import { parseSidecar, rebuild } from "../src/daemon-state-file.ts";
import { type DaemonSessionRecord, reconcileOnReload } from "../src/persisted-session.ts";
import { entryLines, headerLine, parseLogFile } from "../src/session-log-file.ts";
import { FakeLog, META, asst, user } from "./support/log-fixture.ts";

// docs/feat/subagent-ledger-log.md §3 — the `serve` reload derives the SAME
// notes the laptop's load does (one shared function), from the segment's
// entries THROUGH the sidecar's `logHead`, over the record's FINAL messages.

const ID = "sv1";
const CWD = "/w";
const header = headerLine({ id: ID, ...META, cwd: CWD });

/** The record a restarted daemon reads back from these two file texts. */
function reload(
  entries: readonly KnownLogEntry[],
  rec: Partial<DaemonSessionRecord> & { readonly messages: readonly ChatMessage[] },
): DaemonSessionRecord {
  const logText = header + entryLines(entries);
  const parsed = parseLogFile(logText, ID);
  if (!parsed.ok) throw new Error(parsed.reason);
  const reached = entries.at(-1);
  if (reached === undefined) throw new Error("no entry");
  const sidecar = parseSidecar(
    `${JSON.stringify({
      format: "tentacle-daemon-state",
      schemaVersion: 1,
      id: ID,
      logHead: rec.logHead ?? { seq: reached.seq, id: reached.id },
      k: rec.messages.length,
      tail: [],
      lastActiveAt: 1,
      updatedAt: 1,
      title: "t",
      turns: rec.turns ?? [],
      enqueueIds: [],
      returned: [],
      ...(rec.turn ? { turn: rec.turn } : {}),
    })}\n`,
    ID,
  );
  if (!sidecar.ok) throw new Error(sidecar.reason);
  const rebuilt = rebuild(parsed, sidecar.value, (c) => c === CWD);
  if (!rebuilt.ok) throw new Error(rebuilt.reason);
  return rebuilt.value;
}

describe("serve reload: the sub-agent load derivation (docs/feat/subagent-ledger-log.md)", () => {
  test("an open `bg` before `logHead` becomes a load note, appended by `reconcileOnReload`", () => {
    // RED on main: `rebuild` has no `loadNotes`, so a `serve` restart silently
    // forgets that a background child existed (eval A4, Finding 2).
    // Mutation: derive from the whole segment instead of `entriesThrough` → the
    // FM 17 test below goes red; drop `loadNotes` from `rebuild` → this one.
    const log = new FakeLog("D1");
    const messages = [user("go"), asst("ok")];
    const entries = [...log.base(messages), log.subagentBackground("sa-1")];
    const record = reload(entries, { messages });
    expect(record.loadNotes).toHaveLength(1);
    expect(record.loadNotes[0]?.note).toEqual({ kind: "subagent_lost", id: "sa-1" });
    const reconciled = reconcileOnReload(record);
    expect(reconciled.messages.at(-1)?.note).toEqual({ kind: "subagent_lost", id: "sa-1" });
    // The loaded history is otherwise the capture's, untouched.
    expect(reconciled.messages.slice(0, messages.length)).toEqual(messages);
  });

  test("FM 17: a marker AFTER the sidecar's `logHead` is ignored (a write whose sidecar did not land)", () => {
    // Mutation: derive from `currentSegment(parsed).entries` when paired → the
    // marker of the unlanded write is derived from, and the report it may hold
    // is believed while the rest of that write is ignored → red.
    const log = new FakeLog("D1");
    const messages = [user("go"), asst("ok")];
    const landed = [...log.base(messages)];
    const unlanded = [log.subagentBackground("sa-1"), log.subagentEnd("sa-1", "R")];
    const head = landed.at(-1);
    if (head === undefined) throw new Error("no entry");
    const record = reload([...landed, ...unlanded], {
      messages,
      logHead: { seq: head.seq, id: head.id },
    });
    expect(record.loadNotes).toEqual([]);
  });

  test("a note in the sidecar's TAIL closes its id (delivered after the last log write)", () => {
    // The overlay is where a delivered note lands before the next log write.
    // Mutation: derive over `record.logged` only → the delivered child is noted a second time → red.
    const log = new FakeLog("D1");
    const messages = [user("go"), asst("ok")];
    const entries = [...log.base(messages), log.subagentBackground("sa-1")];
    const reached = entries.at(-1);
    if (reached === undefined) throw new Error("no entry");
    const parsed = parseLogFile(header + entryLines(entries), ID);
    if (!parsed.ok) throw new Error(parsed.reason);
    const delivered: ChatMessage = {
      role: "user",
      content: "[background] sub-agent sa-1 finished",
      note: { kind: "subagent_report", id: "sa-1" },
    };
    const sidecar = parseSidecar(
      `${JSON.stringify({
        format: "tentacle-daemon-state",
        schemaVersion: 1,
        id: ID,
        logHead: { seq: reached.seq, id: reached.id },
        k: messages.length,
        tail: [delivered],
        lastActiveAt: 1,
        updatedAt: 1,
        title: "t",
        turns: [],
        enqueueIds: [],
        returned: [],
      })}\n`,
      ID,
    );
    if (!sidecar.ok) throw new Error(sidecar.reason);
    const rebuilt = rebuild(parsed, sidecar.value, (c) => c === CWD);
    if (!rebuilt.ok) throw new Error(rebuilt.reason);
    expect(rebuilt.value.messages.at(-1)).toEqual(delivered);
    expect(rebuilt.value.loadNotes).toEqual([]);
  });

  test("an UNPROVABLE pair (`logHead` names no complete segment): the notes come from the last segment, as the history does", () => {
    // FM 4 + review nit-1: when `foldThrough` cannot prove the pair, the history
    // is the log's own last segment, so the derivation must read THAT segment —
    // not `[]` (nothing derived) and not a second, different source.
    // Mutation: `entriesThrough(...) ?? []` → no note for a child the last
    // segment says is open → red.
    const log = new FakeLog("D1");
    const messages = [user("go"), asst("ok")];
    const entries = [...log.base(messages), log.subagentBackground("sa-1")];
    const record = reload(entries, {
      messages,
      // A head from another incarnation: no segment holds it.
      logHead: { seq: 9, id: "OTHER/9" },
    });
    expect(record.paired).toBe(false);
    expect(record.messages).toEqual(messages);
    expect(record.loadNotes.map((m) => m.note)).toEqual([{ kind: "subagent_lost", id: "sa-1" }]);
  });
});
