import { afterEach, describe, expect, test } from "bun:test";
import {
  type ThemeIo,
  type ThemeSetting,
  prepareTheme,
  resetThemeForTest,
  setThemeMode,
  themeMode,
} from "../src/theme.ts";

/**
 * `prepareTheme` — the one place the palette is decided (docs/feat/tui-light-theme.md
 * S4/S7). It runs FIRST in `startTui` and in `pickSession`, before Ink mounts, and is
 * memoized per process so two mounts cost one query.
 *
 * `auto` asks the terminal, then falls back to `COLORFGBG`, then dark. A forced
 * setting never touches the terminal at all, so a user whose terminal lies (or a
 * slow link) can opt out of the 200 ms cost.
 */
afterEach(() => {
  setThemeMode("dark");
  resetThemeForTest();
});

/** A fake terminal: `canProbe`, the probe result, and the environment. */
function fakeIo(
  overrides: Partial<ThemeIo> & {
    probed?: readonly [number, number, number] | null;
    late?: boolean;
  } = {},
): ThemeIo & { probes: number } {
  const state = { probes: 0 };
  return {
    get probes() {
      return state.probes;
    },
    canProbe: overrides.canProbe ?? true,
    probe: () => {
      state.probes += 1;
      return Promise.resolve({
        color: overrides.probed ?? null,
        late: overrides.late ?? false,
      });
    },
    colorFgBg: "colorFgBg" in overrides ? overrides.colorFgBg : undefined,
  };
}

describe("a forced setting skips the terminal entirely", () => {
  test("dark and light apply with no probe at all", async () => {
    for (const setting of ["dark", "light"] as const) {
      // A fresh process per launch: the memo is per process, so reset it.
      resetThemeForTest();
      const io = fakeIo({ probed: [255, 255, 255] });
      const result = await prepareTheme(setting, io);
      expect(result.mode).toBe(setting);
      expect(result.late).toBe(false);
      // Mutation: probe before checking the setting → this counts one.
      expect(io.probes).toBe(0);
    }
  });
});

describe("auto", () => {
  test("the probed colour decides", async () => {
    const light = await prepareTheme("auto", fakeIo({ probed: [255, 255, 255] }));
    expect(light.mode).toBe("light");
    resetThemeForTest();
    const dark = await prepareTheme("auto", fakeIo({ probed: [0, 0, 0] }));
    expect(dark.mode).toBe("dark");
  });

  test("no answer falls back to COLORFGBG, then to dark", async () => {
    const fromEnv = await prepareTheme("auto", fakeIo({ colorFgBg: "0;15" }));
    expect(fromEnv.mode).toBe("light");
    resetThemeForTest();
    const fallback = await prepareTheme("auto", fakeIo({}));
    expect(fallback.mode).toBe("dark");
  });

  test("a terminal that cannot be probed still honours COLORFGBG, no query sent", async () => {
    const io = fakeIo({ canProbe: false, colorFgBg: "0;15", probed: [0, 0, 0] });
    const result = await prepareTheme("auto", io);
    expect(result.mode).toBe("light");
    expect(io.probes).toBe(0);
    expect(result.late).toBe(false);
  });

  test("a timed-out probe is reported as late, so the caller guards stdin", async () => {
    // Mutation: drop `late` from the result → the guard is never armed, and a late
    // reply lands in the prompt as junk.
    const result = await prepareTheme("auto", fakeIo({ late: true }));
    expect(result.late).toBe(true);
  });
});

describe("memoized per process", () => {
  test("two mounts cost ONE query, and the second reuses the mode", async () => {
    const io = fakeIo({ probed: [255, 255, 255] });
    const first = await prepareTheme("auto", io);
    // A second mount (the runtime after the picker) sees the same io object.
    const second = await prepareTheme("auto", io);
    expect(first.mode).toBe("light");
    expect(second.mode).toBe("light");
    // Mutation: drop the memo → three queries.
    expect(io.probes).toBe(1);
  });

  test("concurrent calls share one in-flight query", async () => {
    const io = fakeIo({ probed: [0, 0, 0] });
    const [a, b] = await Promise.all([prepareTheme("auto", io), prepareTheme("auto", io)]);
    expect(a).toEqual(b);
    expect(io.probes).toBe(1);
  });

  test("the applied mode is the module's current one", async () => {
    await prepareTheme("light", fakeIo({}));
    expect(themeMode()).toBe("light");
    expect(setThemeMode).toBeTypeOf("function");
  });
});

describe("the setting type", () => {
  test("every accepted setting is handled", async () => {
    const all: ThemeSetting[] = ["auto", "dark", "light"];
    for (const setting of all) {
      const result = await prepareTheme(setting, fakeIo({}));
      expect(["dark", "light"]).toContain(result.mode);
      resetThemeForTest();
    }
  });
});
