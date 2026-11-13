/**
 * `agent_control` (docs/feat/agent-status.md, "Merge into agent_control"): ONE
 * parent-side tool with three actions — `status` (read-only), `message`, `kill`.
 * The behaviour of each action is the one its own tool had, so the assertions
 * below are the old tools' own texts, byte for byte: that is what keeps the
 * merge from quietly changing what the model is told.
 *
 * What is NEW and therefore worth pinning: which fields an action needs (checked
 * in `execute`, so the error is ours), the class per action (`status` read-only,
 * `message`/`kill` exclusive — today's three classes), and the description
 * following `subagents.twoWay`.
 */
import { describe, expect, test } from "bun:test";
import {
  AGENT_INBOX_MAX,
  AGENT_MESSAGE_MAX_CHARS,
  AgentJobs,
  type ToolContext,
} from "@tentacle/core";
import {
  AGENT_CONTROL_TOOL_NAME,
  agentControlDescription,
  createAgentControlTool,
} from "../src/agent-control.ts";

const tick = () => new Promise((r) => setTimeout(r, 1));
const ctx = { sessionId: "s", signal: new AbortController().signal } as unknown as ToolContext;

interface Rig {
  readonly jobs: AgentJobs;
  readonly gate: PromiseWithResolvers<{ report: string; toolUses: number; stopReason: string }>;
  readonly started: boolean;
  readonly isAborted: () => boolean;
  readonly drain: () => string[];
  readonly ended: string[];
}

/** One running background child (`sa-1`) on a real `AgentJobs`. */
function rig(cap = 2): Rig {
  let n = 0;
  const ended: string[] = [];
  const jobs = new AgentJobs(cap);
  jobs.bind({
    launched: () => `sa-${++n}`,
    ended: (id, stop) => ended.push(`${id}:${stop}`),
  });
  const gate = Promise.withResolvers<{ report: string; toolUses: number; stopReason: string }>();
  let aborted = false;
  let inbox: { drain(): string[] } | undefined;
  const started = jobs.start(
    { callId: "c1", agentType: "general", description: "map repo" },
    async (c) => {
      inbox = c.inbox;
      c.signal.addEventListener("abort", () => {
        aborted = true;
      });
      return gate.promise;
    },
  );
  return {
    jobs,
    gate,
    started: started.ok,
    isAborted: () => aborted,
    drain: () => inbox?.drain() ?? [],
    ended,
  };
}

/** A `now` a fixed 84s after a child that started at `startedAt`; the rig records
 * the real one, so the test reads it from the row instead of guessing. */
const NOW = (startedAt: number) => startedAt + 84_000;

