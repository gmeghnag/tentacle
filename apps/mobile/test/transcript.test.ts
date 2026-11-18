/**
 * The transcript fold (docs/feat/mobile-session-view.md 12b "Tests" — its
 * `transcript.test.ts` row), one case per behaviour the plan names:
 * history → rows; own vs foreign turn produce identical rows; the tool
 * lifecycle including `denied`; a diff attaching to its tool row; `history`
 * replacing vs compaction keeping + notice; `unsupported` once per kind; and the
 * notices for an error / a lost turn.
 */
import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "@tentacle/core";
import { NOTICE_GLYPHS, noticeLooks } from "../src/notice-group.ts";
import {
  type Row,
  type State,
  TURN_INTERRUPTED_NOTICE,
  TURN_LOST_NOTICE,
  type ToolRow,
  apply,
  initialState,
  unsupportedNotice,
} from "../src/transcript.ts";

function fold(inputs: readonly Parameters<typeof apply>[1][]): State {
  return inputs.reduce<State>((state, input) => apply(state, input), initialState);
}

const text = (delta: string) => ({ type: "text" as const, delta });
const reasoning = (delta: string) => ({ type: "reasoning" as const, delta });

describe("a history becomes rows", () => {
  const history: readonly ChatMessage[] = [
    { role: "system", content: "you are a helpful agent" },
    { role: "user", content: "read the file" },
    {
      role: "assistant",
      content: "Reading it.",
      toolCalls: [{ id: "c1", name: "fs_read", arguments: '{"path":"a.txt"}' }],
    },
    { role: "tool", toolCallId: "c1", content: "hello", durationMs: 12 },
    { role: "assistant", content: "It says hello." },
  ];

  test("every visible message, in order, with its tool result attached", () => {
    const state = fold([{ type: "history", messages: history, reason: null }]);
    expect(state.rows.map((row) => row.kind)).toEqual(["user", "assistant", "tool", "assistant"]);
    const tool = state.rows[2] as ToolRow;
    expect(tool.id).toBe("c1");
    expect(tool.label).toBe("Read"); // `toolLabel`, not the raw name
    expect(tool.status).toBe("ok");
    expect(tool.output).toBe("hello");
    expect(tool.durationMs).toBe(12);
  });

  test("the system prompt is not a row", () => {
    const state = fold([{ type: "history", messages: history, reason: null }]);
    expect(state.rows.some((row) => row.kind === "user" && row.text.includes("helpful"))).toBe(
      false,
    );
  });

  test("a history REPLACES what is shown, and its keys never repeat an old one", () => {
    const first = fold([
      { type: "history", messages: [{ role: "user", content: "one" }], reason: null },
    ]);
    const second = apply(first, {
      type: "history",
      messages: [{ role: "user", content: "two" }],
      reason: null,
    });
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0]?.kind === "user" && second.rows[0].text).toBe("two");
    expect(second.rows[0]?.key).not.toBe(first.rows[0]?.key);
  });

  test("a refused-with-a-reply tool is `denied`, not `error`/`ok`", () => {
    const state = fold([
      {
        type: "history",
        messages: [
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "c2", name: "shell", arguments: "{}" }],
          },
          {
            role: "tool",
            toolCallId: "c2",
            content: "Permission denied by the user",
            denialReply: "use rm -rf instead",
          },
        ],
        reason: null,
      },
    ]);
    const tool = state.rows[0] as ToolRow;
    expect(tool.status).toBe("denied");
    expect(tool.denialReply).toBe("use rm -rf instead");
  });
});

