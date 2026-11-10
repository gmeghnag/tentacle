/**
 * docs/feat/history-validity-invariant.md at the daemon: the notice is sent
 * ONCE per loaded session (T6c), and a turn that fails still persists an
 * answered tool call (T5g).
 *
 * The model is a fake llama.cpp-shaped server (500 on any request holding a
 * non-object call argument), reached through the real `OpenAIProvider`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import type {
  ChatMessage,
  ExecutionEnvironment,
  ModelProvider,
  StreamEvent,
  Tool,
  ToolResult,
} from "@tentacle/core";
import { PermissionBroker } from "@tentacle/core";
import { PROTOCOL_VERSION } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { z } from "zod";
import { OpenAIProvider } from "../../providers/src/index.ts";

const BAD = '{"path":"a.txt","content":"line1\nunterminated';

/** A provider that replays a fixed script, one round per call. */
class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  private turn = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(): AsyncIterable<StreamEvent> {
    for (const event of this.script[this.turn++] ?? [{ type: "done" }]) {
      yield event;
    }
  }
}

const env: ExecutionEnvironment = {
  id: "noop",
  async exec() {
    return { stdout: "", stderr: "", exitCode: 0 };
  },
  async readFile() {
    return "";
  },
  async writeFile() {},
};

const fsWrite: Tool<{ path: string; content: string }> = {
  name: "fs_write",
  description: "write a file",
  inputSchema: z.object({ path: z.string(), content: z.string() }),
  permission: "none",
  async execute(input) {
    return { content: `wrote ${input.path} (${input.content.length} bytes)` };
  },
};

/** llama.cpp's complaint for any request whose call arguments are not an object. */
function poisonIndex(body: string): number | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const messages = (parsed as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) {
    return undefined;
  }
  for (const [index, m] of messages.entries()) {
    const calls = (m as { tool_calls?: unknown }).tool_calls;
    if (!Array.isArray(calls)) {
      continue;
    }
    for (const c of calls) {
      const args = (c as { function?: { arguments?: unknown } }).function?.arguments;
      if (typeof args !== "string") {
        return index;
      }
      let value: unknown;
      try {
        value = JSON.parse(args);
      } catch {
        return index;
      }
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return index;
      }
    }
  }
  return undefined;
}

interface FakeLlama {
  readonly baseURL: string;
  stop(): void;
}