describe("agent_control: the three actions do what their old tools did", () => {
  test("status: the child's own facts, its last 3 actions and its unread count", async () => {
    const r = rig(4);
    for (const label of ["Read src/a.ts", "Edit src/a.ts", "$ bun test", "Read src/b.ts"]) {
      r.jobs.progress("sa-1", { kind: "subagent_tool", label });
    }
    r.jobs.progress("sa-1", {
      kind: "subagent_usage",
      promptTokens: 70_000,
      completionTokens: 4_000,
    });
    expect(r.jobs.message("sa-1", "try the other file", "agent").ok).toBe(true);

    const startedAt = r.jobs.rows()[0]?.startedAt ?? 0;
    const out = await createAgentControlTool(r.jobs, { now: () => NOW(startedAt) }).execute(
      { action: "status" },
      ctx,
    );
    expect(out.isError).toBe(false);
    expect(out.content).toBe(
      [
        "1 background sub-agent (of 4 allowed)",
        "sa-1 · general · map repo · running 1m 24s · 4 tools · 74k tokens · 1 unread",
        "  last 3: Edit src/a.ts · $ bun test · Read src/b.ts (+1 earlier)",
      ].join("\n"),
    );
    r.gate.resolve({ report: "r", toolUses: 4, stopReason: "end_turn" });
    await tick();
  });

  test("status: one id selects one child; an unknown/finished one is a tool error", async () => {
    const r = rig(2);
    const tool = createAgentControlTool(r.jobs, {
      now: () => NOW(r.jobs.rows()[0]?.startedAt ?? 0),
    });
    const miss = (id: string) =>
      `no such background sub-agent: ${id} — it finished, was stopped, or never existed. If it just finished, its report arrives as a [background] note.`;
    expect(await tool.execute({ action: "status", agent_id: "sa-9" }, ctx)).toEqual({
      content: miss("sa-9"),
      isError: true,
    });
    expect((await tool.execute({ action: "status", agent_id: "sa-1" }, ctx)).content).toContain(
      "sa-1 · general · map repo",
    );
    r.gate.resolve({ report: "r", toolUses: 0, stopReason: "end_turn" });
    await tick();
    // A finished child has no row, but it still answers truthfully — never "no
    // such" for a child that just reported (docs/fix/subagent-error-report.md C).
    // This rig binds no host clock, so the record has no age and none is claimed.
    expect(await tool.execute({ action: "status", agent_id: "sa-1" }, ctx)).toEqual({
      content:
        "sa-1 ended (end_turn) after 0 tool uses. Its report reaches you as a [background] note at your next step.",
      isError: false,
    });
  });

  test("status: nothing running is not an error, and says how the report arrives", async () => {
    const jobs = new AgentJobs(1);
    jobs.bind({ launched: () => "sa-1", ended: () => {} });
    expect(await createAgentControlTool(jobs).execute({ action: "status" }, ctx)).toEqual({
      content:
        "no background sub-agents are running (subagents.maxParallel = 1). A [background] note arrives when one finishes.",
      isError: false,
    });
  });

  test("message (twoWay off): 'queued', never 'delivered', and the child reads it", async () => {
    const r = rig();
    const tool = createAgentControlTool(r.jobs);
    const out = await tool.execute(
      { action: "message", agent_id: "sa-1", text: "also check X" },
      ctx,
    );
    expect(out.isError).toBe(false);
    expect(out.content).toBe(
      "queued for sa-1: it reads it before its next model step. No reply comes back; its report still arrives as a [background] note.",
    );
    expect(out.content).not.toContain("delivered");
    expect(r.drain()).toEqual(["[message from the parent agent] also check X"]);
    r.gate.resolve({ report: "r", toolUses: 0, stopReason: "end_turn" });
    await tick();
  });

  test("message: every refusal is an error carrying AgentJobs' own reason", async () => {
    const r = rig();
    const tool = createAgentControlTool(r.jobs);
    expect(await tool.execute({ action: "message", agent_id: "sa-9", text: "hi" }, ctx)).toEqual({
      content:
        "sa-9 is not a running background sub-agent (it finished, was stopped, or never existed): nothing was sent.",
      isError: true,
    });
    for (let i = 1; i <= AGENT_INBOX_MAX; i++) {
      expect(
        (await tool.execute({ action: "message", agent_id: "sa-1", text: `m${i}` }, ctx)).isError,
      ).toBe(false);
    }
    const full = await tool.execute({ action: "message", agent_id: "sa-1", text: "m9" }, ctx);
    expect(full).toEqual({
      content: `sa-1 already has ${AGENT_INBOX_MAX} unread messages: nothing was sent. Wait for it to read them or for its report.`,
      isError: true,
    });
    r.drain();
    r.jobs.kill("sa-1");
    expect(await tool.execute({ action: "message", agent_id: "sa-1", text: "hi" }, ctx)).toEqual({
      content: "sa-1 is being stopped: nothing was sent.",
      isError: true,
    });
    r.gate.resolve({ report: "r", toolUses: 0, stopReason: "end_turn" });
    await tick();
  });

  test("message: an over-length text is refused with the limit, and nothing is queued", async () => {
    const r = rig();
    const long = await createAgentControlTool(r.jobs).execute(
      { action: "message", agent_id: "sa-1", text: "x".repeat(AGENT_MESSAGE_MAX_CHARS + 1) },
      ctx,
    );
    expect(long.isError).toBe(true);
    expect(long.content).toContain(`${AGENT_MESSAGE_MAX_CHARS}`);
    expect(r.drain()).toEqual([]);
    r.gate.resolve({ report: "r", toolUses: 0, stopReason: "end_turn" });
    await tick();
  });

  test("kill: its signal aborts, its exit is cancelled, and a second kill is not an error", async () => {
    const r = rig();
    const tool = createAgentControlTool(r.jobs);
    expect(await tool.execute({ action: "kill", agent_id: "sa-1" }, ctx)).toEqual({
      content: "killed background sub-agent sa-1",
      isError: false,
    });
    expect(r.isAborted()).toBe(true);
    expect(await tool.execute({ action: "kill", agent_id: "sa-1" }, ctx)).toEqual({
      content: "background sub-agent sa-1 was not running",
      isError: false,
    });
    expect(await tool.execute({ action: "kill", agent_id: "sa-9" }, ctx)).toEqual({
      content: "background sub-agent sa-9 was not running",
      isError: false,
    });
    r.gate.resolve({ report: "partial", toolUses: 1, stopReason: "end_turn" });
    await tick();
    expect(r.ended).toEqual(["sa-1:cancelled"]);
  });

  test("kill: a foreground child is not killable by id (it has none)", async () => {
    const r = rig(2);
    expect(r.jobs.acquire("fg one").ok).toBe(true);
    expect(
      (await createAgentControlTool(r.jobs).execute({ action: "kill", agent_id: "fg one" }, ctx))
        .content,
    ).toBe("background sub-agent fg one was not running");
    expect(r.isAborted()).toBe(false);
    r.gate.resolve({ report: "r", toolUses: 0, stopReason: "end_turn" });
    await tick();
  });
});

