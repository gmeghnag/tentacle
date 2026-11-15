/**
 * C3, T6 (docs/feat/voice-conversation.md §4 + F10): a voice turn on the daemon.
 *
 * A voice prompt's rounds carry (b) the transient spoken-style system line and,
 * with `reasoning:"off"`, (a) `reasoning:"off"` only until the turn's FIRST tool
 * call. With `reasoning:"keep"` the line still comes and no `reasoning` field
 * does — the person's switch is honoured, not overridden. An ordinary turn gets
 * neither.
 *
 * F10 is the load-bearing part: the line is added to the OUTGOING request only.
 * The history the session stores, `session/log` and the `serve` store must never
 * contain it. That is asserted here on the daemon side (`snapshot`, the log
 * store) and in `packages/daemon/test/voice-turn-serve.test.ts` over real files.
 *
 * Mutations that must turn these red: append the line to `messages` before the
 * request → F10 tests red; ignore `keep` (always emit `reasoning`) → the `keep`
 * test red; never close the window at the first tool call → the "after the
 * tool call" assertions red; drop `params.voice` in `Connection` → all red.
 */
import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import {
  type ChatMessage,
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
  VOICE_SPOKEN_LINE,
} from "@tentacle/core";
import type { Tool } from "@tentacle/core";
import { PROTOCOL_VERSION } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { z } from "zod";
import { Connection } from "../src/connection.ts";
import { SessionHost } from "../src/session-host.ts";

