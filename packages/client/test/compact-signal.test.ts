import { expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import {
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import { ToolRegistry } from "@tentacle/tools";
import { DomainErrorCode, type DuplexChannel, createChannelPair } from "@tentacle/transport";
import { RemoteClient } from "../src/remote-client.ts";

// docs/feat/mobile-hub-commands.md C2 item 9: `RemoteSession.compact(signal)` —
// the phone's Stop during its own compaction. An abort sends `session/cancel`
// with NO `turnId` ("whatever runs, a compaction included"), and the daemon
// rejects the compaction `Cancelled` with the history untouched.
// Mutation: `compact` ignoring its signal → the first test hangs on no cancel frame.

const env = {} as ExecutionEnvironment;

/** Answers the first call (the turn) at once; every later call is the compaction's summary. */
class Summarizer implements ModelProvider {
  readonly id = "h";
  calls = 0;
  summaries = 0;
  constructor(private readonly hang: boolean) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.calls += 1;
    if (this.calls === 1) {
      yield { type: "text", delta: "reply about the old chat" };
      yield { type: "done" };
      return;
    }
    this.summaries += 1;
    if (this.hang) {
      await new Promise<void>((resolve) => {
        if (request.signal?.aborted) {
          resolve();
        }
        request.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new Error("aborted");
    }
    yield { type: "text", delta: "summary" };
    yield { type: "done" };
  }
}

type Frame = { method?: string; params?: Record<string, unknown> };

async function harness(hang = true) {
  const model = new Summarizer(hang);
  const host = new SessionHost({
    defaultCwd: "/tmp/compact-signal",
    createAgent: () => ({
      agent: new Agent({ model, tools: new ToolRegistry(), env, systemPrompt: "sys" }),
      permissions: new PermissionBroker(),
    }),
  });
  const [d, c] = createChannelPair();
  new Connection(d, host);
  const frames: Frame[] = [];
  const spy: DuplexChannel = {
    send: (data) => {
      frames.push(JSON.parse(data) as Frame);
      c.send(data);
    },
    close: () => c.close(),
    setOnMessage: (h) => c.setOnMessage(h),
    setOnClose: (h) => c.setOnClose(h),
  };
  const client = new RemoteClient(spy, new PermissionBroker());
  await client.initialize();
  const session = client.newSession(undefined, crypto.randomUUID());
  for await (const _ of session.send("the old chat")) {
    // drain
  }
  return { client, session, frames, model };
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rejection(run: Promise<unknown>): Promise<unknown> {
  return run.then(
    () => null,
    (e: unknown) => e,
  );
}

test("an abort during compact sends session/cancel WITHOUT a turnId and rejects Cancelled", async () => {
  const { client, session, frames, model } = await harness();
  const before = await session.snapshot();
  const control = new AbortController();
  const run = rejection(session.compact(control.signal));
  for (let i = 0; i < 100 && model.summaries === 0; i += 1) {
    await delay(5);
  }
  expect(model.summaries).toBe(1);
  control.abort();
  const error = await Promise.race([run, delay(500).then(() => "still running")]);
  expect((error as { code?: number } | null)?.code).toBe(DomainErrorCode.Cancelled);
  const cancels = frames.filter((f) => f.method === "session/cancel");
  expect(cancels.length).toBe(1);
  const compactFrame = frames.find((f) => f.method === "session/compact");
  expect(cancels[0]?.params).toEqual({ sessionId: compactFrame?.params?.sessionId });
  expect(cancels[0]?.params).not.toHaveProperty("turnId");
  // The history is untouched.
  expect(await session.snapshot()).toEqual(before);
  client.close();
});

test("a signal already aborted sends no compaction at all and rejects Cancelled", async () => {
  const { client, session, frames } = await harness();
  const control = new AbortController();
  control.abort();
  const error = await rejection(session.compact(control.signal));
  expect((error as { code?: number } | null)?.code).toBe(DomainErrorCode.Cancelled);
  expect(frames.some((f) => f.method === "session/compact")).toBe(false);
  client.close();
});

test("an abort after the compaction settled sends nothing (the outcome already folded wins)", async () => {
  const { client, session, frames, model } = await harness(false);
  const control = new AbortController();
  const result = await session.compact(control.signal);
  expect(model.summaries).toBe(1);
  expect(result.before).toBeGreaterThan(result.after);
  control.abort();
  await delay(10);
  expect(frames.some((f) => f.method === "session/cancel")).toBe(false);
  client.close();
});
