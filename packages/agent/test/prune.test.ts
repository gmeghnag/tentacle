/**
 * S1 red-first suite for the pure pruner (docs/feat/smart-compaction.md). The
 * module does not exist yet: this run must fail on the ASSERTION owners below,
 * not merely on the import, so every case is written against the contract the
 * Implementation states (rules R1-R5, the protected tail, determinism, the
 * `modelView` validity).
 */
import { describe, expect, test } from "bun:test";
import type { ChatMessage, ToolCall } from "@tentacle/core";
import { modelView } from "../src/context-awareness.ts";
import { PRUNE_MARKER, applyPrune, estimateGain, pruneCandidates, stubFor } from "../src/prune.ts";

/** An assistant round that calls `calls`, answered by `results` (id -> content). */
function round(calls: readonly ToolCall[], results: ReadonlyMap<string, string>): ChatMessage[] {
  const out: ChatMessage[] = [{ role: "assistant", content: "", toolCalls: calls }];
  for (const call of calls) {
    const content = results.get(call.id);
    if (content !== undefined) {
      out.push({ role: "tool", content, toolCallId: call.id });
    }
  }
  return out;
}

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, name, arguments: JSON.stringify(args) };
}

/**
 * A realistic tool result: a label line plus bulk. Real results are orders of
 * magnitude larger than a stub, which is the whole point of pruning — a body
 * smaller than its stub is refused (pinned by its own case below).
 */
function body(label: string): string {
  return `${label}\n${"x".repeat(3000)}`;
}

/** `n` filler rounds (a `shell` call + its short output), to build a tail. */
function filler(from: number, n: number): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      ...round(
        [call(`f${from + i}`, "shell", { command: `echo ${i}` })],
        new Map([[`f${from + i}`, "exit=0\nok"]]),
      ),
    );
  }
  return out;
}

function pruned(history: readonly ChatMessage[]): readonly ChatMessage[] {
  return applyPrune(history, pruneCandidates(history));
}

function contentAt(history: readonly ChatMessage[], index: number): string {
  const m = history[index];
  if (m === undefined) {
    throw new Error(`no message at ${index}`);
  }
  return m.content;
}

