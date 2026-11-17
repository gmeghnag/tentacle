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

function dropFormatToParts(): void {
  Object.defineProperty(Intl.NumberFormat.prototype, "formatToParts", {
    value: undefined,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(Intl.DateTimeFormat.prototype, "formatToParts", {
    value: undefined,
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
  test("currency labels are identical with and without formatToParts", () => {
    const expected = CASES.map(([v, f]) => [formatNumber(v, f), formatParts(v, f)]);
    dropFormatToParts();
    const actual = CASES.map(([v, f]) => [formatNumber(v, f), formatParts(v, f)]);
    expect(actual).toEqual(expected);
  });

  test("month date ticks are identical with and without formatToParts", () => {
    const spans: [number, number, string | undefined][] = [
      [Date.UTC(2023, 0, 15), Date.UTC(2025, 10, 3), undefined],
      [Date.UTC(2010, 5, 1), Date.UTC(2025, 5, 1), "America/New_York"],
      [Date.UTC(2024, 0, 1), Date.UTC(2024, 11, 31), "Asia/Tokyo"],
    ];
    const expected = spans.map(([a, b, z]) => dateTicks(a, b, 6, z));
    dropFormatToParts();
    const actual = spans.map(([a, b, z]) => dateTicks(a, b, 6, z));
    expect(actual).toEqual(expected);
  });
});
