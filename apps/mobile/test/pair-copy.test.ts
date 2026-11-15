/**
 * Slice-6 visual review N4: Pair's sheet copy used straight quotes
 * (`Pair with 'gmeghnag-mac'?`), "don't" and "...". The copy is typographic.
 */
import { describe, expect, test } from "bun:test";
import { PAIR_COPY, pairSheetHeading } from "../src/pair-copy.ts";
import type { PairingView } from "../src/pairing-flow.ts";

const base = { text: "", submit: "empty" } as unknown as PairingView;
const view = (over: Partial<PairingView>): PairingView => ({ ...base, ...over }) as PairingView;

/** No straight quote and no three-dot ellipsis anywhere in the copy. */
function typographic(s: string): boolean {
  return !/['"]/.test(s) && !s.includes("...");
}

describe("pairSheetHeading", () => {
  test("review names the computer without quotes, and counts its addresses", () => {
    const h = pairSheetHeading(
      view({
        stage: "review",
        review: { computerName: "gmeghnag-mac", addressCount: 2 },
      } as Partial<PairingView>),
    );
    expect(h.title).toBe("Pair with gmeghnag-mac?");
    expect(h.subtitle).toBe("It answers on 2 addresses.");
    expect(
      pairSheetHeading(
        view({
          stage: "review",
          review: { computerName: "m", addressCount: 1 },
        } as Partial<PairingView>),
      ).subtitle,
    ).toBe("It answers on 1 address.");
  });

  test("compare is centred and says where to answer", () => {
    const h = pairSheetHeading(view({ stage: "compare" } as Partial<PairingView>));
    expect(h.title).toBe("Compare the code");
    expect(h.centred).toBe(true);
  });

  test("done names the computer without quotes", () => {
    expect(
      pairSheetHeading(view({ stage: "done", computerName: "box" } as Partial<PairingView>)).title,
    ).toBe("Paired with box");
  });

  test("every heading and every fixed sentence is typographic", () => {
    for (const stage of ["review", "connecting", "compare", "done", "failed"] as const) {
      const h = pairSheetHeading(
        view({
          stage,
          computerName: "box",
          review: { computerName: "box", addressCount: 1 },
        } as Partial<PairingView>),
      );
      expect(typographic(h.title ?? "")).toBe(true);
      expect(typographic(h.subtitle ?? "")).toBe(true);
    }
    for (const line of Object.values(PAIR_COPY)) {
      expect(typographic(typeof line === "function" ? line("box") : line)).toBe(true);
    }
    expect(PAIR_COPY.mismatch).toBe("Codes don’t match");
    expect(PAIR_COPY.waiting).toBe("Waiting for your answer on the computer…");
  });
});
