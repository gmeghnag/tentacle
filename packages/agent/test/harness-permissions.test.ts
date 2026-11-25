/**
 * Slice shr-5 (docs/feat/subagent-harness-runners.md D4): a harness child's
 * permission ask reaches the ONE broker through the session's gate and
 * `subagentRequester`; auto mode is the broker's alone; the in-worktree rule
 * passes only Edit/Write inside the run's worktree, after hooks.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ExecutionEnvironment,
  type ModelProvider,
  NO_CAPABILITIES,
  type PermissionRequest,
  type PermissionRequestOptions,
  type PermissionRequester,
  type PermissionResponse,
  type SessionCapabilities,
  type Tool,
  autoApproves,
} from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import type { HarnessDeps, HarnessWorktrees } from "../src/harness/child.ts";
import {
  CLAUDE_CODE_CAPS,
  CLAUDE_DEFAULT_TOOLS,
  createClaudeCodeCodec,
} from "../src/harness/claude-code.ts";
import {
  HARNESS_ASK_DENIED,
  type HarnessPermissions,
  authorizeHarnessAsk,
  insideWorktree,
} from "../src/harness/permissions.ts";
import { type HarnessProc, type Spawner, createProcessAdapter } from "../src/harness/process.ts";
import { HookRunner } from "../src/hooks.ts";
import { SessionGrants } from "../src/session-grants.ts";
import { type AgentType, createSubagentRunner } from "../src/subagent.ts";

const enc = new TextEncoder();

interface Ask {
  readonly req: PermissionRequest;
  readonly options: PermissionRequestOptions | undefined;
  answer(r: PermissionResponse): void;
}

/** The session's ONE requester: records every ask; `auto` answers like auto-accept ON. */
class SpyBroker {
  readonly asks: Ask[] = [];
  constructor(private readonly auto = false) {}
  readonly request: PermissionRequester = (req, options) =>
    new Promise<PermissionResponse>((resolve) => {
      this.asks.push({ req, options, answer: resolve });
      if (this.auto && autoApproves(req)) {
        resolve({ allowed: true, auto: true });
        return;
      }
      options?.signal?.addEventListener(
        "abort",
        () => resolve({ allowed: false, dismissed: true }),
        { once: true },
      );
    });
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 2));
  }
}

// ---- a fake `claude` behind the real process transport + codec ----

const INIT = {
  type: "system",
  subtype: "init",
  session_id: "s-1",
  tools: [...CLAUDE_DEFAULT_TOOLS],
  permissionMode: "default",
  claude_code_version: "2.1.331",
};
const RESULT = { type: "result", is_error: false, result: "done", total_cost_usd: 0.01 };

function askLine(tool: string, input: unknown) {
  return {
    type: "control_request",
    request_id: "req-1",
    request: {
      subtype: "can_use_tool",
      tool_name: tool,
      input,
      tool_use_id: "toolu_1",
      permission_suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
    },
  };
}

interface Spawned {
  cmd: readonly string[];
  stdin: Record<string, unknown>[];
}

/** Asks once with `tool`/`input`; ends on our answer (or on an interrupt). */
function fakeClaude(tool: string, input: unknown) {
  const spawned: Spawned[] = [];
  const spawner: Spawner = (cmd) => {
    const rec: Spawned = { cmd, stdin: [] };
    spawned.push(rec);
    let out: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stdout = new ReadableStream<Uint8Array>({
      start: (c) => {
        out = c;
      },
    });
    const stderr = new ReadableStream<Uint8Array>({ start: (c) => c.close() });
    let resolveExit: (code: number) => void = () => {};
    const exited = new Promise<number>((r) => {
      resolveExit = r;
    });
    let done = false;
    let interrupted = false;
    const emit = (o: unknown): void => {
      if (!done) out?.enqueue(enc.encode(`${JSON.stringify(o)}\n`));
    };
    const exit = (code: number): void => {
      if (done) return;
      done = true;
      out?.close();
      resolveExit(code);
    };
    if (cmd[1] === "--version") {
      emit("2.1.331 (Claude Code)");
      queueMicrotask(() => exit(0));
    }
    const proc: HarnessProc = {
      pid: 4343,
      write: (data) => {
        for (const line of data.split("\n").filter((l) => l !== "")) {
          const o = JSON.parse(line) as Record<string, unknown>;
          rec.stdin.push(o);
          const req = o.request as { subtype?: string } | undefined;
          if (o.type === "user") {
            emit(INIT);
            emit(askLine(tool, input));
          } else if (o.type === "control_response") {
            // Claude goes on with its turn after an answer: the result comes later.
            setTimeout(() => {
              if (!interrupted) emit(RESULT);
            }, 20);
          } else if (o.type === "control_request" && req?.subtype === "interrupt") {
            interrupted = true;
            emit({
              ...RESULT,
              subtype: "error_during_execution",
              is_error: true,
              result: "",
              terminal_reason: "aborted_streaming",
            });
          }
        }
      },
      endInput: () => exit(0),
      stdout,
      stderr,
      exited,
      kill: () => exit(137),
    };
    return proc;
  };
  const answer = () =>
    spawned.find((s) => s.cmd[1] !== "--version")?.stdin.find((o) => o.type === "control_response");
  return { spawner, answer };
}

