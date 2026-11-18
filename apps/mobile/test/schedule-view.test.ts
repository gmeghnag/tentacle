import { describe, expect, test } from "bun:test";
import type { ScheduleRow } from "@tentacle/protocol";
import {
  firedRowView,
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

describe("firedRowView: a fired wake as a timeline node (docs/feat/scheduled-fire-row.md)", () => {
  const AT = new Date(2026, 10, 17, 11, 54).getTime();
  const text = "[scheduled sc-1 · every 10m · fire 5] check CI\non PR #412";

  test("the stored/live record gives the fire time; one line collapsed, the prompt in full open", () => {
    expect(firedRowView(text, { id: "sc-1", spec: "every 10m", fire: 5, at: AT }, NOW)).toEqual({
      name: "Wake 11:54",
      subtitle: "check CI on PR #412",
      body: "check CI\non PR #412",
      a11yLabel: "Wake 11:54: check CI on PR #412",
    });
  });

  test("an older daemon or log (no instant): every → #N, at → its spec time", () => {
    expect(firedRowView(text, { id: "sc-1", spec: "every 10m" }, NOW)?.name).toBe("Wake #5");
    expect(firedRowView(text, undefined, NOW)?.name).toBe("Wake #5");
    expect(
      firedRowView("[scheduled sc-2 · at 2026-11-16T09:05 · fire 1] go", undefined, NOW)?.name,
    ).toBe("Wake 16 Nov 09:05");
  });

  test("an ordinary message is not a fired node", () => {
    expect(firedRowView("hello", undefined, NOW)).toBeNull();
  });

  test("a hostile prompt's labels are one sanitized line", () => {
    const view = firedRowView(
      `[scheduled sc-1 · every 10m · fire 1] a\u001b[2J‮${"z".repeat(400)}`,
      undefined,
      NOW,
    );
    expect(view?.subtitle).not.toContain("\u001b");
    expect(view?.subtitle).not.toContain("‮");
    expect(view?.subtitle.length).toBeLessThanOrEqual(80);
  });
});
