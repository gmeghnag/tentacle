/**
 * docs/fix/mobile-foreground-jump.md: a resync (a foreground return, a pull, a
 * Retry) REPLACES the rows with the daemon's history (`withHistory`). The rows
 * it rebuilds for messages already on screen must keep their KEYS (and, when
 * nothing changed, the very same row objects): the list's virtualised cells are
 * measured per key, so fresh keys drop every measurement above the viewport, the
 * estimated spacer changes the content height, the visible rows jump and the
 * not-following list reads the change as "New messages" (simulator, 2026-11-19:
 * a long session scrolled up jumped once and the pill flipped).
 */
import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "@tentacle/core";
import { type State, apply, initialState } from "../src/transcript.ts";

type Input = Parameters<typeof apply>[1];

const history = (messages: readonly ChatMessage[]): Input => ({
  type: "history",
  messages,
  reason: null,
});

const fold = (inputs: readonly Input[], from: State = initialState): State =>
  inputs.reduce<State>((state, input) => apply(state, input), from);

const keys = (state: State): string[] => state.rows.map((row) => row.key);

/** A turn with a thought, two tool steps (one failing) and an answer. */
const messages: readonly ChatMessage[] = [
  { role: "user", content: "hi" },
  { role: "assistant", content: "hello", thought: { ms: 12_400 } } as ChatMessage,
  { role: "user", content: "look around" },
  {
    role: "assistant",
    content: "Checking the workspace.",
    toolCalls: [
      { id: "c1", name: "shell", arguments: '{"command":"ls"}' },
      { id: "c2", name: "shell", arguments: '{"command":"ls missing"}' },
    ],
    thought: { ms: 1_000 },
  } as ChatMessage,
  { role: "tool", toolCallId: "c1", content: "a\nb", durationMs: 5 },
  { role: "tool", toolCallId: "c2", content: "no such dir", isError: true, durationMs: 6 },
  { role: "assistant", content: "Done: a and b." },
];

describe("a resync with the SAME history keeps every row as it was", () => {
  test("identical messages → identical keys, and the very same row objects", () => {
    const before = fold([history(messages)]);
    const after = apply(before, history(messages));
    expect(keys(after)).toEqual(keys(before));
    expect(after.rows.every((row, i) => row === before.rows[i])).toBe(true);
  });

  test("a second and a third resync change nothing either", () => {
    const first = fold([history(messages)]);
    const third = fold([history(messages), history(messages)], first);
    expect(keys(third)).toEqual(keys(first));
  });

  test("rows folded LIVE keep their keys when the history of that turn replaces them", () => {
    const live = fold([
      history(messages.slice(0, 3)),
      { type: "reasoning", delta: "Let me look." },
      { type: "text", delta: "Checking the workspace." },
      { type: "tool_start", id: "c1", name: "shell", arguments: '{"command":"ls"}' },
      { type: "tool_start", id: "c2", name: "shell", arguments: '{"command":"ls missing"}' },
      { type: "tool_result", id: "c1", name: "shell", result: { content: "a\nb" }, durationMs: 5 },
      {
        type: "tool_result",
        id: "c2",
        name: "shell",
        result: { content: "no such dir", isError: true },
        durationMs: 6,
      },
      { type: "text", delta: "Done: a and b." },
    ] as never);
    const after = apply(live, history(messages));
    expect(after.rows.map((row) => row.kind)).toEqual(live.rows.map((row) => row.kind));
    expect(keys(after)).toEqual(keys(live));
    // The content is the history's (the reasoning text is never stored).
    const thought = after.rows.find((row, i) => row.kind === "reasoning" && i > 2);
    expect(thought?.kind === "reasoning" && thought.text).toBe("");
  });
});

