import { describe, expect, test } from "bun:test";
import type { ExecOptions, ExecutionEnvironment, HookSpec, ToolResult } from "@tentacle/core";
import {
  HookRunner,
  MAX_HOOK_STDOUT,
  combineToolCallVotes,
  hookMatches,
  hookName,
  parseToolCallOutcome,
  parseToolResultOutcome,
  runResultHooks,
} from "../src/hooks.ts";

const spec = (over: Partial<HookSpec> = {}): HookSpec => ({
  event: "tool_call",
  command: "x",
  ...over,
});
const ok = (stdout: string) => ({ stdout, stderr: "", exitCode: 0 });

describe("hookName", () => {
  test("explicit name, else the basename of the command's first word", () => {
    expect(hookName(spec({ name: "guard" }))).toBe("guard");
    expect(hookName(spec({ command: "~/.config/tentacle/hooks/no-rm.sh --strict" }))).toBe(
      "no-rm.sh",
    );
    expect(hookName(spec({ command: "python3 redact.py" }))).toBe("python3");
  });
});

describe("hookMatches", () => {
  test("no matcher and * match everything", () => {
    expect(hookMatches(spec(), "shell")).toBe(true);
    expect(hookMatches(spec({ matcher: "*" }), "mcp__a__b")).toBe(true);
  });
  test("plain names and a|b alternatives match exactly", () => {
    expect(hookMatches(spec({ matcher: "shell" }), "shell")).toBe(true);
    expect(hookMatches(spec({ matcher: "shell" }), "shell_output")).toBe(false);
    expect(hookMatches(spec({ matcher: "fs_edit|fs_multi_edit" }), "fs_multi_edit")).toBe(true);
    expect(hookMatches(spec({ matcher: "fs_edit|fs_multi_edit" }), "fs_write")).toBe(false);
  });
  test("anything else is an unanchored regex", () => {
    expect(hookMatches(spec({ matcher: "mcp__.*" }), "mcp__gh__issues")).toBe(true);
    expect(hookMatches(spec({ matcher: "mcp__.*" }), "shell")).toBe(false);
  });
});

describe("parseToolCallOutcome", () => {
  test("exit 0 empty → none; JSON decisions; input → modify", () => {
    expect(parseToolCallOutcome(ok(""), undefined)).toEqual({ kind: "none" });
    expect(parseToolCallOutcome(ok('{"decision":"allow"}'), undefined)).toEqual({ kind: "allow" });
    expect(parseToolCallOutcome(ok('{"decision":"ask"}'), undefined)).toEqual({ kind: "ask" });
    expect(parseToolCallOutcome(ok('{"decision":"deny","reason":"no"}'), undefined)).toEqual({
      kind: "deny",
      reason: "no",
    });
    expect(parseToolCallOutcome(ok('{"decision":"deny"}'), undefined)).toEqual({
      kind: "deny",
      reason: "blocked by hook",
    });
    expect(parseToolCallOutcome(ok('{"input":{"a":1}}'), undefined)).toEqual({
      kind: "modify",
      input: { a: 1 },
    });
    expect(parseToolCallOutcome(ok('{"input":{"a":1},"decision":"allow"}'), undefined)).toEqual({
      kind: "modify",
      input: { a: 1 },
      decision: "allow",
    });
  });
  test("exit 2 → deny with stderr (trimmed, clipped; empty → default)", () => {
    expect(
      parseToolCallOutcome({ stdout: "", stderr: " nope \n", exitCode: 2 }, undefined),
    ).toEqual({
      kind: "deny",
      reason: "nope",
    });
    expect(parseToolCallOutcome({ stdout: "", stderr: "", exitCode: 2 }, undefined)).toEqual({
      kind: "deny",
      reason: "blocked by hook",
    });
    const long = parseToolCallOutcome(
      { stdout: "", stderr: "x".repeat(5000), exitCode: 2 },
      undefined,
    );
    expect(long.kind === "deny" && long.reason.length).toBe(2001);
  });
  test("failures: ignore (default) → none + failure; block → deny", () => {
    const failures = [
      ok("not json"),
      ok("[1,2]"),
      ok('{"decision":"maybe"}'),
      ok('{"input":"rm"}'),
      ok(`{"a":"${"x".repeat(MAX_HOOK_STDOUT)}"}`),
      { stdout: "", stderr: "boom", exitCode: 1 },
      "timeout" as const,
      "error" as const,
    ];
    for (const f of failures) {
      const ignored = parseToolCallOutcome(f, undefined);
      expect(ignored.kind).toBe("none");
      expect(ignored.kind === "none" && typeof ignored.failure).toBe("string");
      expect(parseToolCallOutcome(f, "ignore").kind).toBe("none");
      const blocked = parseToolCallOutcome(f, "block");
      expect(blocked.kind === "deny" && blocked.reason.startsWith("hook failed: ")).toBe(true);
    }
  });
});