describe("a turn's stream", () => {
  test("an OWN and a FOREIGN turn produce identical rows (no branching on `own`)", () => {
    const events: readonly Parameters<typeof apply>[1][] = [
      text("Look: "),
      reasoning("thinking"),
      text("done."),
      { type: "tool_start", id: "c1", name: "fs_read", arguments: "{}" },
      { type: "tool_result", id: "c1", name: "fs_read", result: { content: "ok" } },
    ];
    const own = fold([{ type: "turn_started", turnId: "t", own: true }, ...events]);
    const foreign = fold([{ type: "turn_started", turnId: "t", own: false }, ...events]);
    // The bracket records who started it; the ROWS must not differ.
    const strip = (state: State): unknown => state.rows.map((row) => ({ ...row, key: undefined }));
    expect(strip(own)).toEqual(strip(foreign));
    expect(own.turn?.own).toBe(true);
    expect(foreign.turn?.own).toBe(false);
  });

  test("text deltas extend one row; a reasoning chunk ends it", () => {
    const state = fold([
      { type: "turn_started", turnId: "t", own: true },
      text("a"),
      text("b"),
      reasoning("think"),
      text("c"),
    ]);
    expect(state.rows.map((row) => row.kind)).toEqual(["assistant", "reasoning", "assistant"]);
    expect(state.rows[0]?.kind === "assistant" && state.rows[0].text).toBe("ab");
  });

  test("the tool lifecycle: running → queued → running → ok", () => {
    const state = fold([
      { type: "turn_started", turnId: "t", own: true },
      { type: "tool_start", id: "c1", name: "shell", arguments: '{"command":"ls"}' },
      { type: "tool_phase", id: "c1", phase: "queued" },
      { type: "tool_phase", id: "c1", phase: "running" },
      { type: "tool_result", id: "c1", name: "shell", result: { content: "a.txt" } },
    ]);
    const tool = state.rows[0] as ToolRow;
    expect(tool.status).toBe("ok");
    expect(tool.label).toBe("Bash");
    expect(tool.output).toBe("a.txt");
  });

  test("a settled tool row never moves back to queued/running", () => {
    const state = fold([
      { type: "turn_started", turnId: "t", own: true },
      { type: "tool_start", id: "c1", name: "shell", arguments: "{}" },
      { type: "tool_result", id: "c1", name: "shell", result: { content: "x" } },
      { type: "tool_phase", id: "c1", phase: "queued" },
    ]);
    expect((state.rows[0] as ToolRow).status).toBe("ok");
  });

  test("a refusal with a reply is `denied` live too, and its words are kept", () => {
    const state = fold([
      { type: "turn_started", turnId: "t", own: true },
      { type: "tool_start", id: "c1", name: "fs_write", arguments: "{}" },
      {
        type: "tool_result",
        id: "c1",
        name: "fs_write",
        result: {
          content: "Permission denied by the user: `fs_write` was not run.",
          isError: true,
          denialReply: "not that file",
        },
      },
    ]);
    const tool = state.rows[0] as ToolRow;
    expect(tool.status).toBe("denied");
    expect(tool.denialReply).toBe("not that file");
  });

  test("a plain error is `error` (and still shows its output)", () => {
    const state = fold([
      { type: "turn_started", turnId: "t", own: true },
      { type: "tool_start", id: "c1", name: "shell", arguments: "{}" },
      { type: "tool_result", id: "c1", name: "shell", result: { content: "boom", isError: true } },
    ]);
    const tool = state.rows[0] as ToolRow;
    expect(tool.status).toBe("error");
    expect(tool.output).toBe("boom");
  });

  test("a result with no matching call still opens a row (never dropped)", () => {
    const state = fold([
      { type: "turn_started", turnId: "t", own: true },
      { type: "tool_result", id: "ghost", name: "shell", result: { content: "x" } },
    ]);
    expect(state.rows).toHaveLength(1);
    expect((state.rows[0] as ToolRow).id).toBe("ghost");
  });

  test("a diff attaches to its tool row, with the daemon's own counts", () => {
    const state = fold([
      { type: "turn_started", turnId: "t", own: true },
      { type: "tool_start", id: "c1", name: "fs_write", arguments: "{}" },
      {
        type: "tool_result",
        id: "c1",
        name: "fs_write",
        result: {
          content: "wrote a.txt",
          details: {
            kind: "diff",
            path: "a.txt",
            patch: "@@ -1 +1 @@\n-a\n+b\n",
            added: 1,
            removed: 1,
          },
        },
      },
    ]);
    const tool = state.rows[0] as ToolRow;
    expect(tool.diff?.path).toBe("a.txt");
    expect(tool.diff?.added).toBe(1);
    expect(tool.diff?.removed).toBe(1);
  });

  test("an artifact detail is never taken as a diff (model-artifacts S2)", () => {
    const state = fold([
      { type: "turn_started", turnId: "t", own: true },
      { type: "tool_start", id: "c1", name: "present", arguments: "{}" },
      {
        type: "tool_result",
        id: "c1",
        name: "present",
        result: {
          content: "Presented",
          details: {
            kind: "artifact",
            artifact: {
              artifactId: "a1",
              version: 1,
              sha256: "a".repeat(64),
              size: 10,
              mimeType: "text/plain",
              kind: "text",
              title: "notes",
              callId: "c1",
              createdAt: 0,
            },
          },
        },
      },
    ]);
    const tool = state.rows[0] as ToolRow;
    expect(tool.status).toBe("ok");
    expect(tool.diff).toBeUndefined();
    // It is the row's CARD instead (S9, T9.1): the live `present` result's own
    // meta, which the band row draws — never a reload's guess.
    expect(tool.artifact?.artifactId).toBe("a1");
    expect(tool.artifact?.callId).toBe("c1");
  });

  test("the turn bracket: started → ended, and a lost turn says so", () => {
    const running = fold([{ type: "turn_started", turnId: "t9", own: true }]);
    expect(running.turn?.turnId).toBe("t9");
    expect(running.rows).toHaveLength(0); // the bracket is NOT a row
    const ended = apply(running, { type: "turn_ended", outcome: "ended" });
    expect(ended.turn).toBe(null);
    expect(ended.rows).toHaveLength(0); // a clean end needs no notice
    const lost = apply(running, { type: "turn_ended", outcome: "lost" });
    const lostNotice = lost.rows.at(-1);
    expect(lostNotice?.kind === "notice" ? lostNotice.text : undefined).toBe(TURN_LOST_NOTICE);
    const interrupted = apply(running, { type: "turn_ended", outcome: "interrupted" });
    const stopped = interrupted.rows.at(-1);
    expect(stopped?.kind === "notice" ? stopped.text : undefined).toBe(TURN_INTERRUPTED_NOTICE);
  });

  test("a failed turn surfaces the daemon's words as a notice", () => {
    const state = fold([
      { type: "turn_started", turnId: "t", own: true },
      { type: "turn_ended", outcome: "failed", message: "the model refused" },
    ]);
    expect(state.rows.at(-1)).toEqual({
      kind: "notice",
      key: state.rows.at(-1)?.key as string,
      text: "⚠ the model refused",
    });
  });

  test("a cancelled turn is quiet (the transcript already says what happened)", () => {
    const state = fold([
      { type: "turn_started", turnId: "t", own: true },
      text("half an ans"),
      { type: "turn_ended", outcome: "cancelled" },
    ]);
    expect(state.rows.map((row) => row.kind)).toEqual(["assistant"]);
  });
});

