import { describe, expect, test } from "bun:test";
import { ARC, spinnerFrame } from "../src/spinner.ts";

describe("spinnerFrame", () => {
  test("arc advances one frame per interval and wraps", () => {
    expect(ARC.frames).toEqual(["◜", "◠", "◝", "◞", "◡", "◟"]);
    expect(spinnerFrame(ARC, 0)).toBe("◜");
    expect(spinnerFrame(ARC, 99)).toBe("◜");
    expect(spinnerFrame(ARC, 100)).toBe("◠");
    expect(spinnerFrame(ARC, 550)).toBe("◟");
    expect(spinnerFrame(ARC, 600)).toBe("◜");
  });

  test("a negative elapsed time (clock skew) shows the first frame", () => {
    expect(spinnerFrame(ARC, -500)).toBe("◜");
  });

  test("every arc frame is one cell wide", () => {
    for (const f of ARC.frames) expect([...f]).toHaveLength(1);
  });
});
