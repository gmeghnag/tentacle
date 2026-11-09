import { describe, expect, test } from "bun:test";
import {
  AGENT_ID_PREFIX,
  type AgentJob,
  AgentJobLedger,
  NOTE_KIND,
  capSubagentText,
  subagentLoadNotes,
  subagentLostNote,
  subagentReportNote,
} from "@tentacle/core";
import type { ChatMessage } from "@tentacle/core";
import {
  type KnownLogEntry,
  LogSubagentBackgroundEntrySchema,
  LogSubagentEndEntrySchema,
  SUBAGENT_AGENT_TYPE_MAX_CHARS,
  SUBAGENT_CALL_ID_MAX_CHARS,
  SUBAGENT_DESCRIPTION_MAX_CHARS,
  SUBAGENT_REPORT_MAX_CHARS,
  SUBAGENT_STOP_REASON_MAX_CHARS,
} from "@tentacle/protocol";

// docs/feat/subagent-ledger-log.md §2 — the pure `AgentJobLedger`: the ONE set
// of transitions the live path (6a) and the replay (a load) share, and THE load
// derivation `subagentLoadNotes` both load sites call. Each test names the
// mutation that must turn it red (AGENTS §9).

const job = (agentId: string, over: Partial<AgentJob> = {}): AgentJob => ({
  agentId,
  callId: `c-${agentId}`,
  agentType: "explore",
  description: "map the repo",
  state: "running",
  ...over,
});

/** A `subagent_background` entry, envelope and all (what a reader hands the derivation). */
const bg = (agentId: string, over: Record<string, unknown> = {}): KnownLogEntry =>
  ({
    type: "subagent_background",
    seq: 1,
    id: `inc/${agentId}/bg`,
    ts: 1,
    agentId,
    callId: `c-${agentId}`,
    agentType: "explore",
    description: "map the repo",
    ...over,
  }) as unknown as KnownLogEntry;

/** A `subagent_end` entry, envelope and all. */
const endEntry = (agentId: string, over: Record<string, unknown> = {}): KnownLogEntry =>
  ({
    type: "subagent_end",
    seq: 2,
    id: `inc/${agentId}/end`,
    ts: 1,
    agentId,
    stopReason: "end_turn",
    ...over,
  }) as unknown as KnownLogEntry;

/** A body spread into an entry envelope, parsed by the REAL schema a reader uses. */
const envelope = (
  body: Record<string, unknown>,
  type: "subagent_background" | "subagent_end",
  seq: number,
): { ok: boolean } => {
  const entry = { ...body, type, seq, id: `inc/${seq}`, ts: 1, critical: false };
  const parsed =
    type === "subagent_background"
      ? LogSubagentBackgroundEntrySchema.safeParse(entry)
      : LogSubagentEndEntrySchema.safeParse(entry);
  return { ok: parsed.success };
};

const note = (content: string, kind: string, id?: string): ChatMessage => ({
  role: "user",
  content,
  note: { kind, ...(id !== undefined ? { id } : {}) },
});

