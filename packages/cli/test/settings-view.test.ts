/**
 * The `/settings` texts (docs/feat/session-settings-apply.md): pure, one line
 * of JSON each under the config's names, container-set keys marked, any text
 * hidden (it may be the pod's, AGENTS §7).
 */
import { describe, expect, test } from "bun:test";
import {
  DomainErrorCode,
  JsonRpcErrorCode,
  type SessionSettings,
  type SessionSettingsReport,
} from "@tentacle/protocol";
import { RpcError } from "@tentacle/transport";
import {
  changedNotice,
  settingsCommandLines,
  settingsShowLines,
  syncedLines,
  updateFailureLine,
} from "../src/settings-view.ts";

const plain = (lines: readonly { text: string; hint?: string }[]): string[] =>
  lines.map((l) => (l.hint ? `${l.text} ${l.hint}` : l.text));

const report = (r: Partial<SessionSettingsReport>): SessionSettingsReport => ({
  carried: {},
  overridden: {},
  ...r,
});

describe("settingsShowLines: /settings alone", () => {
  /** The block as the user reads it, one array item per row. */
  const block = (lines: readonly { text: string }[]): string[] =>
    (lines[0]?.text ?? "").split("\n");

  test("ALL the session's settings, one block, nested by section, in the table's order; no final line when it matches", () => {
    const mine: SessionSettings = {
      contextWindow: 1000,
      subagentsEnabled: true,
      subagentMaxParallel: 4,
      maxIterations: 3,
      dedupOutput: true,
      toolExecution: "parallel",
    };
    const lines = settingsShowLines(mine, report({ carried: mine }));
    expect(block(lines)).toEqual([
      "{",
      '  "model": {',
      '    "contextWindow": 1000',
      "  },",
      '  "subagents": {',
      '    "enabled": true,',
      '    "maxParallel": 4',
      "  },",
      '  "maxIterations": 3,',
      '  "tools": {',
      '    "dedupOutput": true,',
      '    "execution": "parallel"',
      "  }",
      "}",
    ]);
    expect(lines).toHaveLength(1);
  });

  test("the block is JSON once the comments are gone", () => {
    const mine: SessionSettings = { maxIterations: 3, dedupOutput: true, contextWindow: 1 };
    const lines = settingsShowLines(mine, report({ carried: { ...mine, maxIterations: 5 } }));
    const json = block(lines)
      .map((row) => row.replace(/ \/\/ .*$/, ""))
      .join("\n");
    expect(JSON.parse(json)).toEqual({
      model: { contextWindow: 1 },
      maxIterations: 5,
      tools: { dedupOutput: true },
    });
  });

  test("a difference is an end-of-line comment after the comma; the final line counts them, its command in the hint", () => {
    const lines = settingsShowLines(
      { maxIterations: 3, dedupOutput: true, toolExecution: "sequential" },
      report({ carried: { maxIterations: 5, dedupOutput: true, toolExecution: "parallel" } }),
    );
    expect(block(lines)).toEqual([
      "{",
      '  "maxIterations": 5, // this terminal: 3',
      '  "tools": {',
      '    "dedupOutput": true,',
      '    "execution": "parallel" // this terminal: "sequential"',
      "  }",
      "}",
    ]);
    expect(lines[1]).toEqual({
      text: "2 differs from this terminal",
      hint: "(/settings sync to use this terminal's values)",
    });
    expect(lines).toHaveLength(2);
  });

  test("a container-set key is marked, with this terminal's value when it differs, and is never counted", () => {
    // Mutation: drop the container exclusion → "1 differs" promises a change a sync cannot make.
    const lines = settingsShowLines(
      { maxIterations: 3, dedupOutput: false },
      report({
        carried: { maxIterations: 7, dedupOutput: false },
        containerKeys: ["maxIterations"],
      }),
    );
    expect(block(lines)).toEqual([
      "{",
      '  "maxIterations": 7, // (container) this terminal: 3',
      '  "tools": {',
      '    "dedupOutput": false',
      "  }",
      "}",
    ]);
    expect(lines).toHaveLength(1);
  });

  test("a container-set key equal to this terminal's: only the mark", () => {
    const lines = settingsShowLines(
      { maxIterations: 7 },
      report({ carried: { maxIterations: 7 }, containerKeys: ["maxIterations"] }),
    );
    expect(block(lines)).toEqual(["{", '  "maxIterations": 7 // (container)', "}"]);
  });

  test("an overridden key is container-set too, with the container's value", () => {
    const lines = settingsShowLines(
      { maxIterations: 3 },
      report({ carried: { maxIterations: 3 }, overridden: { maxIterations: 9 } }),
    );
    expect(block(lines)).toEqual([
      "{",
      '  "maxIterations": 9 // (container) this terminal: 3',
      "}",
    ]);
    expect(lines).toHaveLength(1);
  });

  test("a value only one side has: (default) on the other, and it counts", () => {
    const onlySession = settingsShowLines({}, report({ carried: { contextWindow: 9000 } }));
    expect(block(onlySession)).toEqual([
      "{",
      '  "model": {',
      '    "contextWindow": 9000 // this terminal: (default)',
      "  }",
      "}",
    ]);
    expect(onlySession[1]?.text).toBe("1 differs from this terminal");
    const onlyMine = settingsShowLines({ contextWindow: 9000 }, report({}));
    expect(block(onlyMine)).toEqual([
      "{",
      '  "model": {',
      '    "contextWindow": "(default)" // this terminal: 9000',
      "  }",
      "}",
    ]);
    expect(onlyMine[1]?.text).toBe("1 differs from this terminal");
  });

  test("nothing at all: an empty block", () => {
    expect(settingsShowLines({}, report({}))).toEqual([{ text: "{}" }]);
  });

  test("names the laptop does not know are dropped; any text is hidden", () => {
    const lines = plain(
      settingsShowLines(
        { agentTaskDescription: "my plan" },
        report({
          carried: { agentTaskDescription: "pod words" },
          containerKeys: ["evil name", "__proto__"],
        }),
      ),
    );
    expect(lines.join("\n")).not.toContain("pod words");
    expect(lines.join("\n")).not.toContain("my plan");
    expect(lines.join("\n")).not.toContain("evil");
    expect(lines[0]?.split("\n")).toEqual([
      "{",
      '  "subagents": {',
      '    "agentTaskDescription": "(text differs)" // this terminal: (text differs)',
      "  }",
      "}",
    ]);
    expect(lines[1]).toBe(
      "1 differs from this terminal (/settings sync to use this terminal's values)",
    );
  });

  test("the same description text reads '(same text)', with no comment", () => {
    const mine = { agentTaskDescription: "x" };
    expect(block(settingsShowLines(mine, report({ carried: mine })))).toContain(
      '    "agentTaskDescription": "(same text)"',
    );
  });
});

