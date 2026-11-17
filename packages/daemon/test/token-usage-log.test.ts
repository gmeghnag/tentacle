import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Agent } from "@tentacle/agent";
import {
  type ChatMessage,
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
  type Usage,
} from "@tentacle/core";
import {
  type KnownLogEntry,
  KnownLogEntrySchema,
  LOG_ENTRY_CRITICAL,
  type LogResult,
} from "@tentacle/protocol";
import { ToolRegistry, shellTool } from "@tentacle/tools";
import type { DaemonSessionRecord } from "../src/persisted-session.ts";
import { type AgentFactory, SessionHost } from "../src/session-host.ts";
import { parseLogFile } from "../src/session-log-file.ts";
import { SessionLog, type UsageBody } from "../src/session-log.ts";
import { SessionPersister } from "../src/session-persister.ts";
import { SpyDaemonStore } from "./support/daemon-store-spy.ts";

// docs/feat/token-usage-log.md: every measured model round leaves ONE
// non-critical `usage` entry (round, model, prompt/completion/cached, how many
// messages it sent), it projects nothing, and it survives a reload. A round the
// provider did not measure leaves NO entry. Each test names the mutation that
// turns it red (AGENTS §9).

const CWD = "/tmp/token-usage-log";
const env = {} as ExecutionEnvironment;

/** Answers from a script of rounds: each request is one round, its usage as given (absent: none). */
class Scripted implements ModelProvider {
  readonly id = "scripted";
  /** The usage of each successive round; a callback may answer differently per request. */
  constructor(private readonly rounds: readonly (Usage | undefined)[]) {}
  readonly requests: ChatRequest[] = [];
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    const at = this.requests.length;
    this.requests.push(request);
    const usage = this.rounds[Math.min(at, this.rounds.length - 1)];
    yield { type: "text", delta: `round ${at}` };
    yield usage
      ? { type: "done", usage, stopReason: "stop" }
      : { type: "done", stopReason: "stop" };
  }
}

function rig(model: ModelProvider, store = new SpyDaemonStore(), modelId = "test-model") {
  const createAgent: AgentFactory = () => {
    const permissions = new PermissionBroker();
    const agent = new Agent({
      model,
      modelId,
      tools: new ToolRegistry().register(shellTool),
      env,
      requestPermission: (req, options) => permissions.request(req, options),
      systemPrompt: "sys",
    });
    return { agent, permissions };
  };
  const persister = new SessionPersister({ store, cwd: CWD, model: "m", onError: () => {} });
  const host = new SessionHost({ defaultCwd: CWD, persister, createAgent });
  return { host, store };
}

type Entry = LogResult["entries"][number] & {
  round?: number;
  final?: true;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  cachedPromptTokens?: number;
  messages?: number;
};
const cold = (hosted: { logRead(): LogResult }): Entry[] => hosted.logRead().entries as Entry[];
const usageEntries = (entries: readonly Entry[]) => entries.filter((e) => e.type === "usage");

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const m = (role: ChatMessage["role"], content: string): ChatMessage => ({ role, content });

/** A pure log over plain arrays (no daemon session around it). */
function pureLog() {
  let t = 1000;
  const log = new SessionLog("inc-1", () => t++);
  const entries = (): KnownLogEntry[] => {
    const out: KnownLogEntry[] = [];
    let after: { seq: number; id: string } | undefined;
    for (;;) {
      const page = log.read(after, 1 << 20, sha256);
      out.push(...(page.entries as KnownLogEntry[]));
      const tip = page.entries.at(-1);
      if (!page.more || tip === undefined) {
        break;
      }
      after = { seq: tip.seq, id: tip.id };
    }
    return out;
  };
  return { log, entries };
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${String(cond)}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

const durableLog = (store: SpyDaemonStore, id: string): string => {
  const record: DaemonSessionRecord | undefined = store.durable.get(id);
  if (!record) throw new Error(`${id}: nothing durable`);
  const files = store.files.get(id);
  if (files?.log === undefined) throw new Error(`${id}: no log text`);
  return files.log;
};

describe("a usage entry can never be written malformed (fix round 1: one bad entry refused the whole log)", () => {
  test("an unmeasurable field is DROPPED, and the entry still parses as a known entry", () => {
    // Mutation: `this.push({ type: "usage", critical: false, ...body })` unchecked
    // → `cachedPromptTokens: null` lands in the log and `KnownLogEntrySchema`
    // refuses it, so every later read of the file fails (`malformed usage entry N`).
    const { log, entries } = pureLog();
    log.start([m("system", "S")], "create");
    log.usage({
      promptTokens: 10,
      completionTokens: 5,
      // A provider's raw JSON, before its own guard (a LiteLLM-style `null`).
      cachedPromptTokens: null as unknown as number,
      model: "",
      round: 1,
    });
    const usage = entries().filter((e) => e.type === "usage");
    expect(usage).toHaveLength(1);
    const [row] = usage;
    expect(row !== undefined && "cachedPromptTokens" in row).toBe(false);
    expect(row !== undefined && "model" in row).toBe(false);
    expect(row?.round).toBe(1);
    // The point of the guard: the entry PARSES, so no reader refuses the file.
    for (const entry of entries()) {
      expect(KnownLogEntrySchema.safeParse(entry).success).toBe(true);
    }
    // The required counts are the entry's identity: without them there is no row.
    expect(row?.promptTokens).toBe(10);
    expect(row?.completionTokens).toBe(5);
  });

  test("no measurable prompt/completion ⇒ NO entry at all (never a 0/0 row)", () => {
    // Mutation: drop the `result.success` guard → an unparsable entry is pushed.
    const { log, entries } = pureLog();
    log.start([m("system", "S")], "create");
    log.usage({ promptTokens: undefined, completionTokens: undefined } as unknown as UsageBody);
    expect(entries().filter((e) => e.type === "usage")).toEqual([]);
  });
  test("a null cache count a provider let through never reaches the file (the durable log still parses)", async () => {
    // Mutation: drop the sanitizer in `SessionLog.usage` → the written entry is
    // malformed and `parseLogFile` refuses the whole file (fix round 1).
    const model = new Scripted([
      // What a LiteLLM-style proxy yields before the provider's own guard.
      { promptTokens: 9, completionTokens: 4, cachedPromptTokens: null as unknown as number },
    ]);
    const r = rig(model);
    const { hosted } = r.host.open({ create: true }, { send: () => {} });
    hosted.prompt("t1", [{ type: "text", text: "go" }]);
    await until(() => usageEntries(cold(hosted)).length >= 1);
    await hosted.persisted();
    const parsed = parseLogFile(durableLog(r.store, hosted.id), hosted.id);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.skipped).toBe(0);
    const onDisk = parsed.segments.flatMap((s) => s.entries).filter((e) => e.type === "usage");
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0] !== undefined && "cachedPromptTokens" in onDisk[0]).toBe(false);
  });
});

