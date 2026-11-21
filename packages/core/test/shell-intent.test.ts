import { describe, expect, test } from "bun:test";
import {
  INTENT_MAX,
  permissionIntent,
  shellCommand,
  shellExitCode,
  shellIntent,
  shellOutcome,
  shellRowParts,
} from "../src/index.ts";

const args = (description: unknown, command = "ls") => JSON.stringify({ command, description });

describe("shellIntent", () => {
  test("no usable description → null", () => {
    expect(shellIntent(JSON.stringify({ command: "ls" }))).toBeNull();
    expect(shellIntent(args(""))).toBeNull();
    expect(shellIntent(args("   \n\t "))).toBeNull();
    expect(shellIntent(args(null))).toBeNull();
    expect(shellIntent(args(42))).toBeNull();
    expect(shellIntent("not json")).toBeNull();
    expect(shellIntent("42")).toBeNull();
    expect(shellIntent('"a string"')).toBeNull();
    expect(shellIntent("[]")).toBeNull();
  });

  test("a plain sentence is kept as written", () => {
    expect(shellIntent(args("Controllo i test del pacchetto mobile"))).toBe(
      "Controllo i test del pacchetto mobile",
    );
  });

  test("ANSI escapes and controls never survive (cannot move the cursor or add a row)", () => {
    expect(shellIntent(args("\u001b[2JRun\u001b[31m tests"))).toBe("Run tests");
    expect(shellIntent(args("line one\nline two\r\x07"))).toBe("line one line two");
    expect(shellIntent(args("a\u0085b"))).toBe("a b");
  });

  test("bidi overrides and zero-width chars are removed, not spaced", () => {
    expect(shellIntent(args("safe‮ txt.exe"))).toBe("safe txt.exe");
    expect(shellIntent(args("ze​ro⁦wid⁩th﻿"))).toBe("zerowidth");
  });

  test("an over-long sentence is cut to INTENT_MAX code points + …", () => {
    const out = shellIntent(args("a".repeat(200)));
    expect(out).toBe(`${"a".repeat(INTENT_MAX)}…`);
    expect(INTENT_MAX).toBe(72);
  });

  test("the cut never splits a surrogate pair", () => {
    const out = shellIntent(args(`${"a".repeat(INTENT_MAX - 1)}😀😀😀`)) ?? "";
    expect(out).toBe(`${"a".repeat(INTENT_MAX - 1)}😀…`);
    expect(Array.from(out).length).toBe(INTENT_MAX + 1);
  });
});

describe("shellCommand / shellExitCode", () => {
  test("command or empty", () => {
    expect(shellCommand(args("x", "bun test"))).toBe("bun test");
    expect(shellCommand("{}")).toBe("");
    expect(shellCommand("nope")).toBe("");
  });

  test("exit=N only on the first line, a whole number", () => {
    expect(shellExitCode("exit=0\nok")).toBe(0);
    expect(shellExitCode("exit=2\n")).toBe(2);
    expect(shellExitCode("exit=124\n[killed]")).toBe(124);
    expect(shellExitCode("exit=-1")).toBe(-1);
    expect(shellExitCode("no code here")).toBeNull();
    expect(shellExitCode("exit=2x\n")).toBeNull();
    expect(shellExitCode("out\nexit=2")).toBeNull();
    expect(shellExitCode(undefined)).toBeNull();
  });
});

describe("shellOutcome", () => {
  test("written outcome: ✓ / ✗ exit N / ✗, null while running", () => {
    expect(shellOutcome({ status: "running" })).toBeNull();
    expect(shellOutcome({ status: "queued" })).toBeNull();
    expect(shellOutcome({ status: "ok", text: "exit=0\nfine" })).toBe("✓");
    expect(shellOutcome({ status: "error", text: "exit=2\nboom" })).toBe("✗ exit 2");
    expect(shellOutcome({ status: "error", text: "exit=124\n[killed]" })).toBe("✗ exit 124");
  });

  test("a background start (no exit=) settles as ✓", () => {
    expect(shellOutcome({ status: "ok", text: "started background job j1: `x`" })).toBe("✓");
  });

  test("a denial never invents a code", () => {
    expect(shellOutcome({ status: "error", text: "Permission denied by the user: no" })).toBe("✗");
    expect(shellOutcome({ status: "denied" })).toBe("✗");
  });

  test("a spilled result reads the code from the spill head, not the banner", () => {
    expect(
      shellOutcome({
        status: "error",
        text: "[output spilled to /x/y.txt — 9000 lines]\nexit=9",
        spillHead: "exit=3\nlots",
      }),
    ).toBe("✗ exit 3");
  });
});

describe("shellRowParts", () => {
  const a = args("Run the tests", "bun test");

  test("no sentence → null (today's row)", () => {
    expect(shellRowParts(JSON.stringify({ command: "ls" }), "running", false)).toBeNull();
  });

  test("not compact: the $ row always shows", () => {
    for (const status of ["queued", "running", "ok", "error", "denied"] as const) {
      expect(shellRowParts(a, status, false)).toEqual({
        sentence: "Run the tests",
        command: "bun test",
        commandRow: true,
      });
    }
  });

  test("compact: hidden while running/queued and on success, shown on failure/denial", () => {
    expect(shellRowParts(a, "queued", true)?.commandRow).toBe(false);
    expect(shellRowParts(a, "running", true)?.commandRow).toBe(false);
    expect(shellRowParts(a, "ok", true)?.commandRow).toBe(false);
    expect(shellRowParts(a, "error", true)?.commandRow).toBe(true);
    expect(shellRowParts(a, "denied", true)?.commandRow).toBe(true);
  });
});

describe("permissionIntent", () => {
  const rows = new Map([
    ["c1", args("List the files", "ls")],
    ["c2", JSON.stringify({ command: "ls" })],
  ]);
  const argsOf = (id: string) => rows.get(id);
  const shell = { tool: "shell" };

  test("the asking call's own shell ask → its sentence", () => {
    expect(permissionIntent(shell, { toolCallId: "c1", origin: "call" }, argsOf)).toBe(
      "List the files",
    );
    expect(permissionIntent(shell, { toolCallId: "c1" }, argsOf)).toBe("List the files");
  });

  test("a sub-agent ask names the parent call → no sentence", () => {
    expect(permissionIntent(shell, { toolCallId: "c1", origin: "subagent" }, argsOf)).toBeNull();
  });

  test("non-shell, non-tool kind, no id, unknown id, no sentence → null", () => {
    expect(permissionIntent({ tool: "fs_write" }, { toolCallId: "c1" }, argsOf)).toBeNull();
    expect(
      permissionIntent({ tool: "shell", kind: "hooks_trust" }, { toolCallId: "c1" }, argsOf),
    ).toBeNull();
    expect(permissionIntent(shell, {}, argsOf)).toBeNull();
    expect(permissionIntent(shell, { toolCallId: "zz" }, argsOf)).toBeNull();
    expect(permissionIntent(shell, { toolCallId: "c2" }, argsOf)).toBeNull();
  });
});