describe("settingsCommandLines: the states around a report", () => {
  test("not open yet / no report / a report", () => {
    expect(plain(settingsCommandLines({}, { open: false }))).toEqual([
      "The session is not open yet: it starts with this terminal's settings.",
    ]);
    expect(plain(settingsCommandLines({}, { open: true }))).toEqual([
      "This session takes its settings from the container's own config.",
    ]);
    expect(settingsCommandLines({}, { open: true, report: report({}) })).toEqual([{ text: "{}" }]);
  });
});

describe("changedNotice: another terminal's apply", () => {
  test("only the keys whose running value changed, with the new values", () => {
    // Mutation: list unchanged keys → "tools.dedupOutput" appears.
    const previous = report({ carried: { maxIterations: 1, dedupOutput: true } });
    const next = report({ carried: { maxIterations: 3, dedupOutput: true } });
    expect(changedNotice({}, previous, next)).toBe(
      'Session settings changed by another terminal: { "maxIterations": 3 }',
    );
  });

  test("nothing changed: no notice", () => {
    const same = report({ carried: { maxIterations: 3 } });
    expect(changedNotice({}, same, same)).toBeNull();
  });

  test("no earlier report: every key", () => {
    expect(changedNotice({}, undefined, report({ carried: { maxIterations: 3 } }))).toBe(
      'Session settings changed by another terminal: { "maxIterations": 3 }',
    );
  });

  test("a key that became container-set is news, marked; a dropped key reads (default)", () => {
    const previous = report({ carried: { maxIterations: 7, contextWindow: 10 } });
    const next = report({ carried: { maxIterations: 7 }, containerKeys: ["maxIterations"] });
    expect(changedNotice({}, previous, next)).toBe(
      'Session settings changed by another terminal: { "model.contextWindow": "(default)", "maxIterations": 7 (container) }',
    );
  });

  test("text stays hidden", () => {
    const text = changedNotice(
      {},
      report({}),
      report({ carried: { agentTaskDescription: "pod words" } }),
    );
    expect(text).not.toContain("pod words");
  });
});

describe("syncedLines and updateFailureLine: the sync's outcome", () => {
  test("applied: the confirmation, then what the container keeps", () => {
    const mine: SessionSettings = { maxIterations: 3 };
    expect(
      plain(
        syncedLines(mine, {
          applied: true,
          settings: { carried: mine, overridden: { maxIterations: 9 } },
        }),
      ),
    ).toEqual(["Session settings synced.", 'Container config: { "maxIterations": 9 }']);
    expect(
      plain(syncedLines(mine, { applied: true, settings: { carried: mine, overridden: {} } })),
    ).toEqual(["Session settings synced."]);
  });

  test("not applied: the daemon decides by its own config", () => {
    expect(plain(syncedLines({}, { applied: false }))).toEqual([
      "This session takes its settings from the container's own config: nothing to sync.",
    ]);
  });

  test("each refusal by its code, never by its text", () => {
    const line = (error: unknown) => updateFailureLine(error).text;
    expect(line(new RpcError(DomainErrorCode.TurnInProgress, "x"))).toBe(
      "Can't sync settings while a turn is running.",
    );
    expect(line(new RpcError(DomainErrorCode.CompactInProgress, "x"))).toBe(
      "Can't sync settings while a compaction is running.",
    );
    expect(line(new RpcError(JsonRpcErrorCode.MethodNotFound, "x"))).toBe(
      "This container's tentacle predates /settings sync: quit and attach again to update it.",
    );
    expect(
      line(
        new RpcError(
          JsonRpcErrorCode.InternalError,
          "the connection dropped before the daemon answered; not retried",
        ),
      ),
    ).toBe("The connection dropped before the daemon answered: run /settings sync again.");
    expect(line(new Error("boom\u001b[31m"))).toBe("Could not sync the settings: boom[31m");
  });

  test("F5 a pod's error text is capped, one line", () => {
    // Round 1: 5000 characters of the pod's words on the screen.
    const { text } = updateFailureLine(new Error(`a\nb${"x".repeat(5000)}`));
    expect(text.startsWith("Could not sync the settings: ab")).toBe(true);
    expect(text.length).toBeLessThanOrEqual("Could not sync the settings: ".length + 500);
  });
});

describe("settingsCommandLines after an attach that timed out (F3)", () => {
  test("no claim about the settings the session runs", () => {
    // Round 1: "it starts with this terminal's settings", which may be false.
    const lines = plain(settingsCommandLines({}, { open: false, unconfirmed: true }));
    expect(lines).toEqual([
      "The session is not attached yet: it may be running with other settings, shown after your first prompt.",
    ]);
  });
});
