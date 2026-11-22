import { describe, expect, test } from "bun:test";
import {
  type KnownLogEntry,
  KnownLogEntrySchema,
  LOG_ENTRY_CRITICAL,
  WORKFLOW_INPUTS_MAX_CHARS,
  WORKFLOW_PROMPT_MAX_CHARS,
  WORKFLOW_REASON_MAX_CHARS,
} from "@tentacle/protocol";
import type { ChatMessage } from "../src/model.ts";
import {
  capWorkflowInputs,
  workflowEndBody,
  workflowLoadNotes,
  workflowStartBody,
  workflowStepBody,
} from "../src/workflow-ledger.ts";

// docs/feat/agent-workflows.md Slice 3 (D4): the three non-critical entry
// types, their capped builders, and THE load derivation.

const HASH = "3f2a".repeat(16);
let seq = 0;
/** A body wrapped in an emitter's envelope, as the log holds it. */
function entry(type: string, body: object): KnownLogEntry {
  seq += 1;
  return { ...body, type, critical: false, seq, id: `D/${seq}`, ts: 1 } as KnownLogEntry;
}
const start = (runId: string, name = "task") =>
  entry(
    "workflow_start",
    workflowStartBody({
      runId,
      name,
      version: 3,
      hash: HASH,
      path: `workflows/${name}.yaml`,
      inputs: { slug: "x" },
      by: "user",
      turnId: "t-1",
    }),
  );
const step = (runId: string, stepId: string) =>
  entry(
    "workflow_step",
    workflowStepBody({
      runId,
      stepId,
      attempt: 0,
      round: 0,
      state: "ok",
      verdict: "pass",
      reason: "done",
      where: "local",
    }),
  );
const end = (runId: string) =>
  entry("workflow_end", workflowEndBody({ runId, state: "ok", reason: "7/7" }));

describe("workflow log entries round-trip through the strip schemas", () => {
  test("each built entry parses as itself (no field lost, none added)", () => {
    for (const e of [start("wf-1"), step("wf-1", "plan"), end("wf-1")]) {
      const parsed = KnownLogEntrySchema.safeParse(e);
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data).toEqual(e);
    }
  });

  test("an unknown field from a newer build is stripped, the entry still loads", () => {
    const parsed = KnownLogEntrySchema.safeParse({ ...end("wf-2"), futureField: 1 });
    expect(parsed.success && "futureField" in parsed.data).toBe(false);
    expect(parsed.success).toBe(true);
  });

  test("a newer build's new state word does not poison the reader (free word, not an enum)", () => {
    expect(KnownLogEntrySchema.safeParse({ ...end("wf-3"), state: "skipped" }).success).toBe(true);
    expect(
      KnownLogEntrySchema.safeParse({ ...step("wf-3", "plan"), state: "paused", verdict: "skip" })
        .success,
    ).toBe(true);
  });

  test("all three are NON-critical (owner Q1)", () => {
    expect(LOG_ENTRY_CRITICAL.workflow_start).toBe(false);
    expect(LOG_ENTRY_CRITICAL.workflow_step).toBe(false);
    expect(LOG_ENTRY_CRITICAL.workflow_end).toBe(false);
  });
});