/** A llama.cpp-shaped `/v1` endpoint: SSE text, or 500 on a poisoned request. */
function fakeLlama(replies: readonly string[]): FakeLlama {
  let turn = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.text();
      if (poisonIndex(body) !== undefined) {
        return Response.json(
          { error: { code: 500, message: "Failed to parse tool call arguments as JSON" } },
          { status: 500 },
        );
      }
      const url = new URL(req.url);
      if (url.pathname.endsWith("/chat/completions")) {
        const text = replies[turn++] ?? "ok";
        const frame = { choices: [{ delta: { content: text } }] };
        const end = { choices: [{ delta: {}, finish_reason: "stop" }] };
        const sse = [frame, end].map((c) => `data: ${JSON.stringify(c)}\n\n`).join("");
        return new Response(sse, { headers: { "content-type": "text/event-stream" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { baseURL: `http://localhost:${server.port}/v1`, stop: () => server.stop(true) };
}

const INIT = { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { streaming: true } };

interface Harness {
  readonly baseURL: string;
  open(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  prompt(sessionId: string, text: string): Promise<unknown>;
  repairs(): { invalidArguments: number }[];
  untilTurnEnd(): Promise<void>;
  close(): void;
}

/** A SessionHost over the fake model, attached through a real Connection. */
async function harness(fake: FakeLlama): Promise<Harness> {
  const { Connection } = await import("../src/connection.ts");
  const { SessionHost } = await import("../src/session-host.ts");
  const { RpcPeer, createChannelPair } = await import("@tentacle/transport");

  const host = new SessionHost({
    defaultCwd: "/tmp/history-validity-daemon",
    createAgent: () => {
      const permissions = new PermissionBroker();
      const tools = new ToolRegistry().register(fsWrite);
      const agent = new Agent({
        model: new OpenAIProvider({ baseURL: fake.baseURL, model: "fake" }),
        tools,
        env,
        requestPermission: (req, options) => permissions.request(req, options),
      });
      return { agent, permissions };
    },
  });
  const [d, c] = createChannelPair();
  new Connection(d, host);
  const updates: { type: string; [k: string]: unknown }[] = [];
  const client = new RpcPeer(c, {
    onNotification: (method, params) => {
      if (method === "session/update") {
        const u = (params as { update: { type: string } }).update;
        updates.push(u as never);
      }
    },
    onRequest: async (method) => {
      throw new Error(`unexpected request ${method}`);
    },
  });
  await client.request("initialize", INIT);
  let turn = 0;
  return {
    baseURL: fake.baseURL,
    open: (params) => client.request("session/open", params) as Promise<Record<string, unknown>>,
    prompt: (sessionId, text) => {
      turn++;
      return client.request("session/prompt", {
        sessionId,
        turnId: `t${turn}`,
        content: [{ type: "text", text }],
      });
    },
    repairs: () => {
      return updates
        .filter((u) => u.type === "history_repaired")
        .map((u) => ({ invalidArguments: u.invalidArguments as number }));
    },
    untilTurnEnd: async () => {
      const deadline = Date.now() + 3000;
      while (!updates.some((u) => u.type === "turn_end")) {
        if (Date.now() > deadline) {
          throw new Error("timed out waiting for turn_end");
        }
        await Bun.sleep(2);
      }
    },
    close: () => {
      host.close("S");
    },
  };
}

describe("T6c: the notice is sent once per loaded session", () => {
  test("two prompts over a poisoned history give exactly one history_repaired", async () => {
    const fake = fakeLlama(["first", "second"]);
    const h = await harness(fake);
    try {
      const poisoned: ChatMessage[] = [
        { role: "user", content: "write a file" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "fs_write", arguments: BAD }],
        },
        { role: "tool", content: "invalid JSON arguments for fs_write", toolCallId: "c1" },
      ];
      await h.open({ sessionId: "S", create: true, messages: poisoned });
      await h.prompt("S", "hey");
      await h.untilTurnEnd();
      await h.prompt("S", "again");
      await h.untilTurnEnd();
      const seen = h.repairs();
      expect(seen).toHaveLength(1);
      expect(seen[0]?.invalidArguments).toBe(1);
    } finally {
      h.close();
      fake.stop();
    }
  });
});

describe("T6c: nothing to report means no notice (F1, F22)", () => {
  test("a valid history gives zero history_repaired", async () => {
    const fake = fakeLlama(["a", "b"]);
    const h = await harness(fake);
    try {
      await h.open({ sessionId: "S", create: true });
      await h.prompt("S", "hello");
      await h.untilTurnEnd();
      await h.prompt("S", "again");
      await h.untilTurnEnd();
      expect(h.repairs()).toEqual([]);
    } finally {
      h.close();
      fake.stop();
    }
  });

  test('a history whose only issue is "" arguments gives zero (it is no error)', async () => {
    const fake = fakeLlama(["a", "b"]);
    const h = await harness(fake);
    try {
      const empty: ChatMessage[] = [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "fs_write", arguments: "" }],
        },
        { role: "tool", content: "ok", toolCallId: "c1" },
      ];
      await h.open({ sessionId: "S", create: true, messages: empty });
      await h.prompt("S", "hello");
      await h.untilTurnEnd();
      expect(h.repairs()).toEqual([]);
    } finally {
      h.close();
      fake.stop();
    }
  });
});

