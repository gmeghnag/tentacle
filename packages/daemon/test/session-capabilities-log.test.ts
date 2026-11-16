import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@tentacle/agent";
import {
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { LOG_ENTRY_CRITICAL, type LogResult } from "@tentacle/protocol";
import { ToolRegistry, shellTool } from "@tentacle/tools";
import type { DaemonSessionRecord } from "../src/persisted-session.ts";
import { type AgentFactory, SessionHost } from "../src/session-host.ts";
import { headerLine } from "../src/session-log-file.ts";
import { LogSessionStore } from "../src/session-log-store.ts";
import { SessionPersister } from "../src/session-persister.ts";
import { SpyDaemonStore } from "./support/daemon-store-spy.ts";

// The session's switches are RECORDED in its log (docs/feat/session-capabilities.md
// S3b): a non-critical `capabilities` entry on every change, after every `base`
// when something is off, and a `serve` restart reloads them from it. Each test
// names the mutation that turns it red (AGENTS §9).

const CWD = "/tmp/session-capabilities-log";
const env = {} as ExecutionEnvironment;
/** An MCP server's tool, tagged as the adapter tags it. */
const echoTool = { ...shellTool, name: "mcp__echo__echo", mcpServer: "echo" };
const OFF_ECHO = { disabledMcp: ["echo"], disabledSkills: [] };

/** Records each request's tool names; answers with a bare "done". */
class Recorder implements ModelProvider {
  readonly id = "recorder";
  readonly tools: string[][] = [];
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.tools.push((request.tools ?? []).map((t) => t.name));
    yield { type: "text", delta: "ok" };
    yield { type: "done" };
  }
}

function rig(store = new SpyDaemonStore()) {
  const model = new Recorder();
  const createAgent: AgentFactory = () => {
    const permissions = new PermissionBroker();
    const agent = new Agent({
      model,
      tools: new ToolRegistry().register(shellTool).register(echoTool),
      env,
      requestPermission: (req, options) => permissions.request(req, options),
      systemPrompt: "sys",
    });
    return { agent, permissions };
  };
  const persister = new SessionPersister({ store, cwd: CWD, model: "m", onError: () => {} });
  const host = new SessionHost({ defaultCwd: CWD, persister, createAgent });
  return { host, store, model, persister };
}

type Entry = LogResult["entries"][number] & { capabilities?: unknown };

/** The cold read: the current segment, from its `base`. */
const cold = (hosted: { logRead(): LogResult }): Entry[] => hosted.logRead().entries as Entry[];
const capsEntries = (entries: readonly Entry[]) => entries.filter((e) => e.type === "capabilities");

const durable = (store: SpyDaemonStore, id: string): DaemonSessionRecord => {
  const record = store.durable.get(id);
  if (!record) throw new Error(`${id}: nothing durable`);
  return record;
};

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${String(cond)}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe("the switches are recorded in the session log", () => {
  test("L1 a change logs the whole state AFTER, non-critical; an idempotent set logs nothing", () => {
    // Mutation: no `log.capabilities` in `setCapability` → no entry.
    const r = rig();
    const { hosted } = r.host.open({ create: true }, { send: () => {} });
    // A fresh session logs no switches (everything on): the log is unchanged for it.
    expect(capsEntries(cold(hosted))).toEqual([]);

    hosted.setCapability({ kind: "mcp", name: "echo", enabled: false });
    hosted.setCapability({ kind: "mcp", name: "echo", enabled: false }); // idempotent
    hosted.setCapability({ kind: "skill", name: "k8s", enabled: false });
    const logged = capsEntries(cold(hosted));
    expect(logged.map((e) => e.capabilities)).toEqual([
      { disabledMcp: ["echo"], disabledSkills: [] },
      { disabledMcp: ["echo"], disabledSkills: ["k8s"] },
    ]);
    // Non-critical (owner Q2): an older build SKIPS it, never refuses the log.
    expect(LOG_ENTRY_CRITICAL.capabilities).toBe(false);
    for (const e of logged) expect(e.critical === true).toBe(false);

    // Back to everything on: logged too (the fold must see the change).
    hosted.setCapability({ kind: "mcp", name: "echo", enabled: true });
    hosted.setCapability({ kind: "skill", name: "k8s", enabled: true });
    expect(capsEntries(cold(hosted)).at(-1)?.capabilities).toEqual({
      disabledMcp: [],
      disabledSkills: [],
    });
  });

  test("L2 a created session's seed is logged (resume / fork / hop carry it)", () => {
    // Mutation: no log in `seedCapabilities` → the seeded state is in no entry.
    const r = rig();
    const { hosted } = r.host.open(
      { create: true, capabilities: { disabledMcp: ["echo", "echo"], disabledSkills: [] } },
      { send: () => {} },
    );
    expect(capsEntries(cold(hosted)).map((e) => e.capabilities)).toEqual([
      { disabledMcp: ["echo"], disabledSkills: [] },
    ]);
    // An empty seed is "everything on": nothing to log.
    const empty = r.host.open(
      { create: true, capabilities: { disabledMcp: [], disabledSkills: [] } },
      { send: () => {} },
    ).hosted;
    expect(capsEntries(cold(empty))).toEqual([]);
  });

  test("L3 a new segment (/clear, compaction) carries the switches again (F12)", async () => {
    // Mutation: no capabilities in `logSegmentFacts` → the cold read from the new base has none.
    const r = rig();
    const { hosted } = r.host.open(
      {
        create: true,
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "q" },
          { role: "assistant", content: "a" },
        ],
      },
      { send: () => {} },
    );
    hosted.setCapability({ kind: "mcp", name: "echo", enabled: false });
    hosted.clear();
    const segment = cold(hosted);
    expect(segment[0]?.type).toBe("base");
    expect(capsEntries(segment).map((e) => e.capabilities)).toEqual([
      { disabledMcp: ["echo"], disabledSkills: [] },
    ]);
  });
});

