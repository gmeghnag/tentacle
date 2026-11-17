import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import {
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
  type Usage,
} from "@tentacle/core";
import { LOG_ENTRY_CRITICAL, type LogResult } from "@tentacle/protocol";
import { ToolRegistry, shellTool } from "@tentacle/tools";
import type { DaemonSessionRecord } from "../src/persisted-session.ts";
import { type AgentFactory, SessionHost } from "../src/session-host.ts";
import { parseLogFile } from "../src/session-log-file.ts";
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

function rig(model: ModelProvider, store = new SpyDaemonStore()) {
  const createAgent: AgentFactory = () => {
    const permissions = new PermissionBroker();
    const agent = new Agent({
      model,
      modelId: "test-model",
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
