/**
 * docs/feat/agent-message-two-way.md T19–T21, end to end over the REAL
 * `createLocalRuntime` ↔ `Connection` stack (the stack of
 * `agent-message.e2e.test.ts`): a background child calls `agent_notify`, the
 * parent's conversation gets the note, and the laptop sees the notice. T20
 * holds the parent's turn open and proves the note arrives inside the SAME turn
 * (a steer, never a wake). T21 proves `subagents.twoWay: false` leaves the child
 * without the tool.
 *
 * Mutation (non-vacuity, AGENTS §9): wire the runner's `notify` to a fresh
 * `AgentJobs` instead of the session's → T19 fails (no parent listens there).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ChatRequest,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { Connection, LogSessionStore, SessionHost } from "@tentacle/daemon";
import { createChannelPair } from "@tentacle/transport";
import type { SessionController } from "@tentacle/tui";
import { type TentacleConfig, loadConfig } from "../src/config.ts";
import { createLocalRuntime } from "../src/local-runtime.ts";
import { SessionSaver } from "../src/session-saver.ts";
import { buildAgent } from "../src/wiring.ts";

const macro = () => new Promise((r) => setTimeout(r, 2));
async function settle(n = 14): Promise<void> {
  for (let i = 0; i < n; i++) await macro();
}
async function until(pred: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) {
      throw new Error("timed out");
    }
    await macro();
  }
}

/** A bounded wait that REPORTS, so a missing frame fails at the assertion below. */
async function seen(pred: () => boolean, ms = 2000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) {
      return false;
    }
    await macro();
  }
  return true;
}

const text = (delta: string): StreamEvent => ({ type: "text", delta });
const done: StreamEvent = { type: "done" };
const bgTask = (id: string): StreamEvent => ({
  type: "tool_call",
  toolCall: {
    id,
    name: "agent_task",
    arguments: JSON.stringify({ description: "map repo", prompt: "go", background: true }),
  },
});
const notify = (id: string, body: string): StreamEvent => ({
  type: "tool_call",
  toolCall: { id, name: "agent_notify", arguments: JSON.stringify({ text: body }) },
});
const message = (id: string, agentId: string, body: string): StreamEvent => ({
  type: "tool_call",
  toolCall: {
    id,
    name: "agent_message",
    arguments: JSON.stringify({ agent_id: agentId, text: body }),
  },
});

type Step = readonly StreamEvent[] | { gate: Promise<void>; events: readonly StreamEvent[] };

/** ONE provider for parent and children: the child's own prompt picks the script. */
class RoutedModel implements ModelProvider {
  readonly id = "routed";
  readonly parent: Step[] = [];
  readonly child: Step[] = [];
  readonly parentSeen: ChatRequest[] = [];
  readonly childSeen: ChatRequest[] = [];
  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const isChild = req.messages.some(
      (m) => m.role === "system" && String(m.content).includes("sub-agent"),
    );
    (isChild ? this.childSeen : this.parentSeen).push(req);
    const s = (isChild ? this.child : this.parent).shift() ?? [text("ok"), done];
    if ("gate" in s) {
      await s.gate;
      for (const e of s.events) yield e;
      return;
    }
    for (const e of s) yield e;
  }
}

const roles = (req: ChatRequest | undefined) =>
  (req?.messages ?? []).map((m) => `${m.role}:${String(m.content)}`);

let dir: string;
let configDir: string;
const saved = process.env.TENTACLE_CONFIG_DIR;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "two-way-e2e-"));
  configDir = join(dir, "config");
  await mkdir(configDir, { recursive: true });
  process.env.TENTACLE_CONFIG_DIR = configDir;
});

afterAll(async () => {
  if (saved === undefined) {
    Reflect.deleteProperty(process.env, "TENTACLE_CONFIG_DIR");
  } else {
    process.env.TENTACLE_CONFIG_DIR = saved;
  }
  await rm(dir, { recursive: true, force: true });
});

/** A config whose `subagents.twoWay` this test sets, loaded the CLI's way. */
async function config(twoWay: boolean): Promise<TentacleConfig> {
  await writeFile(
    join(configDir, "config.jsonc"),
    JSON.stringify({ subagents: { twoWay, maxParallel: 4 } }),
  );
  const loaded = await loadConfig({ configDir, cwd: dir, env: {} });
  expect(loaded.subagentsTwoWay).toBe(twoWay);
  return loaded;
}