describe("the laptop store folds the CURRENT segment's switches", () => {
  const META = { cwd: CWD, model: "m", createdAt: 1 };
  const user = { role: "user" as const, content: "q" };
  const file = (entries: readonly Record<string, unknown>[]) => {
    let prev: string | undefined;
    const lines = entries.map((body, i) => {
      const id = `i/${i + 1}`;
      const line = JSON.stringify({ ...body, seq: i + 1, id, ...(prev ? { prev } : {}), ts: 1 });
      prev = id;
      return `${line}\n`;
    });
    return headerLine({ id: "s1", ...META }) + lines.join("");
  };
  const base = (reason: string) => ({ type: "base", critical: true, inc: "i", reason, count: 1 });
  const msg = { type: "message", critical: true, message: user };
  const caps = (disabledMcp: string[]) => ({
    type: "capabilities",
    capabilities: { disabledMcp, disabledSkills: [] },
  });

  async function load(text: string) {
    const dir = await mkdtemp(join(tmpdir(), "caps-store-"));
    try {
      await writeFile(join(dir, "s1.jsonl"), text);
      const result = await new LogSessionStore(dir).load("s1");
      if (result.status !== "ok") throw new Error(result.status);
      return result.record;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test("S1 the last entry of the current segment wins", async () => {
    // Mutation: take the FIRST entry → `a` instead of `b`.
    const record = await load(file([base("create"), msg, caps(["a"]), caps(["b"])]));
    expect(record.capabilities).toEqual({ disabledMcp: ["b"], disabledSkills: [] });
  });

  test("S2 a superseded segment's switches never apply (keepSuperseded)", async () => {
    // Mutation: fold the whole file instead of the current segment → `a` comes back off.
    const record = await load(file([base("create"), msg, caps(["a"]), base("context_reset"), msg]));
    expect(record.capabilities).toBeUndefined();
  });
});

describe("a serve restart reloads the switches from the log (F6)", () => {
  test("R1 restore: the session and its agent hide the server again", async () => {
    // Mutation: `rebuild` does not fold `capabilities` → the record has none, everything on.
    const r = rig();
    const { hosted } = r.host.open({ create: true }, { send: () => {} });
    hosted.setCapability({ kind: "mcp", name: "echo", enabled: false });
    await hosted.persisted();
    const record = durable(r.store, hosted.id);
    expect(record.capabilities).toEqual({ disabledMcp: ["echo"], disabledSkills: [] });

    const restarted = rig(r.store);
    const restored = restarted.host.restore(record);
    expect(restored.capabilities()).toEqual({ disabledMcp: ["echo"], disabledSkills: [] });
    // The model is told: the first request after the restart lacks the tool.
    restored.prompt("t1", [{ type: "text", text: "go" }]);
    await until(() => restarted.model.tools.length > 0);
    expect(restarted.model.tools[0]).toContain("shell");
    expect(restarted.model.tools[0]).not.toContain("mcp__echo__echo");
    // And the new incarnation's segment states it again (a cold read knows it).
    expect(capsEntries(cold(restored)).at(-1)?.capabilities).toEqual({
      disabledMcp: ["echo"],
      disabledSkills: [],
    });
  });

  test("R3 a session CREATED with switches (a `connect` /clear) has them on disk with no later change", async () => {
    // Mutation: a create's first write captured before the seed is logged → the record has none.
    const r = rig();
    const { hosted } = r.host.open({ create: true, capabilities: OFF_ECHO }, { send: () => {} });
    await hosted.persisted();
    expect(durable(r.store, hosted.id).capabilities).toEqual(OFF_ECHO);
  });

  test("R2 only the log THROUGH the sidecar's entry counts: a later write that never paired is ignored", async () => {
    // Mutation: fold the whole last segment instead of THROUGH `logHead` → `k8s` comes back off.
    const r = rig();
    const { hosted } = r.host.open({ create: true }, { send: () => {} });
    hosted.setCapability({ kind: "mcp", name: "echo", enabled: false });
    await hosted.persisted();
    const files = r.store.files.get(hosted.id);
    if (files?.log === undefined) throw new Error("no log");
    // A log write landed, its state file did not (a crash between the two).
    const last = JSON.parse(files.log.trimEnd().split("\n").at(-1) ?? "{}") as {
      seq: number;
      id: string;
    };
    const inc = last.id.split("/")[0];
    files.log += `${JSON.stringify({
      type: "capabilities",
      seq: last.seq + 1,
      id: `${inc}/${last.seq + 1}`,
      prev: last.id,
      ts: 1,
      capabilities: { disabledMcp: ["echo"], disabledSkills: ["k8s"] },
    })}\n`;
    expect(durable(r.store, hosted.id).capabilities).toEqual({
      disabledMcp: ["echo"],
      disabledSkills: [],
    });
  });
});
