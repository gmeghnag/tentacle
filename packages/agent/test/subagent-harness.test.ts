/**
 * Slice shr-4 (docs/feat/subagent-harness-runners.md D3/D6): a `claude` child
 * through the REAL process transport + Claude Code codec, with a fake spawner
 * (no real `claude`) and fake worktrees. It must look exactly like a tentacle
 * child on the seam: start / tool / usage / end, a report, a failure.
 */
import { describe, expect, test } from "bun:test";
import { type ModelProvider, SubagentFailure, type ToolProgressEvent } from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import {
  HARNESS_ASK_DENIED,
  type HarnessDeps,
  type HarnessWorktrees,
} from "../src/harness/child.ts";
import {
  CLAUDE_CODE_CAPS,
  CLAUDE_DEFAULT_TOOLS,
  createClaudeCodeCodec,
} from "../src/harness/claude-code.ts";
import { type HarnessProc, type Spawner, createProcessAdapter } from "../src/harness/process.ts";
import type { HarnessAdapter } from "../src/harness/types.ts";
import type { SnapshotWorktree, WorktreeOutcome } from "../src/harness/worktree.ts";
import { type AgentType, createSubagentRunner } from "../src/subagent.ts";

const enc = new TextEncoder();
const SID = "11111111-2222-3333-4444-555555555555";

const INIT = {
  type: "system",
  subtype: "init",
  session_id: SID,
  tools: [...CLAUDE_DEFAULT_TOOLS],
  permissionMode: "default",
  claude_code_version: "2.1.331",
};
const TOOL_USE = {
  type: "assistant",
  message: {
    id: "m1",
    content: [{ type: "tool_use", name: "Read", input: { file_path: "a.ts" } }],
    usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 30 },
  },
};
const RATE = {
  type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed",
    unifiedWindows: {
      five_hour: { utilization: 0.34, resetsAt: 1795609800, status: "allowed" },
      seven_day: { utilization: 0.12, resetsAt: 1795730400, status: "allowed" },
    },
  },
};
const RESULT = { type: "result", is_error: false, result: "found it", total_cost_usd: 0.4234 };

/** How the fake CLI answers one stdin line. Returns stdout objects to emit, and/or `exit`. */
type Script = (line: Record<string, unknown>, ctl: FakeCtl) => void;
interface FakeCtl {
  emit(...objs: unknown[]): void;
  exit(code: number): void;
}

interface Spawned {
  cmd: readonly string[];
  cwd?: string;
  stdin: string[];
}

function fakeSpawner(script: Script, version = "2.1.331 (Claude Code)") {
  const spawned: Spawned[] = [];
  const spawner: Spawner = (cmd, options) => {
    const rec: Spawned = {
      cmd,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      stdin: [],
    };
    spawned.push(rec);
    let out: ReadableStreamDefaultController<Uint8Array> | undefined;
    let err: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stdout = new ReadableStream<Uint8Array>({
      start: (c) => {
        out = c;
      },
    });
    const stderr = new ReadableStream<Uint8Array>({
      start: (c) => {
        err = c;
      },
    });
    let resolveExit: (code: number) => void = () => {};
    const exited = new Promise<number>((r) => {
      resolveExit = r;
    });
    let done = false;
    const ctl: FakeCtl = {
      emit: (...objs) => {
        for (const o of objs) out?.enqueue(enc.encode(`${JSON.stringify(o)}\n`));
      },
      exit: (code) => {
        if (done) return;
        done = true;
        out?.close();
        err?.close();
        resolveExit(code);
      },
    };
    if (cmd[1] === "--version") {
      out?.enqueue(enc.encode(`${version}\n`));
      queueMicrotask(() => ctl.exit(0));
    }
    const proc: HarnessProc = {
      pid: 4242,
      write: (data) => {
        for (const line of data.split("\n").filter((l) => l !== "")) {
          rec.stdin.push(line);
          script(JSON.parse(line) as Record<string, unknown>, ctl);
        }
      },
      endInput: () => ctl.exit(0),
      stdout,
      stderr,
      exited,
      kill: () => ctl.exit(137),
    };
    return proc;
  };
  return { spawner, spawned };
}