describe("history events", () => {
  test("a compaction KEEPS the transcript and says so once (another device's)", () => {
    const before = fold([
      { type: "history", messages: [{ role: "user", content: "hi" }], reason: null },
    ]);
    const after = apply(before, { type: "history", messages: [], reason: "compact" });
    expect(after.rows).toHaveLength(2);
    // One wording whatever device compacted (harness-notices Q6): the separator.
    expect(after.rows[1]).toMatchObject({ kind: "notice", text: "compacted", separator: true });
  });

  test("this client's OWN compaction says nothing (the screen already showed it)", () => {
    const before = fold([
      { type: "history", messages: [{ role: "user", content: "hi" }], reason: null },
    ]);
    const after = apply(before, {
      type: "history",
      messages: [],
      reason: "compact",
      own: true,
    });
    expect(after).toBe(before);
  });

  test("a context reset APPENDS (the old transcript stays, decision 9)", () => {
    const before = fold([
      { type: "history", messages: [{ role: "user", content: "before" }], reason: null },
    ]);
    const reset: readonly ChatMessage[] = [
      {
        role: "user",
        content:
          "[context reset] You renewed your own context with context_reset.\nEverything before it was discarded. Your restart prompt:\n<restart_prompt>\ncarry on\n</restart_prompt>",
      },
    ];
    const after = apply(before, { type: "history", messages: reset, reason: "context_reset" });
    expect(after.rows.map((row) => row.kind)).toEqual(["user", "notice", "user"]);
    expect(after.rows[1]?.kind === "notice" && after.rows[1].separator).toBe(true);
    expect(after.rows[2]?.kind === "user" && after.rows[2].restart).toBe(true);
  });

  test("a /clear replaces it all", () => {
    const before = fold([
      { type: "history", messages: [{ role: "user", content: "one" }], reason: null },
    ]);
    const after = apply(before, { type: "history", messages: [], reason: "clear" });
    expect(after.rows).toHaveLength(0);
  });
});

