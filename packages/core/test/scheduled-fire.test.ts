import { describe, expect, test } from "bun:test";
import { type ScheduledJob, schedulePromptText } from "../src/schedule.ts";
import {
  firedWakeLine,
  firedWakeOf,
  scheduleFallbackWhen,
  scheduledPromptOf,
  wakeTimeText,
} from "../src/scheduled-fire.ts";

/** Local-clock instants, so the tests hold in any zone. */
const NOW = new Date(2026, 10, 17, 18, 0).getTime();
const AT_1554 = new Date(2026, 10, 17, 15, 54).getTime();
const YESTERDAY_1614 = new Date(2026, 10, 16, 16, 14).getTime();

function job(over: Partial<ScheduledJob>): ScheduledJob {
  return {
    id: "sc-1",
    kind: "every",
    spec: "every 10m",
    prompt: "saluta l'utente",
    createdAt: 0,
    expiresAt: 0,
    nextAt: 0,
    fires: 1,
    failures: 0,
    createdBy: "t",
    ...over,
  };
}

describe("scheduledPromptOf (the inverse of schedulePromptText)", () => {
  const prompts = ["saluta l'utente", "a ] b · c] d", "line 1\nline 2\n\nline 4", ""];
  for (const prompt of prompts) {
    test(`round-trips every and at: ${JSON.stringify(prompt)}`, () => {
      for (const j of [
        job({ prompt, fires: 5 }),
        job({ id: "sc-12", kind: "at", spec: "at 2026-11-17T15:54", prompt }),
      ]) {
        expect(scheduledPromptOf(schedulePromptText(j))).toEqual({
          id: j.id,
          spec: j.spec,
          fire: j.fires,
          prompt,
        });
      }
    });
  }

  test("an ordinary message, a mid-text prefix, a missing fire → null", () => {
    expect(scheduledPromptOf("ciao")).toBeNull();
    expect(scheduledPromptOf("x [scheduled sc-1 · every 10m · fire 1] y")).toBeNull();
    expect(scheduledPromptOf("[scheduled sc-1 · every 10m] y")).toBeNull();
    expect(scheduledPromptOf("[scheduled sc-1 · every 10m · fire x] y")).toBeNull();
  });
});

describe("wakeTimeText / scheduleFallbackWhen (owner Q5)", () => {
  test("an instant: today → HH:MM, another day → D Mon HH:MM", () => {
    expect(wakeTimeText(AT_1554, NOW)).toBe("15:54");
    expect(wakeTimeText(YESTERDAY_1614, NOW)).toBe("16 Nov 16:14");
  });

  test("an older message's at spec is reformatted as a string, every → #N, other → as given", () => {
    expect(scheduleFallbackWhen("at 2026-11-17T15:54", 1, NOW)).toBe("15:54");
    expect(scheduleFallbackWhen("at 2026-11-16T09:05", 1, NOW)).toBe("16 Nov 09:05");
    expect(scheduleFallbackWhen("every 10m", 5, NOW)).toBe("#5");
    expect(scheduleFallbackWhen("at tomorrow 9:00", 1, NOW)).toBe("tomorrow 9:00");
    expect(scheduleFallbackWhen(`at ${"x".repeat(80)}`, 1, NOW).length).toBe(32);
  });
});

describe("firedWakeOf (structural first, the text prefix as fallback)", () => {
  const every5 = schedulePromptText(job({ fires: 5 }));

  test("the persisted instant wins: an every wake shows its fire time", () => {
    const view = firedWakeOf(
      every5,
      { id: "sc-1", spec: "every 10m", fire: 5, at: YESTERDAY_1614 },
      NOW,
    );
    expect(view).toEqual({ when: "16 Nov 16:14", prompt: "saluta l'utente" });
    expect(view === null ? "" : firedWakeLine(view)).toBe("Wake 16 Nov 16:14 · saluta l'utente");
  });

  test("an older log (no field) and an older daemon's {id, spec} ref fall back to the text", () => {
    expect(firedWakeOf(every5, undefined, NOW)).toEqual({ when: "#5", prompt: "saluta l'utente" });
    expect(firedWakeOf(every5, { id: "sc-1", spec: "every 10m" }, NOW)?.when).toBe("#5");
    const at = schedulePromptText(job({ kind: "at", spec: "at 2026-11-17T15:54" }));
    expect(firedWakeOf(at, undefined, NOW)?.when).toBe("15:54");
  });

  test("an ordinary message is not a fired row", () => {
    expect(firedWakeOf("ciao", undefined, NOW)).toBeNull();
  });

  test("the line is one line; an empty prompt leaves the head alone", () => {
    expect(firedWakeLine({ when: "15:54", prompt: "a\n\n  b" })).toBe("Wake 15:54 · a b");
    expect(firedWakeLine({ when: "15:54", prompt: "" })).toBe("Wake 15:54");
  });
});
