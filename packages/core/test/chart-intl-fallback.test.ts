/**
 * Hermes on iOS (Apple's Intl) may lack `formatToParts` — the owner's device
 * log for the IBM chart (docs/fix/mobile-qa-sweep.md, addendum 09:52) is a
 * `TypeError` on the chart's tool row. A chart must still render, and render the
 * SAME labels, when `formatToParts` is missing on NumberFormat / DateTimeFormat.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { dateTicks, formatNumber, formatParts } from "../src/index.ts";

const numberParts = Intl.NumberFormat.prototype.formatToParts;
const dateParts = Intl.DateTimeFormat.prototype.formatToParts;

/** `missing`: no method at all; `empty`: a stub that returns no parts. */
type Broken = "missing" | "empty";
const BROKEN: Broken[] = ["missing", "empty"];

function breakFormatToParts(how: Broken): void {
  const value = how === "missing" ? undefined : () => [];
  Object.defineProperty(Intl.NumberFormat.prototype, "formatToParts", {
    value,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(Intl.DateTimeFormat.prototype, "formatToParts", {
    value,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  Object.defineProperty(Intl.NumberFormat.prototype, "formatToParts", {
    value: numberParts,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(Intl.DateTimeFormat.prototype, "formatToParts", {
    value: dateParts,
    configurable: true,
    writable: true,
  });
});

const CASES: [number, { unit: string; locale: string; decimals?: number }][] = [
  [187.25, { unit: "$", locale: "en", decimals: 2 }],
  [187.25, { unit: "$", locale: "it", decimals: 2 }],
  [-20800, { unit: "€", locale: "en" }],
  [20800, { unit: "€", locale: "it" }],
  [1234567, { unit: "£", locale: "en-GB" }],
  [12.5, { unit: "ms", locale: "en" }],
];

describe("chart formatting without Intl formatToParts (Hermes-iOS)", () => {
  test.each(BROKEN)("currency labels are identical when formatToParts is %s", (how) => {
    const expected = CASES.map(([v, f]) => [formatNumber(v, f), formatParts(v, f)]);
    breakFormatToParts(how);
    const actual = CASES.map(([v, f]) => [formatNumber(v, f), formatParts(v, f)]);
    expect(actual).toEqual(expected);
  });

  test.each(BROKEN)("month date ticks are identical when formatToParts is %s", (how) => {
    const spans: [number, number, string | undefined][] = [
      [Date.UTC(2023, 0, 15), Date.UTC(2025, 10, 3), undefined],
      [Date.UTC(2010, 5, 1), Date.UTC(2025, 5, 1), "America/New_York"],
      [Date.UTC(2024, 0, 1), Date.UTC(2024, 11, 31), "Asia/Tokyo"],
    ];
    const expected = spans.map(([a, b, z]) => dateTicks(a, b, 6, z));
    breakFormatToParts(how);
    const actual = spans.map(([a, b, z]) => dateTicks(a, b, 6, z));
    expect(actual).toEqual(expected);
  });
});