test("`unsupported` is said once per kind", () => {
  const once = fold([{ type: "unsupported", kind: "shiny_new_thing" }]);
  expect(once.rows).toHaveLength(1);
  expect(once.rows[0]?.kind === "notice" && once.rows[0].text).toBe(
    unsupportedNotice("shiny_new_thing"),
  );
  const twice = apply(once, { type: "unsupported", kind: "shiny_new_thing" });
  expect(twice).toBe(once);
  const other = apply(once, { type: "unsupported", kind: "another_thing" });
  expect(other.rows).toHaveLength(2);
});

test("a prompt's images are carried on its row (the owner's requirement)", () => {
  const state = fold([
    {
      type: "user_message",
      text: "what is this?",
      attachments: [{ id: "a".repeat(64), mimeType: "image/png", size: 12, name: "shot.png" }],
    },
  ]);
  const row = state.rows[0];
  expect(row?.kind).toBe("user");
  expect(row?.kind === "user" && row.images).toEqual([
    { id: "a".repeat(64), mimeType: "image/png", size: 12, name: "shot.png" },
  ]);
});

test("a fired turn's ref is carried on its row; an ordinary prompt's row has none (cron-tool S6)", () => {
  const state = fold([
    {
      type: "user_message",
      text: "[scheduled sc-1 · every 10m · fire 5] check CI",
      schedule: { id: "sc-1", spec: "every 10m" },
    },
    { type: "user_message", text: "and now something else" },
  ]);
  const fired = state.rows[0];
  expect(fired?.kind === "user" && fired.schedule).toEqual({ id: "sc-1", spec: "every 10m" });
  // Absence is the normal case (an ordinary prompt, an older daemon, a RELOAD):
  // never an empty object, which a renderer would have to second-guess.
  const plain = state.rows[1];
  expect(plain?.kind === "user" && "schedule" in plain).toBe(false);
});

test("a fired turn's row is the SAME live and reloaded from the stored message (scheduled-fire-row)", () => {
  // Mutation: drop `schedule: m.scheduled` in transcript-history.ts → the reloaded
  // row has no record (its node would say `#5`, not the fire time) → red.
  const record = { id: "sc-1", spec: "every 10m", fire: 5, at: 1_763_394_840_000 };
  const text = "[scheduled sc-1 · every 10m · fire 5] check CI";
  const live = fold([{ type: "user_message", text, schedule: record }]).rows[0];
  const stored: ChatMessage = { role: "user", content: text, scheduled: record };
  const reloaded = fold([{ type: "history", messages: [stored], reason: null }]).rows[0];
  const shape = (row: typeof live) =>
    row?.kind === "user"
      ? { text: row.text, images: row.images, schedule: row.schedule }
      : "not a user row";
  expect(shape(reloaded)).toEqual(shape(live));
  expect(shape(live)).toEqual({ text, images: [], schedule: record });
  // An older log (no field): no record, the node falls back to the text prefix.
  const old = fold([{ type: "history", messages: [{ role: "user", content: text }], reason: null }])
    .rows[0];
  expect(old?.kind === "user" && "schedule" in old).toBe(false);
});

test("a closed session keeps the transcript and adds one notice", () => {
  const before = fold([
    { type: "history", messages: [{ role: "user", content: "hi" }], reason: null },
  ]);
  const after = apply(before, { type: "closed", reason: "deleted" });
  expect(after.closed).toBe("deleted");
  expect(after.rows).toHaveLength(2);
  expect(after.rows[1]?.kind === "notice" && after.rows[1].text).toContain("deleted");
});

