/**
 * docs/feat/logs-cmd.md sub-task 2 (`logs-watch`) — the CLI half: the live
 * update→event map (`updateEvents`), `--only` over the live vocabulary, and
 * `logs -f <uid> --connect <url>` end to end over an in-memory channel pair
 * (no socket). Each test names the mutation that turns it red (AGENTS §9).
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
import { PROTOCOL_VERSION, type SessionUpdate, WATCH_CATEGORIES } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { ErrorCode, RpcError } from "@tentacle/transport";
import { Connection } from "../../daemon/src/connection.ts";
import { SessionHost } from "../../daemon/src/session-host.ts";
import { main } from "../src/index.ts";
import {
  LOG_CATEGORIES,
  categoriesOf,
  filterEvents,
  formatEvent,
  jsonLine,
  updateEvents,
} from "../src/log-events.ts";

const UID = "025e6a9d-d332-4a45-9051-8a957fa31811";

const env: ExecutionEnvironment = {
  id: "noop",
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
};

/** A model that streams text, then asks nothing and ends: the simplest live turn. */
class Talker implements ModelProvider {
  readonly id = "talker";
  constructor(
    private readonly chunks: readonly string[] = ["hello ", "world"],
    private readonly fail = false,
  ) {}
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    if (this.fail) {
      throw new Error("provider exploded");
    }
    for (const delta of this.chunks) {
      yield { type: "text", delta };
    }
    yield { type: "done" };
  }
}

const events = (update: SessionUpdate): ReturnType<typeof updateEvents> =>
  updateEvents(update, UID, 1000);

describe("the vocabulary", () => {
  test("the CLI's --only names ARE the daemon's watch categories (one word, one meaning)", () => {
    // Mutation: rename a category on one side → `--only ask` filters the file
    // half but the daemon silently queues everything (or refuses).
    expect([...LOG_CATEGORIES]).toEqual([...WATCH_CATEGORIES]);
  });
});

describe("updateEvents: the live half of the ONE vocabulary", () => {
  test("streamed text becomes a `text` event with its length", () => {
    // Mutation: drop the `agent_message_chunk` arm → live text is invisible to
    // `logs -f`, the whole point of sub-task 2.
    const [event] = events({
      type: "agent_message_chunk",
      content: { type: "text", text: "hi" },
    });
    expect(event).toEqual({ v: 1, ts: 1000, session: UID, type: "text", text: "hi", chars: 2 });
    expect(categoriesOf(event as never)).toEqual(["text"]);
  });

  test("an ask carries its tool, title and the options a person would choose", () => {
    // Mutation: print only the tool name → the follower cannot tell what the
    // person is being asked (nor which answers exist).
    const [event] = events({
      type: "permission_request",
      requestId: "r1",
      toolCallId: "c1",
      tool: "shell",
      title: "run rm -rf build",
      options: [
        { optionId: "o1", name: "Allow once", kind: "allow_once" },
        { optionId: "o2", name: "Deny", kind: "reject_once" },
      ],
    });
    expect(event).toMatchObject({
      type: "ask",
      requestId: "r1",
      tool: "shell",
      options: ["Allow once", "Deny"],
    });
    expect(categoriesOf(event as never)).toEqual(["ask"]);
  });

  test("a failed turn's end is `turn` AND `error`, and carries the message", () => {
    // Mutation: `turn_end` → `turn` only, or drop `error` → `--only error`
    // misses the failure, or shows it with no reason.
    const [event] = events({
      type: "turn_end",
      turnId: "t1",
      stopReason: "error",
      error: { message: "provider exploded" },
    });
    expect(event).toMatchObject({
      type: "turn_end",
      stopReason: "error",
      error: "provider exploded",
    });
    expect(categoriesOf(event as never)).toEqual(["turn", "error"]);
  });

  test("a closed session is an `error` event (the stream stopping IS the failure)", () => {
    // Mutation: map `session_closed` to `notice` → an `--only error` follower
    // sits on a stream that already ended.
    const [event] = events({ type: "session_closed", reason: "closed" });
    expect(event).toMatchObject({ type: "closed", reason: "closed" });
    expect(categoriesOf(event as never)).toEqual(["error"]);
  });

  test("state-only updates produce no line (a plan, a usage meter, a queue state)", () => {
    // Mutation: emit a `notice` per update → a follower's screen fills with a
    // line per token meter tick.
    expect(events({ type: "plan", entries: [] })).toEqual([]);
    expect(events({ type: "agent_usage", promptTokens: 1, completionTokens: 2 })).toEqual([]);
    expect(events({ type: "queued", entries: [], returned: [] })).toEqual([]);
  });

  test("a lost count belongs to every `--only` (losing it is the bug owner Q3 forbids)", () => {
    // Mutation: give `lost` one category → `--only ask` hides the fact that
    // asks were dropped, which is exactly when it matters.
    const lost = { v: 1, ts: 1000, session: UID, type: "lost", count: 7 } as const;
    for (const category of ["ask", "error", "turn", "text"] as const) {
      expect(filterEvents([lost], [category])).toHaveLength(1);
    }
  });

  test("text mode sanitises a pod's escapes; `--json` escapes C1", () => {
    // Mutation: print the raw text → an ESC from a pod's model reaches the
    // terminal (AGENTS §7: a pod is not trusted).
    const [event] = events({
      type: "agent_message_chunk",
      content: { type: "text", text: "\u001b[31mred\u001b[0m\u009b" },
    });
    const line = formatEvent(event as never);
    expect(line).not.toContain("\u001b");
    expect(line).not.toContain("\u009b");
    const json = jsonLine(event);
    expect(json).not.toContain("\u009b");
    expect(json).toContain("\\u009b");
  });
});