describe("parseToolResultOutcome", () => {
  test("pass / replace / exit 2 / failures", () => {
    expect(parseToolResultOutcome(ok(""), undefined)).toEqual({ kind: "pass" });
    expect(parseToolResultOutcome(ok("{}"), undefined)).toEqual({ kind: "pass" });
    expect(parseToolResultOutcome(ok('{"content":"new"}'), undefined)).toEqual({
      kind: "replace",
      content: "new",
    });
    expect(parseToolResultOutcome(ok('{"content":"e","is_error":true}'), undefined)).toEqual({
      kind: "replace",
      content: "e",
      isError: true,
    });
    expect(parseToolResultOutcome({ stdout: "", stderr: "bad", exitCode: 2 }, undefined)).toEqual({
      kind: "replace",
      content: "bad",
      isError: true,
    });
    expect(parseToolResultOutcome("timeout", undefined).kind).toBe("pass");
    expect(parseToolResultOutcome(ok('{"content":1}'), "block")).toEqual({
      kind: "replace",
      content: "hook failed: `content` is not a string",
      isError: true,
    });
  });
});

describe("combineToolCallVotes", () => {
  const input = { command: "ls" };
  test("deny short-circuits", () => {
    expect(
      combineToolCallVotes(input, [
        { hook: "a", vote: { kind: "allow" } },
        { hook: "b", vote: { kind: "deny", reason: "r" } },
        { hook: "c", vote: { kind: "ask" } },
      ]),
    ).toEqual({ kind: "deny", reason: "r", hook: "b" });
  });
  test("modify chains; the last modifier is named", () => {
    expect(
      combineToolCallVotes(input, [
        { hook: "a", vote: { kind: "modify", input: { command: "a" } } },
        { hook: "b", vote: { kind: "modify", input: { command: "b" } } },
      ]),
    ).toEqual({ kind: "gate", input: { command: "b" }, modified: true, force: null, hook: "b" });
  });
  test("any ask → force ask; all allow → force allow; allow + none → normal gate", () => {
    expect(
      combineToolCallVotes(input, [
        { hook: "a", vote: { kind: "allow" } },
        { hook: "b", vote: { kind: "ask" } },
      ]),
    ).toMatchObject({ force: "ask" });
    expect(
      combineToolCallVotes(input, [
        { hook: "a", vote: { kind: "allow" } },
        { hook: "b", vote: { kind: "modify", input, decision: "allow" } },
      ]),
    ).toMatchObject({ force: "allow" });
    expect(
      combineToolCallVotes(input, [
        { hook: "a", vote: { kind: "allow" } },
        { hook: "b", vote: { kind: "none" } },
      ]),
    ).toEqual({ kind: "gate", input, modified: false, force: null });
    expect(combineToolCallVotes(input, [])).toEqual({
      kind: "gate",
      input,
      modified: false,
      force: null,
    });
  });
});

function fakeEnv(answer: (command: string, opts?: ExecOptions) => string) {
  const calls: { command: string; opts?: ExecOptions }[] = [];
  const env: ExecutionEnvironment = {
    id: "fake",
    async exec(command, opts) {
      calls.push({ command, ...(opts ? { opts } : {}) });
      return ok(answer(command, opts));
    },
    async readFile() {
      return "";
    },
    async writeFile() {},
  };
  return { env, calls };
}

