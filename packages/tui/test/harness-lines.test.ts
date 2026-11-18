/**
 * S2 (feat/harness-notices): harness lines get ONE grey voice, a glyph by kind,
 * and they GROUP — plus the truncation pair collapses into one line and a
 * one-line `_…_` notice stops being an italic markdown command reply.
 *
 * RED before the fix: `harnessNoticeOf` did not exist (a one-line `_…_` notice was
 * an `AssistantItem{notice:true}`, drawn with the model's accent `●`), and a
 * second cut appended a second notice beside the first.
 */
import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@tentacle/agent";
import {
  type DisplayState,
  applyEvent,
  initialState,
  pushNoticeItem,
  startTurn,
} from "../src/state.ts";

const fold = (state: DisplayState, events: readonly AgentEvent[]): DisplayState =>
  events.reduce((s, e) => applyEvent(s, e, 1000), state);

describe("harnessNoticeOf: what a `pushNotice` text becomes", () => {
  test("a one-line `_…_` notice is a HARNESS line, underscores stripped", () => {
    // Mutation: keep the AssistantItem path → `kind: "assistant"` here and the
    // text still carries its underscores, drawn as italics with the model's `●`.
    const s = pushNoticeItem(initialState, "_Can't compact while a turn is running._");
    expect(s.items.at(-1)).toEqual({
      kind: "notice",
      text: "Can't compact while a turn is running.",
    });
  });

  test("inline code inside the italics survives, the wrapping underscores do not", () => {
    // Mutation: drop the `stripInlineMarkdown` call → the backticks reach the row
    // (the `/attach` smoke test in `app-commands.test.tsx` caught exactly this).
    const s = pushNoticeItem(initialState, "_Usage: `/attach <path>` (a path may be dragged in)_");
    expect(s.items.at(-1)).toEqual({
      kind: "notice",
      text: "Usage: /attach <path> (a path may be dragged in)",
    });
  });

  test("a `warn` level is carried onto the notice", () => {
    const s = pushNoticeItem(initialState, "_Compact failed: down_", "warn");
    expect(s.items.at(-1)).toEqual({ kind: "notice", text: "Compact failed: down", level: "warn" });
  });

  test("a MULTI-LINE command reply stays a command reply (Q5: /help, /model, /mcp)", () => {
    // Mutation: accept any text starting/ending with `_` → this becomes a notice.
    const help = "_**tentacle** commands_\n\n- `/mcp` — panel\n- `/model` — pick_";
    const s = pushNoticeItem(initialState, help);
    expect(s.items.at(-1)).toEqual({ kind: "assistant", text: help, notice: true });
  });

  test("a partially wrapped or bare text stays a command reply", () => {
    for (const text of [
      "Model: `m`",
      "_starts only",
      "ends only_",
      "__",
      "***MCP** — 1 of 1_",
      "",
    ]) {
      expect(pushNoticeItem(initialState, text).items.at(-1)).toEqual({
        kind: "assistant",
        text,
        notice: true,
      });
    }
  });

  test("an EMPTY `__` is not a harness line: there is nothing to say", () => {
    const s = pushNoticeItem(initialState, "__");
    expect(s.items.at(-1)).toEqual({ kind: "assistant", text: "__", notice: true });
  });

  test("model text never merges into a harness line, nor it into model text", () => {
    // Mutation: drop the `kind === "assistant"` guard on the text case → the
    // notice is extended, and its level/glyph follows the model's text.
    let s = startTurn(initialState, "q", 1);
    s = pushNoticeItem(s, "_noted._");
    s = fold(s, [{ type: "text", delta: "reply" }]);
    expect(s.items.slice(1)).toEqual([
      { kind: "notice", text: "noted." },
      { kind: "assistant", text: "reply" },
    ]);
  });
});