test("the link status is state, never a row (the screen draws its banner)", () => {
  const down = fold([{ type: "link", status: "down" }]);
  expect(down.link).toBe("down");
  expect(down.rows).toHaveLength(0);
  expect(apply(down, { type: "link", status: "down" })).toBe(down);
});

test("the daemon's explanations become notices, never silence", () => {
  const cut = fold([{ type: "truncated_reply", reason: "length", retrying: false }]);
  expect(cut.rows[0]?.kind).toBe("notice");
  const empty = fold([{ type: "empty_turn" }]);
  expect(empty.rows[0]?.kind).toBe("notice");
  const repaired = fold([
    { type: "history_repaired", invalidArguments: 1, unansweredCalls: 0, orphanResults: 0 },
  ]);
  expect(repaired.rows[0]?.kind).toBe("notice");
  const leak = fold([{ type: "dsml_leak", text: "the model leaked a tool call" }]);
  expect(leak.rows[0]?.kind).toBe("notice");
  // A hook's note is shown; the loop's own nudge is not.
  const hook = fold([{ type: "context_note", text: "hook said so", reason: "hook" }]);
  expect(hook.rows).toHaveLength(1);
  const nudge = fold([{ type: "context_note", text: "keep going", reason: "continue" }]);
  expect(nudge.rows).toHaveLength(0);
});

/** A notice row's level, as the row carries it (`undefined` = info). */
const levelOfRow = (row: Row | undefined): "warn" | undefined =>
  row?.kind === "notice" ? row.level : undefined;

describe("harness levels: the TUI's table, so the phone can draw `▲` vs `◇`", () => {
  // docs/feat/mobile-harness-notices.md S1 / `packages/tui/src/state.ts:724`,`:730`.
  // Mutation: drop a `"warn"` in `transcript.ts` → the matching case goes red.
  test("a cut reply and an empty turn WARN; a repair, a leak and a hook note are info", () => {
    const cut = fold([{ type: "truncated_reply", reason: "length", retrying: false }]);
    expect(levelOfRow(cut.rows[0])).toBe("warn");
    const empty = fold([{ type: "empty_turn" }]);
    expect(levelOfRow(empty.rows[0])).toBe("warn");
    // Info is the ABSENCE of the field, never a `level: "info"` (the TUI's shape).
    const repaired = fold([
      { type: "history_repaired", invalidArguments: 1, unansweredCalls: 0, orphanResults: 0 },
    ]);
    expect(repaired.rows[0]).toMatchObject({ kind: "notice" });
    expect(levelOfRow(repaired.rows[0])).toBeUndefined();
    const leak = fold([{ type: "dsml_leak", text: "the model leaked a tool call" }]);
    expect(levelOfRow(leak.rows[0])).toBeUndefined();
    const hook = fold([{ type: "context_note", text: "hook said so", reason: "hook" }]);
    expect(levelOfRow(hook.rows[0])).toBeUndefined();
  });

  test("the phone-only notices: a LOST turn's stream warns, the rest are info (Owner Q3)", () => {
    const lost = fold([{ type: "turn_started", turnId: "t1", own: false }]);
    const ended = apply(lost, { type: "turn_ended", outcome: "lost" });
    expect(levelOfRow(ended.rows[0])).toBe("warn");
    const interrupted = apply(lost, { type: "turn_ended", outcome: "interrupted" });
    expect(levelOfRow(interrupted.rows[0])).toBeUndefined();
    const closed = fold([{ type: "closed", reason: "deleted" }]);
    expect(levelOfRow(closed.rows[0])).toBeUndefined();
    const unsupported = fold([{ type: "unsupported", kind: "brand_new_update" }]);
    expect(levelOfRow(unsupported.rows[0])).toBeUndefined();
    const failed = apply(lost, { type: "turn_ended", outcome: "failed", message: "boom" });
    expect(failed.rows[0]?.kind === "notice" ? failed.rows[0].text : "").toBe("⚠ boom");
  });

  test("the merged `again` line keeps the warn level AND its key (FlatList identity)", () => {
    // Mutation: build the merged row from scratch (or default its level) → red on
    // either assertion: the block would lose its `▲`, or the list its identity.
    const s = fold([
      { type: "turn_started", turnId: "t1", own: true },
      text("part one"),
      { type: "truncated_reply", reason: "length", retrying: true },
      { type: "truncated_reply", reason: "length", retrying: false },
    ]);
    const notices = s.rows.filter((r) => r.kind === "notice");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: "notice", level: "warn" });
    expect(notices[0]?.text).toContain("cut again");
    // The key is the FIRST line's: a re-ask rewrites in place, never re-keys.
    const first = fold([
      { type: "turn_started", turnId: "t1", own: true },
      text("part one"),
      { type: "truncated_reply", reason: "length", retrying: true },
    ]);
    const firstNotice = first.rows.find((r) => r.kind === "notice");
    const mergedKey = notices[0]?.kind === "notice" ? notices[0].key : "";
    expect(mergedKey).not.toBe("");
    expect(firstNotice?.key).toBe(mergedKey);
  });

  test("a reloaded history groups EXACTLY as the live fold does, and carries no level", () => {
    // The failure mode the plan names ("reload vs live"): a cut/empty warning is
    // never persisted, so a reload has no `▲` — but NOTES from history are the
    // same rows and must group the same, or the block re-opens on reopen.
    const history: readonly ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "user", content: "a job exited 0", note: { kind: "background" } },
      { role: "user", content: "a sub-agent finished", note: { kind: "subagent", id: "sa-1" } },
    ];
    const reloaded = apply(initialState, { type: "history", messages: history, reason: null });
    const notices = reloaded.rows.filter((r) => r.kind === "notice");
    expect(notices).toHaveLength(2);
    expect(notices.every((r) => r.level === undefined)).toBe(true);
    // One block: the second note hangs under the first (no glyph of its own).
    const looks = noticeLooks(reloaded.rows);
    expect(looks.get(notices[0]?.key ?? "")).toEqual({ glyph: NOTICE_GLYPHS.info, joined: false });
    expect(looks.get(notices[1]?.key ?? "")).toEqual({ glyph: null, joined: true });
  });
});