describe("what really changed still gets fresh keys", () => {
  test("a longer history: the shared rows keep their keys, the new ones are fresh", () => {
    const before = fold([history(messages.slice(0, 3))]);
    const after = apply(before, history(messages));
    expect(keys(after).slice(0, before.rows.length)).toEqual(keys(before));
    const fresh = keys(after).slice(before.rows.length);
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.some((key) => keys(before).includes(key))).toBe(false);
    expect(new Set(keys(after)).size).toBe(after.rows.length);
  });

  test("a different history (a /clear, another session): no key survives", () => {
    const before = fold([history(messages)]);
    const after = apply(before, history([{ role: "user", content: "something else" }]));
    expect(keys(after).some((key) => keys(before).includes(key))).toBe(false);
  });

  test("a row that is gone in the middle: keys survive only up to it", () => {
    const before = fold([history(messages)]);
    // c1 is gone: the tool rows after the assistant line no longer line up.
    const edited: readonly ChatMessage[] = [
      ...messages.slice(0, 3),
      {
        role: "assistant",
        content: "Checking the workspace.",
        toolCalls: [{ id: "c2", name: "shell", arguments: '{"command":"ls missing"}' }],
        thought: { ms: 1_000 },
      } as ChatMessage,
      { role: "tool", toolCallId: "c2", content: "no such dir", isError: true, durationMs: 6 },
      { role: "assistant", content: "Done: a and b." },
    ];
    const after = apply(before, history(edited));
    const toolAt = after.rows.findIndex((row) => row.kind === "tool");
    expect(toolAt).toBeGreaterThan(0);
    expect(keys(after).slice(0, toolAt)).toEqual(keys(before).slice(0, toolAt));
    expect(
      keys(after)
        .slice(toolAt)
        .some((key) => keys(before).includes(key)),
    ).toBe(false);
    expect(new Set(keys(after)).size).toBe(after.rows.length);
  });

  test("after a mismatch no later row reuses an old key, even where the kinds line up", () => {
    // A turn that answered in two consecutive assistant messages (a round with no
    // tool, then another): two `assistant` rows side by side. The resync's history
    // gained a user line early, so the two lists are misaligned from index 1 on —
    // yet indices 2 and 3 hold an `assistant` row on BOTH sides. `sameSlot`
    // matches an answer by KIND alone, so without the leading-prefix rule the row
    // named "one" would inherit the key of the different answer named "two" (and
    // the screen state keyed by it: `openSteps`/`fullSteps`, read-aloud).
    const was: readonly ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "one" },
      { role: "assistant", content: "two" },
    ];
    const before = fold([history(was)]);
    const after = apply(
      before,
      history([
        { role: "user", content: "hi" },
        { role: "user", content: "wait" },
        { role: "assistant", content: "one" },
        { role: "assistant", content: "two" },
      ]),
    );
    // Non-vacuous: a same-kind pair really does sit past the first mismatch.
    expect(before.rows.map((row) => row.kind)).toEqual(["user", "assistant", "assistant"]);
    expect(after.rows.map((row) => row.kind)).toEqual(["user", "user", "assistant", "assistant"]);
    expect(keys(after)[0]).toBe(keys(before)[0]);
    // The property: only the leading run keeps a key. Past the first mismatch
    // (index 1) nothing may carry a key from ANY position of the old list.
    expect(
      keys(after)
        .slice(1)
        .filter((key) => keys(before).includes(key)),
    ).toEqual([]);
    expect(new Set(keys(after)).size).toBe(after.rows.length);
  });

  test("a changed row in the shared prefix keeps its key but shows the NEW content", () => {
    const before = fold([history(messages)]);
    const changed = messages.map((m, i) =>
      i === 6 ? ({ ...m, content: "Done: a, b and c." } as ChatMessage) : m,
    );
    const after = apply(before, history(changed));
    const last = after.rows[after.rows.length - 1];
    // An assistant row whose text changed is the same SLOT (the answer of that
    // turn), so it keeps its key: the cell re-renders in place, nothing jumps.
    expect(last?.key).toBe(before.rows[before.rows.length - 1]?.key ?? "missing");
    expect(last?.kind === "assistant" && last.text).toBe("Done: a, b and c.");
  });
});