/** A happy run: init, one tool call, a rate-limit event, the result. */
const happy: Script = (line, ctl) => {
  if (line.type === "user") ctl.emit(INIT, TOOL_USE, RATE, RESULT);
};

function fakeWorktrees(outcome: WorktreeOutcome = { changed: false }, failCreate = false) {
  const log: string[] = [];
  const wt: HarnessWorktrees = {
    create: async ({ cwd, id }) => {
      log.push(`create ${cwd} ${id}`);
      if (failCreate) throw new Error("git apply failed: patch does not apply");
      const made: SnapshotWorktree = {
        id,
        path: `/repo/.tentacle/worktrees/harness-${id}`,
        branch: `harness/${id}`,
        baseline: "abc",
        repoRoot: "/repo",
      };
      return made;
    },
    finish: async (made) => {
      log.push(`finish ${made.id}`);
      return outcome;
    },
  };
  return { wt, log };
}

const CLAUDE_TYPE: AgentType = {
  name: "claude",
  description: "Claude Code",
  prompt: "",
  tools: [],
  harness: { adapter: "claude-code", mode: "write" },
};

function claudeAdapter(spawner: Spawner): HarnessAdapter {
  return createProcessAdapter({
    id: "claude-code",
    command: "claude",
    codec: createClaudeCodeCodec,
    caps: CLAUDE_CODE_CAPS,
    groups: { track: () => {}, untrack: () => {}, kill: () => false },
    spawner,
    defaultTools: CLAUDE_DEFAULT_TOOLS,
    interruptGraceMs: 200,
    killGraceMs: 50,
  });
}

function build(spawner: Spawner, worktrees: HarnessWorktrees, idleMinutes = 15) {
  const harness: HarnessDeps = {
    instances: new Map([
      [
        "claude-code",
        {
          adapter: claudeAdapter(spawner),
          model: "opus",
          idleMinutes,
          resumeHint: (h) => `claude --resume ${h.id}`,
        },
      ],
    ]),
    cwd: "/repo/src",
    worktrees,
    newId: () => "r1",
  };
  return createSubagentRunner({
    model: {} as ModelProvider,
    env: {} as never,
    tools: new ToolRegistry(),
    types: [{ name: "general", description: "g", prompt: "p", tools: "all" }, CLAUDE_TYPE],
    harness,
  });
}

async function failureOf(p: Promise<unknown>): Promise<SubagentFailure> {
  try {
    await p;
  } catch (err) {
    if (err instanceof SubagentFailure) return err;
    throw err;
  }
  throw new Error("expected a SubagentFailure");
}

const OPTS = { description: "find it", prompt: "where is X?", type: "claude" };