describe("T5g: a failed turn persists an ANSWERED call (Part B at the daemon)", () => {
  test("the persisted log holds 'Not run', then the failed-turn note; a reload adds no second answer", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { Connection } = await import("../src/connection.ts");
    const { SessionHost } = await import("../src/session-host.ts");
    const { LogSessionStore } = await import("../src/session-log-store.ts");
    const { SessionPersister } = await import("../src/session-persister.ts");
    const { RpcPeer, createChannelPair } = await import("@tentacle/transport");

    const NOT_RUN =
      "Not run: the turn stopped unexpectedly before this call started. Ask again if it is still needed.";
    const dir = await mkdtemp(join(tmpdir(), "hv-daemon-"));
    const persister = new SessionPersister({
      store: new LogSessionStore(dir),
      cwd: "/tmp/history-validity-daemon",
      model: "fake",
      onError: () => {},
    });
    const model = new ScriptedProvider([
      [{ type: "tool_call", toolCall: { id: "c1", name: "askme", arguments: "{}" } }],
    ]);
    const askme: Tool<Record<string, never>> = {
      name: "askme",
      description: "asks",
      inputSchema: z.object({}),
      permission: "ask",
      async execute() {
        return { content: "ran" };
      },
    };
    const base = {
      defaultCwd: "/tmp/history-validity-daemon",
      persister,
    };
    const createAgent = () => {
      const permissions = new PermissionBroker();
      // The requester itself throws: the turn ends as an error.
      const agent = new Agent({
        model,
        tools: new ToolRegistry().register(askme),
        env,
        requestPermission: async () => {
          throw new Error("authorize boom");
        },
      });
      return { agent, permissions };
    };
    try {
      const host = new SessionHost({ ...base, createAgent });
      const [d, c] = createChannelPair();
      new Connection(d, host);
      const client = new RpcPeer(c, {
        onNotification: () => {},
        onRequest: async (method) => {
          throw new Error(`unexpected request ${method}`);
        },
      });
      await client.request("initialize", INIT);
      await client.request("session/open", { sessionId: "S", create: true });
      await client.request("session/prompt", {
        sessionId: "S",
        turnId: "t1",
        content: [{ type: "text", text: "go" }],
      });
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const loaded = await persister.load("S");
        if (loaded.ok && loaded.record.messages.some((m) => m.role === "tool")) {
          break;
        }
        await Bun.sleep(5);
      }

      const loaded = await persister.load("S");
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      const messages = loaded.record.messages;
      const answer = messages.find((m) => m.role === "tool" && m.toolCallId === "c1");
      expect(answer?.content).toBe(NOT_RUN);
      // `closeFailedTurn`'s assistant note follows, so the roles stay valid.
      expect(messages.at(-1)?.role).toBe("assistant");

      // A reload adds no second answer: `labelUnansweredCalls` finds nothing.
      const { reconcileOnReload } = await import("../src/persisted-session.ts");
      const healed = reconcileOnReload({ ...loaded.record, messages });
      expect(healed.messages.filter((m) => m.toolCallId === "c1")).toHaveLength(1);
    } finally {
      await persister.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("T4a: the store keeps the model's bytes; only the VIEW is repaired", () => {
  test("the log on disk holds the invalid arguments verbatim after a real turn", async () => {
    const { mkdtemp, readdir, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { Connection } = await import("../src/connection.ts");
    const { SessionHost } = await import("../src/session-host.ts");
    const { LogSessionStore } = await import("../src/session-log-store.ts");
    const { SessionPersister } = await import("../src/session-persister.ts");
    const { repairHistory } = await import("@tentacle/core");
    const { RpcPeer, createChannelPair } = await import("@tentacle/transport");

    const dir = await mkdtemp(join(tmpdir(), "hv-t4a-"));
    const persister = new SessionPersister({
      store: new LogSessionStore(dir),
      cwd: "/tmp/history-validity-daemon",
      model: "fake",
      onError: () => {},
    });
    const model = new ScriptedProvider([
      [{ type: "tool_call", toolCall: { id: "c1", name: "fs_write", arguments: BAD } }],
      [{ type: "text", delta: "done" }],
    ]);
    try {
      const host = new SessionHost({
        defaultCwd: "/tmp/history-validity-daemon",
        persister,
        createAgent: () => {
          const permissions = new PermissionBroker();
          const agent = new Agent({
            model,
            tools: new ToolRegistry().register(fsWrite),
            env,
            requestPermission: (req, options) => permissions.request(req, options),
          });
          return { agent, permissions };
        },
      });
      const [d, c] = createChannelPair();
      new Connection(d, host);
      const client = new RpcPeer(c, {
        onNotification: () => {},
        onRequest: async (method) => {
          throw new Error(`unexpected request ${method}`);
        },
      });
      await client.request("initialize", INIT);
      await client.request("session/open", { sessionId: "S", create: true });
      await client.request("session/prompt", {
        sessionId: "S",
        turnId: "t1",
        content: [{ type: "text", text: "write a file" }],
      });
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const loaded = await persister.load("S");
        if (loaded.ok && loaded.record.messages.some((m) => m.role === "tool")) {
          break;
        }
        await Bun.sleep(5);
      }
      await persister.stop();

      // On disk: the model's ORIGINAL bytes, stored verbatim (§7 "never
      // silently lost"): the log is the record of what happened.
      const files = (await readdir(dir, { recursive: true })).filter((f) => f.endsWith(".jsonl"));
      expect(files.length).toBeGreaterThan(0);
      const raw = await readFile(join(dir, files[0] ?? ""), "utf8");
      expect(raw).toContain("unterminated");

      // A reload's projection keeps them, and repairs only the model's copy.
      const reader = new SessionPersister({
        store: new LogSessionStore(dir),
        cwd: "/tmp/history-validity-daemon",
        model: "fake",
        onError: () => {},
      });
      const loaded = await reader.load("S");
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      const stored = loaded.record.messages.flatMap((m) => m.toolCalls ?? []);
      expect(stored.find((c) => c.id === "c1")?.arguments).toBe(BAD);
      const view = repairHistory(loaded.record.messages).messages.flatMap((m) => m.toolCalls ?? []);
      expect(view.find((c) => c.id === "c1")?.arguments).not.toBe(BAD);
      await reader.stop();
      host.close("S");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