describe("AgentJobLedger — the transitions (live path and replay alike)", () => {
  test("background → running; end → ended; segmentFacts re-emits what a segment start must not lose", () => {
    // Mutation: `segmentFacts` emission filtered to `running` only → an ended
    // child's report never reaches the new segment (FM 12) → red.
    const ledger = new AgentJobLedger();
    const started = ledger.background({
      agentId: "sa-1",
      callId: "c1",
      agentType: "explore",
      description: "map the repo",
    });
    expect(started).toEqual({
      agentId: "sa-1",
      callId: "c1",
      agentType: "explore",
      description: "map the repo",
    });
    expect(ledger.running().map((j) => j.agentId)).toEqual(["sa-1"]);
    // Running → [bg].
    expect(ledger.segmentFacts()).toEqual([
      { agentId: "sa-1", callId: "c1", agentType: "explore", description: "map the repo" },
    ]);

    const ended = ledger.end("sa-1", "end_turn", "the report");
    expect(ended).toEqual({ agentId: "sa-1", stopReason: "end_turn", report: "the report" });
    expect(ledger.running()).toEqual([]);
    // Ended undelivered → [bg, end{report}]: the pair a segment start re-emits.
    expect(ledger.segmentFacts()).toEqual([
      { agentId: "sa-1", callId: "c1", agentType: "explore", description: "map the repo" },
      { agentId: "sa-1", stopReason: "end_turn", report: "the report" },
    ]);
  });

  test("a duplicate `background` / a duplicate or late `end` is `null`: first wins, nothing is logged twice", () => {
    // Mutation: let `end` run twice (drop the `state === "ended"` guard) → the
    // second call returns a body, and FM 7/8 log two ends for one id → red.
    const ledger = new AgentJobLedger();
    expect(
      ledger.background({ agentId: "sa-1", callId: "c1", agentType: "t", description: "d" }),
    ).not.toBeNull();
    expect(
      ledger.background({ agentId: "sa-1", callId: "c1", agentType: "t", description: "d" }),
    ).toBeNull();
    const first = ledger.end("sa-1", "end_turn", "first report");
    expect(first?.report).toBe("first report");
    expect(ledger.end("sa-1", "cancelled", "a later report")).toBeNull();
    // The first one still holds: a late end never overwrites the work product.
    expect(ledger.segmentFacts()[1]).toEqual({
      agentId: "sa-1",
      stopReason: "end_turn",
      report: "first report",
    });
  });

  test("noteSeen closes the id its note names, and only a sub-agent kind with an id", () => {
    // Mutation: `noteSeen` as a no-op → the note never closes its child, so the
    // next load notes it again (the load is then not idempotent) → red.
    const ledger = new AgentJobLedger();
    ledger.background({ agentId: "sa-1", callId: "c1", agentType: "t", description: "d" });
    ledger.background({ agentId: "sa-2", callId: "c2", agentType: "t", description: "d" });
    // A shell job's exit note names a job, not a sub-agent: nothing closes.
    ledger.noteSeen({ kind: NOTE_KIND.backgroundExit, id: "sa-1" });
    expect(ledger.running().map((j) => j.agentId)).toEqual(["sa-1", "sa-2"]);
    // No id: nothing to close.
    ledger.noteSeen({ kind: NOTE_KIND.subagentLost });
    expect(ledger.running()).toHaveLength(2);
    ledger.noteSeen({ kind: NOTE_KIND.subagentReport, id: "sa-1" });
    expect(ledger.running().map((j) => j.agentId)).toEqual(["sa-2"]);
    ledger.noteSeen({ kind: NOTE_KIND.subagentLost, id: "sa-2" });
    expect(ledger.segmentFacts()).toEqual([]);
    expect(ledger.loadNotes()).toEqual([]);
  });

  test("an ORPHAN `end` (its `bg` gone) re-emits only its `end`: never a `background` with an empty `callId`", () => {
    // FM 5 × the schema: `subagent_background` requires `callId` (min 1), so an
    // orphan's `bg` would be malformed and a reader would refuse the whole log.
    // Mutation: re-emit `segmentFacts()` without the `callId !== ""` guard → the
    // re-emitted `bg` fails `KnownLogEntrySchema` → red.
    const ledger = new AgentJobLedger();
    // The REPLAY path (`subagentLoadNotes`) is the one that keeps an orphan (FM 5).
    ledger.end("sa-9", "end_turn", "ORPHAN", { orphan: true });
    const facts = ledger.segmentFacts();
    expect(facts).toEqual([{ agentId: "sa-9", stopReason: "end_turn", report: "ORPHAN" }]);
    // And the orphan's own note survives a load from those re-emitted facts.
    const reemitted = facts.map((fact, i) => ({
      ...fact,
      type: "stopReason" in fact ? "subagent_end" : "subagent_background",
      seq: i + 1,
      id: `inc3/${i + 1}`,
      ts: 1,
    })) as KnownLogEntry[];
    expect(subagentLoadNotes(reemitted, [])[0]?.content).toContain("ORPHAN");
  });

  test("M1: a late `end` AFTER delivery is `null`, and re-emits nothing at a segment start", () => {
    // docs/feat/subagent-ledger-log.md review M1, FM 7 ("first wins"). Mutation:
    // drop the `closed` check in `end` → a delivered child is re-noted (a second,
    // contradictory report) at the next load (a compaction drops the note's segment).
    const ledger = new AgentJobLedger();
    ledger.background({ agentId: "sa-1", callId: "c1", agentType: "t", description: "d" });
    expect(ledger.end("sa-1", "end_turn", "R1")?.report).toBe("R1");
    ledger.noteSeen({ kind: NOTE_KIND.subagentReport, id: "sa-1" });
    expect(ledger.end("sa-1", "killed", "R2")).toBeNull();
    expect(ledger.segmentFacts()).toEqual([]);
    expect(ledger.loadNotes()).toEqual([]);
  });

  test("M1: a live `end` for an id never started is `null`; a replay (`{orphan:true}`) still notes it (FM 5)", () => {
    // Mutation: drop `opts.orphan` → either a live end logs an orphan marker for
    // an id nobody started, or FM 5 loses a work product. Both are red here.
    const ledger = new AgentJobLedger();
    expect(ledger.end("sa-77", "end_turn")).toBeNull();
    expect(ledger.segmentFacts()).toEqual([]);
    expect(ledger.end("sa-77", "end_turn", "ORPHAN", { orphan: true })).toEqual({
      agentId: "sa-77",
      stopReason: "end_turn",
      report: "ORPHAN",
    });
  });

  test("M1: fromHistory remembers what was DELIVERED, so a later `end` for that id is `null`", () => {
    // Mutation: `fromHistory` not marking a sub-agent note's id closed → a reload
    // forgets the delivery and a replayed/late `end` re-notes it → red.
    const ledger = AgentJobLedger.fromHistory([
      note("[background] sub-agent sa-1 finished", NOTE_KIND.subagentReport, "sa-1"),
      note("[background] sub-agent sa-2 was lost", NOTE_KIND.subagentLost, "sa-2"),
      // A shell job's exit note does NOT close a sub-agent id.
      note("[background] job sa-3 exited", NOTE_KIND.backgroundExit, "sa-3"),
    ]);
    expect(ledger.end("sa-1", "killed", "R2")).toBeNull();
    expect(ledger.end("sa-2", "killed", "R2")).toBeNull();
    // Not even the REPLAY's orphan allowance re-notes a delivered id (M1's
    // second report: the note outlived the segment its markers were in).
    expect(ledger.end("sa-1", "killed", "R2", { orphan: true })).toBeNull();
    // A closed id is never STARTED again either (its note already told the model).
    expect(
      ledger.background({ agentId: "sa-1", callId: "c9", agentType: "t", description: "d" }),
    ).toBeNull();
    // The background exit is not a sub-agent note: the id is still startable.
    expect(
      ledger.background({ agentId: "sa-3", callId: "c3", agentType: "t", description: "d" }),
    ).not.toBeNull();
    expect(ledger.segmentFacts()).toEqual([
      { agentId: "sa-3", callId: "c3", agentType: "t", description: "d" },
    ]);
  });

  test("fromHistory seeds the counter from note ids AND from `sa-N` in a message's text", () => {
    // Mutation: drop the text scan → a restarted session hands out an id the
    // model already saw (FM 20) → red.
    expect(new AgentJobLedger().nextId()).toBe(`${AGENT_ID_PREFIX}1`);
    const fromNote = AgentJobLedger.fromHistory([
      note("[background] sub-agent sa-7 …", NOTE_KIND.subagentReport, "sa-7"),
    ]);
    expect(fromNote.nextId()).toBe(`${AGENT_ID_PREFIX}8`);
    // The tool result is the only trace (`started in background as sa-3 …`).
    const fromText = AgentJobLedger.fromHistory([
      { role: "tool", content: "started in background as sa-3: map repo", toolCallId: "c1" },
    ]);
    expect(fromText.nextId()).toBe(`${AGENT_ID_PREFIX}4`);
    // A user typing "sa-900" only skips numbers: still no reuse.
    const fromUser = AgentJobLedger.fromHistory([{ role: "user", content: "what is sa-900?" }]);
    expect(fromUser.nextId()).toBe(`${AGENT_ID_PREFIX}901`);
  });

  test("handOver gives the open jobs away; adopt takes them and keeps their ids reserved", () => {
    // Mutation: `adopt` not reserving the counter → the new session re-hands out
    // an id it adopted (feat/clear-keeps-jobs) → red.
    const old = new AgentJobLedger();
    old.background({ agentId: "sa-4", callId: "c1", agentType: "t", description: "d" });
    const carried = old.handOver();
    expect(carried.map((j) => j.agentId)).toEqual(["sa-4"]);
    expect(old.running()).toEqual([]);
    const next = new AgentJobLedger();
    next.adopt(carried);
    expect(next.running().map((j) => j.agentId)).toEqual(["sa-4"]);
    expect(next.nextId()).toBe(`${AGENT_ID_PREFIX}5`);
  });
});

