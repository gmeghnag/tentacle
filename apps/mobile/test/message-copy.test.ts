/**
 * Copy a message on the phone (docs/feat/mobile-copy-text.md D1): WHAT a row
 * copies is decided here, React-free, and shared with the header menu's own
 * copy actions — so a per-message copy and "Copy last answer" are the same
 * bytes by construction, and a `serve` session and a Mac session behave alike
 * (both are just `Row`s).
 */
import { describe, expect, test } from "bun:test";
import {
  COPY_FLASH_MS,
  copyFlashFor,
  copyFlashShown,
  flashReleased,
  messageCopy,
  messageText,
} from "../src/message-copy.ts";
import { sessionMenu } from "../src/session-menu.ts";
import type { Row } from "../src/transcript-rows.ts";

const NOW = 1_763_700_000_000;

const user = (key: string, text: string, extra: Partial<Row> = {}): Row =>
  ({ kind: "user", key, text, images: [], ...extra }) as Row;
const answer = (key: string, text: string, extra: Partial<Row> = {}): Row =>
  ({ kind: "assistant", key, text, version: text.length, ...extra }) as Row;

const tool: Row = {
  kind: "tool",
  key: "t",
  id: "c1",
  name: "shell",
  label: "Bash",
  args: "{}",
  status: "ok",
};
const thought: Row = { kind: "reasoning", key: "r", text: "hmm", version: 3 };
const notice: Row = { kind: "notice", key: "n", text: "turn ended" };

describe("messageText: the MARKDOWN SOURCE of a message, trimmed at the end", () => {
  test("T1 an answer copies byte-for-byte, trailing blank lines trimmed", () => {
    const source = [
      "Here is **bold**, a fence and a [link](https://example.com).",
      "",
      "```ts",
      "const a = 1 < 2;",
      "```",
      "",
      "",
    ].join("\n");
    expect(messageText(answer("a1", source))).toBe(source.trimEnd());
  });

  test("T2 the person's own prompt copies as typed", () => {
    expect(messageText(user("u1", "  indented start\nsecond line"))).toBe(
      "  indented start\nsecond line",
    );
  });

  test("T2 a restart prompt (a context reset's body) copies", () => {
    const restart: Row = {
      kind: "context",
      key: "c1",
      event: "reset",
      body: "carry on\n",
    };
    expect(messageText(restart)).toBe("carry on");
  });

  test("T2 a photo-only prompt has no text to copy (never a `[image: …]` label)", () => {
    const photo: Row = {
      kind: "user",
      key: "u1",
      text: "",
      images: [{ id: "i1", mimeType: "image/jpeg", size: 12, name: "a.jpg" }],
    };
    expect(messageText(photo)).toBe("");
    expect(messageCopy(photo, NOW)).toEqual({ kind: "empty", label: "No text to copy" });
  });

  test("T2 a pdf-only prompt has no text to copy", () => {
    const pdf: Row = {
      kind: "user",
      key: "u1",
      text: "",
      images: [],
      documents: ["[pdf: report.pdf · 2 pp]"],
    };
    expect(messageCopy(pdf, NOW)).toEqual({ kind: "empty", label: "No text to copy" });
  });

  test("T2 blank text is `empty`, never a copy of whitespace", () => {
    expect(messageCopy(user("u1", "  \n"), NOW)).toEqual({
      kind: "empty",
      label: "No text to copy",
    });
  });

  test("T4 tool, thought and notice rows are not messages at all", () => {
    for (const row of [tool, thought, notice]) {
      expect(messageText(row)).toBeNull();
      expect(messageCopy(row, NOW)).toBeNull();
    }
  });

  test("T4 a compaction node is a step, not a message", () => {
    const compact: Row = { kind: "context", key: "c2", event: "compact", body: "summary" };
    expect(messageCopy(compact, NOW)).toBeNull();
  });
});

