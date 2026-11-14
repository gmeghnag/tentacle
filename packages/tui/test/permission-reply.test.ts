import { describe, expect, test } from "bun:test";
import type { PermissionRequest } from "@tentacle/core";
import type { Key } from "ink";
import { EMPTY_EDITOR, setValue } from "../src/editor.ts";
import {
  ARM_MS,
  DENIED_LABEL,
  type DialogContext,
  type DialogStep,
  MENU,
  type ReplyMode,
  denialReplyLines,
  draftOf,
  insertReply,
  isArmed,
  orphanNotice,
  replyView,
  stepPermissionKey,
} from "../src/permission-reply.ts";
import { buildPermissionChoices } from "../src/permission-ui.ts";

// docs/feat/permission-reply.md: the dialog's fourth answer "No, let's talk
// about it" — every key decision here, pure; `App` only executes the action.
// docs/fix/quit-enter-ask.md: the ARMING WINDOW — an approving key typed for
// the main input as the dialog appears must not answer it.

const key = (over: Partial<Key> = {}): Key => ({
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  ...over,
});

const shell: PermissionRequest = {
  tool: "shell",
  level: "ask",
  title: "Run a shell command",
  detail: "rm -rf build",
  input: {},
};
const replyable: PermissionRequest = { ...shell, reply: { maxChars: 2000 } };
/** `armed` defaults to true: the window has passed (every pre-existing case here). */
const ctx = (
  req: PermissionRequest,
  selected = 0,
  maxChars = 2000,
  armed = true,
): DialogContext => ({
  choices: buildPermissionChoices(req),
  selected,
  maxChars,
  armed,
});
const step = (state: ReplyMode, char: string, k: Partial<Key>, c: DialogContext): DialogStep =>
  stepPermissionKey(state, char, key(k), c);
/** Type `text` into the field, one key at a time. */
const type = (state: ReplyMode, text: string, c: DialogContext): ReplyMode =>
  [...text].reduce((s, ch) => step(s, ch, {}, c).state, state);

describe("the choices", () => {
  test("a fourth choice only when the request takes a reply", () => {
    expect(buildPermissionChoices(shell).map((c) => c.label)).toEqual([
      "Yes",
      "Yes, and don't ask again this session",
      "No",
    ]);
    const four = buildPermissionChoices(replyable);
    expect(four.map((c) => c.label)).toEqual([
      "Yes",
      "Yes, and don't ask again this session",
      "No",
      "No, let's talk about it",
    ]);
    expect(four[3]?.reply).toBe(true);
    expect(buildPermissionChoices({ ...replyable, kind: "hooks_trust" }).some((c) => c.reply)).toBe(
      false,
    );
  });
});

