/**
 * The work-units seam (docs/feat/a2a.md, slice S2-work-units-seam): the
 * ended-units table of a hosted `serve` session, its live fill at a turn's or a
 * run's end, its carry into every new log segment as `unit_end`, the loader's
 * `units`, and `HostedSession.workUnits()` — across compaction, context reset,
 * `/clear` and a reload from the real `LogSessionStore`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, WorkflowDriver } from "@tentacle/agent";
import {
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
  type Tool,
  type ToolContext,
  type WorkUnit,
} from "@tentacle/core";
import type { KnownSessionUpdateParams } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { z } from "zod";
import type { HostedSession } from "../src/hosted-session.ts";
import { RESTART_TURN_END, endedUnitsAtLoad } from "../src/persisted-session.ts";
import { SessionHost } from "../src/session-host.ts";
import { LogSessionStore } from "../src/session-log-store.ts";
import { SessionPersister } from "../src/session-persister.ts";

const CWD = "/tmp/work-units";
const env: ExecutionEnvironment = {
  id: "noop",
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
};
const YAML =
  "schemaVersion: 1\nname: task\nversion: 1\nsteps:\n  - id: plan\n    agent: { prompt_text: plan it }\n";

/** Answers `answer: <prompt>`; a prompt `hang` waits until aborted; `ask` calls the asking tool first. */
class Scripted implements ModelProvider {
  readonly id = "m";
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    if (request.messages.at(-1)?.role === "tool") {
      yield { type: "text", delta: "answer: ran" };
      yield { type: "done" };
      return;
    }
    const last = [...request.messages].reverse().find((m) => m.role === "user");
    // The prompt's last line (the host prefixes a date stamp line).
    const text = (typeof last?.content === "string" ? last.content : "").split("\n").at(-1) ?? "";
    if (text === "ask") {
      yield { type: "tool_call", toolCall: { id: "c1", name: "run", arguments: "{}" } };
      yield { type: "done" };
      return;
    }
    if (text === "hang") {
      await new Promise<void>((resolve) =>
        request.signal?.addEventListener("abort", () => resolve()),
      );
    }
    yield { type: "text", delta: `answer: ${text}` };
    yield { type: "done" };
  }
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "work-units-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
let n = 0;

/** A `serve`-shaped host on a real store; `block` makes every workflow step wait until released. */
function rig(root: string, block?: Promise<void>) {
  const store = new LogSessionStore(root);
  const persister = new SessionPersister({ store, cwd: CWD, model: "m", onError: () => {} });
  const host = new SessionHost({
    defaultCwd: CWD,
    persister,
    createAgent: () => {
      const permissions = new PermissionBroker();
      const run: Tool = {
        name: "run",
        description: "run",
        inputSchema: z.object({}).passthrough(),
        permission: "ask",
        execute: async () => ({ content: "ok" }),
      };
      const agent = new Agent({
        model: new Scripted(),
        tools: new ToolRegistry().register(run),
        env,
        systemPrompt: "sys",
        requestPermission: (req, options) => permissions.request(req, options),
      });
      return { agent, permissions, workflows: driver(block) };
    },
  });
  return { host, persister };
}