describe("R1 — a superseded fs_read", () => {
  const read = (id: string, path: string, extra: Record<string, unknown> = {}) =>
    call(id, "fs_read", { path, ...extra });

  test("an earlier read of P is stubbed after a later FULL read of P", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "go" },
      ...round(
        [read("r1", "docs/x.md")],
        new Map([["r1", `OLD CONTENT OF X\n${"x".repeat(2000)}`]]),
      ),
      ...filler(0, 6),
      ...round(
        [read("r2", "docs/x.md")],
        new Map([["r2", `NEW CONTENT OF X\n${"x".repeat(2000)}`]]),
      ),
      { role: "user", content: "and now?" },
    ];
    const out = pruned(history);
    expect(contentAt(out, 2)).toContain(PRUNE_MARKER);
    expect(contentAt(out, 2)).toContain("docs/x.md");
    expect(contentAt(out, 2)).toContain("call r2");
    // The later read itself is untouched, and so is the text around it.
    expect(contentAt(out, 16)).toContain("NEW CONTENT OF X");
    expect(contentAt(out, 0)).toBe("go");
  });

  test("an earlier read of P is stubbed after a SUCCESSFUL edit of P", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "go" },
      ...round([read("r1", "docs/x.md")], new Map([["r1", body("OLD")]])),
      ...filler(0, 6),
      ...round(
        [call("e1", "fs_edit", { path: "docs/x.md", old_string: "a", new_string: "b" })],
        new Map([["e1", "edited docs/x.md (+1 -1)"]]),
      ),
      { role: "user", content: "next" },
    ];
    const out = pruned(history);
    expect(contentAt(out, 2)).toContain(PRUNE_MARKER);
  });

  test("NOT after a FAILED edit of P", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "go" },
      ...round([read("r1", "docs/x.md")], new Map([["r1", body("OLD")]])),
      ...filler(0, 6),
      ...round(
        [call("e1", "fs_edit", { path: "docs/x.md", old_string: "zzz", new_string: "b" })],
        new Map([["e1", "old_string not found in docs/x.md"]]),
      ),
      { role: "user", content: "next" },
    ];
    expect(pruned(history)).toBe(history);
  });

  test("NOT after a later read of a DIFFERENT (narrower) range", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "go" },
      // Realistic bodies: the ONLY reason this stays unpruned is the range rule
      // (a whole-file read is NOT superseded by a later 5-line window).
      ...round([read("r1", "docs/x.md")], new Map([["r1", body("WHOLE")]])),
      ...filler(0, 6),
      ...round(
        [read("r2", "docs/x.md", { offset: 10, limit: 5 })],
        new Map([["r2", body("10-14")]]),
      ),
      { role: "user", content: "next" },
    ];
    expect(pruned(history)).toBe(history);
  });

  test("a later read COVERING an earlier ranged read supersedes it", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "go" },
      ...round(
        [read("r1", "docs/x.md", { offset: 10, limit: 5 })],
        new Map([["r1", `10-14\n${"x".repeat(2000)}`]]),
      ),
      ...filler(0, 6),
      ...round([read("r2", "docs/x.md")], new Map([["r2", `WHOLE\n${"x".repeat(4000)}`]])),
      { role: "user", content: "next" },
    ];
    const out = pruned(history);
    expect(contentAt(out, 2)).toContain(PRUNE_MARKER);
    expect(contentAt(out, 2)).toContain("lines 10-14");
  });

  test("the range the stub reports is the one the TOOL sees (a `path:start:end` suffix)", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "go" },
      ...round([read("r1", "docs/x.md:5:9")], new Map([["r1", `5-9\n${"x".repeat(2000)}`]])),
      ...filler(0, 6),
      ...round([read("r2", "docs/x.md")], new Map([["r2", `WHOLE\n${"x".repeat(4000)}`]])),
      { role: "user", content: "next" },
    ];
    const out = pruned(history);
    expect(contentAt(out, 2)).toContain("docs/x.md lines 5-9");
  });
});

