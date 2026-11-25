import { describe, expect, test } from "bun:test";
import {
  CLAUDE_CODE_VERSION_FLOOR,
  claudeToolLabel,
  createClaudeCodeCodec,
  isModelShape,
  versionAtLeast,
} from "../src/harness/claude-code.ts";
import type { CliCodec, HarnessRunSpec } from "../src/harness/types.ts";

const spec = (over: Partial<HarnessRunSpec> = {}): HarnessRunSpec => ({
  prompt: "p",
  mode: "write",
  runId: "r1",
  ...over,
});
const parseOne = (codec: CliCodec | undefined, o: unknown) =>
  (codec ?? createClaudeCodeCodec()).parse(JSON.stringify(o));

describe("claude-code argv", () => {
  test("always restricted + stdio permission prompt, never a Claude-side mode", () => {
    const argv = createClaudeCodeCodec().argv(
      spec({ model: "opus", jsonSchema: { a: 1 }, tools: ["Read", "Bash"] }),
    );
    expect(argv).toContain("--restricted");
    expect(
      argv.slice(
        argv.indexOf("--permission-prompt-tool"),
        argv.indexOf("--permission-prompt-tool") + 2,
      ),
    ).toEqual(["--permission-prompt-tool", "stdio"]);
    expect(argv).not.toContain("--permission-mode");
    expect(argv).not.toContain("--dangerously-skip-permissions");
    for (const bad of ["dontAsk", "acceptEdits", "auto", "bypassPermissions"])
      expect(argv).not.toContain(bad);
    expect(argv[argv.indexOf("--tools") + 1]).toBe("Read,Bash");
    expect(argv[argv.indexOf("--json-schema") + 1]).toBe('{"a":1}');
  });

  test("default tools are the write set; the prompt is not in argv", () => {
    const argv = createClaudeCodeCodec().argv(spec({ prompt: "SECRET-PROMPT" }));
    expect(argv[argv.indexOf("--tools") + 1]).toBe("Read,Grep,Glob,Edit,Write,Bash");
    expect(argv.join(" ")).not.toContain("SECRET-PROMPT");
    expect(argv).not.toContain("--model");
  });

  test("--model is exactly one element, verbatim", () => {
    const argv = createClaudeCodeCodec().argv(spec({ model: "claude-opus-5-5" }));
    const i = argv.indexOf("--model");
    expect(argv[i + 1]).toBe("claude-opus-5-5");
    expect(argv.filter((a) => a === "claude-opus-5-5")).toHaveLength(1);
  });

  test("a model that is a flag or has a bad shape never reaches argv", () => {
    for (const bad of [
      "--dangerously-skip-permissions",
      "-x",
      "",
      "a b",
      "a;b",
      "x".repeat(65),
      "a\nb",
    ]) {
      expect(isModelShape(bad)).toBe(false);
      expect(() => createClaudeCodeCodec().argv(spec({ model: bad }))).toThrow();
    }
    for (const ok of ["opus", "claude-opus-5-5", "anthropic.claude:v1", "opus[1m]"])
      expect(isModelShape(ok)).toBe(true);
  });

  test("bad tool names and remote mode are refused", () => {
    expect(() => createClaudeCodeCodec().argv(spec({ tools: ["Bash,Write"] }))).toThrow();
    expect(() => createClaudeCodeCodec().argv(spec({ tools: ["--x"] }))).toThrow();
    expect(() => createClaudeCodeCodec().argv(spec({ mode: "remote" }))).toThrow();
  });
});

