import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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
import { Connection, LogSessionStore, SessionHost } from "@tentacle/daemon";
import { ToolRegistry } from "@tentacle/tools";
import { createChannelPair } from "@tentacle/transport";
import { createLocalRuntime } from "../src/local-runtime.ts";
import { SessionSaver } from "../src/session-saver.ts";

// docs/feat/clear-fork-history.md T23 (laptop side, end to end): a real daemon
// (no persister, like a pod), the real `createLocalRuntime`, `SessionSaver` and
// `LogSessionStore`. `/clear` leaves LIVE + FORK on the laptop.

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "clear-fork-e2e-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const env: ExecutionEnvironment = {
  id: "noop",
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
};
class Quiet implements ModelProvider {
  readonly id = "q";
  async *stream(_r: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: "text", delta: "old reply" };
    yield { type: "done" };
  }
}

for (const keepSuperseded of [false, true]) {
  test(`laptop: /clear leaves LIVE + FORK (keepSuperseded ${keepSuperseded})`, async () => {
    const runtimes: AgentJobs[] = [];
    const host = new SessionHost({
      defaultCwd: dir,
      createAgent: () => {
        const agentJobs = new AgentJobs(2);
        runtimes.push(agentJobs);
        return {
          agent: new Agent({
            model: new Quiet(),
            tools: new ToolRegistry(),
            env,
            agentJobs,
            systemPrompt: "sys",
          }),
          permissions: new PermissionBroker(),
          agentJobs,
        };
      },
    });
    const [daemonCh, clientCh] = createChannelPair();
    const connection = new Connection(daemonCh, host);
    const store = new LogSessionStore(join(dir, "sessions"), { keepSuperseded });
    const notices: string[] = [];
    const saver = new SessionSaver(store, (t) => notices.push(t));
    const runtime = await createLocalRuntime({
      channel: clientCh,
      disposeTransport: () => connection.close(),
      permissions: new PermissionBroker(),
      saver,
      cwd: dir,
      model: "m",
      resume: null,
    });
    const controller = runtime.createSession();
    for await (const _ of controller.send("the OLD chat")) {
      // drain
    }
    const gate = Promise.withResolvers<never>();
    runtimes[0]?.start(
      { callId: "c1", agentType: "general", description: "map" },
      () => gate.promise,
    );
    await controller.flushed?.();
    await controller.clear?.();
    await controller.flushed?.();
    expect(await saver.drain()).toEqual([]);
    await store.drain();

    const records = (await store.list()).records;
    expect(records).toHaveLength(2);
    const files = await readdir(join(dir, "sessions"));
    const liveId = [...host.values()][0]?.id ?? "";
    expect(files).toContain(`${liveId}.jsonl`);
    const forkRecord = records.find((r) => r.id !== liveId);
    expect(forkRecord).toBeDefined();
    const fork = await store.load(forkRecord?.id ?? "");
    if (fork.status !== "ok") throw new Error(JSON.stringify(fork));
    expect(fork.record.messages.map((m) => `${m.role}:${m.note?.kind ?? ""}:${m.content}`)).toEqual(
      ["system::sys", "user::the OLD chat", "assistant::old reply"],
    );
    // The work stays with the live session: no lost note, no marker in the fork.
    const forkText = await readFile(store.file(forkRecord?.id ?? ""), "utf8");
    expect(forkText).not.toContain("subagent_background");
    expect(forkText).not.toContain("was lost");
    const live = await store.load(liveId);
    if (live.status !== "ok") throw new Error(JSON.stringify(live));
    expect(live.record.id).toBe(liveId);
    expect(live.record.messages.some((m) => m.content === "the OLD chat")).toBe(false);
    expect((await readFile(store.file(liveId), "utf8")).includes("the OLD chat")).toBe(
      keepSuperseded,
    );
    gate.reject(new Error("end"));
    runtime.dispose();
  });
}