describe("the truncation merge is scoped to the re-ask's OWN round (Review round 3 MEDIUM-1)", () => {
  const noticeTexts = (s: State) => s.rows.flatMap((r) => (r.kind === "notice" ? [r.text] : []));

  test("a LATER cut of the same turn appends a new line, it does not rewrite the first", () => {
    // The re-ask's round ended normally (it ran a tool), so what follows is a
    // second, separate cut. Mutation: merge on any turn notice → one line, the
    // first one rewritten far above the tool row.
    const s = fold([
      { type: "turn_started", turnId: "t1", own: true },
      text("part one"),
      { type: "truncated_reply", reason: "length", retrying: true },
      text(" continued"),
      { type: "tool_start", id: "t1", name: "fs_read", arguments: '{"path":"a"}' },
      { type: "tool_result", id: "t1", name: "fs_read", result: { content: "hi" } },
      text("final round"),
      { type: "truncated_reply", reason: "length", retrying: false },
    ]);
    expect(noticeTexts(s)).toEqual([
      "the reply was cut at the model's output limit — this answer is incomplete; asking it to continue",
      "the reply was cut at the model's output limit — this answer is incomplete",
    ]);
    expect(s.rows.at(-1)?.kind).toBe("notice");
  });

  test("a NEW turn's cut never merges into the previous turn's line", () => {
    // The new turn's `user` row is not an answer row, so the structural rule
    // rejects the earlier line with no separate per-turn check. Mutation: merge
    // on any turn notice text (the round-3 rule) → the old line is rewritten.
    const s = fold([
      { type: "turn_started", turnId: "t1", own: true },
      text("part one"),
      { type: "truncated_reply", reason: "length", retrying: true },
      { type: "turn_ended", outcome: "ended" },
      { type: "user_message", text: "another question" },
      { type: "turn_started", turnId: "t2", own: true },
      { type: "truncated_reply", reason: "length", retrying: false },
    ]);
    expect(noticeTexts(s)).toEqual([
      "the reply was cut at the model's output limit — this answer is incomplete; asking it to continue",
      "the model returned nothing: it hit its output limit before writing anything",
    ]);
  });

  test("a `cut` never merges: the output-limit line stays, the stream-cut one is appended", () => {
    const s = fold([
      { type: "turn_started", turnId: "t1", own: true },
      text("part one"),
      { type: "truncated_reply", reason: "length", retrying: true },
      text(" and more"),
      { type: "truncated_reply", reason: "cut", retrying: false },
    ]);
    expect(noticeTexts(s)).toEqual([
      "the reply was cut at the model's output limit — this answer is incomplete; asking it to continue",
      "the model's stream was cut before it finished — this answer is incomplete",
    ]);
  });
});

