/**
 * C3, T7·client (docs/feat/voice-conversation.md §4): `RemoteClient.prompt` /
 * `.enqueue` put `voice` on the FRAME only when the caller asks.
 *
 * The frame is what the daemon parses, and both payloads are STRIP schemas
 * (AGENTS §7), so a field the client forgets is not an error — it is silently a
 * normal turn (a talk that reasons for ten seconds, or a steer that never marks
 * its turn). That is why this asserts the JSON that went out, not the types.
 *
 * The other half of the property is just as load-bearing: an ORDINARY turn's
 * frame must be byte-for-byte what it was before C3, so a client that never
 * uses voice mode (the TUI today, an older UI) is untouched.
 *
 * Mutations that must turn these red: spread `voice` unconditionally in
 * `RemoteClient.prompt`/`enqueue` → the ordinary-turn tests red; drop the
 * spread → the voice tests red.
 */
import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import {
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import { PROTOCOL_VERSION } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { type DuplexChannel, createChannelPair } from "@tentacle/transport";
import { RemoteClient } from "../src/remote-client.ts";

const CWD = "/tmp/voice-turn-client";
const env: ExecutionEnvironment = {
  id: "noop",
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
};

const tick = (ms = 2): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${String(cond)}`);
    await tick();
  }
}

/** A model whose round HANGS until the test lets it go (so a steer can be sent mid-turn). */
class Parked implements ModelProvider {
  readonly id = "parked";
  calls = 0;
  release: (() => void) | null = null;
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    this.calls++;
    if (this.calls === 1) {
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
      yield { type: "text", delta: "typed answer" };
      yield { type: "done" };
      return;
    }
    yield { type: "text", delta: "next" };
    yield { type: "done" };
  }
}

/** Every frame the client wrote, parsed (the daemon's side sees exactly this). */
function session() {
  const model = new Parked();
  const host = new SessionHost({
    defaultCwd: CWD,
    createAgent: () => ({
      agent: new Agent({
        model,
        tools: new ToolRegistry(),
        env,
        requestPermission: (req, options) => new PermissionBroker().request(req, options),
      }),
      permissions: new PermissionBroker(),
    }),
  });
  const frames: { method?: string; params?: Record<string, unknown> }[] = [];
  const [d, c] = createChannelPair();
  new Connection(d, host);
  const link: DuplexChannel = {
    send: (data) => {
      frames.push(JSON.parse(data) as { method?: string; params?: Record<string, unknown> });
      c.send(data);
    },
    close: () => c.close(),
    setOnMessage: (h) => c.setOnMessage(h),
    setOnClose: (h) => c.setOnClose(h),
  };
  const client = new RemoteClient(link, new PermissionBroker());
  const paramsOf = (method: string): Record<string, unknown>[] =>
    frames.filter((f) => f.method === method).map((f) => f.params ?? {});
  return { client, model, paramsOf };
}

describe("T7 the client sends `voice` only when asked", () => {
  test("prompt: an ordinary turn's frame carries no voice key at all", async () => {
    const { client, model, paramsOf } = session();
    await client.initialize();
    await client.openSession(undefined, undefined, "s1");
    const parked = client.prompt("s1", "t1", "ciao");
    await until(() => model.calls === 1);
    model.release?.();
    await parked;
    const [params] = paramsOf("session/prompt");
    expect(params).toBeDefined();
    expect(params !== undefined && "voice" in params).toBe(false);
    // The rest of the frame is unchanged (C3 is additive).
    expect(params).toEqual({
      sessionId: "s1",
      turnId: "t1",
      content: [{ type: "text", text: "ciao" }],
    });
    client.close();
  });

  test("prompt: a voice turn's frame carries its own reasoning", async () => {
    const { client, model, paramsOf } = session();
    await client.initialize();
    await client.openSession(undefined, undefined, "s1");
    const parked = client.prompt("s1", "t1", "ciao", undefined, undefined, undefined, {
      reasoning: "off",
    });
    await until(() => model.calls === 1);
    model.release?.();
    await parked;
    const [params] = paramsOf("session/prompt");
    expect(params?.voice).toEqual({ reasoning: "off" });
    client.close();
  });

  test("enqueue: `voice` rides the steer only when the caller asks", async () => {
    const { client, model, paramsOf } = session();
    await client.initialize();
    await client.openSession(undefined, undefined, "s1");
    const parked = client.prompt("s1", "t1", "go");
    await until(() => model.calls === 1);
    // A typed steer to the running turn: no voice key.
    await client.enqueue("s1", "e1", "t1", "typed steer");
    // A voice steer: its own profile.
    await client.enqueue("s1", "e2", "t1", "spoken steer", { reasoning: "keep" });
    const steers = paramsOf("session/enqueue");
    expect(steers).toHaveLength(2);
    const [typed, spoken] = steers;
    expect(typed !== undefined && "voice" in typed).toBe(false);
    expect(spoken?.voice).toEqual({ reasoning: "keep" });
    model.release?.();
    await parked;
    client.close();
  });
});
