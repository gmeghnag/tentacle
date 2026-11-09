import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@tentacle/agent";
import {
  AgentJobs,
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import type { Attachment } from "../src/hosted-session.ts";
import { type AgentFactory, SessionHost } from "../src/session-host.ts";
import { LogSessionStore } from "../src/session-log-store.ts";
import { SessionPersister } from "../src/session-persister.ts";

// docs/feat/subagent-background.md, 6a-1: the SessionHost wiring of the runtime
// (T32 the settings sync, T33 the `serve` restart).

const CWD = "/tmp/subagent-bg-host";
const env: ExecutionEnvironment = {
  id: "noop",
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
};
class Quiet implements ModelProvider {
  readonly id = "q";
  async *stream(_r: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: "text", delta: "ok" };
    yield { type: "done" };
  }
}
const attachment: Attachment = { send: () => {} };

describe("T32: a settings sync (SessionHost.updateSettings)", () => {
  const report = { applied: [], ignored: [] } as never;

  test("a factory that reuses the AgentJobs swaps; its exit then reaches the NEW agent only", async () => {
    const built: Agent[] = [];
    const factory: AgentFactory = (_cwd, context) => {
      const agentJobs = context.reuse?.agentJobs ?? new AgentJobs(2);
      const agent = new Agent({ model: new Quiet(), tools: new ToolRegistry(), env, agentJobs });
      built.push(agent);
      return {
        agent,
        permissions: context.reuse?.permissions ?? new PermissionBroker(),
        agentJobs,
        settingsReport: report,
      };
    };
    const host = new SessionHost({ defaultCwd: CWD, createAgent: factory });
    const { hosted } = host.open({ create: true }, attachment);
    const runtime = hosted.reusable().agentJobs;
    expect(runtime).toBeDefined();
    const outcome = host.updateSettings(hosted, hosted.id, {} as never);
    expect(outcome.applied).toBe(true);
    expect(hosted.reusable().agentJobs).toBe(runtime as AgentJobs);
    const [old, next] = built;
    runtime?.start({ callId: "c", agentType: "general", description: "after sync" }, async () => ({
      report: "R",
      toolUses: 0,
      stopReason: "end_turn",
    }));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(old?.pendingExitCount).toBe(0);
    expect(next?.pendingExitCount).toBe(1);
  });

  test("a factory that builds its OWN AgentJobs is refused and the stray one is disposed", async () => {
    const strays: AgentJobs[] = [];
    const factory: AgentFactory = (_cwd, context) => {
      const agentJobs = context.reuse ? new AgentJobs(2) : new AgentJobs(2);
      if (context.reuse) strays.push(agentJobs);
      return {
        agent: new Agent({ model: new Quiet(), tools: new ToolRegistry(), env, agentJobs }),
        permissions: context.reuse?.permissions ?? new PermissionBroker(),
        agentJobs,
        settingsReport: report,
      };
    };
    const host = new SessionHost({ defaultCwd: CWD, createAgent: factory });
    const { hosted } = host.open({ create: true }, attachment);
    expect(() => host.updateSettings(hosted, hosted.id, {} as never)).toThrow(/did not reuse/);
    // Disposed: it refuses new work.
    expect(strays[0]?.acquire("x").ok).toBe(false);
  });
});

describe("T33: the `serve` restart (real LogSessionStore)", () => {
  test("a live child at stop() is ONE lost note after the reload, and the counter continues", async () => {
    const dir = await mkdtemp(join(tmpdir(), "subagent-bg-restart-"));
    try {
      const rig = () => {
        const store = new LogSessionStore(dir);
        const persister = new SessionPersister({ store, cwd: CWD, model: "m", onError: () => {} });
        const runtimes: AgentJobs[] = [];
        const host = new SessionHost({
          defaultCwd: CWD,
          persister,
          createAgent: () => {
            const agentJobs = new AgentJobs(2);
            runtimes.push(agentJobs);
            return {
              agent: new Agent({ model: new Quiet(), tools: new ToolRegistry(), env, agentJobs }),
              permissions: new PermissionBroker(),
              agentJobs,
            };
          },
        });
        return { host, persister, runtimes };
      };
      const first = rig();
      const { hosted } = first.host.open(
        { create: true, messages: [{ role: "user", content: "x" }] },
        attachment,
      );
      const gate = Promise.withResolvers<never>();
      const started = first.runtimes[0]?.start(
        { callId: "c1", agentType: "general", description: "map the repo" },
        () => gate.promise,
      );
      expect(started).toEqual({ ok: true, agentId: "sa-1" });
      await hosted.persisted();
      await first.persister.stop(); // the "crash": the child dies with the process
      const id = hosted.id;

      const second = rig();
      const loaded = await second.persister.load(id);
      if (!loaded.ok) throw new Error(loaded.reason);
      expect(loaded.record.loadNotes.map((m) => `${m.note?.kind}:${m.note?.id}`)).toEqual([
        "subagent_lost:sa-1",
      ]);
      const restored = second.host.restore(loaded.record);
      expect(restored.snapshotPage().messages.at(-1)?.note).toEqual({
        kind: "subagent_lost",
        id: "sa-1",
      });
      // The counter continues past the lost id: a new child is sa-2, never sa-1 again.
      const next = second.runtimes[0]?.start(
        { callId: "c2", agentType: "general", description: "again" },
        () => new Promise<never>(() => {}),
      );
      expect(next).toEqual({ ok: true, agentId: "sa-2" });
      await second.persister.stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