// The reason the merge needed validation in `execute`: the schema is ONE flat
// object (no `oneOf`, which local OpenAI-compatible models handle poorly), so it
// cannot say which action needs which field. The tool must, in its own words.
describe("agent_control: which fields an action needs", () => {
  test("message without agent_id or text is an error naming both", async () => {
    const r = rig();
    const tool = createAgentControlTool(r.jobs);
    const needs = { content: 'action "message" needs agent_id and text.', isError: true };
    expect(await tool.execute({ action: "message" }, ctx)).toEqual(needs);
    expect(await tool.execute({ action: "message", agent_id: "sa-1" }, ctx)).toEqual(needs);
    expect(await tool.execute({ action: "message", text: "hi" }, ctx)).toEqual(needs);
    // Nothing was queued by any of them.
    expect(r.drain()).toEqual([]);
    r.gate.resolve({ report: "r", toolUses: 0, stopReason: "end_turn" });
    await tick();
  });

  test("kill without agent_id is an error, and nothing is stopped", async () => {
    const r = rig();
    expect(await createAgentControlTool(r.jobs).execute({ action: "kill" }, ctx)).toEqual({
      content: 'action "kill" needs agent_id.',
      isError: true,
    });
    expect(r.isAborted()).toBe(false);
    r.gate.resolve({ report: "r", toolUses: 0, stopReason: "end_turn" });
    await tick();
  });

  test("status needs no other field: agent_id is optional", () => {
    const r = rig();
    const tool = createAgentControlTool(r.jobs);
    expect(tool.inputSchema.safeParse({ action: "status" }).success).toBe(true);
    expect(tool.inputSchema.safeParse({ action: "status", agent_id: "sa-1" }).success).toBe(true);
    // The action itself is the only required member, and its values are fixed.
    expect(tool.inputSchema.safeParse({}).success).toBe(false);
    expect(tool.inputSchema.safeParse({ agent_id: "sa-1" }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ action: "nope" }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ action: "message", agent_id: "" }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ action: "message", text: "" }).success).toBe(false);
    // `status` no longer takes `actions`: it always shows the last 3, and an
    // unknown key is stripped rather than refused (a .strip() schema).
    const parsed = tool.inputSchema.safeParse({ action: "status", actions: 5 });
    expect(parsed.success).toBe(true);
    expect(parsed.success ? Object.hasOwn(parsed.data, "actions") : true).toBe(false);
    r.gate.resolve({ report: "r", toolUses: 0, stopReason: "end_turn" });
  });

  test("a call with an unknown action reaching execute is an error, never a throw", async () => {
    const r = rig();
    const out = await createAgentControlTool(r.jobs).execute(
      { action: "delete" } as unknown as { action: "status" },
      ctx,
    );
    expect(out.isError).toBe(true);
    expect(out.content).toBe("unknown action: delete — use status, message or kill.");
    r.gate.resolve({ report: "r", toolUses: 0, stopReason: "end_turn" });
    await tick();
  });
});