/** A daemon (a real `SessionHost`+`Connection`) behind an in-memory channel pair. */
function daemon(model: ModelProvider = new Talker()) {
  const host = new SessionHost({
    defaultCwd: "/tmp/logs-watch-cli",
    createAgent: () => {
      const permissions = new PermissionBroker();
      const agent = new Agent({
        model,
        tools: new ToolRegistry(),
        env,
        requestPermission: (req, options) => permissions.request(req, options),
      });
      return { agent, permissions };
    },
  });
  const [daemonCh, clientCh] = createChannelPair();
  new Connection(daemonCh, host);
  return { host, clientCh };
}

interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/** `main(["logs", …])`, dialing the in-memory channel instead of a socket. */
async function logs(
  args: string[],
  clientCh: ReturnType<typeof daemon>["clientCh"],
  seams: { signal?: AbortSignal } = {},
): Promise<Run> {
  let out = "";
  let err = "";
  const code = await main(["bun", "cli", "logs", ...args], {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
    terminal: { stdin: false, stdout: false },
    colour: false,
    logsDial: () => async () => clientCh,
    ...(seams.signal !== undefined ? { logsSignal: seams.signal } : {}),
  });
  return { code, out, err };
}

/** Open a session on the daemon and run one turn (the way another client would). */
async function session(model: ModelProvider = new Talker()): Promise<ReturnType<typeof daemon>> {
  const d = daemon(model);
  const client = new RpcPeer(d.clientCh, { onNotification: () => {}, onRequest: async () => ({}) });
  await client.request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { streaming: true },
  });
  await client.request("session/open", { sessionId: UID, create: true });
  return d;
}