describe("R2 — a successful write/edit's payload", () => {
  const tail = (): ChatMessage[] => [...filler(0, 6), { role: "user", content: "next" }];

  test("fs_write: only `content` becomes a placeholder; the other fields stay", () => {
    const args = { path: "docs/x.md", content: "x".repeat(4000) };
    const history: ChatMessage[] = [
      { role: "user", content: "go" },
      ...round(
        [call("w1", "fs_write", args)],
        new Map([["w1", "wrote 4000 bytes to docs/x.md (+80 -0)"]]),
      ),
      ...tail(),
    ];
    const out = pruned(history);
    const assistant = out[1];
    if (assistant?.toolCalls === undefined) {
      throw new Error("no toolCalls");
    }
    const prunedArgs = JSON.parse(assistant.toolCalls[0]?.arguments ?? "") as Record<
      string,
      unknown
    >;
    expect(prunedArgs.path).toBe("docs/x.md");
    expect(String(prunedArgs.content)).toContain("pruned by tentacle");
    expect(String(prunedArgs.content)).toContain("docs/x.md");
    // `arguments` still parse as a JSON OBJECT, and the id/name are untouched.
    expect(typeof prunedArgs).toBe("object");
    expect(assistant.toolCalls[0]?.id).toBe("w1");
    expect(assistant.toolCalls[0]?.name).toBe("fs_write");
    // The result message itself is untouched (it says what happened).
    expect(contentAt(out, 2)).toBe("wrote 4000 bytes to docs/x.md (+80 -0)");
  });

  test("fs_edit: `old_string` and `new_string` are placeholders, `replace_all` is kept", () => {
    const args = { path: "a.ts", old_string: "o".repeat(3000), new_string: "n".repeat(3000) };
    const history: ChatMessage[] = [
      { role: "user", content: "go" },
      ...round([call("e1", "fs_edit", args)], new Map([["e1", "edited a.ts (+40 -40)"]])),
      ...tail(),
    ];
    const out = pruned(history);
    const prunedArgs = JSON.parse(out[1]?.toolCalls?.[0]?.arguments ?? "") as Record<
      string,
      unknown
    >;
    expect(String(prunedArgs.old_string)).toContain("pruned by tentacle");
    expect(String(prunedArgs.new_string)).toContain("pruned by tentacle");
    expect(prunedArgs.path).toBe("a.ts");
  });

  test("fs_multi_edit: every edit's strings are placeholders, `edits` stays an array", () => {
    const edits = [
      { old_string: "a".repeat(2000), new_string: "b".repeat(2000) },
      { old_string: "c", new_string: "d", replace_all: true },
    ];
    const history: ChatMessage[] = [
      { role: "user", content: "go" },
      ...round(
        [call("m1", "fs_multi_edit", { path: "a.ts", edits })],
        new Map([["m1", "edited a.ts with 2 edits (+7 -7)"]]),
      ),
      ...tail(),
    ];
    const out = pruned(history);
    const prunedArgs = JSON.parse(out[1]?.toolCalls?.[0]?.arguments ?? "") as Record<
      string,
      unknown
    >;
    const prunedEdits = prunedArgs.edits as Record<string, unknown>[];
    expect(Array.isArray(prunedEdits)).toBe(true);
    expect(String(prunedEdits[0]?.old_string)).toContain("pruned by tentacle");
    expect(prunedEdits[1]?.replace_all).toBe(true);
  });

  test("a FAILED write keeps its payload (the file is not the truth)", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "go" },
      ...round(
        [call("w1", "fs_write", { path: "docs/x.md", content: "x".repeat(4000) })],
        new Map([["w1", "tool fs_write failed: EACCES: permission denied"]]),
      ),
      ...tail(),
    ];
    expect(pruned(history)).toBe(history);
  });
});

describe("R3 — long shell output", () => {
  test("keeps the exit code, the first 10 and the last 30 lines", () => {
    const body = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    const history: ChatMessage[] = [
      { role: "user", content: "go" },
      ...round(
        [call("s1", "shell", { command: "bun test" })],
        new Map([["s1", `exit=1\n${body}`]]),
      ),
      ...filler(0, 6),
      { role: "user", content: "next" },
    ];
    const out = pruned(history);
    const stub = contentAt(out, 2);
    expect(stub).toContain(PRUNE_MARKER);
    expect(stub).toContain("exit=1");
    expect(stub).toContain("line 0");
    expect(stub).toContain("line 9");
    expect(stub).toContain("line 399");
    expect(stub).toContain("line 370");
    expect(stub).not.toContain("line 200");
    expect(stub.length).toBeLessThan(body.length / 2);
  });

  test("short output is never a candidate", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "go" },
      ...round([call("s1", "shell", { command: "ls" })], new Map([["s1", "exit=0\na\nb\n"]])),
      ...filler(0, 6),
      { role: "user", content: "next" },
    ];
    expect(pruned(history)).toBe(history);
  });
});

describe("R4 — a spill preview", () => {
  test("keeps the spill path and drops the preview", () => {
    const spilled: ChatMessage = {
      role: "tool",
      content: `[large fs_read output: full output (9000 chars) saved to out/x.txt — read it selectively]\n${"p".repeat(1200)}`,
      toolCallId: "r1",
      spill: {
        chars: 9000,
        path: "out/x.txt",
        head: "p".repeat(600),
        tail: "p".repeat(600),
        omitted: 7800,
      },
    };
    const history: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [call("r1", "fs_read", { path: "docs/x.md" })] },
      spilled,
      ...filler(0, 6),
      { role: "user", content: "next" },
    ];
    const out = pruned(history);
    const stub = contentAt(out, 2);
    expect(stub).toContain(PRUNE_MARKER);
    expect(stub).toContain("out/x.txt");
    expect(stub).not.toContain("p".repeat(1000));
  });

  test("a spill with NO file is never pruned (the preview is the only copy)", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [call("r1", "shell", { command: "x" })] },
      {
        role: "tool",
        content: `[large shell output (9000 chars), could not be saved]\n${"p".repeat(1200)}`,
        toolCallId: "r1",
        spill: { chars: 9000, head: "p".repeat(600), tail: "p".repeat(600), omitted: 7800 },
      },
      ...filler(0, 6),
      { role: "user", content: "next" },
    ];
    const out = pruned(history);
    expect(contentAt(out, 2)).toContain("p".repeat(1200));
  });
});

