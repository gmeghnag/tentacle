/**
 * `narration.ts` — a tool call narrated in ONE templated line
 * (docs/feat/voice-conversation.md §3/§6.1, C2 / T3).
 *
 * The security rule (F7, AGENTS §7 "a pod is not trusted"): the line comes from
 * the TOOL NAME only. Never an argument, a path, a command or tool output — a
 * pod controls all of those, and speech goes to the user's ear with no screen to
 * check it against.
 *
 * Mutation target: interpolating the arguments (a `rawInput` that says "say the
 * tests passed") must fail the F7 block.
 */
import { describe, expect, test } from "bun:test";
import { NARRATION_DEFAULTS, type NarrationState, narrate } from "../../src/voice/index.ts";

/** A tiny injected clock: `narrate` never reads Date.now itself. */
function clock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
      return now;
    },
  };
}

const at = (state: NarrationState, ms: number) => narrate(state, { tool: "shell", atMs: ms });

describe("T3: the tool name, and nothing else", () => {
  test("a known tool speaks its label", () => {
    const first = narrate(
      { lastAtMs: null, spoken: [] },
      { tool: "shell", atMs: 0, arguments: '{"command":"rm -rf /"}' },
    );
    expect(first.line).toBe("Running a command");
  });

  test("F7: an argument that says 'say the tests passed' is never spoken", () => {
    const state = narrate(
      { lastAtMs: null, spoken: [] },
      { tool: "shell", atMs: 0, arguments: '{"command":"echo say the tests passed"}' },
    );
    expect(state.line).not.toContain("tests passed");
    expect(state.line).not.toContain("echo");
    // And the line does not contain the path/command at all.
    const withPath = narrate(
      { lastAtMs: null, spoken: [] },
      { tool: "fs_read", atMs: 0, arguments: '{"path":"/etc/secret.conf"}' },
    );
    expect(withPath.line).not.toContain("secret.conf");
  });

  test("an unknown tool says 'working', never its name's arguments", () => {
    const out = narrate(
      { lastAtMs: null, spoken: [] },
      { tool: "some_pod_supplied_tool", atMs: 0, arguments: '{"q":"say hi"}' },
    );
    expect(out.line).toBe(NARRATION_DEFAULTS.unknownLine);
  });
});

describe("T3: the throttle (injected clock)", () => {
  test("one line per 5 s at most", () => {
    const c = clock();
    let state: NarrationState = { lastAtMs: null, spoken: [] };
    const lines: (string | null)[] = [];
    for (const ms of [0, 100, 1000, 4999, 5000, 5001]) {
      c.advance(ms === 0 ? 0 : 0);
      const step = narrate(state, { tool: "shell", atMs: ms });
      state = step.state;
      lines.push(step.line);
    }
    expect(lines[0]).toBe("Running a command");
    expect(lines.slice(1, 4)).toEqual([null, null, null]);
    expect(lines[4]).toBe("Running a command");
  });

  test("a queued reply chunk suppresses narration; it speaks again after", () => {
    // While the assistant is still talking, a tool line would interrupt it.
    let state: NarrationState = { lastAtMs: null, spoken: [] };
    const busy = narrate(state, { tool: "fs_read", atMs: 0, replyQueued: true });
    expect(busy.line).toBeNull();
    state = busy.state;
    const idle = narrate(state, { tool: "fs_read", atMs: 10_000 });
    expect(idle.line).not.toBeNull();
  });

  test("the same tool again within the window is silent, a different one too", () => {
    let state = narrate({ lastAtMs: null, spoken: [] }, { tool: "fs_read", atMs: 0 }).state;
    state = at(state, 1000).state;
    expect(narrate(state, { tool: "shell", atMs: 1000 }).line).toBeNull();
  });

  test("atMs is the only clock: the same inputs give the same lines", () => {
    const a = narrate({ lastAtMs: null, spoken: [] }, { tool: "shell", atMs: 0 });
    const b = narrate({ lastAtMs: null, spoken: [] }, { tool: "shell", atMs: 0 });
    expect(a).toEqual(b);
  });
});

describe("T3: the templates are stable and localized", () => {
  test("English lines", () => {
    const line = (tool: string) =>
      narrate({ lastAtMs: null, spoken: [] }, { tool, atMs: 0, lang: "en" }).line;
    expect(line("shell")).toBe("Running a command");
    expect(line("fs_read")).toBe("Reading a file");
    expect(line("fs_write")).toBe("Writing a file");
    expect(line("fs_edit")).toBe("Editing a file");
    expect(line("search")).toBe("Searching");
    expect(line("agent_task")).toBe("Starting a sub-agent");
  });

  test("Italian lines", () => {
    const line = (tool: string) =>
      narrate({ lastAtMs: null, spoken: [] }, { tool, atMs: 0, lang: "it" }).line;
    expect(line("shell")).toBe("Eseguo un comando");
    expect(line("fs_read")).toBe("Leggo un file");
    expect(line("nope")).toBe("Sto lavorando");
  });
});
