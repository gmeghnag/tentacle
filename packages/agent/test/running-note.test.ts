import { describe, expect, test } from "bun:test";
import {
  AgentJobs,
  type BackgroundJob,
  type ChatRequest,
  type ExecutionEnvironment,
  type JobController,
  type ModelProvider,
  type StreamEvent,
} from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { Agent } from "../src/agent.ts";
import { compactedHistory, stillRunningNote } from "../src/compact.ts";
import { contextResetHistory } from "../src/context-reset.ts";
import { Session } from "../src/session.ts";

const JOB = { id: "j1", command: "bun run dev" };
const AGENT = { agentId: "sa-1", description: "map the repo" };
const SHELL_PARA =
  "Background jobs still running (shell_output / shell_kill):\n- j1: `bun run dev`";
const AGENT_PARA =
  "Background sub-agents still running (each report arrives later as a [background] note):\n- sa-1: map the repo";
const NO_SKILLS = { kept: [], dropped: [] };

describe("stillRunningNote (T18)", () => {
  test("shell paragraph is today's text; agents paragraph follows; empty when none", () => {
    expect(stillRunningNote([JOB], [])).toBe(SHELL_PARA);
    expect(stillRunningNote([], [AGENT])).toBe(AGENT_PARA);
    expect(stillRunningNote([JOB], [AGENT])).toBe(`${SHELL_PARA}\n\n${AGENT_PARA}`);
    expect(stillRunningNote([], [])).toBe("");
  });

  test("a context reset names running sub-agents and shell jobs; with none, unchanged", () => {
    const restart = contextResetHistory({
      systemPrompt: "S",
      prompt: "p",
      jobs: [JOB],
      agents: [AGENT],
      skills: NO_SKILLS,
    })[1]?.content;
    expect(restart).toContain(SHELL_PARA);
    expect(restart).toContain(AGENT_PARA);
    const bare = { systemPrompt: "S", prompt: "p", jobs: [], skills: NO_SKILLS };
    // No `agents` and `agents: []` read the same as today's message.
    expect(contextResetHistory({ ...bare, agents: [] })).toEqual(contextResetHistory(bare));
    expect(contextResetHistory(bare)[1]?.content).not.toContain("Background");
  });

  test("a compaction appends the running note after the summary; with none, today's text", () => {
    const old = [{ role: "user" as const, content: "a" }];
    const plain = compactedHistory(old, "the gist");
    expect(plain[0]?.content).toBe(
      "Summary of the earlier conversation (compacted to save context):\n\nthe gist",
    );
    const named = compactedHistory(old, "the gist", NO_SKILLS, stillRunningNote([JOB], [AGENT]));
    expect(named[0]?.content).toBe(`${plain[0]?.content}\n\n${SHELL_PARA}\n\n${AGENT_PARA}`);
  });

  test("Session.compact names what is running right now", async () => {
    const running: BackgroundJob = {
      id: "j1",
      command: "bun run dev",
      startedAt: 0,
      status: "running",
      exitCode: null,
    };
    const jobs: JobController = {
      start: () => running,
      read: () => undefined,
      kill: () => false,
      list: () => [running],
      dispose: () => {},
      onStart: () => () => {},
      onExit: () => () => {},
    };
    const agentJobs = new AgentJobs(2);
    agentJobs.bind({ launched: () => "sa-1", ended: () => {} });
    const gate = Promise.withResolvers<never>();
    agentJobs.start(
      { callId: "c", agentType: "general", description: "map the repo" },
      () => gate.promise,
    );
    const model: ModelProvider = {
      id: "m",
      async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
        yield { type: "text", delta: "SUMMARY" };
        yield { type: "done" };
      },
    };
    const env: ExecutionEnvironment = {
      id: "noop",
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      readFile: async () => "",
      writeFile: async () => {},
    };
    const agent = new Agent({ model, tools: new ToolRegistry(), env, jobs, agentJobs });
    const session = new Session(agent, "s1", {});
    session.messages.push({ role: "user", content: "hello" }, { role: "assistant", content: "hi" });
    await session.compact();
    const summary = session.messages.find((m) => m.role === "user")?.content ?? "";
    expect(summary).toContain("SUMMARY");
    expect(summary).toContain(SHELL_PARA);
    expect(summary).toContain(AGENT_PARA);
    agentJobs.dispose();
  });
});
