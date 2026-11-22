import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ChatMessage,
  workflowEndBody,
  workflowStartBody,
  workflowStepBody,
} from "@tentacle/core";
import type { KnownLogEntry } from "@tentacle/protocol";
import { parseSidecar, rebuild } from "../src/daemon-state-file.ts";
import { reconcileOnReload } from "../src/persisted-session.ts";
import { currentSegment, entryLines, headerLine, parseLogFile } from "../src/session-log-file.ts";
import { LogSessionStore } from "../src/session-log-store.ts";
import { SessionLog } from "../src/session-log.ts";
import { FakeLog, FakeReader, META, asst, user } from "./support/log-fixture.ts";

// docs/feat/agent-workflows.md Slice 3 (D4): BOTH loads (the laptop's store and
// the `serve` reload) close a workflow run a crash left open with ONE note, and
// an older build that does not know the three types still loads the history.

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "workflow-load-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
let n = 0;
const fresh = (): string => join(dir, `d${++n}`);

const INTERRUPTED = { kind: "workflow_interrupted", id: "wf-1" };

describe("the laptop's load closes an open workflow run (D4)", () => {
  test("start without end → the interrupted note at load; loading twice gives the same, and writes nothing", async () => {
    // Mutation: drop `workflowLoadNotes` from `session-log-store.ts` → no note → red.
    const store = new LogSessionStore(fresh());
    const log = new FakeLog("D1");
    const reader = new FakeReader("s");
    await store.write(reader.read(log.base([user("go")]), "cold"));
    await store.write(reader.read([log.workflowStart("wf-1"), log.workflowStep("wf-1", "plan")]));
    const before = await readFile(store.file("s"), "utf8");
    const first = await store.load("s");
    if (first.status !== "ok") throw new Error(first.status);
    expect(first.record.messages.map((m) => m.note)).toEqual([undefined, INTERRUPTED]);
    expect(first.record.messages[1]?.content).toContain('the last one "plan"');
    expect(await readFile(store.file("s"), "utf8")).toBe(before);
    const second = await store.load("s");
    if (second.status !== "ok") throw new Error(second.status);
    expect(second.record.messages).toEqual(first.record.messages);
  });

  test("an ended run → no note; a run only in a SUPERSEDED segment → no note", async () => {
    const store = new LogSessionStore(fresh(), { keepSuperseded: true });
    const log = new FakeLog("D1");
    const reader = new FakeReader("s");
    await store.write(reader.read(log.base([user("go")]), "cold"));
    await store.write(reader.read([log.workflowStart("wf-1"), log.workflowEnd("wf-1")]));
    const ended = await store.load("s");
    if (ended.status !== "ok") throw new Error(ended.status);
    expect(ended.record.messages).toEqual([user("go")]);
    await store.write(reader.read([log.workflowStart("wf-2")]));
    await store.write(reader.read(log.base([user("SUMMARY")], "compact"), "fork"));
    const after = await store.load("s");
    if (after.status !== "ok") throw new Error(after.status);
    expect(after.record.messages).toEqual([user("SUMMARY")]);
  });
});

const ID = "sv1";
const CWD = "/w";
const header = headerLine({ id: ID, ...META, cwd: CWD });

describe("the `serve` reload closes an open workflow run (D4)", () => {
  test("an open start before `logHead` → a load note, appended by `reconcileOnReload`", () => {
    // Mutation: drop `workflowLoadNotes` from `daemon-state-file.ts` → red.
    const log = new FakeLog("D1");
    const messages = [user("go"), asst("ok")];
    const entries = [...log.base(messages), log.workflowStart("wf-1")];
    const reached = entries.at(-1);
    if (reached === undefined) throw new Error("no entry");
    const parsed = parseLogFile(header + entryLines(entries), ID);
    if (!parsed.ok) throw new Error(parsed.reason);
    const sidecar = parseSidecar(
      `${JSON.stringify({
        format: "tentacle-daemon-state",
        schemaVersion: 1,
        id: ID,
        logHead: { seq: reached.seq, id: reached.id },
        k: messages.length,
        tail: [],
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
    expect(rebuilt.value.loadNotes.map((m) => m.note)).toEqual([INTERRUPTED]);
    const reconciled = reconcileOnReload(rebuilt.value);
    expect(reconciled.messages.at(-1)?.note).toEqual(INTERRUPTED);
    expect(reconciled.messages.slice(0, 2)).toEqual(messages);
  });
});

describe("an older build that does not know the three types still loads the conversation (Q1)", () => {
  test("the DAEMON's entries under unknown type names are SKIPPED (non-critical), the history is intact", () => {
    // What an older reader sees: types it does not know, as the real emitter
    // wrote them. Mutation: the emitter writes `critical: true` → this parse
    // refuses the whole file → red.
    const messages: ChatMessage[] = [user("go"), asst("ok")];
    const known = emitted(messages);
    const asOlder = known.map((e) =>
      e.type.startsWith("workflow_")
        ? ({ ...e, type: `${e.type}_v99` } as unknown as KnownLogEntry)
        : e,
    );
    expect(asOlder.filter((e) => e.type.endsWith("_v99"))).toHaveLength(3);
    const parsed = parseLogFile(header + entryLines(asOlder), ID);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(currentSegment(parsed).messages).toEqual(messages);
  });

  test("the daemon emitter writes them non-critical", () => {
    const wf = emitted([user("go")]).filter((e) => e.type.startsWith("workflow_"));
    expect(wf.map((e) => [e.type, e.critical])).toEqual([
      ["workflow_start", false],
      ["workflow_step", false],
      ["workflow_end", false],
    ]);
  });
});

/** The daemon's own `SessionLog` entries for a session with one whole workflow run. */
function emitted(messages: readonly ChatMessage[]): KnownLogEntry[] {
  const log = new SessionLog("D1", () => 1);
  log.start(messages, "create");
  // Bodies from core's builders, as the driver (Slice 4) will build them.
  log.workflowStart(
    workflowStartBody({
      runId: "wf-1",
      name: "task",
      version: 1,
      hash: "b".repeat(64),
      path: "workflows/task.yaml",
      inputs: { slug: "x" },
      by: "model",
    }),
  );
  log.workflowStep(
    workflowStepBody({
      runId: "wf-1",
      stepId: "plan",
      attempt: 0,
      round: 0,
      state: "ok",
      verdict: "pass",
      where: "local",
    }),
  );
  log.workflowEnd(
    workflowEndBody({ runId: "wf-1", state: "stopped", stopReason: "cancelled", reason: "x" }),
  );
  return log.read(undefined, 1 << 20, (t) => t).entries as KnownLogEntry[];
}