describe("the truncated pair collapses into ONE line (S2.6)", () => {
  test("re-ask then cut again: one notice, the merged wording, in place", () => {
    // Mutation: always append (today's behaviour) → two notices, and the first
    // still promises a continuation that was spent.
    let s = startTurn(initialState, "q", 1);
    s = fold(s, [
      { type: "text", delta: "partial " },
      { type: "truncated_reply", reason: "length", retrying: true },
    ]);
    const afterFirst = s.items.length;
    s = fold(s, [{ type: "truncated_reply", reason: "length", retrying: false }]);
    const notices = s.items.filter((i) => i.kind === "notice");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toEqual({
      kind: "notice",
      level: "warn",
      text: "the reply was cut at the model's output limit — asked it to continue, cut again; this answer is incomplete",
    });
    // REPLACED at its own index, not re-appended below the reply.
    expect(s.items.length).toBe(afterFirst);
    expect(s.items.map((i) => i.kind)).toEqual(["user", "assistant", "notice"]);
  });

  test("re-ask then success: the single `asking it to continue` line stays", () => {
    let s = startTurn(initialState, "q", 1);
    s = fold(s, [
      { type: "text", delta: "partial " },
      { type: "truncated_reply", reason: "length", retrying: true },
      { type: "text", delta: "and the rest" },
      { type: "turn_end", reason: "end_turn" },
    ]);
    expect(s.items.filter((i) => i.kind === "notice")).toEqual([
      {
        kind: "notice",
        level: "warn",
        text: "the reply was cut at the model's output limit — this answer is incomplete; asking it to continue",
      },
    ]);
  });

  test("a LATER cut of the same turn is a NEW line, never a rewrite far up the transcript", () => {
    // The re-ask's own round ended NORMALLY (it ran a tool), so a later round's
    // cut is a second, separate fact. Mutation: merge on any turn notice (the
    // round-3 bug) → the notice above the tool row is rewritten and nothing is
    // appended at the turn's end.
    let s = startTurn(initialState, "q", 1);
    s = fold(s, [
      { type: "text", delta: "part one" },
      { type: "truncated_reply", reason: "length", retrying: true },
      { type: "text", delta: " continued, calling a tool" },
      { type: "tool_start", id: "t1", name: "fs_read", arguments: '{"path":"a"}' },
      { type: "tool_result", id: "t1", name: "fs_read", result: { content: "hi" } },
      { type: "text", delta: "final round" },
      { type: "truncated_reply", reason: "length", retrying: false },
    ]);
    const notices = s.items.filter((i) => i.kind === "notice");
    expect(notices).toHaveLength(2);
    expect(notices[0]).toEqual({
      kind: "notice",
      level: "warn",
      text: "the reply was cut at the model's output limit — this answer is incomplete; asking it to continue",
    });
    expect(notices[1]).toMatchObject({ level: "warn" });
    expect(s.items.at(-1)).toMatchObject({ kind: "notice", level: "warn" });
  });

  test("a `cut` never merges: the first fact stays, the stream-cut line is appended", () => {
    // A `cut` fails the turn and is a DIFFERENT fact from the output limit that
    // was re-asked. Mutation: merge on the structure alone (no reason gate) →
    // the output-limit line is overwritten by "the stream was cut".
    let s = startTurn(initialState, "q", 1);
    s = fold(s, [
      { type: "text", delta: "part one" },
      { type: "truncated_reply", reason: "length", retrying: true },
      { type: "text", delta: " and more" },
      { type: "truncated_reply", reason: "cut", retrying: false },
    ]);
    expect(s.items.filter((i) => i.kind === "notice").map((i) => i.text)).toEqual([
      "the reply was cut at the model's output limit — this answer is incomplete; asking it to continue",
      "the model's stream was cut before it finished — this answer is incomplete",
    ]);
  });

  test("a NEW turn's cut never merges into the previous turn's line", () => {
    // A new turn appends a `user` item, which is not an answer item, so the
    // structural rule rejects the earlier line on its own — this pins that no
    // separate per-turn check is needed. Mutation: match on ANY turn notice
    // text (the round-3 rule) → the old turn's line is rewritten.
    let s = startTurn(initialState, "q1", 1);
    s = fold(s, [
      { type: "text", delta: "part one" },
      { type: "truncated_reply", reason: "length", retrying: true },
    ]);
    const first = s.items.length;
    s = startTurn(s, "q2", 2);
    s = fold(s, [{ type: "truncated_reply", reason: "length", retrying: false }]);
    const notices = s.items.filter((i) => i.kind === "notice").map((i) => i.text);
    expect(notices).toEqual([
      "the reply was cut at the model's output limit — this answer is incomplete; asking it to continue",
      "the model returned nothing: it hit its output limit before writing anything",
    ]);
    expect(s.items.length).toBe(first + 2); // the new user item + the new notice
  });

  test("a cut stream fails the turn: its notice is a warn, and is not merged", () => {
    let s = startTurn(initialState, "q", 1);
    s = fold(s, [
      { type: "truncated_reply", reason: "cut", retrying: false },
      { type: "truncated_reply", reason: "length", retrying: true },
    ]);
    // `cut` was never re-asked, so the second one is a NEW fact: no merge.
    expect(s.items.filter((i) => i.kind === "notice")).toHaveLength(2);
    expect(s.items.at(-1)).toMatchObject({ level: "warn" });
  });
});

describe("the level of each harness line (S2.2)", () => {
  test("empty_turn is a warn", () => {
    const s = fold(startTurn(initialState, "q", 1), [{ type: "empty_turn" }]);
    expect(s.items.at(-1)).toMatchObject({ kind: "notice", level: "warn" });
  });

  test("dsml_leak and history_repaired are info", () => {
    const leak = fold(startTurn(initialState, "q", 1), [{ type: "dsml_leak", text: "re-asked" }]);
    expect(leak.items.at(-1)).toEqual({ kind: "notice", text: "re-asked" });
    const repaired = fold(startTurn(initialState, "q", 1), [
      { type: "history_repaired", repaired: 1, answered: 0, dropped: 0 },
    ] as unknown as readonly AgentEvent[]);
    expect(repaired.items.at(-1)).not.toMatchObject({ level: "warn" });
  });
});
