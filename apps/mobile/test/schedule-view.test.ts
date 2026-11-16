import { describe, expect, test } from "bun:test";
import type { ScheduleRow } from "@tentacle/protocol";
import {
  firedScheduleHead,
  scheduleMetaText,
  scheduleTitle,
  wakesBadge,
  wakesMeta,
} from "../src/schedule-view.ts";

const NOW = new Date(2026, 10, 17, 12, 0, 0).getTime(); // 17 Nov 2026 12:00 local

const row = (over: Partial<ScheduleRow> = {}): ScheduleRow => ({
  id: "sc-1",
  kind: "every",
  spec: "every 10m",
  prompt: "check CI on PR #412",
  nextAt: NOW + 10 * 60_000,
  fires: 4,
  createdAt: NOW - 3_600_000,
  expiresAt: new Date(2026, 10, 22, 14, 20).getTime(),
  ...over,
});

describe("scheduleTitle", () => {
  test("the prompt, one line, sanitized", () => {
    expect(scheduleTitle(row())).toBe("check CI on PR #412");
    expect(scheduleTitle(row({ prompt: "a\nb\u001b[31m\u202ec" }))).toBe("a b [31mc");
  });
});

describe("scheduleMetaText", () => {
  test("a recurring wake names its spec, next fire and fire count", () => {
    expect(scheduleMetaText(row(), NOW)).toBe("every 10m · next 12:10 · 4×");
  });

  test("a one-shot names its day and time, never a fire count", () => {
    const meta = scheduleMetaText(
      row({ kind: "at", spec: "at 17:00", nextAt: NOW + 2 * 3_600_000 + 29 * 60_000 }),
      NOW,
    );
    expect(meta).toBe("today 14:29 · one-shot");
    expect(meta).not.toContain("×");
  });

  test("a one-shot another day names that day, in THIS device's zone", () => {
    const at = new Date(2026, 11, 6, 17, 0).getTime();
    expect(scheduleMetaText(row({ kind: "at", nextAt: at }), NOW)).toBe("6 Dec 17:00 · one-shot");
  });
});

describe("wakesBadge / wakesMeta", () => {
  test("a count reads as a word, and zero is no word at all", () => {
    expect(wakesBadge(0)).toBe("");
    expect(wakesBadge(1)).toBe("1 wake");
    expect(wakesBadge(2)).toBe("2 wakes");
    expect(wakesMeta(0)).toBe("");
    expect(wakesMeta(1)).toBe("1 wake");
    expect(wakesMeta(3)).toBe("3 wakes");
  });
});

describe("firedScheduleHead (M8 option B)", () => {
  test("a ref paints the styled head", () => {
    expect(firedScheduleHead({ id: "sc-1", spec: "every 10m" })).toBe("◷ Scheduled · every 10m");
  });

  test("no ref at all paints NOTHING", () => {
    expect(firedScheduleHead(undefined)).toBe("");
  });

  test("a hostile ref is sanitized, one line", () => {
    const head = firedScheduleHead({ id: "sc-1", spec: "every\n10m\u001b[2J" });
    expect(head).toBe("◷ Scheduled · every 10m [2J");
    expect(head).not.toContain("\n");
  });
});