const CLAUDE_TYPE: AgentType = {
  name: "claude",
  description: "Claude Code",
  prompt: "",
  tools: [],
  harness: { adapter: "claude-code", mode: "write" },
};

function build(
  spawner: Spawner,
  broker: SpyBroker | undefined,
  worktreePath = "/nowhere",
  capabilities?: () => SessionCapabilities,
) {
  const worktrees: HarnessWorktrees = {
    create: async ({ id }) => ({
      id,
      path: worktreePath,
      branch: `harness/${id}`,
      baseline: "abc",
      repoRoot: "/repo",
    }),
    finish: async () => ({ changed: false }),
  };
  const harness: HarnessDeps = {
    instances: new Map([
      [
        "claude-code",
        {
          adapter: createProcessAdapter({
            id: "claude-code",
            command: "claude",
            codec: createClaudeCodeCodec,
            caps: CLAUDE_CODE_CAPS,
            groups: { track: () => {}, untrack: () => {}, kill: () => false },
            spawner,
            defaultTools: CLAUDE_DEFAULT_TOOLS,
            interruptGraceMs: 200,
            killGraceMs: 50,
          }),
          model: "opus",
          idleMinutes: 15,
        },
      ],
    ]),
    cwd: "/repo",
    worktrees,
    newId: () => "r1",
  };
  return createSubagentRunner({
    model: {} as ModelProvider,
    env: {} as never,
    tools: new ToolRegistry(),
    types: [CLAUDE_TYPE],
    harness,
    ...(broker ? { requestPermission: broker.request } : {}),
    ...(capabilities ? { capabilities } : {}),
  });
}

const OPTS = { description: "fix it", prompt: "fix X", type: "claude" };

describe("a claude child's asks reach the ONE broker", () => {
  test("Bash: attributed to the parent call; allow → updatedInput, no permission updates", async () => {
    const broker = new SpyBroker();
    const { spawner, answer } = fakeClaude("Bash", { command: "make test", description: "run" });
    const p = build(spawner, broker).run(OPTS, { toolCallId: "call-1" });
    await until(() => broker.asks.length === 1);
    const ask = broker.asks[0];
    expect(ask?.req).toMatchObject({ tool: "shell", detail: "make test" });
    expect(ask?.options).toMatchObject({
      toolCallId: "call-1",
      origin: "subagent",
      agent: { type: "claude", description: "fix it" },
    });
    ask?.answer({ allowed: true, scope: "once" });
    await p;
    // Exactly allow + the approved input: Claude's suggestions are never echoed.
    expect(answer()).toEqual({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "req-1",
        response: {
          behavior: "allow",
          updatedInput: { command: "make test", description: "run" },
        },
      },
    });
  });

  test("a background child's ask carries its sa-N id and its own signal", async () => {
    const broker = new SpyBroker();
    const { spawner } = fakeClaude("Bash", { command: "ls" });
    const signal = new AbortController().signal;
    const p = build(spawner, broker).run(OPTS, { toolCallId: "call-1", agentId: "sa-3", signal });
    await until(() => broker.asks.length === 1);
    expect(broker.asks[0]?.options?.agent).toMatchObject({ type: "claude", id: "sa-3" });
    expect(broker.asks[0]?.options?.signal).toBe(signal);
    broker.asks[0]?.answer({ allowed: false });
    await p;
  });

  test("auto-accept ON: the BROKER answers a Bash ask (harness code never does)", async () => {
    const broker = new SpyBroker(true);
    const { spawner, answer } = fakeClaude("Bash", { command: "rm -rf build" });
    await build(spawner, broker).run(OPTS, { toolCallId: "call-1" });
    expect(broker.asks.map((a) => a.req.tool)).toEqual(["shell"]);
    expect(answer()).toMatchObject({ response: { response: { behavior: "allow" } } });
  });

  test("a refusal reaches Claude as deny with the broker's message", async () => {
    const broker = new SpyBroker();
    const { spawner, answer } = fakeClaude("Write", { file_path: "/etc/x", content: "y" });
    const p = build(spawner, broker).run(OPTS, { toolCallId: "call-1" });
    await until(() => broker.asks.length === 1);
    broker.asks[0]?.answer({ allowed: false, message: "not there" });
    await p;
    expect(answer()).toMatchObject({
      response: { response: { behavior: "deny", message: `${HARNESS_ASK_DENIED}: not there` } },
    });
  });

  test("a tool switched off for the session is refused even with auto-accept ON (never asked)", async () => {
    const broker = new SpyBroker(true);
    const { spawner, answer } = fakeClaude("Bash", { command: "env" });
    const off = () => ({ ...NO_CAPABILITIES, disabledTools: ["shell"] });
    await build(spawner, broker, "/nowhere", off).run(OPTS, { toolCallId: "call-1" });
    expect(broker.asks).toEqual([]);
    expect(answer()).toMatchObject({ response: { response: { behavior: "deny" } } });
    expect(JSON.stringify(answer())).toContain("turned off for this session");
  });

  test("no requester wired → every ask denied", async () => {
    const { spawner, answer } = fakeClaude("Bash", { command: "ls" });
    await build(spawner, undefined).run(OPTS);
    expect(answer()).toMatchObject({
      response: { response: { behavior: "deny", message: HARNESS_ASK_DENIED } },
    });
  });

  test("cancel while an ask is pending withdraws it; the run ends cancelled", async () => {
    const broker = new SpyBroker();
    const { spawner } = fakeClaude("Bash", { command: "ls" });
    const stop = new AbortController();
    const p = build(spawner, broker).run(OPTS, { toolCallId: "call-1", signal: stop.signal });
    await until(() => broker.asks.length === 1);
    stop.abort();
    const result = await p;
    expect(result.stopReason).toBe("cancelled");
  });
});