function driver(block: Promise<void> | undefined): WorkflowDriver {
  return new WorkflowDriver({
    load: async () => ({ path: ".tentacle/workflows/task.yaml", text: YAML, prompts: {} }),
    context: () => ({ models: [], agentTypes: ["general"] }),
    approvals: { has: async () => true, add: async () => {} },
    request: async () => ({ allowed: false }),
    runnerFor: () => async (_opts, controls) => {
      if (block !== undefined) await block;
      const verdict = controls?.extraTools?.find((t) => t.name === "step_verdict");
      await verdict?.execute({ verdict: "pass", reason: "planned" }, {} as ToolContext);
      return { report: "the plan", toolUses: 1, stopReason: "end_turn" };
    },
  });
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${String(cond)}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

const ended = (hosted: HostedSession, kind: string, id: string): WorkUnit | undefined =>
  hosted.workUnits().find((u) => u.kind === kind && u.id === id && u.endedAt !== undefined);

async function turn(hosted: HostedSession, turnId: string, text: string): Promise<void> {
  hosted.prompt(turnId, [{ type: "text", text }]);
  await until(() => ended(hosted, "turn", turnId) !== undefined);
}

/** The LAST segment of the session's file on disk: its entries' types (and the `unit_end`s). */
async function lastSegment(root: string, id: string): Promise<{ type: string; unitId?: string }[]> {
  const find = async (at: string): Promise<string | null> => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        const found = await find(path);
        if (found) return found;
      } else if (entry.name === `${id}.jsonl`) {
        return path;
      }
    }
    return null;
  };
  const file = await find(root);
  if (file === null) throw new Error("no log file");
  const lines = (await readFile(file, "utf8"))
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as { type: string; unitId?: string });
  return lines.slice(lines.map((l) => l.type).lastIndexOf("base"));
}