describe("the caps: enforced by the EMITTER, so a reader never refuses a value", () => {
  test("a long description and an over-cap report are capped head+tail with a cut line", () => {
    // Mutation: log the report uncapped → `subagent_end` fails its 64 KiB schema
    // and the whole log is refused (FM 16/21) → red.
    expect(capSubagentText("short", 10)).toBe("short");
    const long = "a".repeat(SUBAGENT_DESCRIPTION_MAX_CHARS + 100);
    const ledger = new AgentJobLedger();
    const body = ledger.background({
      agentId: "sa-1",
      callId: "c1",
      agentType: "t",
      description: long,
    });
    expect(body?.description.length).toBeLessThanOrEqual(SUBAGENT_DESCRIPTION_MAX_CHARS);
    expect(body?.description).toContain("chars cut");

    const report = `${"head ".repeat(20000)}TAIL`;
    const ended = ledger.end("sa-1", "end_turn", report);
    const capped = ended?.report ?? "";
    expect(capped.length).toBeLessThanOrEqual(SUBAGENT_REPORT_MAX_CHARS);
    expect(capped).toContain("chars cut");
    expect(capped.startsWith("head ")).toBe(true);
    expect(capped.endsWith("TAIL")).toBe(true);
  });

  test("M4: an over-long `agentType`/`callId`/`stopReason` and an empty one never write a body a reader refuses", () => {
    // docs/feat/subagent-ledger-log.md review M4 / P3: a KNOWN entry that fails
    // its schema makes every reader refuse the WHOLE log. Mutation: drop a
    // `bounded` → the emitted body fails its schema → red.
    const ledger = new AgentJobLedger();
    const started = ledger.background({
      agentId: "sa-1",
      callId: "c".repeat(SUBAGENT_CALL_ID_MAX_CHARS + 40),
      agentType: "t".repeat(SUBAGENT_AGENT_TYPE_MAX_CHARS + 40),
      description: "d",
    });
    if (started === null) throw new Error("background returned null");
    expect(started.callId.length).toBe(SUBAGENT_CALL_ID_MAX_CHARS);
    expect(started.agentType.length).toBe(SUBAGENT_AGENT_TYPE_MAX_CHARS);
    expect(envelope(started, "subagent_background", 1).ok).toBe(true);

    const ended = ledger.end("sa-1", "s".repeat(SUBAGENT_STOP_REASON_MAX_CHARS + 40), "R");
    if (ended === null) throw new Error("end returned null");
    expect(ended.stopReason.length).toBe(SUBAGENT_STOP_REASON_MAX_CHARS);
    expect(envelope(ended, "subagent_end", 2).ok).toBe(true);

    // An EMPTY agentType is `min(1)`: emitted as "unknown", so the entry still reads.
    const empty = new AgentJobLedger().background({
      agentId: "sa-2",
      callId: "c2",
      agentType: "",
      description: "d",
    });
    if (empty === null) throw new Error("background returned null");
    expect(empty.agentType).toBe("unknown");
    expect(envelope(empty, "subagent_background", 1).ok).toBe(true);
  });
});