// ---- the bridge itself: gate, hooks, grants, the in-worktree rule ----

let base = "";
let wt = "";
let outside = "";
beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "shr5-"));
  wt = join(base, "wt");
  outside = join(base, "outside");
  await mkdir(join(wt, "src"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(wt, ".git"), "gitdir: /repo/.git/worktrees/x\n");
  await symlink(outside, join(wt, "out-dir"));
  await writeFile(join(outside, "target.txt"), "x");
  await symlink(join(outside, "target.txt"), join(wt, "src", "link.txt"));
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

function perms(broker: SpyBroker, over: Partial<HarnessPermissions> = {}): HarnessPermissions {
  return { requester: broker.request, grants: new SessionGrants(), sessionId: "s", ...over };
}

const call = () => ({ askId: "a1", signal: new AbortController().signal, worktreeRoot: wt });

/** Decide one ask; a broker ask is answered `allowed: false` so the decision settles. */
async function decide(p: HarnessPermissions, broker: SpyBroker, tool: string, input: unknown) {
  const out = authorizeHarnessAsk(p, { type: "permission", tool, input }, call());
  const settled = await Promise.race([out, new Promise((r) => setTimeout(r, 20, "pending"))]);
  if (settled === "pending") {
    for (const a of broker.asks) a.answer({ allowed: false });
  }
  return out;
}

describe("auto mode OFF: the in-worktree rule", () => {
  test("Write/Edit inside the worktree pass with no broker request", async () => {
    const broker = new SpyBroker();
    const p = perms(broker);
    const w = await decide(p, broker, "Write", {
      file_path: join(wt, "src/new/a.ts"),
      content: "",
    });
    const e = await decide(p, broker, "Edit", {
      file_path: "src/b.ts",
      old_string: "a",
      new_string: "b",
    });
    expect(w).toEqual({ allow: true, input: { file_path: join(wt, "src/new/a.ts"), content: "" } });
    expect(e.allow).toBe(true);
    expect(broker.asks).toEqual([]);
  });

  test("a switched-off fs_write/fs_edit is refused even inside the worktree, read LIVE per ask", async () => {
    const broker = new SpyBroker();
    let disabled: string[] = [];
    const p = perms(broker, {
      capabilities: () => ({ ...NO_CAPABILITIES, disabledTools: disabled }),
    });
    const write = { file_path: join(wt, "a.ts"), content: "" };
    expect((await decide(p, broker, "Write", write)).allow).toBe(true);
    disabled = ["fs_write", "fs_edit"];
    const w = await decide(p, broker, "Write", write);
    const e = await decide(p, broker, "Edit", {
      file_path: "b.ts",
      old_string: "a",
      new_string: "b",
    });
    expect(w).toMatchObject({ allow: false });
    expect(e).toMatchObject({ allow: false });
    expect(broker.asks).toEqual([]);
  });

  test("outside, `..`, through a symlink dir or file, `.git`, and Bash are asked", async () => {
    const broker = new SpyBroker();
    const p = perms(broker);
    const paths = [
      join(outside, "x"),
      join(wt, "src", "..", "..", "x"),
      "../x",
      join(wt, "out-dir", "x"),
      join(wt, "src", "link.txt"),
      join(wt, ".git"),
    ];
    for (const file_path of paths) {
      expect((await decide(p, broker, "Write", { file_path, content: "" })).allow).toBe(false);
    }
    expect((await decide(p, broker, "Bash", { command: "touch src/a" })).allow).toBe(false);
    expect(broker.asks.map((a) => a.req.tool)).toEqual([...paths.map(() => "fs_write"), "shell"]);
  });

  test("no worktree (no write run) → an in-tree Write is asked", async () => {
    const broker = new SpyBroker();
    const p = perms(broker);
    const out = authorizeHarnessAsk(
      p,
      { type: "permission", tool: "Write", input: { file_path: join(wt, "a"), content: "" } },
      { askId: "a1", signal: new AbortController().signal },
    );
    await until(() => broker.asks.length === 1);
    broker.asks[0]?.answer({ allowed: true });
    expect((await out).allow).toBe(true);
  });

  test("insideWorktree: a relative path is resolved against the worktree root", async () => {
    expect(await insideWorktree(wt, "src/a.ts")).toBe(true);
    expect(await insideWorktree(wt, "../outside/a.ts")).toBe(false);
    expect(await insideWorktree(wt, "")).toBe(false);
  });
});

function hookRunner(stdout: unknown, exitCode = 0): HookRunner {
  const env = {
    exec: async () => ({ stdout: JSON.stringify(stdout), stderr: "", exitCode }),
  } as unknown as ExecutionEnvironment;
  return new HookRunner({
    specs: [{ event: "tool_call", command: "guard" }],
    env,
    cwd: "/w",
  });
}

describe("the gate's hooks and grants apply", () => {
  test("a tool_call hook blocking an in-worktree Write wins", async () => {
    const broker = new SpyBroker();
    const p = perms(broker, { hooks: hookRunner({ decision: "deny", reason: "frozen" }) });
    const d = await decide(p, broker, "Write", { file_path: join(wt, "src/a.ts"), content: "" });
    expect(d).toEqual({ allow: false, message: "blocked by a tentacle hook (guard): frozen" });
    expect(broker.asks).toEqual([]);
  });

  test("a hook rewrite reaches Claude as updatedInput", async () => {
    const broker = new SpyBroker(true);
    const p = perms(broker, {
      hooks: hookRunner({ decision: "allow", input: { command: "make test -j1" } }),
    });
    const d = await decide(p, broker, "Bash", { command: "make test", description: "run" });
    expect(d).toEqual({ allow: true, input: { command: "make test -j1", description: "run" } });
  });

  test("a hook that rewrites an in-worktree path to outside is asked, not passed", async () => {
    const broker = new SpyBroker();
    const p = perms(broker, {
      hooks: hookRunner({ input: { path: join(outside, "y"), content: "" } }),
    });
    const d = await decide(p, broker, "Write", { file_path: join(wt, "src/a.ts"), content: "" });
    expect(broker.asks.map((a) => a.req.detail)).toEqual([join(outside, "y")]);
    expect(d.allow).toBe(false);
  });

  test("a session grant `git status` answers `Bash git status` with no broker request", async () => {
    const broker = new SpyBroker();
    const grants = new SessionGrants();
    const shell = { name: "shell" } as Tool;
    grants.remember(shell, {
      tool: "shell",
      level: "ask",
      title: "Run a shell command",
      input: {},
      suggestion: { prefix: "git status" },
    });
    const d = await decide(perms(broker, { grants }), broker, "Bash", { command: "git status -s" });
    expect(d.allow).toBe(true);
    expect(broker.asks).toEqual([]);
  });

  test("an unknown Claude tool: generic ask; an 'always' answer creates no grant", async () => {
    const broker = new SpyBroker();
    const p = perms(broker);
    for (let i = 0; i < 2; i++) {
      const out = authorizeHarnessAsk(
        p,
        { type: "permission", tool: "WebFetch", input: { url: "https://x" } },
        call(),
      );
      await until(() => broker.asks.length === i + 1);
      broker.asks[i]?.answer({ allowed: true, scope: "session" });
      expect((await out).allow).toBe(true);
    }
    expect(broker.asks.map((a) => a.req.tool)).toEqual(["claude:WebFetch", "claude:WebFetch"]);
    expect(broker.asks[0]?.req).toMatchObject({
      title: "Claude wants WebFetch",
      detail: '{"url":"https://x"}',
    });
    expect(broker.asks[0]?.req.suggestion).toBeUndefined();
  });
});