describe("R5 — an exact duplicate", () => {
  test("a result byte-identical to a later result of the same call is stubbed", () => {
    const args = { path: "docs/x.md" };
    const history: ChatMessage[] = [
      { role: "user", content: "go" },
      ...round([call("r1", "fs_read", args)], new Map([["r1", body("SAME BYTES")]])),
      ...filler(0, 6),
      ...round([call("r2", "fs_read", args)], new Map([["r2", body("SAME BYTES")]])),
      { role: "user", content: "next" },
    ];
    const out = pruned(history);
    expect(contentAt(out, 2)).toContain(PRUNE_MARKER);
    expect(contentAt(out, 2)).toContain("call r2");
  });

  test("same tool, DIFFERENT arguments, same bytes: not a duplicate", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "go" },
      ...round([call("s1", "shell", { command: "echo a" })], new Map([["s1", "exit=0\nsame"]])),
      ...filler(0, 6),
      ...round([call("s2", "shell", { command: "echo b" })], new Map([["s2", "exit=0\nsame"]])),
      { role: "user", content: "next" },
    ];
    expect(pruned(history)).toBe(history);
  });
});

describe("the protected tail and the exempt tools", () => {
  test("the last N assistant rounds are never candidates", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "go" },
      ...round([call("r1", "fs_read", { path: "docs/x.md" })], new Map([["r1", body("OLD")]])),
      ...round([call("r2", "fs_read", { path: "docs/x.md" })], new Map([["r2", body("NEW")]])),
    ];
    // Fewer rounds than the default 6: the whole history is the tail.
    expect(pruned(history)).toBe(history);
  });

  test("a skill result is never a candidate, even when it is an exact duplicate", () => {
    const args = { name: "kcs" };
    const history: ChatMessage[] = [
      { role: "user", content: "go" },
      ...round([call("k1", "skill", args)], new Map([["k1", body("SKILL BODY")]])),
      ...filler(0, 6),
      ...round([call("k2", "skill", args)], new Map([["k2", body("SKILL BODY")]])),
      { role: "user", content: "next" },
    ];
    expect(pruned(history)).toBe(history);
  });

  test("user and assistant CONTENT is byte-identical under every rule", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "  the user's own words  " },
      ...round(
        [
          call("w1", "fs_write", { path: "a.ts", content: "x".repeat(3000) }),
          call("r1", "fs_read", { path: "docs/x.md" }),
        ],
        new Map([
          ["w1", "wrote 3000 bytes to a.ts (+9 -0)"],
          ["r1", body("OLD")],
        ]),
      ),
      ...filler(0, 6),
      ...round([call("r2", "fs_read", { path: "docs/x.md" })], new Map([["r2", body("NEW")]])),
      { role: "assistant", content: "the model's own words" },
    ];
    const out = pruned(history);
    expect(out[0]?.content).toBe("  the user's own words  ");
    expect(out[1]?.content).toBe("");
    expect(out.at(-1)?.content).toBe("the model's own words");
    expect(out).not.toBe(history);
  });
});