/** The real stack: `buildAgent`'s own wiring, a real `Connection`, a real runtime. */
async function stack(twoWay: boolean) {
  const model = new RoutedModel();
  const cfg = await config(twoWay);
  const host = new SessionHost({
    defaultCwd: dir,
    createAgent: () => {
      const wired = buildAgent(cfg, { modelOverride: model });
      return {
        agent: wired.agent,
        permissions: wired.permissions,
        jobs: wired.jobs,
        ...(wired.agentJobs ? { agentJobs: wired.agentJobs } : {}),
      };
    },
  });
  const [daemonCh, clientCh] = createChannelPair();
  const connection = new Connection(daemonCh, host);
  const store = new LogSessionStore(join(dir, `sessions-${String(twoWay)}`));
  const runtime = await createLocalRuntime({
    channel: clientCh,
    disposeTransport: () => connection.close(),
    permissions: new PermissionBroker(),
    saver: new SessionSaver(store, () => {}),
    cwd: dir,
    model: "routed",
    resume: null,
  });
  return { model, runtime, connection };
}

/** What the TUI does with a turn's stream: drain it. */
async function drain(controller: SessionController, prompt: string): Promise<void> {
  for await (const _event of controller.send(prompt)) {
    // drain
  }
}

const toolNames = (req: ChatRequest | undefined) => (req?.tools ?? []).map((t) => t.name);

test("T21: twoWay off — the child is never offered agent_notify", async () => {
  const s = await stack(false);
  try {
    const controller = s.runtime.createSession();
    s.model.parent.push([bgTask("c1"), done]);
    s.model.child.push([text("report"), done]);
    await drain(controller, "go");
    await settle(8);
    expect(s.model.childSeen.length).toBeGreaterThan(0);
    expect(toolNames(s.model.childSeen[0])).not.toContain("agent_notify");
  } finally {
    s.runtime.dispose();
    s.connection.close();
  }
});

test("T19: a child's notify reaches the parent over RPC; a reply completes the round trip", async () => {
  const s = await stack(true);
  try {
    const controller = s.runtime.createSession();
    s.model.parent.push(
      [bgTask("c1"), done],
      [text("idle"), done],
      [message("m1", "sa-1", "go on"), done],
    );
    const childGate = Promise.withResolvers<void>();
    // Round 1 notifies; round 2 waits for the parent's `agent_message`.
    s.model.child.push([notify("n1", "found X"), done], {
      gate: childGate.promise,
      events: [text("THE REPORT"), done],
    });

    const notices: { agentId: string; text: string; wake: boolean }[] = [];
    controller.onSubagentNotify?.((n) => {
      notices.push({ agentId: n.agentId, text: n.text, wake: n.wake });
    });

    await drain(controller, "go");
    expect(await seen(() => notices.length > 0)).toBe(true);
    expect(notices[0]).toEqual({ agentId: "sa-1", text: "found X", wake: true });
    expect(toolNames(s.model.childSeen[0])).toContain("agent_notify");
    // The note asks for a wake, so the queue counts it for the next turn.
    expect(await controller.stayingRows?.()).toBeUndefined();

    // What the TUI does on a waking notice: a continuation turn.
    await drain(controller, "");
    expect(roles(s.model.parentSeen.at(-1)).join("\n")).toContain("[sub-agent sa-1 → you] found X");

    // The parent answers through task 8's tool; the child reads it.
    await drain(controller, "");
    expect(await seen(() => s.model.childSeen.length >= 2)).toBe(true);
    childGate.resolve();
    await settle(10);
    expect(roles(s.model.childSeen.at(-1)).join("\n")).toContain(
      "[message from the parent agent] go on",
    );
  } finally {
    s.runtime.dispose();
    s.connection.close();
  }
});

test("T20: a notify during the parent's own turn is a steer of THAT turn, not a wake", async () => {
  const s = await stack(true);
  try {
    const controller = s.runtime.createSession();
    const parentGate = Promise.withResolvers<void>();
    // Round 1 launches the child; round 2 is held open while the child notifies.
    s.model.parent.push([bgTask("c1"), done], { gate: parentGate.promise, events: [] }, [
      text("second"),
      done,
    ]);
    s.model.child.push([notify("n1", "mid"), done], [text("report"), done]);

    const turnEnds: unknown[] = [];
    const sending = (async () => {
      for await (const e of controller.send("go")) {
        if (e.type === "turn_end") {
          turnEnds.push(e);
        }
      }
    })();
    await until(() => s.model.childSeen.length > 0);
    await settle(6);
    parentGate.resolve();
    await sending;
    await settle(10);
    // ONE turn for the whole exchange (the launch turn): no second turn started.
    expect(turnEnds).toHaveLength(1);
    const bodies = s.model.parentSeen.map((r) => roles(r).join("\n"));
    expect(bodies.some((b) => b.includes("[sub-agent sa-1 → you] mid"))).toBe(true);
  } finally {
    s.runtime.dispose();
    s.connection.close();
  }
});
