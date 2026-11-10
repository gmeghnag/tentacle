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
import { ToolRegistry } from "@tentacle/tools";
import { render } from "ink-testing-library";
import { createLocalRuntime } from "../../cli/src/local-runtime.ts";
import { SessionSaver } from "../../cli/src/session-saver.ts";
import { Connection, LogSessionStore, SessionHost } from "../../daemon/src/index.ts";
import { createChannelPair } from "../../transport/src/index.ts";
import { App } from "../src/App.tsx";
import type { DisplayItem } from "../src/state.ts";

// docs/fix/clear-silent-noop.md — the regression test at the REAL interface and
// the shape that broke it: the real App over the real RPC stack
// (`createLocalRuntime` → RemoteClient ↔ Connection → SessionHost), a RESUMED
// session (a saved log, seeded like `--resume`), then `/clear` typed before any
// turn has opened it. The daemon had nothing under that id: it answered a hollow
// `{0, 0}`, the transcript stayed, ctx stayed, and no notice ever said why.
// Red on main: the OLD chat is still on screen after `/clear`.

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "clear-resume-app-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const strip = (s: string | undefined) =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: SGR stripping
  (s ?? "").replace(/\x1b\[[0-9;]*m/g, "");

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

/** The owner's shape, shrunk: tool rounds, a sub-agent report, two turns. */
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
      const agent = new Agent({ model, tools: new ToolRegistry(), env, systemPrompt: "sys" });
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

/** The seeded transcript, as `--resume` builds it (packages/tui/src/run.tsx). */
const SEEDED: readonly DisplayItem[] = [
  { kind: "user", text: "map the repo" },
  { kind: "assistant", text: "done mapping" },
];

async function type(stdin: { write(d: string): void }, text: string) {
  stdin.write(text);
  await delay(20);
  stdin.write("\r");
}

test("REPRO (App): /clear on a resumed session nothing has opened replaces the chat", async () => {
  const model = new Quiet();
  const r = await rig(RESUME(dir), model);
  const app = render(
    <App createSession={r.runtime.createSession} model="m" cwd={dir} initialItems={SEEDED} />,
  );
  await delay(80);
  expect(strip(app.lastFrame())).toContain("map the repo");
  expect(r.host.size).toBe(0); // nothing opened yet: the seed IS the conversation

  await type(app.stdin, "/clear");
  await delay(500);
  const frame = strip(app.lastFrame());
  // The transcript is the cleared one — the bug leaves the old chat on screen.
  expect(frame).not.toContain("map the repo");
  expect(frame).not.toContain("done mapping");
  // It is a success, not a complaint (the fix must not nag on the real path).
  expect(frame).not.toContain("did nothing");
  expect(frame).not.toContain("/clear failed");

  // The context really was reset (the owner's symptom: ctx stayed ~19%): the
  // next prompt goes to the model with the old chat GONE.
  await type(app.stdin, "next");
  await delay(300);
  const sent = model.requests[0]?.messages.map((m) => m.content) ?? [];
  expect(sent).not.toContain("map the repo");
  expect(sent.at(-1)).toBe("next");
  app.unmount();
  await r.runtime.dispose();
});

test("REPRO (App): a /clear that resets NOTHING on a chat that is on screen says so", async () => {
  // The loud path, at the same interface: a session whose `clear` answers
  // `{0, 0}` (what a daemon without the conversation under that id returns)
  // must not look like a no-op. Mutation: drop the `clearNoopNotice` branch in
  // `runClear` → no notice, which is exactly the reported bug.
  const calls = { clears: 0 };
  const app = render(
    <App
      createSession={() => ({
        async *send() {
          yield { type: "turn_end" as const, reason: "end_turn" as const };
        },
        close() {},
        clear: () => {
          calls.clears += 1;
          return Promise.resolve({ before: 0, after: 0 });
        },
      })}
      model="m"
      cwd={dir}
      initialItems={SEEDED}
    />,
  );
  await delay(80);
  expect(strip(app.lastFrame())).toContain("map the repo");
  await type(app.stdin, "/clear");
  await delay(200);
  expect(calls.clears).toBe(1);
  expect(strip(app.lastFrame())).toContain("/clear did nothing");
  app.unmount();
});

test("an empty transcript: a `{0, 0}` /clear says nothing (nothing was lost)", async () => {
  const app = render(
    <App
      createSession={() => ({
        async *send() {
          yield { type: "turn_end" as const, reason: "end_turn" as const };
        },
        close() {},
        clear: () => Promise.resolve({ before: 0, after: 0 }),
      })}
      model="m"
      cwd={dir}
    />,
  );
  await delay(80);
  await type(app.stdin, "/clear");
  await delay(200);
  expect(strip(app.lastFrame())).not.toContain("did nothing");
  app.unmount();
});
