import { describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@tentacle/agent";
import {
  AgentJobs,
  type ChatMessage,
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import type { ClearForkCapture } from "../src/persisted-session.ts";
import { SessionHost } from "../src/session-host.ts";
import { LogSessionStore, type LogStoreIo } from "../src/session-log-store.ts";
import { SessionPersister } from "../src/session-persister.ts";
import { SpyDaemonStore } from "./support/daemon-store-spy.ts";

// docs/feat/clear-fork-history.md T9-T16 (the `serve` side): `/clear` keeps the
// chat it drops as a NEW archived session, written in the source's queue.

const CWD = "/tmp/clear-fork";
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
const OLD: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
  { role: "system", content: "sys" },
  { role: "user", content: "the OLD chat" },
  { role: "assistant", content: "old reply" },
];

/** An io that fails (`control.fail`) for every durable write whose path does not name `liveId`. */
function failingForkIo(control: { fail: boolean; liveId: string }): LogStoreIo {
  return {
    append: async (path, data) => {
      await appendFile(path, data, { mode: 0o600 });
    },
    writeDurable: async (path, data) => {
      if (control.fail && !path.includes(control.liveId)) {
        throw Object.assign(new Error("full"), { code: "ENOSPC" });
      }
      await writeFile(path, data, { mode: 0o600 });
    },
  };
}

function rigOn(dir: string, io?: LogStoreIo) {
  const store = new LogSessionStore(dir, io ? { io } : {});
  const errors: string[] = [];
  const persister = new SessionPersister({
    store,
    cwd: CWD,
    model: "m",
    onError: (e: Error) => errors.push(e.message),
  });
  const runtimes: AgentJobs[] = [];
  const host = new SessionHost({
    defaultCwd: CWD,
    persister,
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
  return { store, persister, host, runtimes, errors };
}

const open = (host: SessionHost, messages: readonly (typeof OLD)[number][] = OLD) =>
  host.open({ create: true, messages: [...messages] }, { send: () => {} }).hosted;

async function withDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "clear-fork-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const types = async (path: string) =>
  (await readFile(path, "utf8"))
    .split("\n")
    .filter((l) => l.trim() !== "")
    .slice(1)
    .map((l) => (JSON.parse(l) as { type: string }).type);

describe("serve: /clear keeps the old chat as an archived fork", () => {
  test("T10 the fork is archived, survives a restart, reopens with the old chat and continues its own log; the live session keeps its id and child", async () => {
    await withDir(async (dir) => {
      const first = rigOn(dir);
      const hosted = open(first.host);
      const gate = Promise.withResolvers<never>();
      first.runtimes[0]?.start(
        { callId: "c1", agentType: "general", description: "map" },
        () => gate.promise,
      );
      await hosted.persisted();
      const liveId = hosted.id;
      expect(first.host.archivedCount).toBe(0);
      hosted.clear();
      expect(first.host.archivedCount).toBe(1);
      await hosted.persisted();
      await first.persister.flush(liveId);
      await first.store.drain();
      const listed = first.host.list({}).sessions;
      const fork = listed.find((s) => s.sessionId !== liveId);
      expect(fork?.archived).toBe(true);
      expect(listed.some((s) => s.sessionId === liveId && s.archived !== true)).toBe(true);
      expect(first.runtimes[0]?.list?.().length ?? 1).toBeGreaterThan(0);
      await first.persister.stop();
      gate.reject(new Error("end"));

      // A restart: the fork is found as archived; reopening is the ordinary resume.
      const second = rigOn(dir);
      const forkId = fork?.sessionId ?? "";
      const loaded = await second.persister.loadState(forkId);
      if (!loaded.ok) throw new Error(loaded.reason);
      expect(loaded.meta.archivedAt).toBeDefined();
      second.host.addArchived(loaded.meta);
      expect(second.host.list({}).sessions.map((s) => s.sessionId)).toContain(forkId);
      const full = await second.persister.load(forkId);
      if (!full.ok) throw new Error(full.reason);
      expect(full.record.messages).toEqual(OLD);
      const params = { sessionId: forkId, reopen: true };
      const out = second.host.open(
        params,
        { send: () => {} },
        await second.host.prepareOpen(params),
      );
      expect(out.hosted.id).toBe(forkId);
      expect(out.created).toBe(false);
      expect(out.hosted.snapshotPage().messages).toEqual(OLD);
      await second.persister.stop();
    });
  });

  test("T11 no job marker in the fork; the live log re-emits its sub-agent marker", async () => {
    await withDir(async (dir) => {
      const rig = rigOn(dir);
      const hosted = open(rig.host);
      const gate = Promise.withResolvers<never>();
      rig.runtimes[0]?.start(
        { callId: "c1", agentType: "general", description: "map" },
        () => gate.promise,
      );
      await hosted.persisted();
      hosted.clear();
      await hosted.persisted();
      await rig.persister.flush(hosted.id);
      await rig.store.drain();
      const forkId =
        rig.host.list({}).sessions.find((s) => s.sessionId !== hosted.id)?.sessionId ?? "";
      expect(forkId).not.toBe("");
      const files = await readdir(dir, { recursive: true });
      const forkFile = files.find((f) => f.endsWith(`${forkId}.jsonl`));
      const liveFile = files.find((f) => f.endsWith(`${hosted.id}.jsonl`));
      expect(forkFile).toBeDefined();
      expect(await types(join(dir, forkFile ?? ""))).toEqual([
        "base",
        "message",
        "message",
        "message",
      ]);
      const live = await types(join(dir, liveFile ?? ""));
      expect(live).toContain("subagent_background");
      const loaded = await rig.persister.load(forkId);
      if (!loaded.ok) throw new Error(loaded.reason);
      expect(loaded.record.loadNotes).toEqual([]);
      await rig.persister.stop();
      gate.reject(new Error("end"));
    });
  });

  test("T12 a failed fork keeps the old chat on disk: the live sidecar still names the old head, the reload gives the old chat", async () => {
    await withDir(async (dir) => {
      const control = { fail: false, liveId: "" };
      const rig = rigOn(dir, failingForkIo(control));
      const hosted = open(rig.host);
      control.liveId = hosted.id;
      await hosted.persisted();
      await rig.persister.flush(hosted.id);
      await rig.store.drain();
      control.fail = true;
      hosted.clear();
      await hosted.persisted().catch(() => {});
      await rig.store.drain();
      await rig.persister.stop();
      const second = rigOn(dir);
      const loaded = await second.persister.load(hosted.id);
      if (!loaded.ok) throw new Error(loaded.reason);
      expect(loaded.record.messages).toEqual(OLD);
      await second.persister.stop();
    });
  });

  test("T13 a failed fork is resident and listed; a sweep with a healthy store heals it", async () => {
    await withDir(async (dir) => {
      const control = { fail: false, liveId: "" };
      const rig = rigOn(dir, failingForkIo(control));
      const hosted = open(rig.host);
      control.liveId = hosted.id;
      await hosted.persisted();
      await rig.persister.flush(hosted.id);
      await rig.store.drain();
      control.fail = true;
      hosted.clear();
      await rig.store.drain();
      await Bun.sleep(20);
      const forkId =
        rig.host.list({}).sessions.find((s) => s.sessionId !== hosted.id)?.sessionId ?? "";
      expect(forkId).not.toBe("");
      expect(rig.host.archivedCount).toBe(1);
      control.fail = false;
      rig.host.reapExpired({ idleTtlMs: 1e12, detachedCap: 100 } as never);
      await Bun.sleep(50);
      await rig.store.drain();
      expect(await readdir(dir, { recursive: true })).toContain(`${forkId}.jsonl`);
      expect(rig.host.archivedCount).toBe(1);
      await rig.persister.stop();
    });
  });

  test("T14 no fork for an empty chat, nor without a persister", async () => {
    await withDir(async (dir) => {
      const rig = rigOn(dir);
      const hosted = open(rig.host);
      await hosted.persisted();
      hosted.clear();
      expect(rig.host.archivedCount).toBe(1);
      hosted.clear(); // nothing but the system prompt (and notes) is left
      expect(rig.host.archivedCount).toBe(1);
      await rig.persister.stop();

      // A host without a persister writes nothing and lists no fork.
      const bare = new SessionHost({
        defaultCwd: CWD,
        createAgent: () => ({
          agent: new Agent({
            model: new Quiet(),
            tools: new ToolRegistry(),
            env,
            systemPrompt: "sys",
          }),
          permissions: new PermissionBroker(),
        }),
      });
      const b = bare.open({ create: true, messages: [...OLD] }, { send: () => {} }).hosted;
      b.clear();
      expect(bare.archivedCount).toBe(0);
    });
  });

  test("T9 clear hands the PRE-clear chat and title (a model title is reset by the clear)", async () => {
    const spy = new SpyDaemonStore();
    const persister = new SessionPersister({
      store: spy,
      cwd: CWD,
      model: "m",
      onError: () => {},
    });
    const captured: ClearForkCapture[] = [];
    const host = new SessionHost({
      defaultCwd: CWD,
      persister,
      createAgent: () => ({
        agent: new Agent({
          model: new Quiet(),
          tools: new ToolRegistry(),
          env,
          systemPrompt: "sys",
        }),
        permissions: new PermissionBroker(),
      }),
    });
    const real = persister.fork.bind(persister);
    persister.fork = (source, capture, at) => {
      captured.push(capture);
      return real(source, capture, at);
    };
    const hosted = host.open(
      {
        create: true,
        messages: [...OLD],
        title: { text: "Old title", source: "model" },
      } as never,
      { send: () => {} },
    ).hosted;
    await hosted.persisted();
    hosted.clear();
    expect(captured).toHaveLength(1);
    expect(captured[0]?.messages).toEqual(OLD);
    expect(captured[0]?.title.source).toBe("model");
    await persister.stop();
  });

  test("T15 a throwing keepFork does not fail clear: it returns and the error is reported", async () => {
    const spy = new SpyDaemonStore();
    const errors: Error[] = [];
    const persister = new SessionPersister({
      store: spy,
      cwd: CWD,
      model: "m",
      onError: () => {},
    });
    persister.fork = () => {
      throw new Error("boom");
    };
    const host = new SessionHost({
      defaultCwd: CWD,
      persister,
      exposeTurnErrors: true,
      onTurnError: (e: Error) => errors.push(e),
      createAgent: () => ({
        agent: new Agent({
          model: new Quiet(),
          tools: new ToolRegistry(),
          env,
          systemPrompt: "sys",
        }),
        permissions: new PermissionBroker(),
      }),
    } as never);
    const hosted = host.open({ create: true, messages: [...OLD] }, { send: () => {} }).hosted;
    await hosted.persisted();
    expect(hosted.clear()).toEqual({ before: 3, after: 1 });
    expect(errors.map((e) => e.message).join(" ")).toContain("boom");
    await persister.stop();
  });

  test("T16 persister.fork reaches the store before the same stretch's persist", async () => {
    const spy = new SpyDaemonStore();
    const persister = new SessionPersister({
      store: spy,
      cwd: CWD,
      model: "m",
      onError: () => {},
    });
    const calls: string[] = [];
    const realFork = spy.fork.bind(spy);
    spy.fork = (source, unit) => {
      calls.push("fork");
      return realFork(source, unit);
    };
    const realWrite = spy.write.bind(spy);
    spy.write = (unit) => {
      calls.push("write");
      return realWrite(unit);
    };
    const host = new SessionHost({
      defaultCwd: CWD,
      persister,
      createAgent: () => ({
        agent: new Agent({
          model: new Quiet(),
          tools: new ToolRegistry(),
          env,
          systemPrompt: "sys",
        }),
        permissions: new PermissionBroker(),
      }),
    });
    const hosted = host.open({ create: true, messages: [...OLD] }, { send: () => {} }).hosted;
    await hosted.persisted();
    calls.length = 0;
    hosted.clear();
    await hosted.persisted();
    expect(calls.slice(0, 2)).toEqual(["fork", "write"]);
    await persister.stop();
  });
});