describe("workUnits(): live ends, carried across every segment boundary and a reload", () => {
  test("a turn and a run end → listed; compaction, context reset, /clear, reload keep them, same records", async () => {
    // Mutation: drop the `unit_end` loop in `logSegmentFacts` → the units ended
    // before a boundary vanish at the next end's re-derivation → red after each.
    const root = join(dir, `d${++n}`);
    const first = rig(root);
    const { hosted } = first.host.open({ create: true }, { send: () => {} });

    await turn(hosted, "t-1", "one");
    expect(ended(hosted, "turn", "t-1")).toMatchObject({
      state: "completed",
      native: "end_turn",
      result: "answer: one",
    });
    const started = await hosted.workflow({
      sessionId: hosted.id,
      action: "start",
      name: "task",
      turnId: "t-wf",
    });
    expect(started).toEqual({ ok: true, runId: "wf-1" });
    await until(() => ended(hosted, "workflow", "wf-1") !== undefined);
    expect(ended(hosted, "workflow", "wf-1")).toMatchObject({
      origin: "t-wf",
      state: "completed",
      native: "ok",
    });
    expect(ended(hosted, "workflow", "wf-1")?.result).toContain("the plan");
    const before = hosted.workUnits();
    expect(before.map((u) => `${u.kind}:${u.id}`)).toEqual(["turn:t-1", "workflow:wf-1"]);

    // Each boundary, then a NEW end (which re-derives the table from the new segment).
    await hosted.compact();
    await turn(hosted, "t-2", "two");
    expect(hosted.workUnits().slice(0, 2)).toEqual(before);

    (hosted as unknown as { historyReplaced(r: "context_reset"): void }).historyReplaced(
      "context_reset",
    );
    await turn(hosted, "t-3", "three");
    expect(hosted.workUnits().slice(0, 2)).toEqual(before);

    hosted.clear();
    await turn(hosted, "t-4", "four");
    const live = hosted.workUnits();
    expect(live.map((u) => `${u.kind}:${u.id}`)).toEqual([
      "turn:t-1",
      "workflow:wf-1",
      "turn:t-2",
      "turn:t-3",
      "turn:t-4",
    ]);
    expect(live.slice(0, 2)).toEqual(before);
    expect(live.find((u) => u.id === "t-4")?.result).toBe("answer: four");

    // The last segment on disk carries the four earlier units as `unit_end`.
    await hosted.persisted();
    const segment = await lastSegment(root, hosted.id);
    expect(segment.filter((e) => e.type === "unit_end").map((e) => e.unitId)).toEqual([
      "t-1",
      "wf-1",
      "t-2",
      "t-3",
    ]);
    await first.persister.stop();

    // The reload: the loader derives the same table (live end = load derivation).
    const second = rig(root);
    const loaded = await second.persister.load(hosted.id);
    if (!loaded.ok) throw new Error(loaded.reason);
    const restored = second.host.restore(loaded.record);
    expect(restored.workUnits()).toEqual(live);
    // …and carries it into the reload's segment, so the NEXT end keeps them.
    await turn(restored, "t-5", "five");
    expect(restored.workUnits().slice(0, 5)).toEqual(live);
    await second.persister.stop();
  });

  // One boundary per test, so the carry's mutation is red after EACH of them.
  const boundaries: Record<
    string,
    (s: HostedSession, root: string, p: SessionPersister) => Promise<HostedSession>
  > = {
    compaction: async (s) => {
      await s.compact();
      return s;
    },
    context_reset: async (s) => {
      (s as unknown as { historyReplaced(r: "context_reset"): void }).historyReplaced(
        "context_reset",
      );
      return s;
    },
    clear: async (s) => {
      s.clear();
      return s;
    },
    reload: async (s, root, p) => {
      await s.persisted();
      await p.stop();
      const loaded = await rig(root).persister.load(s.id);
      if (!loaded.ok) throw new Error(loaded.reason);
      return rig(root).host.restore(loaded.record);
    },
  };
  for (const [name, cross] of Object.entries(boundaries)) {
    test(`${name}: the units ended before it survive the next end`, async () => {
      const root = join(dir, `d${++n}`);
      const first = rig(root);
      const { hosted } = first.host.open({ create: true }, { send: () => {} });
      await turn(hosted, "t-1", "one");
      await hosted.workflow({
        sessionId: hosted.id,
        action: "start",
        name: "task",
        turnId: "t-wf",
      });
      await until(() => ended(hosted, "workflow", "wf-1") !== undefined);
      const before = hosted.workUnits();
      const after = await cross(hosted, root, first.persister);
      await turn(after, "t-2", "two");
      expect(after.workUnits().slice(0, 2)).toEqual(before);
      expect(after.workUnits()[2]).toMatchObject({ id: "t-2", state: "completed" });
    });
  }

  test("a crash before the end is written: the turn and the run load as failed: interrupted", async () => {
    // Mutation: `endedUnitsAtLoad` keeps only `units.ended` → both are missing → red.
    const root = join(dir, `d${++n}`);
    const gate = Promise.withResolvers<void>();
    const first = rig(root, gate.promise);
    const { hosted } = first.host.open({ create: true }, { send: () => {} });
    await turn(hosted, "t-1", "one");
    const started = await hosted.workflow({
      sessionId: hosted.id,
      action: "start",
      name: "task",
      turnId: "t-wf",
    });
    expect(started).toEqual({ ok: true, runId: "wf-1" });
    hosted.prompt("t-2", [{ type: "text", text: "hang" }]);
    await until(() => hosted.workUnits().length === 3);
    expect(hosted.workUnits().slice(1)).toEqual([
      { kind: "turn", id: "t-2", state: "working", native: "running" },
      expect.objectContaining({ kind: "workflow", id: "wf-1", origin: "t-wf", state: "working" }),
    ]);
    await hosted.persisted();
    await first.persister.stop(); // the "crash": neither end reaches disk
    const keptT1 = ended(hosted, "turn", "t-1");

    const second = rig(root);
    const loaded = await second.persister.load(hosted.id);
    if (!loaded.ok) throw new Error(loaded.reason);
    const restored = second.host.restore(loaded.record);
    const units = restored.workUnits();
    expect(keptT1).toBeDefined();
    expect(units[0]).toEqual(keptT1 as WorkUnit);
    expect(units.slice(1)).toEqual([
      expect.objectContaining({
        kind: "turn",
        id: "t-2",
        state: "failed",
        native: "error",
        reason: RESTART_TURN_END.error?.message,
      }),
      expect.objectContaining({
        kind: "workflow",
        id: "wf-1",
        origin: "t-wf",
        state: "failed",
        native: "stopped:interrupted",
      }),
    ]);
    // Never a phantom success, and durable: the reload segment carries them.
    await restored.persisted();
    const segment = await lastSegment(root, hosted.id);
    expect(segment.filter((e) => e.type === "unit_end").map((e) => e.unitId)).toEqual([
      "t-1",
      "t-2",
      "wf-1",
    ]);
    gate.resolve();
    hosted.cancel();
    await second.persister.stop();
  });
});