describe("the arming window (docs/fix/quit-enter-ask.md)", () => {
  const disarmed = (req: PermissionRequest = replyable, selected = 0) =>
    ctx(req, selected, 2000, false);

  test("isArmed: null is disarmed, the boundary is exactly ARM_MS, a backwards clock never grants", () => {
    expect(ARM_MS).toBe(500);
    expect(isArmed(null, 1_000)).toBe(false);
    const t0 = 10_000;
    expect(isArmed(t0, t0)).toBe(false);
    expect(isArmed(t0, t0 + ARM_MS - 1)).toBe(false);
    expect(isArmed(t0, t0 + ARM_MS)).toBe(true);
    expect(isArmed(t0, t0 + ARM_MS * 10)).toBe(true);
    // A clock that jumped BACKWARDS must not grant: still disarmed.
    expect(isArmed(t0, t0 - 5_000)).toBe(false);
  });

  test("disarmed: every approving key is swallowed — the dialog stays, nothing answers", () => {
    // Enter on "Yes", y, a, and Enter on any other allow row ("Always allow").
    expect(step(MENU, "", { return: true }, disarmed())).toEqual({
      state: MENU,
      action: { kind: "none" },
    });
    expect(step(MENU, "y", {}, disarmed())).toEqual({ state: MENU, action: { kind: "none" } });
    expect(step(MENU, "a", {}, disarmed())).toEqual({ state: MENU, action: { kind: "none" } });
    expect(step(MENU, "", { return: true }, disarmed(replyable, 1))).toEqual({
      state: MENU,
      action: { kind: "none" },
    });
    // Every kind of request that asks: a hooks trust allow row, `y` on it, and a
    // session-hop "Yes, move it".
    const trust = { ...shell, kind: "hooks_trust" as const };
    expect(step(MENU, "", { return: true }, disarmed(trust)).action).toEqual({ kind: "none" });
    expect(step(MENU, "y", {}, disarmed(trust)).action).toEqual({ kind: "none" });
    const hop = { ...shell, kind: "session_hop" as const };
    expect(step(MENU, "", { return: true }, disarmed(hop)).action).toEqual({ kind: "none" });
  });

  test("disarmed: refusals, arrows, t and Ctrl+C stay immediate (owner Q2)", () => {
    // An accidental refusal is recoverable, an accidental approval is not.
    expect(step(MENU, "n", {}, disarmed()).action).toEqual({
      kind: "answer",
      response: { allowed: false },
    });
    expect(step(MENU, "", { escape: true }, disarmed()).action).toEqual({
      kind: "answer",
      response: { allowed: false },
    });
    // Enter on "No", and `a` on a hooks trust ask with no store (a refusal row).
    expect(step(MENU, "", { return: true }, disarmed(replyable, 2)).action).toEqual({
      kind: "answer",
      response: { allowed: false },
    });
    const trust = { ...shell, kind: "hooks_trust" as const };
    expect(step(MENU, "a", {}, disarmed(trust)).action).toEqual({
      kind: "answer",
      response: { allowed: false },
    });
    expect(step(MENU, "", { downArrow: true }, disarmed()).action).toEqual({
      kind: "select",
      index: 1,
    });
    expect(step(MENU, "", { upArrow: true }, disarmed()).action).toEqual({
      kind: "select",
      index: 3,
    });
    // The reply row / `t` open the field: its Enter can only refuse or send.
    expect(step(MENU, "t", {}, disarmed()).state.mode).toBe("reply");
    expect(step(MENU, "", { return: true }, disarmed(replyable, 3)).state.mode).toBe("reply");
    expect(step(MENU, "c", { ctrl: true }, disarmed()).action).toEqual({ kind: "stop" });
  });

  test("armed: today's behaviour — the same keys do answer", () => {
    const c = ctx(replyable, 0, 2000, true);
    expect(step(MENU, "", { return: true }, c).action).toEqual({
      kind: "answer",
      response: { allowed: true, scope: "once" },
    });
    expect(step(MENU, "y", {}, c).action).toEqual({
      kind: "answer",
      response: { allowed: true, scope: "once" },
    });
    expect(step(MENU, "a", {}, c).action).toEqual({
      kind: "answer",
      response: { allowed: true, scope: "session" },
    });
  });
});

describe("the menu", () => {
  test("y / a / n / Esc answer as today; ↑↓ select; Ctrl+C stops", () => {
    const c = ctx(replyable);
    expect(step(MENU, "y", {}, c).action).toEqual({
      kind: "answer",
      response: { allowed: true, scope: "once" },
    });
    expect(step(MENU, "a", {}, c).action).toEqual({
      kind: "answer",
      response: { allowed: true, scope: "session" },
    });
    expect(step(MENU, "n", {}, c).action).toEqual({ kind: "answer", response: { allowed: false } });
    expect(step(MENU, "", { escape: true }, c).action).toEqual({
      kind: "answer",
      response: { allowed: false },
    });
    expect(step(MENU, "", { upArrow: true }, c).action).toEqual({ kind: "select", index: 3 });
    expect(step(MENU, "", { downArrow: true }, ctx(replyable, 3)).action).toEqual({
      kind: "select",
      index: 0,
    });
    expect(step(MENU, "c", { ctrl: true }, c).action).toEqual({ kind: "stop" });
  });

  test("t, or Enter on the fourth choice, opens the field; with no reply offered, t does nothing", () => {
    const opened = step(MENU, "t", {}, ctx(replyable));
    expect(opened).toEqual({
      state: { mode: "reply", editor: EMPTY_EDITOR },
      action: { kind: "none" },
    });
    expect(step(MENU, "", { return: true }, ctx(replyable, 3)).state.mode).toBe("reply");
    expect(step(MENU, "t", {}, ctx(shell))).toEqual({ state: MENU, action: { kind: "none" } });
  });
});