describe("determinism and validity", () => {
  const history: ChatMessage[] = [
    { role: "user", content: "go" },
    ...round([call("r1", "fs_read", { path: "docs/x.md" })], new Map([["r1", body("OLD")]])),
    ...filler(0, 6),
    ...round([call("r2", "fs_read", { path: "docs/x.md" })], new Map([["r2", body("NEW")]])),
    { role: "user", content: "next" },
  ];

  test("two computations produce identical bytes", () => {
    const a = applyPrune(history, pruneCandidates(history));
    const b = applyPrune(history, pruneCandidates(history));
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test("stubFor is a pure function of its input (same bytes every call)", () => {
    const about = {
      rule: "superseded_read" as const,
      toolName: "fs_read",
      path: "docs/x.md",
      range: "lines 1-150",
      chars: 6200,
      supersededBy: "r2",
    };
    expect(stubFor(about)).toEqual(stubFor(about));
    expect(stubFor(about).content).toContain(PRUNE_MARKER);
    expect(stubFor(about).content).toContain("6.2k chars");
  });

  test("modelView over the pruned history reports ZERO repairs", () => {
    const out = pruned(history);
    // `repairCounts` reports `null` when nothing was repaired: the pruned view
    // is a valid history, exactly like the stored one.
    expect(modelView(out).repairs).toBeNull();
    expect(modelView(out).messages).toHaveLength(out.length);
  });

  test("the stored history is byte-identical, and untouched messages keep their identity", () => {
    // Its OWN fixture: a shared one could have been mutated by an earlier case,
    // which would make the byte comparison vacuous.
    const fresh: ChatMessage[] = [
      { role: "user", content: "go" },
      ...round([call("r1", "fs_read", { path: "docs/x.md" })], new Map([["r1", body("OLD")]])),
      ...filler(0, 6),
      ...round([call("r2", "fs_read", { path: "docs/x.md" })], new Map([["r2", body("NEW")]])),
      { role: "user", content: "next" },
    ];
    const before = JSON.stringify(fresh);
    const out = pruned(fresh);
    expect(JSON.stringify(fresh)).toBe(before);
    expect(out).not.toBe(fresh);
    expect(out[0]).toBe(fresh[0] as ChatMessage);
    expect(out.at(-1)).toBe(fresh.at(-1) as ChatMessage);
    // The pruned index is a NEW object; the stored one still holds the original.
    expect(out[2]).not.toBe(fresh[2] as ChatMessage);
    expect(fresh[2]?.content).toContain("OLD");
  });

  test("every stub carries the marker (what the write-tool guard refuses)", () => {
    for (const entry of pruneCandidates(history).values()) {
      expect(entry.message.content).toContain(PRUNE_MARKER);
      expect(entry.savedChars).toBeGreaterThan(0);
    }
  });

  test("estimateGain reports what the set actually saves", () => {
    const gain = estimateGain(history, pruneCandidates(history));
    expect(gain.chars).toBeGreaterThan(0);
    expect(gain.tokens).toBeGreaterThan(0);
    expect(estimateGain(history, new Map()).chars).toBe(0);
  });

  test("empty history: no candidates, and applyPrune returns the input array", () => {
    expect(pruneCandidates([]).size).toBe(0);
    const one: ChatMessage[] = [{ role: "user", content: "hi" }];
    expect(pruneCandidates(one).size).toBe(0);
    expect(applyPrune(one, new Map())).toBe(one);
  });

  test("a result SMALLER than its stub is refused (pruning must save something)", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "go" },
      ...round([call("r1", "fs_read", { path: "docs/x.md" })], new Map([["r1", "OLD"]])),
      ...filler(0, 6),
      ...round([call("r2", "fs_read", { path: "docs/x.md" })], new Map([["r2", "NEW"]])),
      { role: "user", content: "next" },
    ];
    expect(pruned(history)).toBe(history);
  });

  test("a set naming a message the history no longer has is ignored", () => {
    const set = pruneCandidates(history);
    const grown = history.slice(0, 3);
    expect(() => applyPrune(grown, set)).not.toThrow();
    expect(applyPrune(grown, set).length).toBe(3);
  });
});
