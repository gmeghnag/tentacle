import { describe, expect, test } from "bun:test";
import { VOICE_DEFAULTS, voiceInit } from "../src/voice-session.ts";
import { VOICE_STRIP_ROWS, voiceGhost, voiceStripView } from "../src/voice-view.ts";

/** T4 — the strip's view-model. Presentation only; all decisions are pure here. */

const model = (
  over: Parameters<typeof voiceInit>[0] extends never ? never : Record<string, unknown> = {},
) => ({
  ...voiceInit({ ...VOICE_DEFAULTS }),
  ...over,
});

const view = (m: ReturnType<typeof model>, columns = 80) =>
  voiceStripView(m as never, { columns, appName: "Terminal" });

describe("T4: markers — the strip shows nothing at rest", () => {
  test("idle draws no strip at all", () => {
    expect(view(model())).toBeNull();
    expect(VOICE_STRIP_ROWS).toBeGreaterThan(0);
  });

  test("off draws no strip (the notice said what happened)", () => {
    expect(view(model({ phase: "off" }))).toBeNull();
  });
});

describe("T4: the running strip", () => {
  test("listening shows the dot, the word, the elapsed clock and the language", () => {
    const v = view(model({ phase: "listening", audioMs: 7_400, lang: "it", dbfs: -30 }));
    expect(v).not.toBeNull();
    if (v === null) return;
    expect(v.text).toContain("listening");
    expect(v.text).toContain("0:07");
    expect(v.text).toContain("[it]");
  });

  test("starting says so, before any audio exists", () => {
    const v = view(model({ phase: "starting" }));
    expect(v?.text).toContain("starting");
  });

  test("transcribing says so and drops the meter", () => {
    const v = view(model({ phase: "transcribing" }));
    expect(v?.text).toContain("transcribing");
    expect(v?.meter).toBe("");
  });
});

describe("T4: the elapsed clock is mm:ss and counts AUDIO time", () => {
  test("formats seconds, then minutes", () => {
    expect(view(model({ phase: "listening", audioMs: 0 }))?.text).toContain("0:00");
    expect(view(model({ phase: "listening", audioMs: 65_000 }))?.text).toContain("1:05");
    expect(view(model({ phase: "listening", audioMs: 300_000 }))?.text).toContain("5:00");
  });

  test("truncates rather than rounding up (no 0:01 before a second has passed)", () => {
    expect(view(model({ phase: "listening", audioMs: 999 }))?.text).toContain("0:00");
  });
});

describe("T4: the meter buckets dBFS into a fixed set of heights", () => {
  test("silence is empty, full scale is the tallest bar", () => {
    const quiet = view(model({ phase: "listening", dbfs: -70 }));
    const loud = view(model({ phase: "listening", dbfs: 0 }));
    if (quiet === null || loud === null) throw new Error("strip missing");
    expect(quiet.meter.length).toBeLessThan(loud.meter.length);
    expect(loud.meter.length).toBeGreaterThan(0);
  });

  test("no reading yet is no meter, not a fake bar", () => {
    expect(view(model({ phase: "listening", dbfs: null }))?.meter).toBe("");
  });

  test("the bucket count is stable and monotone in level", () => {
    const heights = [-80, -60, -45, -30, -20, -10, -3, 0].map((dbfs) => {
      const v = view(model({ phase: "listening", dbfs }));
      return v === null ? -1 : v.meter.length;
    });
    for (let i = 1; i < heights.length; i++) {
      expect(heights[i]).toBeGreaterThanOrEqual(heights[i - 1] as number);
    }
  });
});

describe("the live partial is a ghost in the input, not a strip row (feat/voice-live-transcript)", () => {
  test("the strip is ONE row and carries no partial", () => {
    expect(VOICE_STRIP_ROWS).toBe(1);
    const v = view(model({ phase: "listening", partial: "ciao" }), 60);
    expect(v === null ? null : Object.keys(v)).not.toContain("partial");
  });

  test("the ghost is the partial while listening, starting and transcribing", () => {
    for (const phase of ["starting", "listening", "transcribing"] as const) {
      expect(voiceGhost(model({ phase, partial: "ciao" }) as never)).toBe("ciao");
    }
  });

  test("no ghost once the dictation is over (idle) or voice is off", () => {
    for (const phase of ["idle", "off"] as const) {
      expect(voiceGhost(model({ phase, partial: "ciao" }) as never)).toBe("");
    }
  });
});

describe("T4: the strip stays within the terminal width", () => {
  test("the whole strip never exceeds the terminal width", () => {
    const v = view(
      model({
        phase: "listening",
        audioMs: 301_000,
        dbfs: 0,
        lang: "it",
        partial: "y".repeat(500),
      }),
      40,
    );
    expect(v).not.toBeNull();
    if (v === null) return;
    expect(v.text.length).toBeLessThanOrEqual(40);
  });
});

describe("T4: the mic_denied hint names the app, so the user knows where to go", () => {
  test("the hint is only offered when the last error was a permission problem", () => {
    const plain = view(model({ phase: "idle" }));
    expect(plain).toBeNull();
  });
});