describe("messageCopy: what a long-press does", () => {
  test("a message with text is copied, and says so", () => {
    expect(messageCopy(answer("a1", "**b**\n\n"), NOW)).toEqual({
      kind: "copy",
      text: "**b**",
      label: "Copied",
    });
  });

  test("T3 a fired scheduled wake has no long-press (it keeps its own body)", () => {
    const prefix = "[scheduled sc-1 · every 10m · fire 5] check CI";
    expect(messageCopy(user("u1", prefix), NOW)).toBeNull();
    // The same turn with its trust-gated record instead of the prefix.
    const ref = user("u2", "check CI", {
      schedule: { id: "sc-1", spec: "every 10m", at: NOW - 60_000 },
    });
    expect(messageCopy(ref, NOW)).toBeNull();
  });

  test("T5 parity: a message's copy IS what the header's last-answer copy gives", () => {
    const rows: Row[] = [user("u1", "hi"), answer("a1", "first\n\n"), user("u2", "again")];
    const last = [...rows].reverse().find((row) => row.kind === "assistant");
    if (last === undefined) {
      throw new Error("fixture");
    }
    const menu = sessionMenu(rows).find((action) => action.id === "copy-last");
    const copied = messageCopy(last, NOW);
    expect(copied?.kind === "copy" ? copied.text : null).toBe(menu?.text ?? null);
  });

  test("T6 the same row copies the same on a Mac session and a serve session", () => {
    const cases: readonly { readonly row: Row; readonly expected: string }[] = [
      { row: answer("a1", "hello", { at: NOW }), expected: "hello" },
      { row: answer("a1", "hello"), expected: "hello" },
      { row: user("u1", "hello", { at: NOW }), expected: "hello" },
      { row: user("u1", "hello"), expected: "hello" },
    ];
    for (const { row, expected } of cases) {
      const copied = messageCopy(row, NOW);
      expect(copied?.kind === "copy" ? copied.text : null).toBe(expected);
    }
  });
});

describe("copyFlashShown: the pill's window is half-open", () => {
  const flash = {
    outcome: { kind: "copy", text: "hi", label: "Copied" },
    at: NOW,
    pressing: false,
  } as const;

  test("T7 shown at the copy, still shown a millisecond before the window closes", () => {
    expect(copyFlashShown(flash, NOW)).toBe(true);
    expect(copyFlashShown(flash, NOW + COPY_FLASH_MS - 1)).toBe(true);
  });

  test("T7 hidden once the window elapses", () => {
    expect(copyFlashShown(flash, NOW + COPY_FLASH_MS)).toBe(false);
  });

  test("T7 a clock that went backwards hides it, and no flash is not shown", () => {
    expect(copyFlashShown(flash, NOW - 1)).toBe(false);
    expect(copyFlashShown(null, NOW)).toBe(false);
  });

  test("T7 while the press is still DOWN the pill does not count down", () => {
    // A long press copies at 400 ms and may be held for seconds: a window that ran
    // under the finger would hide the pill before its release (the gate's bug).
    expect(copyFlashShown({ ...flash, pressing: true }, NOW + COPY_FLASH_MS * 4)).toBe(true);
  });
});

describe("flashReleased: the pill's window starts when the finger leaves", () => {
  const pressed = {
    outcome: { kind: "copy", text: "hi", label: "Copied" },
    at: NOW,
    pressing: true,
  } as const;

  test("T8 the press that copied ends: the pill is re-anchored at the release", () => {
    const released = flashReleased(pressed, NOW + 3000);
    expect(released?.at).toBe(NOW + 3000);
    expect(released?.outcome).toEqual(pressed.outcome);
    expect(released?.pressing).toBe(false);
  });

  test("T8 only ONE release re-anchors: a later tap cannot extend the pill", () => {
    const released = flashReleased(pressed, NOW + 3000);
    // The same object back, so React skips the render.
    expect(flashReleased(released, NOW + 3200)).toBe(released);
  });

  test("T8 a pill no press produced (the sheet's Copy all) is never re-anchored", () => {
    const sheet = { ...pressed, pressing: false };
    expect(flashReleased(sheet, NOW + 3000)).toBe(sheet);
    expect(flashReleased(null, NOW)).toBeNull();
  });
});

describe("copyFlashFor: only a finger still DOWN holds the pill's countdown", () => {
  const copied = { kind: "copy", text: "hi", label: "Copied" } as const;
  const empty = { kind: "empty", label: "No text to copy" } as const;

  test("T9 a long press still held: the pill waits for the release", () => {
    expect(copyFlashFor(copied, NOW, "press", false)).toEqual({
      outcome: copied,
      at: NOW,
      pressing: true,
    });
  });

  test("T9 a long press already released (a fast press): the window starts now", () => {
    expect(copyFlashFor(copied, NOW, "press", true).pressing).toBe(false);
  });

  test("T9 the VoiceOver action has no finger to lift: the pill counts down at once", () => {
    // No touch ⇒ no onPressOut ⇒ a `pressing` pill would stay up forever.
    for (const outcome of [copied, empty]) {
      const shown = copyFlashFor(outcome, NOW, "action", false);
      expect(shown.pressing).toBe(false);
      expect(copyFlashShown(shown, NOW + COPY_FLASH_MS)).toBe(false);
    }
  });

  test("T9 the sheet's Copy all has no finger either", () => {
    expect(copyFlashFor(copied, NOW, "sheet", false).pressing).toBe(false);
  });
});