const env: ExecutionEnvironment = {
  id: "noop",
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
};

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${String(cond)}`);
    await tick();
  }
}

const say = (delta: string): StreamEvent[] => [{ type: "text", delta }, { type: "done" }];
const call = (id: string, name: string): StreamEvent[] => [
  { type: "tool_call", toolCall: { id, name, arguments: "{}" } },
  { type: "done" },
];

/** Records every request the loop hands the provider (the observable of §4). */
class Recording implements ModelProvider {
  readonly id = "recording";
  readonly calls: ChatRequest[] = [];
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.calls.push({ ...request, messages: [...request.messages] });
    yield* this.script[this.calls.length - 1] ?? say("ok");
  }
}

/** The free tool the scripted tool call runs (no permission → no ask). */
const freeTool: Tool = {
  name: "look",
  description: "look",
  inputSchema: z.object({}).passthrough(),
  permission: "none",
  execute: async () => ({ content: "looked" }),
};

function rig(script: readonly (readonly StreamEvent[])[]) {
  const model = new Recording(script);
  const host = new SessionHost({
    defaultCwd: "/tmp/voice-turn",
    createAgent: () => {
      const permissions = new PermissionBroker();
      const agent = new Agent({
        model,
        tools: new ToolRegistry().register(freeTool),
        env,
        requestPermission: (req, options) => permissions.request(req, options),
      });
      return { agent, permissions };
    },
  });
  return { host, model };
}

/** The spoken line's presence on a request, and whether it reached the HISTORY. */
const hasLine = (request: ChatRequest | undefined): boolean =>
  request?.messages.some((m) => m.role === "system" && m.content === VOICE_SPOKEN_LINE) === true;
const historyHasLine = (messages: readonly ChatMessage[]): boolean =>
  messages.some((m) => m.role === "system" && m.content === VOICE_SPOKEN_LINE);

describe("T6 a voice turn on the daemon (§4 + F10)", () => {
  test('`reasoning:"off"`: reasoning off + the line before the tool call, neither after it', async () => {
    const r = rig([call("c1", "look"), say("spoken answer")]);
    const { hosted } = r.host.open({ create: true }, { send: () => {} });
    hosted.prompt("T1", [{ type: "text", text: "ciao" }], undefined, undefined, {
      reasoning: "off",
    });
    await until(() => r.model.calls.length >= 2);

    const [first, second] = r.model.calls;
    // (a) and (b) on the voice turn's first round.
    expect(first?.reasoning).toBe("off");
    expect(hasLine(first)).toBe(true);
    // The window closed at the first tool call: no `reasoning` any more, the
    // line still there (the person is still listening).
    expect(second?.reasoning).toBeUndefined();
    expect(hasLine(second)).toBe(true);

    // F10: the stored history never carries the line.
    expect(historyHasLine(hosted.snapshotPage().messages)).toBe(false);
    void hosted;
  });

  test('`reasoning:"keep"`: the line, and NO reasoning field (the switch is honoured)', async () => {
    // Mutation: ignore `keep` and always send "off" → red.
    const r = rig([say("spoken answer")]);
    const { hosted } = r.host.open({ create: true }, { send: () => {} });
    hosted.prompt("T2", [{ type: "text", text: "ciao" }], undefined, undefined, {
      reasoning: "keep",
    });
    await until(() => r.model.calls.length >= 1);
    expect(r.model.calls[0]?.reasoning).toBeUndefined();
    expect(hasLine(r.model.calls[0])).toBe(true);
    void hosted;
  });

  test("a turn with no voice is untouched: no line, no reasoning", async () => {
    const r = rig([say("typed answer")]);
    const { hosted } = r.host.open({ create: true }, { send: () => {} });
    hosted.prompt("T3", [{ type: "text", text: "typed" }]);
    await until(() => r.model.calls.length >= 1);
    expect(r.model.calls[0]?.reasoning).toBeUndefined();
    expect(hasLine(r.model.calls[0])).toBe(false);
    void hosted;
  });

  test("a voice `enqueue` marks the REST of its turn, and reopens the window at its round", async () => {
    // The turn starts TYPED (no line, no reasoning); the person then speaks
    // mid-turn. Its own `reasoning:"off"` reopens the window at that round.
    const r = rig([call("c1", "look"), say("typed answer"), say("spoken answer")]);
    const { hosted } = r.host.open({ create: true }, { send: () => {} });
    hosted.prompt("T4", [{ type: "text", text: "go" }]);
    await until(() => r.model.calls.length >= 1);
    expect(hasLine(r.model.calls[0])).toBe(false);
    hosted.enqueue("e1", "T4", "and also", { reasoning: "off" });
    await until(() => r.model.calls.length >= 2);

    const after = r.model.calls[1];
    expect(after?.reasoning).toBe("off");
    expect(hasLine(after)).toBe(true);
    // Still never in the history (F10) — the steer's TEXT is, of course.
    expect(historyHasLine(hosted.snapshotPage().messages)).toBe(false);
    expect(hosted.snapshotPage().messages.some((m) => m.content === "and also")).toBe(true);
  });
});

describe("T6 over the wire: the fields reach the daemon from a real client frame", () => {
  /** A raw JSON-RPC client on the daemon's channel pair (the `clear-connection` rig). */
  async function client(script: readonly (readonly StreamEvent[])[]) {
    const model = new Recording(script);
    const host = new SessionHost({
      defaultCwd: "/tmp/voice-turn-wire",
      createAgent: () => ({
        agent: new Agent({
          model,
          tools: new ToolRegistry().register(freeTool),
          env,
          requestPermission: (req, options) => new PermissionBroker().request(req, options),
        }),
        permissions: new PermissionBroker(),
      }),
    });
    const [d, c] = createChannelPair();
    new Connection(d, host);
    const peer = new RpcPeer(c, {
      onNotification: () => {},
      onRequest: async (method) => {
        throw new Error(`unexpected request ${method}`);
      },
    });
    await peer.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { streaming: true },
    });
    await peer.request("session/open", { sessionId: "S", create: true });
    return { peer, model };
  }

  test("session/prompt{voice} is not stripped before the daemon reads it", async () => {
    // Mutation: drop `params.voice` in `Connection.prompt` → red (the strip
    // schema would otherwise look fine while the profile silently vanished).
    const { peer, model } = await client([say("spoken")]);
    await peer.request("session/prompt", {
      sessionId: "S",
      turnId: "t1",
      content: [{ type: "text", text: "ciao" }],
      voice: { reasoning: "off" },
    });
    await until(() => model.calls.length >= 1);
    expect(model.calls[0]?.reasoning).toBe("off");
    expect(hasLine(model.calls[0])).toBe(true);
    peer.close();
  });

  test("session/enqueue{voice} marks the rest of the turn", async () => {
    const { peer, model } = await client([call("c1", "look"), say("typed"), say("spoken")]);
    await peer.request("session/prompt", {
      sessionId: "S",
      turnId: "t2",
      content: [{ type: "text", text: "go" }],
    });
    await until(() => model.calls.length >= 1);
    expect(hasLine(model.calls[0])).toBe(false);
    await peer.request("session/enqueue", {
      sessionId: "S",
      id: "e1",
      turnId: "t2",
      text: "and also",
      voice: { reasoning: "keep" },
    });
    await until(() => model.calls.length >= 2);
    // `keep`: the line marks it a voice turn, and the reasoning stays configured.
    expect(hasLine(model.calls[1])).toBe(true);
    expect(model.calls[1]?.reasoning).toBeUndefined();
    peer.close();
  });
});

describe("T6 the max_iterations final report still speaks (round-1 LOW)", () => {
  test("a voice steer drained right before the report makes the report a voice turn", async () => {
    // The last allowed round calls a tool, so the loop spends its cap and builds
    // the final report's request BY HAND (it cannot go through `voiceRequest`:
    // it offers no tools and carries no `reasoning`). A voice steer that landed
    // during that last round is drained into the report's messages — and until
    // now the report never consumed the voice mark, so it answered unspeakably
    // and with no spoken-style line. Fix: the report consumes the mark.
    const model = new Recording([call("c1", "look"), say("the report")]);
    const host = new SessionHost({
      defaultCwd: "/tmp/voice-turn-cap",
      createAgent: () => ({
        agent: new Agent({
          model,
          tools: new ToolRegistry().register(freeTool),
          env,
          requestPermission: (req, options) => new PermissionBroker().request(req, options),
          maxIterations: 1,
        }),
        permissions: new PermissionBroker(),
      }),
    });
    const { hosted } = host.open({ create: true }, { send: () => {} });
    // A TYPED turn: no voice profile of its own, so only the steer can mark it.
    hosted.prompt("T5", [{ type: "text", text: "go" }]);
    await until(() => model.calls.length >= 1);
    hosted.enqueue("e1", "T5", "and also", { reasoning: "keep" });
    await until(() => model.calls.length >= 2);

    const report = model.calls[1];
    // Its steer's text is there (the drain), so the mark must be too.
    expect(report?.messages.some((m) => m.role === "user" && m.content === "and also")).toBe(true);
    expect(hasLine(report)).toBe(true);
    // Still never in the history (F10).
    expect(historyHasLine(hosted.snapshotPage().messages)).toBe(false);
  });
});