// Permission and concurrency are what keep a round honest (AGENTS §7): the merged
// tool must class each call EXACTLY as the tool it replaced did — `status` was
// read-only, `message`/`kill` had no `concurrency` at all (hence exclusive).
describe("agent_control: the class follows the action", () => {
  test("no permission prompt, and one read key for status only", () => {
    const r = rig();
    const tool = createAgentControlTool(r.jobs);
    expect(tool.name).toBe(AGENT_CONTROL_TOOL_NAME);
    expect(tool.name).toBe("agent_control");
    expect(tool.permission).toBe("none");
    // It never spawns: `agent_task` alone does.
    expect(tool.spawnKind).toBeUndefined();
    const cls = tool.concurrency;
    if (cls === undefined || cls === "exclusive") throw new Error("expected a key function");
    expect(cls({ action: "status" })).toEqual([{ mode: "read", resource: "subagents" }]);
    for (const input of [
      { action: "message", agent_id: "sa-1", text: "x" },
      { action: "kill", agent_id: "sa-1" },
      {},
      undefined,
      null,
      { action: "delete" },
    ]) {
      expect(cls(input)).toBe("exclusive");
    }
    r.gate.resolve({ report: "r", toolUses: 0, stopReason: "end_turn" });
  });
});

// The description is the whole cost of this merge: it must carry the three
// facts, stay short, and follow `subagents.twoWay` (docs/feat/agent-message-two-way.md).
describe("agent_control: the one description", () => {
  const OFF = agentControlDescription(false);
  const ON = agentControlDescription(true);

  test("it is one short block covering the three actions", () => {
    expect(OFF.length).toBeLessThanOrEqual(400);
    expect(ON.length).toBeLessThanOrEqual(400);
    for (const action of ['"status"', '"message"', '"kill"']) {
      expect(OFF).toContain(action);
    }
    // status: read-only, and never a way to wait.
    expect(OFF).toContain("read-only");
    expect(OFF).toContain("never a way to wait");
    expect(OFF).toContain("[background] note that wakes you");
    // message: read before its next model step; kill: stops it.
    expect(OFF).toContain("read before its next model step");
    expect(OFF).toContain("stops it");
    // Minimal: no `actions` parameter to explain, no JSON-Schema-as-prose.
    expect(OFF).not.toContain("oneOf");
  });

  test("twoWay off: one-way, no reply comes back (today's facts)", () => {
    expect(OFF).toContain("one-way, no reply comes back");
    expect(OFF).not.toContain("agent_notify");
  });

  test("twoWay on: the child may answer with agent_notify, as a note that may wake you", () => {
    expect(ON).not.toBe(OFF);
    expect(ON).toContain("agent_notify");
    expect(ON).toContain("[sub-agent sa-N → you]");
    expect(ON).toContain("may wake you");
    expect(ON).not.toContain("no reply comes back");
    // Everything else is unchanged: only the message clause differs.
    expect(
      ON.replace(
        "it may answer with agent_notify (a [sub-agent sa-N → you] note that may wake you)",
        "one-way, no reply comes back",
      ),
    ).toBe(OFF);
  });

  test("the tool carries the description for its flag", () => {
    expect(createAgentControlTool(rig().jobs).description).toBe(OFF);
    expect(createAgentControlTool(rig().jobs, { twoWay: false }).description).toBe(OFF);
    expect(createAgentControlTool(rig().jobs, { twoWay: true }).description).toBe(ON);
  });
});

