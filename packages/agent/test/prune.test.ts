/**
 * S1 red-first suite for the pure pruner (docs/feat/smart-compaction.md). The
 * module does not exist yet: this run must fail on the ASSERTION owners below,
 * not merely on the import, so every case is written against the contract the
 * Implementation states (rules R1-R5, the protected tail, determinism, the
 * `modelView` validity).
 */
import { describe, expect, test } from "bun:test";
import type { ChatMessage, ToolCall } from "@tentacle/core";
import { PRUNE_SENTINEL, fsEditTool, fsMultiEditTool, fsWriteTool } from "@tentacle/tools";
import { modelView } from "../src/context-awareness.ts";
import {
  PRUNE_MARKER,
  applyPrune,
  estimateGain,
  payloadNote,
  pruneCandidates,
  stubFor,
} from "../src/prune.ts";

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

  test("NOT after a later read that STARTS LATER (it never contained the first lines)", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "go" },
      ...round(
        [read("r1", "docs/x.md", { offset: 1, limit: 50 })],
        new Map([["r1", `1-50\n${"x".repeat(2000)}`]]),
      ),
      ...filler(0, 6),
      // To the end of the file, but from line 40: lines 1-39 are in neither read.
      ...round(
        [read("r2", "docs/x.md", { offset: 40 })],
        new Map([["r2", `40-\n${"x".repeat(2000)}`]]),
      ),
      { role: "user", content: "next" },
    ];
    expect(pruned(history)).toBe(history);
  });

  test("NOT after a later FAILED read of P (nothing superseded)", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "go" },
      ...round([read("r1", "docs/x.md")], new Map([["r1", body("OLD")]])),
      ...filler(0, 6),
      ...round(
        [read("r2", "docs/x.md")],
        new Map([["r2", "tool fs_read failed: ENOENT: no such file or directory"]]),
      ),
      { role: "user", content: "next" },
    ];
    expect(pruned(history)).toBe(history);
  });

  test("a FAILED earlier read is never stubbed (there was no content to supersede)", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "go" },
      ...round(
        [read("r1", "docs/x.md")],
        new Map([["r1", `tool fs_read failed: ENOENT\n${"x".repeat(2000)}`]]),
      ),
      ...filler(0, 6),
      ...round([read("r2", "docs/x.md")], new Map([["r2", body("NEW")]])),
      { role: "user", content: "next" },
    ];
    expect(pruned(history)).toBe(history);
  });

  test("a PDF read with `pages` is covered only by the SAME `pages`", () => {
    const older: ChatMessage[] = [
      { role: "user", content: "go" },
      ...round(
        [read("r1", "doc.pdf", { pages: "101-200" })],
        new Map([["r1", body("PAGES 101-200")]]),
      ),
      ...filler(0, 6),
      // A default read (the first 100 pages) does NOT contain pages 101-200.
      ...round([read("r2", "doc.pdf")], new Map([["r2", body("PAGES 1-100")]])),
      { role: "user", content: "next" },
    ];
    expect(pruned(older)).toBe(older);

    const same: ChatMessage[] = [
      { role: "user", content: "go" },
      ...round([read("r1", "doc.pdf", { pages: "101-200" })], new Map([["r1", body("PAGES")]])),
      ...filler(0, 6),
      ...round([read("r2", "doc.pdf", { pages: "101-200" })], new Map([["r2", body("PAGES")]])),
      { role: "user", content: "next" },
    ];
    const out = pruned(same);
    expect(contentAt(out, 2)).toContain(PRUNE_MARKER);
    expect(contentAt(out, 2)).toContain("pages 101-200");
  });
});