describe("claude-code parse (Repro fixtures)", () => {
  test("system/init → started with tools, permissionMode, version", () => {
    const ev = parseOne(undefined, {
      type: "system",
      subtype: "init",
      session_id: "s-1",
      tools: ["Read"],
      permissionMode: "default",
      claude_code_version: "2.1.331",
    });
    expect(ev).toEqual([
      {
        kind: "started",
        handle: { adapter: "claude-code", id: "s-1" },
        detail: { tools: ["Read"], permissionMode: "default", version: "2.1.331" },
      },
    ]);
  });

  test("tool_use → progress label; text and thinking blocks produce none", () => {
    const ev = parseOne(undefined, {
      type: "assistant",
      message: {
        id: "m1",
        content: [
          { type: "thinking", thinking: "" },
          { type: "text", text: "hi" },
          { type: "tool_use", name: "Bash", input: { command: "cat note.txt" } },
        ],
      },
    });
    expect(ev).toEqual([{ kind: "progress", label: "$ cat note.txt" }]);
  });

  test("labels follow childToolLabel's shapes", () => {
    expect(claudeToolLabel("Bash", { command: "ls", description: "List files" })).toBe(
      "List files",
    );
    expect(claudeToolLabel("Read", { file_path: "a.ts" })).toBe("Read a.ts");
    expect(claudeToolLabel("Edit", { file_path: "a.ts" })).toBe("Edit a.ts");
    expect(claudeToolLabel("Write", { file_path: "b.ts" })).toBe("Write b.ts");
    expect(claudeToolLabel("Grep", { pattern: "foo", path: "src" })).toBe("Search foo in src");
    expect(claudeToolLabel("Glob", { pattern: "*.ts" })).toBe("Search *.ts in .");
    expect(claudeToolLabel("WebSearch", {})).toBe("WebSearch");
  });

  test("usage is deduped by message id (the same id repeated reports once)", () => {
    const codec = createClaudeCodeCodec();
    const msg = (id: string, over = {}) => ({
      type: "assistant",
      message: {
        id,
        content: [{ type: "text", text: "x" }],
        usage: {
          input_tokens: 4,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 20,
          output_tokens: 10,
          ...over,
        },
      },
    });
    expect(parseOne(codec, msg("m1"))).toEqual([
      { kind: "usage", promptTokens: 124, completionTokens: 10 },
    ]);
    expect(parseOne(codec, msg("m1"))).toEqual([]);
    // the same id with a larger output count reports only the increase
    expect(parseOne(codec, msg("m1", { output_tokens: 15 }))).toEqual([
      { kind: "usage", promptTokens: 0, completionTokens: 5 },
    ]);
    expect(parseOne(codec, msg("m2"))).toEqual([
      { kind: "usage", promptTokens: 124, completionTokens: 10 },
    ]);
  });

  test("rate_limit_event → one quota per window", () => {
    const ev = parseOne(undefined, {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        rateLimitType: "five_hour",
        unifiedWindows: {
          five_hour: { utilization: 0.06, resetsAt: 100, status: "allowed" },
          seven_day: { utilization: 0.12, resetsAt: 200, status: "allowed" },
        },
      },
    });
    expect(ev).toEqual([
      { kind: "quota", window: "five_hour", utilization: 0.06, resetsAt: 100, allowed: true },
      { kind: "quota", window: "seven_day", utilization: 0.12, resetsAt: 200, allowed: true },
    ]);
  });

  test("a non-allowed rate limit status is not allowed", () => {
    const ev = parseOne(undefined, {
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 9 },
    });
    expect(ev).toEqual([{ kind: "quota", window: "five_hour", resetsAt: 9, allowed: false }]);
  });

  test("control_request can_use_tool → permission ask; suggestions are not carried", () => {
    const ev = parseOne(undefined, {
      type: "control_request",
      request_id: "req-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Write",
        input: { file_path: "o.txt", content: "x" },
        tool_use_id: "t1",
        permission_suggestions: [{ type: "setMode", mode: "acceptEdits" }],
      },
    });
    expect(ev).toEqual([
      {
        kind: "ask",
        askId: "req-1",
        ask: { type: "permission", tool: "Write", input: { file_path: "o.txt", content: "x" } },
      },
    ]);
    expect(JSON.stringify(ev)).not.toContain("acceptEdits");
  });

  test("a control_request of another subtype, and control_response, are ignored", () => {
    expect(
      parseOne(undefined, {
        type: "control_request",
        request_id: "r",
        request: { subtype: "hook_callback" },
      }),
    ).toEqual([]);
    expect(
      parseOne(undefined, {
        type: "control_response",
        response: { subtype: "success", request_id: "int-1" },
      }),
    ).toEqual([]);
  });

  test("result success → completed with text, cost, structured output", () => {
    const ev = parseOne(undefined, {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "HELLO",
      total_cost_usd: 0.00683,
      structured_output: { verdict: "pass", reason: "ok" },
    });
    expect(ev).toEqual([
      {
        kind: "end",
        status: "completed",
        text: "HELLO",
        structured: { verdict: "pass", reason: "ok" },
        costUsd: 0.00683,
      },
    ]);
  });

  test("is_error with subtype success → failed (not logged in, Repro 7)", () => {
    const ev = parseOne(undefined, {
      type: "result",
      subtype: "success",
      is_error: true,
      result: "Not logged in · Please run /login",
    });
    expect(ev?.[0]).toMatchObject({ kind: "end", status: "failed" });
    expect((ev?.[0] as { error: string }).error).toContain("claude /login");
  });

  test("is_error result with another text → failed carrying that text", () => {
    const ev = parseOne(undefined, {
      type: "result",
      subtype: "success",
      is_error: true,
      result: "model not found",
    });
    expect(ev).toEqual([
      { kind: "end", status: "failed", text: "model not found", error: "model not found" },
    ]);
  });

  test("error_max_budget_usd → budget, cost kept (Repro 6)", () => {
    const ev = parseOne(undefined, {
      type: "result",
      subtype: "error_max_budget_usd",
      is_error: true,
      total_cost_usd: 0.0045,
    });
    expect(ev?.[0]).toMatchObject({ kind: "end", status: "budget", costUsd: 0.0045 });
  });

  test("interrupt result (aborted_streaming) → cancelled with cost (Repro 8)", () => {
    const ev = parseOne(undefined, {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      terminal_reason: "aborted_streaming",
      total_cost_usd: 0.01,
    });
    expect(ev).toEqual([{ kind: "end", status: "cancelled", costUsd: 0.01 }]);
  });

  test("garbled line → null; unknown event type → []", () => {
    const codec = createClaudeCodeCodec();
    expect(codec.parse("not json")).toBeNull();
    expect(codec.parse("[1,2]")).toBeNull();
    expect(codec.parse('"x"')).toBeNull();
    expect(codec.parse(JSON.stringify({ type: "future_event", x: 1 }))).toEqual([]);
    expect(codec.parse(JSON.stringify({ type: "system", subtype: "thinking_tokens" }))).toEqual([]);
  });
});