// With `subagents.twoWay` on, the message RESULT must not tell the parent there
// is no way back (today's `agent_message` behaviour, now one action).
describe("agent_control: twoWay on changes the message result too", () => {
  test("it says the child may answer with agent_notify, arriving as a [sub-agent sa-1 → you] note", async () => {
    const r = rig();
    const out = await createAgentControlTool(r.jobs, { twoWay: true }).execute(
      { action: "message", agent_id: "sa-1", text: "hi" },
      ctx,
    );
    expect(out.content).toBe(
      "queued for sa-1: it reads it before its next model step. It may answer with agent_notify (a [sub-agent sa-1 → you] note that may wake you); its report still arrives as a [background] note.",
    );
    expect(out.content).not.toContain("No reply comes back");
    r.gate.resolve({ report: "r", toolUses: 0, stopReason: "end_turn" });
    await tick();
  });

  // Review finding 1 (docs/fix/autoaccept-wake-turns.md): a child MOVED to the
  // background by `adopt` has no `agent_notify`, so the parent must not be told
  // it may answer — the flag `message` now uses is the same one.
  test("an ADOPTED child (no agent_notify) is not promised as one that may answer", async () => {
    const jobs = new AgentJobs(2);
    let n = 0;
    jobs.bind({ launched: () => `sa-${++n}`, ended: () => {} });
    const slot = jobs.acquire("map repo");
    if (!slot.ok) {
      throw new Error("expected a slot");
    }
    const gate = Promise.withResolvers<{ report: string; toolUses: number; stopReason: string }>();
    slot.adopt(
      { callId: "c1", agentType: "general", description: "map repo" },
      new AbortController(),
      { toolUses: 0, tokens: 0, tail: [] },
      async () => gate.promise,
    );
    const out = await createAgentControlTool(jobs, { twoWay: true }).execute(
      { action: "message", agent_id: "sa-1", text: "hi" },
      ctx,
    );
    expect(out.content).toBe(
      "queued for sa-1: it reads it before its next model step. No reply comes back; its report still arrives as a [background] note.",
    );
    expect(out.content).not.toContain("agent_notify");
    gate.resolve({ report: "r", toolUses: 0, stopReason: "end_turn" });
    await tick();
  });
});

// docs/fix/subagent-error-report.md root cause C, test 8: a child that just
// ENDED answers for itself instead of "no such", and says where its report is.
describe("agent_control status: a recently ended child", () => {
  /** A child that ends at `endedAt` with a chosen outcome; `now` is fixed. */
  function endedRig(outcome: { report: string; toolUses: number; stopReason: string }) {
    const startedAt = 1_000;
    let clock = startedAt;
    let n = 0;
    const jobs = new AgentJobs(2);
    jobs.bind({ launched: () => `sa-${++n}`, ended: () => {}, now: () => clock });
    const gate = Promise.withResolvers<typeof outcome>();
    jobs.start(
      { callId: "c1", agentType: "general", description: "Trace FA shared-mem root cause" },
      async () => gate.promise,
    );
    clock = startedAt + 30_000;
    gate.resolve(outcome);
    return { jobs, now: () => clock };
  }

  const endedText =
    "sa-1 ended (error) 0s ago after 77 tool uses. Its report — the error and any partial output — reaches you as a [background] note at your next step.";

  test("undelivered: the ended text, not an error", async () => {
    // Mutation: drop the `jobs.ended` fallback → "no such" and isError true → red.
    const r = endedRig({ report: "the sub-agent failed: boom", toolUses: 77, stopReason: "error" });
    await tick();
    const tool = createAgentControlTool(r.jobs, { now: r.now });
    expect(await tool.execute({ action: "status", agent_id: "sa-1" }, ctx)).toEqual({
      content: endedText,
      isError: false,
    });
  });

  test("delivered: it says the report is in hand, never promises it again", async () => {
    const r = endedRig({ report: "R", toolUses: 2, stopReason: "end_turn" });
    await tick();
    r.jobs.delivered("sa-1");
    const tool = createAgentControlTool(r.jobs, { now: r.now });
    expect((await tool.execute({ action: "status", agent_id: "sa-1" }, ctx)).content).toBe(
      'sa-1 ended (end_turn) 0s ago after 2 tool uses. Its report was delivered to you as the [background] note "sub-agent sa-1 (Trace FA shared-mem root cause)".',
    );
  });

  test("the no-id listing adds one `recently ended:` line; an unknown id keeps `no such`", async () => {
    // Mutation: keep the listing silent → red.
    const r = endedRig({ report: "R", toolUses: 1, stopReason: "error" });
    await tick();
    const tool = createAgentControlTool(r.jobs, { now: r.now });
    const listing = await tool.execute({ action: "status" }, ctx);
    expect(listing.isError).toBe(false);
    expect(listing.content.split("\n").at(-1)).toBe("recently ended: sa-1 failed 0s ago");
    const miss = await tool.execute({ action: "status", agent_id: "sa-9" }, ctx);
    expect(miss).toEqual({
      content:
        "no such background sub-agent: sa-9 — it finished, was stopped, or never existed. If it just finished, its report arrives as a [background] note.",
      isError: true,
    });
  });
});