describe("R2 — a successful write/edit's payload", () => {
  const P = "news/SCHEMA.md";
  const COLON = ":";

  /**
   * `"go"`, one round of `calls`, then enough filler that the call is outside
   * the protected tail (6 rounds) AND its path is no longer ACTIVE — D2's
   * window is 2 × `keepRecentRounds` (12 by default).
   */
  function retired(
    calls: readonly ToolCall[],
    results: ReadonlyMap<string, string>,
  ): ChatMessage[] {
    return [
      { role: "user", content: "go" },
      ...round(calls, results),
      ...filler(0, 12),
      { role: "user", content: "next" },
    ];
  }

  /** The raw `arguments` string of the call at `index`: byte-identical or not. */
  function rawArgs(history: readonly ChatMessage[], index: number, which = 0): string {
    const raw = history[index]?.toolCalls?.[which]?.arguments;
    if (raw === undefined) {
      throw new Error(`no tool call at ${index}`);
    }
    return raw;
  }

  function argsOf(
    history: readonly ChatMessage[],
    index: number,
    which = 0,
  ): Record<string, unknown> {
    const raw = history[index]?.toolCalls?.[which]?.arguments;
    if (raw === undefined) {
      throw new Error(`no tool call at ${index}`);
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`arguments at ${index} are not a JSON object`);
    }
    return parsed as Record<string, unknown>;
  }

  /** T2 — the payload keys are GONE (a missing key cannot be copied as a value). */
  test("fs_write: `content` is dropped, the rest of the call stays", () => {
    const history = retired(
      [call("w1", "fs_write", { path: P, content: "x".repeat(4000) })],
      new Map([["w1", `wrote 4000 bytes to ${P} (+80 -0)`]]),
    );
    const out = pruned(history);
    const args = argsOf(out, 1);
    expect("content" in args).toBe(false);
    expect(args.path).toBe(P);
    // The id and the name are untouched: this is still the call that ran.
    expect(out[1]?.toolCalls?.[0]?.id).toBe("w1");
    expect(out[1]?.toolCalls?.[0]?.name).toBe("fs_write");
  });

  test("fs_edit: `old_string`/`new_string` are dropped, `replace_all` is kept", () => {
    const history = retired(
      [
        call("e1", "fs_edit", {
          path: "a.ts",
          old_string: "o".repeat(3000),
          new_string: "n".repeat(3000),
          replace_all: true,
        }),
      ],
      new Map([["e1", "edited a.ts (+40 -40)"]]),
    );
    const out = pruned(history);
    const args = argsOf(out, 1);
    expect("old_string" in args).toBe(false);
    expect("new_string" in args).toBe(false);
    expect(args.replace_all).toBe(true);
    expect(args.path).toBe("a.ts");
  });

  test("fs_multi_edit: the whole `edits` array is dropped, `path` stays", () => {
    const edits = [
      { old_string: "a".repeat(2000), new_string: "b".repeat(2000) },
      { old_string: "c", new_string: "d", replace_all: true },
    ];
    const history = retired(
      [call("m1", "fs_multi_edit", { path: "a.ts", edits })],
      new Map([["m1", "edited a.ts with 2 edits (+7 -7)"]]),
    );
    const out = pruned(history);
    const args = argsOf(out, 1);
    expect("edits" in args).toBe(false);
    expect(args.path).toBe("a.ts");
  });

  /** T1 — the evidence's own shape (docs/fix/prune-stub-imitation.md, Context). */
  test("the placeholder never appears in a call's arguments any more", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "go" },
      ...round(
        [call("w30", "fs_write", { path: P, content: "s".repeat(3058) })],
        new Map([["w30", `wrote 3058 bytes to ${P} (+90 -0)`]]),
      ),
      ...filler(0, 4),
      ...round(
        [
          call("m43", "fs_multi_edit", {
            path: P,
            edits: [
              { old_string: "a".repeat(338), new_string: "b".repeat(481) },
              { old_string: "c".repeat(249), new_string: "d".repeat(240) },
              { old_string: "e".repeat(214), new_string: "f".repeat(241) },
              { old_string: "g".repeat(492), new_string: "h".repeat(492) },
            ],
          }),
        ],
        new Map([["m43", `edited ${P} with 4 edits (+6 -4)`]]),
      ),
      // Rounds 6-18: P falls out of the 2 × 6 activity window, so only the
      // stripping rule is exercised here.
      ...filler(10, 13),
      { role: "user", content: "next" },
    ];
    const out = pruned(history);
    for (const message of out) {
      for (const toolCall of message.toolCalls ?? []) {
        expect(toolCall.arguments).not.toContain(PRUNE_MARKER);
        for (const value of Object.values(argsOf([message], 0))) {
          expect(String(value)).not.toContain(PRUNE_MARKER);
        }
      }
    }
    // Both calls are pruned to their `path`, and each result carries the note.
    expect(Object.keys(argsOf(out, 1))).toEqual(["path"]);
    expect(contentAt(out, 2)).toContain(PRUNE_MARKER);
    expect(contentAt(out, 12)).toContain(PRUNE_MARKER);
  });

  /** T3 — what a model would write by imitating the stripped shape can't run. */
  test("the stripped arguments fail the tool's own schema (an imitation writes nothing)", () => {
    const write = pruned(
      retired(
        [call("w1", "fs_write", { path: P, content: "x".repeat(3000) })],
        new Map([["w1", `wrote 3000 bytes to ${P} (+0 -0)`]]),
      ),
    );
    const edit = pruned(
      retired(
        [
          call("e1", "fs_edit", {
            path: P,
            old_string: "o".repeat(2000),
            new_string: "n".repeat(2000),
          }),
        ],
        new Map([["e1", `edited ${P} (+1 -1)`]]),
      ),
    );
    const multi = pruned(
      retired(
        [
          call("m1", "fs_multi_edit", {
            path: P,
            edits: [{ old_string: "a".repeat(2000), new_string: "b".repeat(2000) }],
          }),
        ],
        new Map([["m1", `edited ${P} with 1 edits (+1 -1)`]]),
      ),
    );
    expect(fsWriteTool.inputSchema.safeParse(argsOf(write, 1)).success).toBe(false);
    expect(fsEditTool.inputSchema.safeParse(argsOf(edit, 1)).success).toBe(false);
    expect(fsMultiEditTool.inputSchema.safeParse(argsOf(multi, 1)).success).toBe(false);
    // NOT vacuous: the shape `main` emitted (the marker as a VALUE) passes the
    // schema — that is exactly why the model could send it.
    const stubbed = { path: P, content: `${PRUNE_SENTINEL}${COLON} 3.0k chars⟫` };
    expect(fsWriteTool.inputSchema.safeParse(stubbed).success).toBe(true);
  });

  /** T4 — the note rides the RESULT, after the tool's own success line. */
  test("fs_write: the result keeps its success line and gains one note line", () => {
    const successLine = `wrote 3000 bytes to ${P} (+90 -0)`;
    const history = retired(
      [call("w1", "fs_write", { path: P, content: "x".repeat(3000) })],
      new Map([["w1", successLine]]),
    );
    const out = pruned(history);
    const result = contentAt(out, 2);
    expect(result.startsWith(`${successLine}\n`)).toBe(true);
    const note = result.slice(successLine.length + 1);
    expect(note).toContain(PRUNE_MARKER);
    expect(note).toContain(P);
    expect(note).toContain("3.0k chars");
    // The STORED result is untouched: only the model's copy carries the note.
    expect(contentAt(history, 2)).toBe(successLine);
  });

  test("fs_multi_edit: the note names how many edits it dropped", () => {
    const history = retired(
      [
        call("m1", "fs_multi_edit", {
          path: P,
          edits: [
            { old_string: "a".repeat(338), new_string: "b".repeat(481) },
            { old_string: "c".repeat(249), new_string: "d".repeat(240) },
            { old_string: "e".repeat(214), new_string: "f".repeat(241) },
            { old_string: "g".repeat(492), new_string: "h".repeat(492) },
          ],
        }),
      ],
      new Map([["m1", `edited ${P} with 4 edits (+6 -4)`]]),
    );
    const out = pruned(history);
    const result = contentAt(out, 2);
    expect(result).toContain("4 edits");
    expect(result).toContain(PRUNE_MARKER);
    expect(result).toContain(P);
  });

  /** T5 — D2: a path still being worked on keeps its last two payload calls. */
  test("an ACTIVE path keeps the last two payload calls, byte-identical", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "go" },
      ...round(
        [call("w1", "fs_write", { path: P, content: "w".repeat(3000) })],
        new Map([["w1", `wrote 3000 bytes to ${P} (+0 -0)`]]),
      ),
      ...round(
        [
          call("e1", "fs_edit", {
            path: P,
            old_string: "o".repeat(400),
            new_string: "n".repeat(410),
          }),
        ],
        new Map([["e1", `edited ${P} (+1 -1)`]]),
      ),
      ...round(
        [
          call("e2", "fs_edit", {
            path: P,
            old_string: "p".repeat(500),
            new_string: "q".repeat(490),
          }),
        ],
        new Map([["e2", `edited ${P} (+2 -2)`]]),
      ),
      ...filler(0, 7),
      { role: "user", content: "next" },
    ];
    const out = pruned(history);
    expect(rawArgs(out, 3)).toBe(rawArgs(history, 3));
    expect(rawArgs(out, 5)).toBe(rawArgs(history, 5));
    // The third-from-last is released: only TWO are mirrored.
    expect("content" in argsOf(out, 1)).toBe(false);
  });

  test("an IDLE path is stripped while the active one is kept, in one history", () => {
    const Q = "news/OTHER.md";
    const history: ChatMessage[] = [
      { role: "user", content: "go" },
      ...round(
        [call("q1", "fs_write", { path: Q, content: "q".repeat(3000) })],
        new Map([["q1", `wrote 3000 bytes to ${Q} (+0 -0)`]]),
      ),
      ...filler(0, 13),
      ...round(
        [call("p1", "fs_write", { path: P, content: "p".repeat(3000) })],
        new Map([["p1", `wrote 3000 bytes to ${P} (+0 -0)`]]),
      ),
      ...round(
        [
          call("p2", "fs_edit", {
            path: P,
            old_string: "o".repeat(400),
            new_string: "n".repeat(400),
          }),
        ],
        new Map([["p2", `edited ${P} (+1 -1)`]]),
      ),
      ...filler(20, 7),
      { role: "user", content: "next" },
    ];
    const out = pruned(history);
    expect("content" in argsOf(out, 1)).toBe(false);
    expect(rawArgs(out, 29)).toBe(rawArgs(history, 29));
    expect(rawArgs(out, 31)).toBe(rawArgs(history, 31));
  });

  test("one message, two calls: only the idle path's call is stripped and noted", () => {
    const A = "news/A.md";
    const B = "news/B.md";
    const history: ChatMessage[] = [
      { role: "user", content: "go" },
      ...round(
        [
          call("m1", "fs_write", { path: A, content: "a".repeat(3000) }),
          call("m2", "fs_write", { path: B, content: "b".repeat(3000) }),
        ],
        new Map([
          ["m1", `wrote 3000 bytes to ${A} (+0 -0)`],
          ["m2", `wrote 3000 bytes to ${B} (+0 -0)`],
        ]),
      ),
      ...filler(0, 12),
      // A call on B inside the window makes B active: its last two payload calls
      // (this one and `m2`) keep their arguments.
      ...round(
        [
          call("m3", "fs_edit", {
            path: B,
            old_string: "o".repeat(400),
            new_string: "n".repeat(400),
          }),
        ],
        new Map([["m3", `edited ${B} (+1 -1)`]]),
      ),
      { role: "user", content: "next" },
    ];
    const out = pruned(history);
    expect("content" in argsOf(out, 1, 0)).toBe(false);
    expect(rawArgs(out, 1, 1)).toBe(rawArgs(history, 1, 1));
    // Only the stripped call's result carries the note.
    expect(contentAt(out, 2)).toContain(PRUNE_MARKER);
    expect(contentAt(out, 3)).toBe(`wrote 3000 bytes to ${B} (+0 -0)`);
  });

  test("an `fs_read` of P inside the window alone keeps P active", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "go" },
      ...round(
        [call("w1", "fs_write", { path: P, content: "x".repeat(3000) })],
        new Map([["w1", `wrote 3000 bytes to ${P} (+0 -0)`]]),
      ),
      ...filler(0, 12),
      ...round([call("r1", "fs_read", { path: P })], new Map([["r1", body("CONTENT")]])),
      { role: "user", content: "next" },
    ];
    const out = pruned(history);
    expect(rawArgs(out, 1)).toBe(rawArgs(history, 1));
  });

  /** T6 — pruning has to save something: the note costs. */
  test("a payload smaller than its note is not pruned at all", () => {
    const history = retired(
      [call("e1", "fs_edit", { path: "a.ts", old_string: "abc", new_string: "abcd" })],
      new Map([["e1", "edited a.ts (+1 -1)"]]),
    );
    expect(pruneCandidates(history).size).toBe(0);
    expect(pruned(history)).toBe(history);
  });

  test("estimateGain is the payload minus the note, and nothing else", () => {
    const content = "x".repeat(3000);
    const history = retired(
      [call("w1", "fs_write", { path: P, content })],
      new Map([["w1", `wrote 3000 bytes to ${P} (+0 -0)`]]),
    );
    const note = payloadNote({ chars: content.length, path: P });
    expect(estimateGain(history, pruneCandidates(history)).chars).toBe(
      content.length - note.length,
    );
  });

  /** T7 — a failed write: the payload stays AND no note is added. */
  test("a FAILED write keeps its payload and gets no note", () => {
    const history = retired(
      [call("w1", "fs_write", { path: P, content: "x".repeat(4000) })],
      new Map([["w1", "tool fs_write failed: EACCES: permission denied"]]),
    );
    expect(pruned(history)).toBe(history);
  });

  /** T8 — the pruned copy is a valid, byte-stable history. */
  test("the pruned history has no repairs and is byte-identical across runs", () => {
    const history = retired(
      [call("w1", "fs_write", { path: P, content: "x".repeat(3000) })],
      new Map([["w1", `wrote 3000 bytes to ${P} (+0 -0)`]]),
    );
    const a = pruned(history);
    const b = pruned(history);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(modelView(a).repairs).toBeNull();
    expect(modelView(a).messages).toHaveLength(a.length);
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

  // The cases below use `search` (no `path`, not a `shell`, so R1/R3/R4 cannot
  // reach them) with bodies larger than the stub: R5 itself decides, and the
  // `savedChars > 0` gate cannot mask a wrong answer.

  test("a non-`fs_read` result identical to a later one IS a duplicate", () => {
    const args = { query: "needle" };
    const history: ChatMessage[] = [
      { role: "user", content: "go" },
      ...round([call("q1", "search", args)], new Map([["q1", body("SAME HITS")]])),
      ...filler(0, 6),
      ...round([call("q2", "search", args)], new Map([["q2", body("SAME HITS")]])),
      { role: "user", content: "next" },
    ];
    const out = pruned(history);
    expect(contentAt(out, 2)).toContain(PRUNE_MARKER);
    expect(contentAt(out, 2)).toContain("call q2");
    expect(pruneCandidates(history).get(2)?.rule).toBe("duplicate");
    // The LATER copy is the one still carrying the content.
    expect(out.at(-2)?.content).toContain("SAME HITS");
  });

  test("two identical results outside the tail: only the EARLIER is stubbed", () => {
    const args = { query: "needle" };
    const history: ChatMessage[] = [
      { role: "user", content: "go" },
      ...round([call("q1", "search", args)], new Map([["q1", body("SAME HITS")]])),
      ...round([call("q2", "search", args)], new Map([["q2", body("SAME HITS")]])),
      ...filler(0, 8),
      { role: "user", content: "next" },
    ];
    // Both results are candidates (both before the protected tail).
    const candidates = [...pruneCandidates(history).entries()];
    expect(candidates.map(([index]) => index)).toEqual([2]);
    const out = pruned(history);
    // A stub must never point at another stub: the claim "that one is still in
    // the conversation" has to be TRUE.
    expect(contentAt(out, 2)).toContain(PRUNE_MARKER);
    expect(contentAt(out, 2)).toContain("call q2");
    expect(contentAt(out, 4)).toBe(body("SAME HITS"));
  });

  test("same tool+arguments but DIFFERENT bytes: not a duplicate", () => {
    const args = { query: "needle" };
    const history: ChatMessage[] = [
      { role: "user", content: "go" },
      ...round([call("q1", "search", args)], new Map([["q1", body("FIRST HITS")]])),
      ...filler(0, 6),
      ...round([call("q2", "search", args)], new Map([["q2", body("SECOND HITS")]])),
      { role: "user", content: "next" },
    ];
    expect(pruned(history)).toBe(history);
  });

  test("same tool+bytes but DIFFERENT arguments: not a duplicate", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "go" },
      ...round([call("q1", "search", { query: "a" })], new Map([["q1", body("SAME HITS")]])),
      ...round([call("q2", "search", { query: "b" })], new Map([["q2", body("SAME HITS")]])),
      ...filler(0, 6),
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

  test("a context_reset result is never a candidate, even when it is an exact duplicate", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "go" },
      ...round([call("c1", "context_reset", { prompt: "p" })], new Map([["c1", body("RESET")]])),
      ...filler(0, 6),
      ...round([call("c2", "context_reset", { prompt: "p" })], new Map([["c2", body("RESET")]])),
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
    const long = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    const source: ChatMessage[] = [
      { role: "user", content: "go" },
      ...round(
        [call("s1", "shell", { command: "bun test" })],
        new Map([["s1", `exit=1\n${long}`]]),
      ),
      ...filler(0, 6),
      { role: "user", content: "next" },
    ];
    const set = pruneCandidates(source);
    expect(set.has(2)).toBe(true);
    // A SHORTER history whose index 2 is a different message.
    const other: ChatMessage[] = [
      { role: "user", content: "a different chat" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "and another" },
    ];
    expect(() => applyPrune(other, set)).not.toThrow();
    // Nothing applies, so the array comes back untouched — same reference.
    expect(applyPrune(other, set)).toBe(other);
  });

  test("a set built before an IN-PLACE history replacement fires on nothing", () => {
    // `/compact`, `/clear` and `context_reset` reuse the SAME array
    // (`messages.length = 0; push(...)` — session.ts:366-367, :390-391), so
    // index-only staleness is not detectable by length: the entry must carry
    // the message it was built from.
    const replaced: ChatMessage[] = [
      { role: "user", content: "go" },
      ...round([call("r1", "fs_read", { path: "docs/x.md" })], new Map([["r1", body("OLD")]])),
      ...filler(0, 6),
      ...round([call("r2", "fs_read", { path: "docs/x.md" })], new Map([["r2", body("NEW")]])),
      { role: "user", content: "next" },
    ];
    const set = pruneCandidates(replaced);
    expect(set.size).toBeGreaterThan(0);
    // What `/compact` leaves behind: a DIFFERENT conversation, same array, and
    // the summary sits exactly where the old `fs_read` result was.
    const after: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "SUMMARY OF THE OLD CHAT" },
      { role: "assistant", content: "ok" },
    ];
    replaced.length = 0;
    replaced.push(...after);
    // The set belongs to the OLD history: nothing of it applies to the new one.
    expect(applyPrune(replaced, set)).toBe(replaced);
    expect(estimateGain(replaced, set).chars).toBe(0);
    expect(replaced[1]?.content).toBe("SUMMARY OF THE OLD CHAT");
  });

  test("a stale entry does not hide a live one in the same set", () => {
    const long = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    const old: ChatMessage[] = [
      { role: "user", content: "go" },
      ...round(
        [call("s1", "shell", { command: "bun test" })],
        new Map([["s1", `exit=1\n${long}`]]),
      ),
      ...round([call("r1", "search", { query: "a" })], new Map([["r1", body("HITS")]])),
      ...round([call("r2", "search", { query: "a" })], new Map([["r2", body("HITS")]])),
      ...filler(0, 6),
      { role: "user", content: "next" },
    ];
    const set = pruneCandidates(old);
    const rules = [...set.entries()].map(([index, entry]) => [index, entry.rule]);
    expect(rules).toEqual([
      [2, "long_output"],
      [4, "duplicate"],
    ]);
    // Index 4 is now a different message; index 2 is still the one it named.
    const mixed: ChatMessage[] = [...old];
    mixed[4] = { role: "user", content: "a NEW message at index 4" };
    const out = applyPrune(mixed, set);
    expect(out[4]?.content).toBe("a NEW message at index 4");
    expect(contentAt(out, 2)).toContain(PRUNE_MARKER);
    expect(out[2]?.content).toContain("exit=1");
  });
});