describe("the builders cap every text so the log never holds an entry a reader refuses", () => {
  test("a huge reason / prompt / report still yields a valid entry, cut head + tail", () => {
    const body = workflowStepBody({
      runId: "wf-1",
      stepId: "gate",
      attempt: 1.4,
      round: -2,
      state: "error",
      verdict: "fail",
      reason: `exit 2\n${"x".repeat(10_000)}\nLAST LINE`,
      where: "docker:ci",
      tokens: Number.NaN,
      durationMs: 12.6,
      prompt: "p".repeat(WORKFLOW_PROMPT_MAX_CHARS * 2),
      report: "r".repeat(200_000),
    });
    expect(body.reason.length).toBeLessThanOrEqual(WORKFLOW_REASON_MAX_CHARS);
    expect(body.reason.endsWith("LAST LINE")).toBe(true);
    expect(body.prompt?.length).toBeLessThanOrEqual(WORKFLOW_PROMPT_MAX_CHARS);
    expect([body.attempt, body.round, body.tokens, body.durationMs]).toEqual([1, 0, 0, 13]);
    expect(KnownLogEntrySchema.safeParse(entry("workflow_step", body)).success).toBe(true);
  });

  test("inputs stay within 4 KiB of JSON and a dropped input is SAID, never silent", () => {
    const inputs: Record<string, string> = {};
    for (let i = 0; i < 10; i++) inputs[`k${i}`] = `"${"é\n".repeat(400)}`;
    const capped = capWorkflowInputs(inputs);
    expect(JSON.stringify(capped).length).toBeLessThanOrEqual(WORKFLOW_INPUTS_MAX_CHARS);
    const last = capped.at(-1);
    expect(last?.name).toBe("…");
    expect(last?.value).toMatch(/more input\(s\) not logged/);
    // Kept values may be cut, and say so.
    expect(capped.some((i) => i.value.endsWith("…"))).toBe(true);
    expect(capWorkflowInputs({ b: "2", a: "1" })).toEqual([
      { name: "a", value: "1" },
      { name: "b", value: "2" },
    ]);
    expect(capWorkflowInputs({ ["x".repeat(65)]: "v" })).toEqual([
      { name: "…", value: "1 more input(s) not logged" },
    ]);
    const body = workflowStartBody({
      runId: "wf-9",
      name: "t",
      version: 1,
      hash: HASH,
      path: "p",
      inputs,
      by: "model",
    });
    expect(KnownLogEntrySchema.safeParse(entry("workflow_start", body)).success).toBe(true);
  });

  test("a bad run id / hash / step id is a caller bug: THROWS before it can reach the log", () => {
    const base = { name: "t", version: 1, path: "p", inputs: {}, by: "user" as const };
    expect(() => workflowStartBody({ ...base, runId: "sa-1", hash: HASH })).toThrow(/runId/);
    expect(() => workflowStartBody({ ...base, runId: "wf-1", hash: "nothex" })).toThrow(/hash/);
    expect(() =>
      workflowStepBody({
        runId: "wf-1",
        stepId: "Bad Id",
        attempt: 0,
        round: 0,
        state: "ok",
        where: "local",
      }),
    ).toThrow(/stepId/);
  });
});

describe("workflowLoadNotes — a run a crash left open is closed honestly, once", () => {
  test("start without end → one `stopped · interrupted` note naming the run; the second load adds nothing", () => {
    const entries = [start("wf-1"), step("wf-1", "plan"), step("wf-1", "exec")];
    const history: ChatMessage[] = [{ role: "user", content: "go" }];
    const notes = workflowLoadNotes(entries, history);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.note).toEqual({ kind: "workflow_interrupted", id: "wf-1" });
    expect(notes[0]?.role).toBe("user");
    expect(notes[0]?.content).toContain("wf-1 task v3: stopped · interrupted");
    expect(notes[0]?.content).toContain('the last one "exec"');
    // Idempotent: with the note in the history, nothing more.
    expect(workflowLoadNotes(entries, [...history, ...notes])).toEqual([]);
  });

  test("an ended run → nothing; a live end note also closes it", () => {
    expect(workflowLoadNotes([start("wf-1"), step("wf-1", "plan"), end("wf-1")], [])).toEqual([]);
    const live: ChatMessage = {
      role: "user",
      content: "[workflow wf-1 task: ok]",
      note: { kind: "workflow_end", id: "wf-1" },
    };
    expect(workflowLoadNotes([start("wf-1")], [live])).toEqual([]);
  });

  test("a note of ANOTHER kind with the same id does not close it", () => {
    const other: ChatMessage = {
      role: "user",
      content: "x",
      note: { kind: "subagent_lost", id: "wf-1" },
    };
    expect(workflowLoadNotes([start("wf-1")], [other])).toHaveLength(1);
  });

  test("a step/end whose start is not in the segment is ignored; several runs keep start order", () => {
    expect(workflowLoadNotes([step("wf-4", "plan"), end("wf-5")], [])).toEqual([]);
    const notes = workflowLoadNotes([start("wf-2", "b"), start("wf-1", "a")], []);
    expect(notes.map((m) => m.note?.id)).toEqual(["wf-2", "wf-1"]);
    expect(notes[0]?.content).toContain("before any step finished");
  });

  test("no entries → []", () => {
    expect(workflowLoadNotes([], [])).toEqual([]);
  });
});
