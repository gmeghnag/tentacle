import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type SessionRecord } from "@tentacle/agent";
import {
  type ChatMessage,
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { Connection, LogSessionStore, SessionHost } from "@tentacle/daemon";
import { ToolRegistry } from "@tentacle/tools";
import { createChannelPair } from "@tentacle/transport";
import type { SessionActivity } from "../../tui/src/turn-feed.ts";
import { createLocalRuntime } from "../src/local-runtime.ts";
import { SessionSaver } from "../src/session-saver.ts";

// docs/fix/clear-silent-noop.md — the regression test at the shape that broke
// it: a RESUMED session (a saved log the laptop seeds), `/clear` typed before
// any turn had opened it. The conversation exists only as the client's seed,
// so the daemon has nothing under that id yet. `/clear` must still reset it:
// the seed is opened (the same session the first prompt would create) and
// cleared — never a hollow `{0, 0}` with the chat and the model's context
// untouched, and the dropped chat kept as its own fork.

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "clear-resume-"));
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
  readonly requests: ChatRequest[] = [];
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push({ ...request, messages: [...request.messages] });
    yield { type: "text", delta: "new reply" };
    yield { type: "done" };
  }
}

const UID = "fc027317-56ee-4f2e-ade4-aa7b1753345b";

/** A saved session in the owner's shape: tool rounds, sub-agent markers, two turns. */
const RESUME = (cwd: string): SessionRecord => ({
  id: UID,
  cwd,
  model: "m",
  createdAt: 1,
  updatedAt: 2,
  title: "resumed",
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: "map the repo" },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: "{}" }] },
    { role: "tool", content: "tree", toolCallId: "c1" },
    { role: "user", content: "sub-agent report", note: { kind: "subagent_report" } },
    { role: "assistant", content: "done mapping" },
  ] as ChatMessage[],
});

async function rig(resume: SessionRecord | null, model: Quiet) {
  const host = new SessionHost({
    defaultCwd: dir,
    createAgent: () => {
      const agent = new Agent({
        model,
        tools: new ToolRegistry(),
        env,
        systemPrompt: "sys",
      });
      return { agent, permissions: new PermissionBroker() };
    },
  });
  const [daemonCh, clientCh] = createChannelPair();
  const connection = new Connection(daemonCh, host);
  const store = new LogSessionStore(join(dir, "sessions"));
  const saver = new SessionSaver(store, () => {});
  const runtime = await createLocalRuntime({
    channel: clientCh,
    disposeTransport: () => connection.close(),
    permissions: new PermissionBroker(),
    saver,
    cwd: dir,
    model: "m",
    resume,
  });
  return { host, runtime, store, saver };
}

const drain = async (gen: AsyncIterable<unknown>): Promise<void> => {
  for await (const _ of gen) {
    // consume
  }
};

test("REPRO /clear on a resumed session nothing has opened resets it (no hollow {0,0})", async () => {
  const model = new Quiet();
  const r = await rig(RESUME(dir), model);
  const controller = r.runtime.createSession();
  const seen: SessionActivity[] = [];
  controller.watch?.((a) => seen.push(a));
  expect(r.host.size).toBe(0); // nothing opened yet: the seed IS the conversation

  const result = await controller.clear?.();
  await controller.flushed?.();
  await r.saver.drain();
  await r.store.drain();

  // The daemon reset the real conversation, and the screen is told to replace it.
  expect(result).toEqual({ before: RESUME(dir).messages.length, after: 1 });
  expect(seen.map((a) => (a.kind === "history" ? a.reason : a.kind))).toEqual(["clear"]);
  expect(r.host.size).toBe(1);

  // The chat it dropped is kept as its own session (clear-fork-history).
  const records = (await r.store.list()).records;
  const fork = records.find((rec) => rec.id !== UID);
  expect(fork).toBeDefined();

  // And the next prompt starts from the fresh chat: the old one is gone from
  // the model's context too, not just off the screen.
  await drain(controller.send("next"));
  await new Promise((res) => setTimeout(res, 20));
  const sent = model.requests[0]?.messages.map((m) => m.content) ?? [];
  expect(sent).not.toContain("map the repo");
  expect(sent).not.toContain("done mapping");
  expect(sent.at(-1)).toBe("next");
  await r.runtime.dispose();
});

test("a fresh session (no seed, nothing to clear) is left alone: `{0,0}`, no session created", async () => {
  const r = await rig(null, new Quiet());
  const controller = r.runtime.createSession();
  expect(await controller.clear?.()).toEqual({ before: 0, after: 0 });
  expect(r.host.size).toBe(0);
  await r.runtime.dispose();
});