describe("R0 — a viewed image (docs/feat/image-view.md T10)", () => {
  const ref = {
    id: `a1b2c3d4e5f6${"0".repeat(52)}`,
    mimeType: "image/png",
    size: 9,
    name: "doc.pdf p.3",
  };
  const history = (): ChatMessage[] => [
    { role: "user", content: "look" },
    {
      role: "assistant",
      content: "",
      toolCalls: [call("v1", "image_view", { ref: "a1b2c3d4e5f6" })],
    },
    {
      role: "tool",
      content: "doc.pdf p.3 · 9×9 · low · 1 KB",
      toolCallId: "v1",
      attachments: [ref],
    },
    ...filler(0, 8),
  ];

  test("an old image_view result → a stub WITHOUT attachments that names the ref again", () => {
    const out = pruned(history());
    expect(out[2]?.attachments).toBeUndefined();
    expect(contentAt(out, 2)).toBe(
      `${PRUNE_MARKER}: image_view a1b2c3d4e5f6 (doc.pdf p.3) viewed earlier — image_view a1b2c3d4e5f6 again to see it⟫`,
    );
    expect(out[2]?.toolCallId).toBe("v1");
  });

  test("estimateGain counts the dropped image at imageTokens", () => {
    const h = history();
    const set = pruneCandidates(h);
    expect(estimateGain(h, set, { imageTokens: 3200 }).tokens).toBeGreaterThanOrEqual(3200);
    expect(estimateGain(h, set).tokens).toBeGreaterThanOrEqual(1600);
  });

  test("the stub is byte-stable across two computations", () => {
    const h = history();
    expect(JSON.stringify(pruned(h)[2])).toBe(JSON.stringify(pruned(h)[2]));
  });

  test("a recent image_view (in the protected tail) keeps its image", () => {
    const h = history().slice(0, 3);
    expect(pruned(h)[2]?.attachments).toEqual([ref]);
  });
});