describe("HookRunner / runResultHooks", () => {
  test("tool_result hooks chain in order; the input JSON carries the result and the effective input", async () => {
    const { env, calls } = fakeEnv((cmd, opts) => {
      const prev = JSON.parse(opts?.stdin ?? "{}").tool_result.content as string;
      return JSON.stringify({ content: `${prev}+${cmd}` });
    });
    const hooks = new HookRunner({
      specs: [
        { event: "tool_result", command: "h1" },
        { event: "tool_call", command: "never" },
        { event: "tool_result", matcher: "fs_read", command: "skipped" },
        { event: "tool_result", command: "h2" },
      ],
      env,
      cwd: "/w",
    });
    const result: ToolResult = { content: "raw" };
    const out = await runResultHooks(result, {
      toolName: "shell",
      toolCallId: "c9",
      sessionId: "s1",
      input: { command: "ls" },
      hooks,
      writeSpill: async () => null,
    });
    expect(out).toEqual({ content: "raw+h1+h2" });
    expect(calls.map((c) => c.command)).toEqual(["h1", "h2"]);
    const first = JSON.parse(calls[0]?.opts?.stdin ?? "{}");
    expect(first).toEqual({
      event: "tool_result",
      session_id: "s1",
      cwd: "/w",
      agent: null,
      tool_name: "shell",
      tool_call_id: "c9",
      tool_input: { command: "ls" },
      tool_result: { content: "raw", is_error: false },
    });
    expect(calls[0]?.opts?.env).toEqual({
      TENTACLE_HOOK_EVENT: "tool_result",
      TENTACLE_PROJECT_DIR: "/w",
    });
  });

  test("without a runner in the context the stage is the identity", async () => {
    const result: ToolResult = { content: "raw" };
    expect(
      await runResultHooks(result, {
        toolName: "shell",
        toolCallId: "c",
        writeSpill: async () => null,
      }),
    ).toBe(result);
  });

  test("an ignored failure is logged and does not change the result", async () => {
    const { env } = fakeEnv(() => "garbage");
    const lines: string[] = [];
    const hooks = new HookRunner({
      specs: [{ event: "tool_result", name: "fmt", command: "x" }],
      env,
      cwd: "/w",
      log: (l) => lines.push(l),
    });
    const out = await hooks.toolResult({
      sessionId: "s",
      toolName: "t",
      toolCallId: "c",
      input: {},
      result: { content: "a" },
    });
    expect(out).toEqual({ content: "a" });
    expect(lines).toEqual(["hook fmt (tool_result) failed, ignored: output is not a JSON object"]);
  });

  const runnerWith = (exec: ExecutionEnvironment["exec"], spec: HookSpec, lines: string[]) =>
    new HookRunner({
      specs: [spec],
      env: { id: "f", exec, readFile: async () => "", writeFile: async () => {} },
      cwd: "/w",
      log: (l) => lines.push(l),
    });
  const call = { sessionId: "s", toolName: "t", toolCallId: "c", input: {} };

  test("a process killed by our timeout is classified as a timeout", async () => {
    const lines: string[] = [];
    const hooks = runnerWith(
      async (_c, o) => {
        await Bun.sleep(o?.timeoutMs ?? 0);
        return { stdout: "", stderr: "", exitCode: 124 };
      },
      { event: "tool_result", name: "slow", command: "x", timeout: 1 },
      lines,
    );
    await hooks.toolResult({ ...call, result: { content: "a" } });
    expect(lines).toEqual(["hook slow (tool_result) failed, ignored: timed out"]);
  });

  test("an exec that throws is reported as a start error, not a crash", async () => {
    const lines: string[] = [];
    const hooks = runnerWith(
      async () => {
        throw new Error("ENOENT");
      },
      { event: "tool_result", name: "gone", command: "x" },
      lines,
    );
    expect(await hooks.toolResult({ ...call, result: { content: "a" } })).toEqual({ content: "a" });
    expect(lines).toEqual(["hook gone (tool_result) failed, ignored: could not be started"]);
  });

  test("a hook killed by the user's cancel is not a failure: no vote, no log, even with onFailure block", async () => {
    const lines: string[] = [];
    const controller = new AbortController();
    const hooks = runnerWith(
      async () => {
        controller.abort();
        return { stdout: "", stderr: "", exitCode: 124 };
      },
      { event: "tool_result", name: "b", command: "x", onFailure: "block" },
      lines,
    );
    const out = await hooks.toolResult({
      ...call,
      result: { content: "a" },
      signal: controller.signal,
    });
    expect(out).toEqual({ content: "a" });
    expect(lines).toEqual([]);
  });

  test("a non-boolean is_error is a failure, not a replace", async () => {
    const lines: string[] = [];
    const hooks = runnerWith(
      async () => ({ stdout: '{"content":"x","is_error":"yes"}', stderr: "", exitCode: 0 }),
      { event: "tool_result", name: "e", command: "x" },
      lines,
    );
    expect(await hooks.toolResult({ ...call, result: { content: "a" } })).toEqual({ content: "a" });
    expect(lines).toEqual(["hook e (tool_result) failed, ignored: `is_error` is not a boolean"]);
  });

  test("a tool_call hook killed by the user's cancel casts no vote (no deny, no log)", async () => {
    const lines: string[] = [];
    const controller = new AbortController();
    const hooks = runnerWith(
      async () => {
        controller.abort();
        return { stdout: "", stderr: "", exitCode: 124 };
      },
      { event: "tool_call", name: "b", command: "x", onFailure: "block" },
      lines,
    );
    const verdict = await hooks.toolCall({ ...call, signal: controller.signal });
    expect(verdict).toEqual({ kind: "gate", input: {}, modified: false, force: null });
    expect(lines).toEqual([]);
  });
});
