import { describe, expect, test } from "bun:test";
import { Agent, type AgentEvent } from "@tentacle/agent";
import {
  type ChatMessage,
  type ExecutionEnvironment,
  PermissionBroker,
  type Tool,
} from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import { Method } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { type DuplexChannel, createChannelPair } from "@tentacle/transport";
import { z } from "zod";
import type { SessionEvent } from "../src/mapping.ts";
import { RemoteClient } from "../src/remote-client.ts";
import type { SessionActivity } from "../src/remote-session.ts";
import { GatedModel, type Step, done, t, until } from "./support/fakes.ts";

// docs/feat/context-reset-barrier.md (slice 2): a `history_replaced{context_reset}`
// arrives INSIDE a turn. The client resyncs on it and the turn goes on: the
// screen is kept (a `context_reset` event with the new history, never a
// `history_reset`), and the rest of the turn still reaches it. The agent side
// is slice 3: a fake agent replaces the history and yields `context_reset`.

const CWD = "/tmp/context-reset";
const env = {} as ExecutionEnvironment;

const FRESH: readonly ChatMessage[] = [
  { role: "system", content: "FRESH SYSTEM" },
  { role: "user", content: "RESTART PROMPT" },
];

const probe: Tool = {
  name: "reset_probe",
  description: "probe",
  inputSchema: z.object({}).passthrough(),
  permission: "none",
  execute: async () => ({ content: "reset done" }),
};

/** Fakes slice 3's commit: at the probe's commit, replace in place + `context_reset`, no await between. */
class ResettingAgent extends Agent {
  override async *runMessages(
    ...args: Parameters<Agent["runMessages"]>
  ): AsyncGenerator<AgentEvent> {
    const messages = args[0];
    let probed = false;
    for await (const event of super.runMessages(...args)) {
      if (event.type === "tool_result" && event.name === "reset_probe") {
        probed = true;
      }
      if (probed && event.type === "history_commit") {
        probed = false;
        messages.length = 0;
        messages.push(...FRESH.map((m) => ({ ...m })));
        yield { type: "context_reset", messages: [...messages] };
        continue;
      }
      yield event;
    }
  }
}

const probeCall: Step = {
  kind: "event",
  event: { type: "tool_call", toolCall: { id: "c1", name: "reset_probe", arguments: "{}" } },
};

/**
 * One daemon; round 1 calls the probe, round 2 (on the fresh history)
 * answers; each round first waits at a gate (`next()` opens the one the model
 * waits at). `dial` connects a client whose `session/snapshot` requests can
 * be HELD (the turn then ends behind the snapshot's cut).
 */
function daemon() {
  const model = new GatedModel([
    [{ kind: "gate" }, probeCall, done],
    [{ kind: "gate" }, t("after "), t("the reset"), done],
  ]);
  const next = async (): Promise<void> => {
    await until(() => model.waiting);
    model.open();
  };
  const host = new SessionHost({
    defaultCwd: CWD,
    createAgent: () => {
      const permissions = new PermissionBroker();
      const agent = new ResettingAgent({
        model,
        tools: new ToolRegistry().register(probe),
        env,
        requestPermission: (req) => permissions.request(req),
      });
      return { agent, permissions };
    },
  });
  const dial = () => {
    const [d, c] = createChannelPair();
    new Connection(d, host);
    let holding = false;
    const held: string[] = [];
    const link: DuplexChannel = {
      send: (data) => {
        const frame = JSON.parse(data) as { method?: string };
        if (holding && frame.method === Method.Snapshot) {
          held.push(data);
          return;
        }
        c.send(data);
      },
      close: () => c.close(),
      setOnMessage: (h) => c.setOnMessage(h),
      setOnClose: (h) => c.setOnClose(h),
    };
    const client = new RemoteClient(link, new PermissionBroker());
    return {
      client,
      holdSnapshots: () => {
        holding = true;
      },
      held: () => held.length,
      releaseSnapshots: () => {
        holding = false;
        for (const data of held.splice(0)) c.send(data);
      },
    };
  };
  return { host, next, dial };
}