describe("a foreground sub-agent's progress lands on its Agent row (docs/fix/mobile-chat-glitches.md, item 10)", () => {
  // The owner's "stuck on Running": every `subagent_*` event fell into the fold's
  // `default` and changed nothing, so a minutes-long legitimate wait looked like
  // a hang. Mutation: route the four kinds back to `default` → red.
  const start = { type: "tool_start", id: "call-1", name: "agent_task", arguments: "{}" } as const;
  const sub = (s: State) => (s.rows.find((r) => r.kind === "tool") as ToolRow | undefined)?.sub;

  test("the repro, made an assertion: tools counted, the latest activity, tokens", () => {
    const s = fold([
      { type: "turn_started", turnId: "t1", own: true },
      start,
      {
        type: "subagent_start",
        id: "call-1",
        agentType: "general",
        description: "Task lungo in background",
      },
      { type: "subagent_tool", id: "call-1", label: "shell: sleep 10" },
      { type: "subagent_usage", id: "call-1", promptTokens: 900, completionTokens: 40 },
      { type: "subagent_tool", id: "call-1", label: "agent_notify" },
      { type: "subagent_tool", id: "call-1", label: "shell: sleep 10" },
    ]);
    expect(sub(s)?.toolUses).toBe(3);
    expect(sub(s)?.activities.at(-1)).toBe("shell: sleep 10");
    expect(sub(s)?.tokens).toBe(940);
    expect(sub(s)?.done).toBe(false);
  });

  test("`subagent_end` → done, with the child's own tool count and stop reason", () => {
    const s = fold([
      start,
      { type: "subagent_tool", id: "call-1", label: "Read a.ts" },
      { type: "subagent_end", id: "call-1", toolUses: 2, stopReason: "end_turn" },
    ]);
    expect(sub(s)).toMatchObject({ done: true, toolUses: 2, stopReason: "end_turn" });
    expect(sub(s)?.movedTo).toBeUndefined();
  });

  test("a child MOVED to the background → done + movedTo", () => {
    const s = fold([
      start,
      {
        type: "subagent_end",
        id: "call-1",
        toolUses: 1,
        stopReason: "background",
        agentId: "sa-3",
      },
    ]);
    expect(sub(s)).toMatchObject({ done: true, stopReason: "background", movedTo: "sa-3" });
  });

  test("progress for a call id the fold never saw → the state is identical", () => {
    const before = fold([start]);
    const after = apply(before, { type: "subagent_tool", id: "other", label: "x" });
    expect(after).toBe(before);
  });

  test("a flood of activities keeps only the last 3; the count keeps growing", () => {
    const s = fold([
      start,
      ...Array.from({ length: 10 }, (_, i) => ({
        type: "subagent_tool" as const,
        id: "call-1",
        label: `step ${i + 1}`,
      })),
    ]);
    expect(sub(s)?.activities).toEqual(["step 8", "step 9", "step 10"]);
    expect(sub(s)?.toolUses).toBe(10);
  });

  test("an over-long label is capped by the fold too", () => {
    const s = fold([start, { type: "subagent_tool", id: "call-1", label: "x".repeat(1000) }]);
    expect(sub(s)?.activities).toHaveLength(1);
    expect((sub(s)?.activities[0] ?? "").length).toBeLessThanOrEqual(120);
  });
});