describe("workUnits(): a turn suspended on an ask", () => {
  test("waiting:permission live; after a reload it is still waiting under its id, then ends once", async () => {
    // Mutation: `workUnits` ignores the pending asks → `working` → red.
    // Mutation: `endedUnitsAtLoad` closes the resumed turn too → a phantom end → red.
    const root = join(dir, `d${++n}`);
    const first = rig(root);
    const updates: KnownSessionUpdateParams[] = [];
    const { hosted } = first.host.open({ create: true }, { send: (u) => updates.push(u) });
    hosted.prompt("t-ask", [{ type: "text", text: "ask" }]);
    await until(() => hosted.workUnits()[0]?.state === "waiting");
    expect(hosted.workUnits()).toEqual([
      { kind: "turn", id: "t-ask", state: "waiting", waitingFor: "permission", native: "running" },
    ]);
    await hosted.persisted();
    await first.persister.stop();

    const second = rig(root);
    const loaded = await second.persister.load(hosted.id);
    if (!loaded.ok) throw new Error(loaded.reason);
    const restored = second.host.restore(loaded.record);
    const again: KnownSessionUpdateParams[] = [];
    restored.attach({ send: (u) => again.push(u) });
    await until(() => restored.workUnits()[0]?.state === "waiting");
    expect(restored.workUnits()).toEqual([
      { kind: "turn", id: "t-ask", state: "waiting", waitingFor: "permission", native: "running" },
    ]);
    await until(() => again.some((u) => u.update.type === "permission_request"));
    const ask = again.find((u) => u.update.type === "permission_request")?.update;
    if (ask?.type !== "permission_request") throw new Error("no re-ask");
    restored.resolvePermission(ask.requestId, "allow_once");
    await until(() => ended(restored, "turn", "t-ask") !== undefined);
    expect(restored.workUnits()).toEqual([
      expect.objectContaining({ id: "t-ask", state: "completed", result: "answer: ran" }),
    ]);
    await second.persister.stop();
  });
});

describe("endedUnitsAtLoad (pure)", () => {
  const open: WorkUnit[] = [
    { kind: "turn", id: "t-a", state: "working", native: "running", startedAt: 5 },
    { kind: "turn", id: "t-b", state: "working", native: "running" },
    { kind: "turn", id: "t-c", state: "working", native: "running" },
    { kind: "workflow", id: "wf-1", origin: "t-x", state: "working", native: "running" },
  ];
  const done: WorkUnit = {
    kind: "turn",
    id: "t-0",
    state: "completed",
    native: "end_turn",
    endedAt: 1,
  };

  test("the resumed turn stays live; a key's end wins; no key → the restart end; a run is interrupted", () => {
    // Mutation: ignore the reconciled key's end (always RESTART) → t-b is `failed` → red.
    const units = endedUnitsAtLoad(
      { ended: [done], open },
      [{ turnId: "t-a" }, { turnId: "t-b", end: { stopReason: "cancelled" } }],
      "t-a",
      9,
    );
    expect(units).toEqual([
      done,
      { kind: "turn", id: "t-b", state: "canceled", native: "cancelled", endedAt: 9 },
      {
        kind: "turn",
        id: "t-c",
        state: "failed",
        native: "error",
        reason: RESTART_TURN_END.error?.message,
        endedAt: 9,
      },
      {
        kind: "workflow",
        id: "wf-1",
        origin: "t-x",
        state: "failed",
        native: "stopped:interrupted",
        reason: RESTART_TURN_END.error?.message,
        endedAt: 9,
      },
    ]);
  });

  test("nothing recorded → an empty table", () => {
    expect(endedUnitsAtLoad(undefined, [], undefined, 1)).toEqual([]);
  });
});