describe("claude-code stdin lines", () => {
  const codec = createClaudeCodeCodec();

  test("allow carries updatedInput and no permission updates", () => {
    const line = JSON.parse(codec.answer("req-1", { allow: true, input: { command: "ls" } }));
    expect(line).toEqual({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "req-1",
        response: { behavior: "allow", updatedInput: { command: "ls" } },
      },
    });
    expect(JSON.stringify(line)).not.toContain("updatedPermissions");
  });

  test("deny carries the message", () => {
    const line = JSON.parse(
      codec.answer("req-2", { allow: false, message: "denied by tentacle broker" }),
    );
    expect(line.response.response).toEqual({
      behavior: "deny",
      message: "denied by tentacle broker",
    });
    expect(line.response.request_id).toBe("req-2");
  });

  test("interrupt and userMessage are single JSON lines", () => {
    const i = codec.interrupt();
    expect(i && JSON.parse(i)).toMatchObject({
      type: "control_request",
      request: { subtype: "interrupt" },
    });
    expect(i).not.toContain("\n");
    const u = codec.userMessage("hello\nworld");
    expect(u).not.toContain("\n");
    expect(JSON.parse(u)).toEqual({
      type: "user",
      message: { role: "user", content: "hello\nworld" },
    });
  });
});

describe("versionAtLeast", () => {
  test("compares major.minor.patch; unreadable is never enough", () => {
    expect(versionAtLeast("2.1.331", CLAUDE_CODE_VERSION_FLOOR)).toBe(true);
    expect(versionAtLeast("2.1.330", CLAUDE_CODE_VERSION_FLOOR)).toBe(false);
    expect(versionAtLeast("2.2.0", CLAUDE_CODE_VERSION_FLOOR)).toBe(true);
    expect(versionAtLeast("10.0.0", "9.9.9")).toBe(true);
    expect(versionAtLeast("2.1.331 (Claude Code)", CLAUDE_CODE_VERSION_FLOOR)).toBe(true);
    expect(versionAtLeast("garbage", CLAUDE_CODE_VERSION_FLOOR)).toBe(false);
  });
});
