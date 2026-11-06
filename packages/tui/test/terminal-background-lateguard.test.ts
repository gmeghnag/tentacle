import { afterEach, describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { lateGuard } from "../src/terminal-background-probe.ts";
import { prepareTheme, resetThemeForTest, setThemeMode } from "../src/theme.ts";

/**
 * Fix round 2, Review MEDIUM 2 (docs/feat/tui-light-theme.md): a seeded residue
 * must not swallow typing, and must be seeded exactly ONCE.
 *
 * The probe hands a reply the timeout cut in half to the guard as its starting
 * `pending` (MEDIUM 4, round 1). Two things were wrong with that hand-off:
 *
 *  1. the seed was a READ, not a TAKE, so the `--resume` picker's guard and the
 *     TUI's guard both started with the same half reply;
 *  2. the guard held ANY unterminated `]11;…`, so the very first keystroke after
 *     an abandoned reply was swallowed for the whole 5 s and then dropped at the
 *     deadline.
 *
 * These tests drive `lateGuard` itself — the real Proxy — over a REAL
 * `node:stream` `Readable`, with `utf8` set as Ink sets it (`ink.js`
 * `stdin.setEncoding("utf8")`), so what they assert is what Ink's key parser
 * receives.
 */

afterEach(() => {
  setThemeMode("dark");
  resetThemeForTest();
});

/** A real `Readable` with `utf8` set, exactly as Ink leaves stdin. */
class Tty extends Readable {
  override _read(): void {
    // Pushed by the test, as a tty would be.
  }
}

function tty(): Readable {
  const stream = new Tty();
  stream.setEncoding("utf8");
  return stream;
}

const asStdin = (stream: Readable): NodeJS.ReadStream => stream as unknown as NodeJS.ReadStream;

/** Let the stream's bookkeeping settle (`push` is synchronous, the event is not). */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 2));

/** Settle the palette with a residue, the way a timed-out probe does. */
async function seed(residue: string): Promise<void> {
  resetThemeForTest();
  await prepareTheme("auto", {
    canProbe: true,
    probe: () => Promise.resolve({ color: null, late: true, residue }),
    colorFgBg: undefined,
  });
}

describe("MEDIUM 2: a seeded residue must not swallow typing", () => {
  test("`ESC]11;rgb:1e` then `hello\\r`: the keys come back on the FIRST read", async () => {
    await seed("\x1b]11;rgb:1e");
    const stdin = tty();
    const guard = lateGuard(asStdin(stdin));
    stdin.push("hello\r");
    await tick();
    // Mutation: hold any unterminated `]11;…` (`replyPrefix`'s loose rule) → the
    // first read returns null here, and the keys wait for the 5 s deadline.
    expect(guard.read()).toBe("hello\r");
  });

  test("the same, for a key that is not a spec character: `?`", async () => {
    await seed("]11;rgb:1e");
    const stdin = tty();
    const guard = lateGuard(asStdin(stdin));
    stdin.push("?x");
    await tick();
    expect(guard.read()).toBe("?x");
  });

  test("a real reply tail is STILL stripped — the seed is not given up on", async () => {
    // The other half: the strict rule must keep the case the seed exists for.
    await seed("\x1b]11;rgb:1e");
    const stdin = tty();
    const guard = lateGuard(asStdin(stdin));
    stdin.push("1e/1e/1e\x07x");
    await tick();
    expect(guard.read()).toBe("x");
  });

  test("a typed `]` held by the guard is never dropped", async () => {
    // LOW 6's rule, unchanged: only a head with the `11;` selector may vanish.
    await seed("");
    const stdin = tty();
    const guard = lateGuard(asStdin(stdin));
    stdin.push("]x");
    await tick();
    expect(guard.read()).toBe("]x");
  });
});

describe("MEDIUM 2: the residue is a TAKE — a picker then a TUI seed once", () => {
  test("the second guard starts empty and passes typing at once", async () => {
    await seed("\x1b]11;rgb:1e");
    // The picker's guard takes the residue …
    const picker = tty();
    const pickerGuard = lateGuard(asStdin(picker));
    picker.push("1e/1e/1e\x07");
    await tick();
    expect(pickerGuard.read()).toBe(null);
    // … and the TUI's guard, built after it, must not inherit the same head.
    const tui = tty();
    const tuiGuard = lateGuard(asStdin(tui));
    tui.push("hello\r");
    await tick();
    // Mutation: `pending: themeProbeResidue()` with a read (not a take) → null.
    expect(tuiGuard.read()).toBe("hello\r");
  });

  test("taking the residue empties it for the next caller", async () => {
    await seed("\x1b]11;rgb:1e");
    lateGuard(asStdin(tty()));
    // A second guard cannot see it again.
    const second = tty();
    const guard = lateGuard(asStdin(second));
    second.push("a");
    await tick();
    expect(guard.read()).toBe("a");
  });
});