describe("one usage entry per measured round", () => {
  test("a turn's rounds each log round/tokens/messages, non-critical; the projection is untouched", async () => {
    // Mutation: drop the `event.type === "usage"` branch in `drive` → no entries.
    const model = new Scripted([
      { promptTokens: 100, completionTokens: 10 },
      { promptTokens: 180, completionTokens: 20, cachedPromptTokens: 120 },
    ]);
    const r = rig(model);
    const { hosted } = r.host.open({ create: true }, { send: () => {} });
    const before = cold(hosted).filter((e) => e.type === "message").length;
    hosted.prompt("t1", [{ type: "text", text: "go" }]);
    await until(() => usageEntries(cold(hosted)).length >= 1);
    const rows = usageEntries(cold(hosted));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      round: 0,
      promptTokens: 100,
      completionTokens: 10,
      model: "test-model",
    });
    // How many messages the request carried: the prompt it sent, not a guess.
    expect(rows[0]?.messages).toBeDefined();
    expect(rows[0]?.messages ?? -1).toBe(model.requests[0]?.messages.length ?? -2);
    // Non-critical, like every marker: an older build skips it, never refuses.
    expect(LOG_ENTRY_CRITICAL.usage).toBe(false);
    for (const row of rows) expect(row.critical === true).toBe(false);
    // It projects nothing: the history is exactly what it was (plus the turn's messages).
    const messages = cold(hosted).filter((e) => e.type === "message").length;
    expect(messages).toBeGreaterThanOrEqual(before);
  });

  test("a round the provider did not measure leaves NO entry (never a 0/0 row)", async () => {
    // Mutation: log a row with `promptTokens: 0` when `event.usage` is absent → a row appears.
    const model = new Scripted([undefined]);
    const r = rig(model);
    const { hosted } = r.host.open({ create: true }, { send: () => {} });
    hosted.prompt("t1", [{ type: "text", text: "go" }]);
    await until(() => model.requests.length > 0);
    // Give the drive loop a turn to settle, then check nothing was recorded.
    await new Promise((r2) => setTimeout(r2, 50));
    expect(usageEntries(cold(hosted))).toEqual([]);
  });

  test("an unmeasured cache count is OMITTED on disk too (no 0)", async () => {
    // Mutation: `cachedPromptTokens: usage.cachedPromptTokens ?? 0` in `drive` → the field appears.
    const model = new Scripted([{ promptTokens: 7, completionTokens: 3 }]);
    const r = rig(model);
    const { hosted } = r.host.open({ create: true }, { send: () => {} });
    hosted.prompt("t1", [{ type: "text", text: "go" }]);
    await until(() => usageEntries(cold(hosted)).length >= 1);
    const row = usageEntries(cold(hosted))[0];
    expect(row === undefined ? "none" : "cachedPromptTokens" in row).toBe(false);
  });

  test("the entries are on disk and still there after a reload of the file", async () => {
    // Mutation: a `usage` entry the fold drops as unknown → `skipped` > 0 / no entry after reload.
    const model = new Scripted([{ promptTokens: 42, completionTokens: 5 }]);
    const r = rig(model);
    const { hosted } = r.host.open({ create: true }, { send: () => {} });
    hosted.prompt("t1", [{ type: "text", text: "go" }]);
    await until(() => usageEntries(cold(hosted)).length >= 1);
    await hosted.persisted();
    const text = durableLog(r.store, hosted.id);
    const parsed = parseLogFile(text, hosted.id);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.skipped).toBe(0);
    const last = parsed.segments[parsed.segments.length - 1];
    const onDisk = (last?.entries ?? []).filter((e) => e.type === "usage") as Entry[];
    expect(onDisk.map((e) => [e.round, e.promptTokens, e.completionTokens])).toEqual([[0, 42, 5]]);
  });
});