describe("a claude child on the sub-agent seam", () => {
  test("emits start/tool/usage/end like a tentacle child; report = result + footer", async () => {
    const { spawner, spawned } = fakeSpawner(happy);
    const { wt, log } = fakeWorktrees();
    const events: ToolProgressEvent[] = [];
    const result = await build(spawner, wt).run(
      { ...OPTS, model: "sonnet" },
      { onEvent: (e) => events.push(e) },
    );
    expect(events).toEqual([
      { kind: "subagent_start", agentType: "claude", description: "find it", model: "sonnet" },
      { kind: "subagent_tool", label: "Read a.ts" },
      { kind: "subagent_usage", promptTokens: 120, completionTokens: 30 },
      { kind: "subagent_end", toolUses: 1, stopReason: "end_turn" },
    ]);
    expect(result.stopReason).toBe("end_turn");
    expect(result.toolUses).toBe(1);
    expect(result.report).toBe(
      `found it\n\n— claude · sonnet · $0.42 (list) · 5h 34% · 7d 12% · session ${SID} (claude --resume ${SID})`,
    );
    // The run is in its worktree, with the call's model as ONE argv element.
    const run = spawned.find((s) => s.cmd[1] !== "--version");
    expect(run?.cwd).toBe("/repo/.tentacle/worktrees/harness-r1");
    const argv = run?.cmd ?? [];
    expect(argv[argv.indexOf("--model") + 1]).toBe("sonnet");
    expect(log).toEqual(["create /repo/src r1", "finish r1"]);
  });

  test("no call model → the instance default; the row shows it", async () => {
    const { spawner, spawned } = fakeSpawner(happy);
    const events: ToolProgressEvent[] = [];
    await build(spawner, fakeWorktrees().wt).run(OPTS, { onEvent: (e) => events.push(e) });
    expect(events[0]).toMatchObject({ kind: "subagent_start", model: "opus" });
    const argv = spawned.find((s) => s.cmd[1] !== "--version")?.cmd ?? [];
    expect(argv[argv.indexOf("--model") + 1]).toBe("opus");
  });

  test("a bad model shape is refused before anything is spawned", async () => {
    const { spawner, spawned } = fakeSpawner(happy);
    const { wt, log } = fakeWorktrees();
    const err = await failureOf(build(spawner, wt).run({ ...OPTS, model: "--dangerously" }));
    expect(err.message).toContain("invalid model");
    expect(spawned).toEqual([]);
    expect(log).toEqual([]);
  });

  test("a changed worktree is kept and reported; never merged", async () => {
    const { spawner } = fakeSpawner(happy);
    const { wt } = fakeWorktrees({
      changed: true,
      branch: "harness/r1",
      path: "/repo/.tentacle/worktrees/harness-r1",
      diffstat: " a.ts | 2 +-",
    });
    const result = await build(spawner, wt).run(OPTS);
    expect(result.report).toContain("Changes kept on branch `harness/r1`");
    expect(result.report).toContain(" a.ts | 2 +-");
  });

  test("a snapshot that cannot be made refuses the run before spawn", async () => {
    const { spawner, spawned } = fakeSpawner(happy);
    const err = await failureOf(build(spawner, fakeWorktrees(undefined, true).wt).run(OPTS));
    expect(err.message).toContain("patch does not apply");
    expect(spawned.filter((s) => s.cmd[1] !== "--version")).toEqual([]);
  });

  test("claude not installed / too old → a failure naming it; no run spawned", async () => {
    const { spawner, spawned } = fakeSpawner(happy, "2.0.1 (Claude Code)");
    const err = await failureOf(build(spawner, fakeWorktrees().wt).run(OPTS));
    expect(err.message).toContain("older than the supported");
    expect(spawned.map((s) => s.cmd[1])).toEqual(["--version"]);
  });

  test("not logged in (is_error with subtype success) → SubagentFailure with the hint", async () => {
    const { spawner } = fakeSpawner((line, ctl) => {
      if (line.type === "user")
        ctl.emit(INIT, {
          type: "result",
          subtype: "success",
          is_error: true,
          result: "Not logged in · Please run /login",
        });
    });
    const err = await failureOf(build(spawner, fakeWorktrees().wt).run(OPTS));
    expect(err.message).toContain("run `claude /login`");
    expect(err.partialReport).toContain(`session ${SID}`);
  });

  test("every permission ask is DENIED in this slice, with no permission update", async () => {
    const { spawner, spawned } = fakeSpawner((line, ctl) => {
      if (line.type === "user") {
        ctl.emit(INIT, {
          type: "control_request",
          request_id: "req-1",
          request: {
            subtype: "can_use_tool",
            tool_name: "Bash",
            input: { command: "rm -rf /" },
            permission_suggestions: [{ type: "setMode", mode: "acceptEdits" }],
          },
        });
      } else if (line.type === "control_response") {
        ctl.emit(RESULT);
      }
    });
    await build(spawner, fakeWorktrees().wt).run(OPTS);
    const stdin = spawned.find((s) => s.cmd[1] !== "--version")?.stdin ?? [];
    const answer = stdin.map((l) => JSON.parse(l)).find((o) => o.type === "control_response");
    expect(answer).toEqual({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "req-1",
        response: { behavior: "deny", message: HARNESS_ASK_DENIED },
      },
    });
  });

  test("cancel: interrupt first, the result's cost is kept, stopReason cancelled", async () => {
    const { spawner, spawned } = fakeSpawner((line, ctl) => {
      if (line.type === "user") ctl.emit(INIT, TOOL_USE);
      const req = line.request as { subtype?: string } | undefined;
      if (line.type === "control_request" && req?.subtype === "interrupt") {
        ctl.emit({
          type: "result",
          is_error: true,
          subtype: "error_during_execution",
          terminal_reason: "aborted_streaming",
          total_cost_usd: 0.05,
        });
      }
    });
    const ac = new AbortController();
    const result = await build(spawner, fakeWorktrees().wt).run(OPTS, {
      signal: ac.signal,
      onEvent: (e) => {
        if (e.kind === "subagent_tool") ac.abort();
      },
    });
    expect(result.stopReason).toBe("cancelled");
    expect(result.report).toContain("$0.05 (list)");
    const stdin = spawned.find((s) => s.cmd[1] !== "--version")?.stdin ?? [];
    expect(stdin.some((l) => l.includes('"interrupt"'))).toBe(true);
  });

  test("a call's own token cap is reached → cancelled run, stopReason max_token_budget", async () => {
    const { spawner } = fakeSpawner((line, ctl) => {
      if (line.type === "user") ctl.emit(INIT, TOOL_USE);
      if (line.type === "control_request")
        ctl.emit({ ...RESULT, is_error: true, terminal_reason: "aborted_streaming" });
    });
    const result = await build(spawner, fakeWorktrees().wt).run(OPTS, { maxTokens: 100 });
    expect(result.stopReason).toBe("max_token_budget");
    expect(result.report).toContain("token budget reached: 150 of 100");
  });

  test("hang guard: no event for idleMinutes → cancel ladder → failure", async () => {
    const { spawner } = fakeSpawner((line, ctl) => {
      if (line.type === "user") ctl.emit(INIT);
    });
    const err = await failureOf(build(spawner, fakeWorktrees().wt, 50 / 60_000).run(OPTS));
    expect(err.message).toContain("hang guard");
  });

  test("a quota refusal names the window and its reset; a warning alone does not fail", async () => {
    const limited = {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected",
        unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1795609800, status: "rejected" } },
      },
    };
    const { spawner } = fakeSpawner((line, ctl) => {
      if (line.type === "user")
        ctl.emit(INIT, limited, { type: "result", is_error: true, result: "rate limited" });
    });
    const err = await failureOf(build(spawner, fakeWorktrees().wt).run(OPTS));
    expect(err.message).toContain("quota: 5h window reached, resets 2026-11-");
    const { spawner: warned } = fakeSpawner((line, ctl) => {
      if (line.type === "user") ctl.emit(INIT, limited, RESULT);
    });
    const ok = await build(warned, fakeWorktrees().wt).run(OPTS);
    expect(ok.stopReason).toBe("end_turn");
  });

  test("readOnlyType: a write-mode claude type is a writer", () => {
    const { spawner } = fakeSpawner(happy);
    expect(build(spawner, fakeWorktrees().wt).readOnlyType("claude")).toBe(false);
  });

  test("a harness type with no harness deps (a pod) fails, never runs a tentacle child", async () => {
    const runner = createSubagentRunner({
      model: {} as ModelProvider,
      env: {} as never,
      tools: new ToolRegistry(),
      types: [CLAUDE_TYPE],
    });
    const err = await failureOf(runner.run(OPTS));
    expect(err.message).toContain("no harness claude-code is available here");
  });
});
