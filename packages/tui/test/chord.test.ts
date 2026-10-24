import { describe, expect, test } from "bun:test";
import { CHORD_WINDOW_MS, type ChordState, idleChord, stepChord } from "../src/chord.ts";

const ctrl = { ctrl: true };
const plain = {};

/** Ctrl+X at `at`, then `char`/`key` at `then`: the second step's action. */
function second(char: string, key: { ctrl?: boolean }, at: number, then: number) {
  const armed = stepChord(idleChord, "x", ctrl, at);
  expect(armed.action).toBe("consumed");
  return stepChord(armed.state, char, key, then);
}

describe("stepChord (Ctrl+X Ctrl+S)", () => {
  test("Ctrl+X arms (consumed), Ctrl+S within the window fires and disarms", () => {
    const fired = second("s", ctrl, 1000, 1200);
    expect(fired.action).toBe("sendNow");
    expect(fired.state).toEqual(idleChord);
  });

  test("the window: 1499 ms fires, 1501 ms passes the key through", () => {
    expect(CHORD_WINDOW_MS).toBe(1500);
    expect(second("s", ctrl, 0, 1499).action).toBe("sendNow");
    const late = second("s", ctrl, 0, 1501);
    expect(late.action).toBe("pass");
    expect(late.state).toEqual(idleChord);
  });

  test("the letters match case-insensitively (Ctrl+Shift+S, caps lock)", () => {
    const armed = stepChord(idleChord, "X", ctrl, 0);
    expect(armed.action).toBe("consumed");
    expect(stepChord(armed.state, "S", ctrl, 10).action).toBe("sendNow");
  });

  test("another key between them disarms and is passed through unchanged", () => {
    const other = second("a", plain, 0, 10);
    expect(other.action).toBe("pass");
    expect(other.state).toEqual(idleChord);
    // …so a Ctrl+S right after it does not fire.
    expect(stepChord(other.state, "s", ctrl, 20).action).toBe("pass");
    // A plain `s` (no Ctrl) is another key too.
    expect(second("s", plain, 0, 10).action).toBe("pass");
  });

  test("Ctrl+S while not armed passes", () => {
    expect(stepChord(idleChord, "s", ctrl, 0)).toEqual({ state: idleChord, action: "pass" });
  });

  test("a key while idle passes and leaves the state untouched", () => {
    const res = stepChord(idleChord, "q", plain, 0);
    expect(res).toEqual({ state: idleChord, action: "pass" });
  });

  test("Ctrl+X again re-arms from the latest press", () => {
    const first = stepChord(idleChord, "x", ctrl, 0);
    const again = stepChord(first.state, "x", ctrl, 1400);
    expect(again.action).toBe("consumed");
    const state: ChordState = again.state;
    expect(stepChord(state, "s", ctrl, 2800).action).toBe("sendNow");
  });
});