/** Collect `events` in the background; `ended` resolves "ended", the error, or "hung". */
function collect(events: AsyncIterable<SessionEvent>, ms = 3000) {
  const into: SessionEvent[] = [];
  const ended = Promise.race([
    (async () => {
      for await (const e of events) into.push(e);
      return "ended";
    })().catch((e: unknown) => e),
    new Promise((r) => setTimeout(() => r("hung"), ms)),
  ]);
  return { into, ended };
}

/** The events as one line each: the type, plus what tells them apart. */
const shape = (events: readonly SessionEvent[]): string[] =>
  events.map((e) => {
    if (e.type === "text") return `text:${e.delta}`;
    if (e.type === "tool_result") return `tool_result:${e.name}`;
    if (e.type === "turn_end") return `turn_end:${e.reason}`;
    if (e.type === "context_reset" || e.type === "history_reset") {
      return `${e.type}:${e.messages.map((m) => `${m.role}:${m.content}`).join("|")}`;
    }
    return e.type;
  });

describe("context_reset over the real daemon (the mid-turn barrier)", () => {
  test("an own turn live at the cut: the screen is kept (context_reset, never history_reset) and the rest of the turn arrives", async () => {
    const d = daemon();
    const a = d.dial();
    await a.client.initialize();
    const session = a.client.newSession(undefined, crypto.randomUUID());
    const run = collect(session.send("go"));
    await d.next();
    await until(() => run.into.some((e) => e.type === "context_reset"));
    await d.next();
    expect(await run.ended).toBe("ended");
    expect(shape(run.into)).toEqual([
      "tool_start",
      "tool_result:reset_probe",
      "context_reset:system:FRESH SYSTEM|user:RESTART PROMPT",
      "text:after ",
      "text:the reset",
      "turn_end:end_turn",
    ]);
    a.client.close();
  });

  test("an own turn that ended behind the snapshot's cut: the new history, then its REAL end (learned from the daemon, never guessed)", async () => {
    const d = daemon();
    const a = d.dial();
    await a.client.initialize();
    const sid = crypto.randomUUID();
    const session = a.client.newSession(undefined, sid);
    const run = collect(session.send("go"));
    await until(() => d.host.get(sid) !== undefined);
    a.holdSnapshots();
    await d.next();
    await until(() => a.held() > 0);
    await d.next();
    // The turn ends daemon-side while this client waits for its snapshot.
    await until(() => d.host.get(sid)?.running === false);
    a.releaseSnapshots();
    expect(await run.ended).toBe("ended");
    expect(shape(run.into)).toEqual([
      "tool_start",
      "tool_result:reset_probe",
      "context_reset:system:FRESH SYSTEM|user:RESTART PROMPT|assistant:after the reset",
      "turn_end:end_turn",
    ]);
    a.client.close();
  });

  test("another device's turn: the reset reaches its foreign turn the same way (kept screen, then the rest)", async () => {
    const d = daemon();
    const a = d.dial();
    const b = d.dial();
    await a.client.initialize();
    await b.client.initialize();
    const sid = crypto.randomUUID();
    const sa = a.client.newSession(undefined, sid);
    const own = collect(sa.send("go"));
    await until(() => d.host.get(sid)?.running === true);
    // B attaches while A's turn waits for its first round: a foreign turn.
    const sb = b.client.newSession(undefined, sid, undefined, { attach: {} });
    const activities: SessionActivity[] = [];
    sb.watch((x) => activities.push(x));
    await sb.open();
    await until(() => activities.some((x) => x.kind === "turn"));
    const turn = activities.find((x) => x.kind === "turn");
    if (turn?.kind !== "turn") throw new Error("no foreign turn");
    const foreign = collect(turn.events);
    await d.next();
    await until(() => foreign.into.some((e) => e.type === "context_reset"));
    await d.next();
    expect(await own.ended).toBe("ended");
    expect(await foreign.ended).toBe("ended");
    expect(shape(foreign.into)).toEqual([
      "user_message",
      "tool_start",
      "tool_result:reset_probe",
      "context_reset:system:FRESH SYSTEM|user:RESTART PROMPT",
      "text:after ",
      "text:the reset",
      "turn_end:end_turn",
    ]);
    a.client.close();
    b.client.close();
  });
});