describe("the field", () => {
  const c = ctx(replyable, 3);
  const open = step(MENU, "t", {}, c).state;

  test("typed text + Enter → a refusal with the message", () => {
    const typed = type(open, "try bun run build", c);
    expect(step(typed, "", { return: true }, c).action).toEqual({
      kind: "answer",
      response: { allowed: false, message: "try bun run build" },
    });
  });

  test("empty or blank + Enter → a plain No (owner Q2)", () => {
    expect(step(open, "", { return: true }, c).action).toEqual({
      kind: "answer",
      response: { allowed: false },
    });
    expect(step(type(open, "  ", c), "", { return: true }, c).action).toEqual({
      kind: "answer",
      response: { allowed: false },
    });
  });

  test("letters are text, not shortcuts: y / n / t / a never answer", () => {
    for (const ch of ["y", "n", "t", "a"]) {
      const s = step(open, ch, {}, c);
      expect(s.action).toEqual({ kind: "none" });
      expect(draftOf(s.state)).toBe(ch);
    }
  });

  test("Esc → back to the menu, the draft kept for this request; t reopens it", () => {
    const typed = type(open, "why", c);
    const back = step(typed, "", { escape: true }, c);
    expect(back.state.mode).toBe("menu");
    expect(back.action).toEqual({ kind: "none" });
    expect(draftOf(back.state)).toBe("why");
    const again = step(back.state, "t", {}, c);
    expect(again.state.mode === "reply" ? again.state.editor.value : "").toBe("why");
  });

  test("a trailing \\ + Enter is a newline; Ctrl+V asks for the clipboard; Ctrl+C stops", () => {
    const typed = type(open, "a\\", c);
    const nl = step(typed, "", { return: true }, c);
    expect(nl.action).toEqual({ kind: "none" });
    expect(draftOf(nl.state)).toBe("a\n");
    expect(step(open, "v", { ctrl: true }, c).action).toEqual({ kind: "pasteClipboard" });
    expect(step(typed, "c", { ctrl: true }, c).action).toEqual({ kind: "stop" });
  });

  test("input past maxChars is clipped (typed and pasted)", () => {
    const small = ctx(replyable, 3, 5);
    const s = type(step(MENU, "t", {}, small).state, "abcdefgh", small);
    expect(draftOf(s)).toBe("abcde");
    expect(draftOf(insertReply(step(MENU, "t", {}, small).state, "0123456789", 5))).toBe("01234");
    // A selection is replaced, so its room counts.
    const sel: ReplyMode = {
      mode: "reply",
      editor: { ...setValue("abcde"), anchor: 0, cursor: 5 },
    };
    expect(draftOf(insertReply(sel, "xyz", 5))).toBe("xyz");
  });
});

describe("the field's view", () => {
  test("prompt, at most 4 rows (scrolling), footer; the counter from 80 %", () => {
    const v = replyView({ mode: "reply", editor: setValue("hello") }, 60, 2000);
    expect(v.prompt).toBe("Tell the agent why, or what to do instead:");
    expect(v.rows.length).toBe(1);
    expect(v.footer).toBe(" enter send · esc back · empty = No");
    const tall = replyView({ mode: "reply", editor: setValue("1\n2\n3\n4\n5\n6") }, 60, 2000);
    expect(tall.rows.length).toBe(4);
    const near = replyView({ mode: "reply", editor: setValue("x".repeat(1640)) }, 60, 2000);
    expect(near.footer).toBe(" enter send · esc back · empty = No · 1640/2000");
    const below = replyView({ mode: "reply", editor: setValue("x".repeat(1599)) }, 60, 2000);
    expect(below.footer).not.toContain("/2000");
  });
});

describe("the transcript row", () => {
  test("`✗ Denied · <text>`; continuation lines indented under the text", () => {
    expect(DENIED_LABEL).toBe("✗ Denied");
    expect(denialReplyLines("try bun run build first")).toEqual([
      "✗ Denied · try bun run build first",
    ]);
    expect(denialReplyLines("why?\ntry bun run build\n")).toEqual([
      "✗ Denied · why?",
      "           try bun run build",
    ]);
  });
});

describe("orphanNotice: the hand-back says what really happened (fix round 1 F2)", () => {
  test("'already settled' only when the request really was settled", () => {
    expect(orphanNotice("settled")).toContain("already settled");
    for (const cause of ["session-lost", "failed", "unreplyable"] as const) {
      expect(orphanNotice(cause)).not.toContain("already settled");
      expect(orphanNotice(cause)).toContain("back in the input");
    }
  });

  test("a lost session says it MAY have arrived; a failure says it was not sent; an older daemon says it takes no reply", () => {
    expect(orphanNotice("session-lost")).toContain("may not have reached the agent");
    expect(orphanNotice("failed")).toContain("could not be sent");
    expect(orphanNotice("unreplyable")).toContain("does not take a reply");
  });
});