describe("subagentLoadNotes — THE load derivation (laptop load + serve reload)", () => {
  test("FM 22: no markers, no notes; and the markers alone give one note per open child", () => {
    expect(subagentLoadNotes([], [])).toEqual([]);
    expect(subagentLoadNotes([bg("sa-1")], [])).toHaveLength(1);
  });

  test("FM 1/4: an open `bg` is a LOST note (the restart killed it), with its id where a load keys on it", () => {
    // Mutation: emit `subagent_report` for a running child too → a lost child
    // reads as finished and its (absent) report is never looked for → red.
    const notes = subagentLoadNotes([bg("sa-1")], []);
    expect(notes).toHaveLength(1);
    const lost = notes[0];
    expect(lost?.role).toBe("user");
    expect(lost?.note).toEqual({ kind: NOTE_KIND.subagentLost, id: "sa-1" });
    expect(lost?.content).toContain("sa-1 (map the repo) was lost");
    expect(lost?.content).toContain("restarted before it finished");
  });

  test("FM 2: an undelivered `end{report}` becomes the report note, the work product never dropped", () => {
    // Mutation: return the lost note for an ended child → the report is lost → red.
    const notes = subagentLoadNotes([bg("sa-1"), endEntry("sa-1", { report: "THE REPORT" })], []);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.note).toEqual({ kind: NOTE_KIND.subagentReport, id: "sa-1" });
    expect(notes[0]?.content).toContain("finished (end_turn) before the session restarted:");
    expect(notes[0]?.content).toContain("THE REPORT");
  });

  test("an ended child that left no report says so (never an empty body)", () => {
    const notes = subagentLoadNotes([bg("sa-1"), endEntry("sa-1")], []);
    expect(notes[0]?.content).toContain("ended (end_turn) before the session restarted");
    expect(notes[0]?.content).toContain("it left no report");
  });

  test("FM 5: an `end` without its `bg` still yields its note, without a description", () => {
    const notes = subagentLoadNotes([endEntry("sa-9", { report: "ORPHAN REPORT" })], []);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.content).toContain("[background] sub-agent sa-9 finished (end_turn)");
    expect(notes[0]?.content).not.toContain("(map the repo)");
    expect(notes[0]?.content).toContain("ORPHAN REPORT");
  });

  test("FM 6: a note without its markers adds nothing (closed, nothing open)", () => {
    const messages = [
      note("[background] sub-agent sa-1 finished", NOTE_KIND.subagentReport, "sa-1"),
    ];
    expect(subagentLoadNotes([], messages)).toEqual([]);
  });

  test("FM 8: duplicate markers in one segment give ONE note per id (first wins)", () => {
    const notes = subagentLoadNotes(
      [
        bg("sa-1"),
        bg("sa-1"),
        endEntry("sa-1", { report: "R" }),
        endEntry("sa-1", { report: "R2" }),
      ],
      [],
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]?.content).toContain("R");
    expect(notes[0]?.content).not.toContain("R2");
  });

  test("idempotence: the same inputs give the same notes; with them in the messages, none", () => {
    // Mutation: drop the `noteSeen` loop from `subagentLoadNotes` → the second
    // load notes the child again (an endless re-note on every resume) → red.
    const entries = [bg("sa-1"), endEntry("sa-1", { report: "R" }), bg("sa-2")];
    const messages: ChatMessage[] = [{ role: "user", content: "go" }];
    const first = subagentLoadNotes(entries, messages);
    expect(subagentLoadNotes(entries, messages)).toEqual(first);
    expect(first).toHaveLength(2);
    // The next persist puts the notes IN the messages (the seed / reload segment).
    expect(subagentLoadNotes(entries, [...messages, ...first])).toEqual([]);
  });

  test("a re-emitted pair at a new segment (`segmentFacts`) is closed by the note it produced", () => {
    // FM 12/13: a compaction re-emits [bg, end]; the note of the old segment is
    // in the messages → no second note.
    const ledger = new AgentJobLedger();
    ledger.background({ agentId: "sa-1", callId: "c1", agentType: "explore", description: "map" });
    ledger.end("sa-1", "end_turn", "R");
    const reemitted: KnownLogEntry[] = ledger.segmentFacts().map((fact, i) => ({
      ...fact,
      type: "stopReason" in fact ? "subagent_end" : "subagent_background",
      seq: i + 1,
      id: `inc2/${i + 1}`,
      ts: 1,
    })) as KnownLogEntry[];
    const messages = [
      subagentReportNote(job("sa-1", { state: "ended", stopReason: "end_turn", report: "R" })),
    ];
    expect(subagentLoadNotes(reemitted, messages)).toEqual([]);
    // Without the note, the same segment gives it once.
    expect(subagentLoadNotes(reemitted, [])).toHaveLength(1);
  });

  test("the shared text builders: live and load read alike; the load's is the live one's default", () => {
    const ended = job("sa-1", { state: "ended", stopReason: "end_turn", report: "R" });
    expect(subagentReportNote(ended).content).toBe(
      "[background] sub-agent sa-1 (map the repo) finished (end_turn) before the session restarted:\nR",
    );
    // 6a's live note is the SAME builder with its own headline.
    expect(subagentReportNote(ended, "[background] sub-agent sa-1 finished:").content).toBe(
      "[background] sub-agent sa-1 finished:\nR",
    );
    expect(subagentLostNote(job("sa-2")).note).toEqual({
      kind: NOTE_KIND.subagentLost,
      id: "sa-2",
    });
  });
});
