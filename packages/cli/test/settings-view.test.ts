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
  appliedLines,
  changedNotice,
  settingsCommandLines,
  settingsShowLines,
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
  test("ALL the session's settings in the table's order, then 'matches'", () => {
    const mine: SessionSettings = { maxIterations: 3, dedupOutput: true, contextWindow: 1000 };
    expect(plain(settingsShowLines(mine, report({ carried: mine })))).toEqual([
      'Session settings: { "model.contextWindow": 1000, "maxIterations": 3, "tools.dedupOutput": true }',
      "This terminal matches.",
    ]);
  });

  test("a container-set key shows the value that runs, marked, and is never 'differs'", () => {
    // Mutation: drop the container exclusion from "differs" → maxIterations is promised a change.
    const mine: SessionSettings = { maxIterations: 3, dedupOutput: false };
    const lines = settingsShowLines(
      mine,
      report({
        carried: { maxIterations: 7, dedupOutput: false },
        overridden: {},
        containerKeys: ["maxIterations"],
      }),
    );
    expect(plain(lines)).toEqual([
      'Session settings: { "maxIterations": 7 (container), "tools.dedupOutput": false }',
      "This terminal matches.",
    ]);
  });

  test("an overridden key is container-set too, with the container's value", () => {
    const lines = settingsShowLines(
      { maxIterations: 3 },
      report({ carried: { maxIterations: 3 }, overridden: { maxIterations: 9 } }),
    );
    expect(plain(lines)).toEqual([
      'Session settings: { "maxIterations": 9 (container) }',
      "This terminal matches.",
    ]);
  });

  test("this terminal differs: its values of the keys an apply would change, with the grey hint", () => {
    const lines = settingsShowLines(
      { maxIterations: 3, dedupOutput: true },
      report({ carried: { maxIterations: 5, dedupOutput: true, contextWindow: 9000 } }),
    );
    expect(lines[1]).toEqual({
      text: 'This terminal differs: { "model.contextWindow": "(default)", "maxIterations": 3 }',
      hint: "(/settings apply)",
    });
    expect(lines).toHaveLength(2);
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
    expect(lines[0]).toBe(
      'Session settings: { "subagents.agentTaskDescription": "(text differs)" }',
    );
    expect(lines[1]).toBe(
      'This terminal differs: { "subagents.agentTaskDescription": "(text differs)" } (/settings apply)',
    );
  });

  test("the same description text reads '(same text)'", () => {
    const mine = { agentTaskDescription: "x" };
    expect(plain(settingsShowLines(mine, report({ carried: mine })))[0]).toBe(
      'Session settings: { "subagents.agentTaskDescription": "(same text)" }',
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
    expect(settingsCommandLines({}, { open: true, report: report({}) })).toHaveLength(2);
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

describe("appliedLines and updateFailureLine: the apply's outcome", () => {
  test("applied: the confirmation, then what the container keeps", () => {
    const mine: SessionSettings = { maxIterations: 3 };
    expect(
      plain(
        appliedLines(mine, {
          applied: true,
          settings: { carried: mine, overridden: { maxIterations: 9 } },
        }),
      ),
    ).toEqual(["Session settings applied.", 'Container config: { "maxIterations": 9 }']);
    expect(
      plain(appliedLines(mine, { applied: true, settings: { carried: mine, overridden: {} } })),
    ).toEqual(["Session settings applied."]);
  });

  test("not applied: the daemon decides by its own config", () => {
    expect(plain(appliedLines({}, { applied: false }))).toEqual([
      "This session takes its settings from the container's own config: nothing to apply.",
    ]);
  });

  test("each refusal by its code, never by its text", () => {
    const line = (error: unknown) => updateFailureLine(error).text;
    expect(line(new RpcError(DomainErrorCode.TurnInProgress, "x"))).toBe(
      "Can't apply settings while a turn is running.",
    );
    expect(line(new RpcError(DomainErrorCode.CompactInProgress, "x"))).toBe(
      "Can't apply settings while a compaction is running.",
    );
    expect(line(new RpcError(JsonRpcErrorCode.MethodNotFound, "x"))).toBe(
      "This container's tentacle predates /settings apply: quit and attach again to update it.",
    );
    expect(
      line(
        new RpcError(
          JsonRpcErrorCode.InternalError,
          "the connection dropped before the daemon answered; not retried",
        ),
      ),
    ).toBe("The connection dropped before the daemon answered: run /settings apply again.");
    expect(line(new Error("boom\u001b[31m"))).toBe("Could not apply the settings: boom[31m");
  });

  test("F5 a pod's error text is capped, one line", () => {
    // Round 1: 5000 characters of the pod's words on the screen.
    const { text } = updateFailureLine(new Error(`a\nb${"x".repeat(5000)}`));
    expect(text.startsWith("Could not apply the settings: ab")).toBe(true);
    expect(text.length).toBeLessThanOrEqual("Could not apply the settings: ".length + 500);
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