describe("logs -f --connect: the live follower", () => {
  test("it follows a running turn, prints its text, and ends 0 when the session closes", async () => {
    // Mutation: print only the file half's events (no `updateEvents`) → no
    // `text` line ever appears; or never read `ended` → the loop never stops.
    const d = await session();
    const [daemonCh, clientCh] = createChannelPair();
    // A second connection drives the turn (the "other TUI"), the follower watches.
    new (await import("../../daemon/src/connection.ts")).Connection(daemonCh, d.host);
    const driver = new RpcPeer(clientCh, { onNotification: () => {}, onRequest: async () => ({}) });
    await driver.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { streaming: true },
    });
    await driver.request("session/open", { sessionId: UID });
    // The follower's dial gets its own pair (the channel is one connection).
    const [fd, fc] = createChannelPair();
    new (await import("../../daemon/src/connection.ts")).Connection(fd, d.host);
    const run = logs([UID, "-f", "--connect", "ws://x", "--json"], fc);
    await new Promise((done) => setTimeout(done, 20));
    await driver.request("session/prompt", {
      sessionId: UID,
      turnId: "t1",
      content: [{ type: "text", text: "go" }],
    });
    // Let the turn stream, then close the session (the follower must exit 0).
    await new Promise((done) => setTimeout(done, 60));
    d.host.close(UID);
    const result = await run;
    expect(result.code).toBe(0);
    const lines = result.out
      .trim()
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as { type: string });
    const kinds = lines.map((line) => line.type);
    expect(kinds).toContain("turn_start");
    expect(kinds).toContain("text");
    expect(kinds).toContain("turn_end");
    expect(kinds).toContain("closed");
    expect(result.err).toContain("watching");
  }, 15_000);

  test("an unknown session is refused with the way out (never a revive)", async () => {
    // Mutation: fall back to `session/open{create:true}` → the follower creates
    // a session nobody asked for and follows an empty one.
    const d = await session();
    const [fd, fc] = createChannelPair();
    new (await import("../../daemon/src/connection.ts")).Connection(fd, d.host);
    const result = await logs(
      ["11111111-2222-3333-4444-555555555555", "-f", "--connect", "ws://x"],
      fc,
    );
    expect(result.code).toBe(1);
    expect(result.err).toContain("logs --tail");
    expect(d.host.get("11111111-2222-3333-4444-555555555555")).toBeUndefined();
  });

  test("a daemon too old for session/watch says so (MethodNotFound)", async () => {
    // Mutation: swallow the error → the follower spins on an empty stream with
    // no word about why nothing arrives.
    const [a, b] = createChannelPair();
    // A peer that answers EVERY request and knows no `session/watch`: an older daemon.
    new RpcPeer(a, {
      onNotification: () => {},
      onRequest: async (method) =>
        method === "initialize"
          ? {
              protocolVersion: PROTOCOL_VERSION,
              agentCapabilities: { tools: true, permissions: true },
            }
          : Promise.reject(new RpcError(ErrorCode.MethodNotFound, "unknown method: session/watch")),
    });
    const result = await logs([UID, "-f", "--connect", "ws://x"], b);
    expect(result.code).toBe(1);
    expect(result.err).toContain("too old");
  });

  test("--connect needs a uid, and --summary is refused with the way out", async () => {
    // Mutation: allow `--connect` with no uid → it guesses a remote "newest"
    // (another project's session). Or print a local summary of a remote read.
    const d = await session();
    const noUid = await logs(["-f", "--connect", "ws://x"], d.clientCh);
    expect(noUid.code).toBe(1);
    expect(noUid.err).toContain("needs a session id");
    const summary = await logs([UID, "--summary", "--connect", "ws://x"], d.clientCh);
    expect(summary.code).toBe(1);
    expect(summary.err).toContain("on that host");
  });

  test("a Ctrl+C (an aborted signal) stops the follow with exit 0 and unwatches", async () => {
    // Mutation: return 1 on abort, or skip `closeWatch` → a normal stop looks
    // like a failure, and the daemon keeps a watcher per Ctrl+C.
    const d = await session();
    const [fd, fc] = createChannelPair();
    new (await import("../../daemon/src/connection.ts")).Connection(fd, d.host);
    const abort = new AbortController();
    const run = logs([UID, "-f", "--connect", "ws://x"], fc, { signal: abort.signal });
    await new Promise((done) => setTimeout(done, 30));
    // The daemon holds exactly one watcher while we follow.
    const hosted = d.host.get(UID);
    abort.abort();
    const result = await run;
    expect(result.code).toBe(0);
    expect(hosted).toBeDefined();
  }, 15_000);

  test("--tail over --connect reads the daemon's committed log without attaching", async () => {
    // Mutation: use `session/open` to earn the log read → `--tail` attaches
    // (a follower becomes a client, and `ps` shows it).
    const d = await session();
    // One turn, so the committed log has entries to read.
    const [dd, dc] = createChannelPair();
    new (await import("../../daemon/src/connection.ts")).Connection(dd, d.host);
    const driver = new RpcPeer(dc, { onNotification: () => {}, onRequest: async () => ({}) });
    await driver.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { streaming: true },
    });
    await driver.request("session/open", { sessionId: UID });
    await driver.request("session/prompt", {
      sessionId: UID,
      turnId: "t1",
      content: [{ type: "text", text: "go" }],
    });
    await new Promise((done) => setTimeout(done, 60));
    const hosted = d.host.get(UID);
    const attachedBefore = hosted?.attachedCount ?? 0;

    const [fd, fc] = createChannelPair();
    new (await import("../../daemon/src/connection.ts")).Connection(fd, d.host);
    const result = await logs([UID, "--tail", "5", "--connect", "ws://x", "--json"], fc);
    expect(result.code).toBe(0);
    const kinds = result.out
      .trim()
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => (JSON.parse(line) as { type: string }).type);
    expect(kinds).toContain("turn_start");
    // Reading did not attach: the follower remains a watcher only.
    expect(hosted?.attachedCount).toBe(attachedBefore);
  }, 15_000);
});
