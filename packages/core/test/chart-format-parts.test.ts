/**
 * `formatParts` (docs/feat/model-charts.md *iPhone visual language (rev 2)*
 * item 3, slice C5): the hero's number split from its unit, so the unit can be
 * styled smaller — joined back, it must read exactly as `formatNumber`.
 */
import { describe, expect, test } from "bun:test";
import { type NumberFormat, formatNumber, formatParts } from "../src/index.ts";

function joined(value: number, format: NumberFormat): string {
  const p = formatParts(value, format);
  if (p.unit === "") return p.number;
  if (p.unit === "%") return `${p.number}%`;
  if (p.unitBefore)
    return p.number.startsWith("−") ? `−${p.unit}${p.number.slice(1)}` : `${p.unit}${p.number}`;
  return `${p.number} ${p.unit}`;
}

describe("formatParts", () => {
  test("parts: number, unit, side", () => {
    expect(formatParts(20800, { unit: "€", format: "full", locale: "it" })).toEqual({
      number: "20.800",
      unit: "€",
      unitBefore: false,
    });
    expect(formatParts(20800, { unit: "€", format: "full", locale: "en" })).toEqual({
      number: "20,800",
      unit: "€",
      unitBefore: true,
    });
    expect(formatParts(12.5, { unit: "ms", locale: "en" })).toEqual({
      number: "12.5",
      unit: "ms",
      unitBefore: false,
    });
    expect(formatParts(7, {})).toEqual({ number: "7", unit: "", unitBefore: false });
  });

  test("joined back, it reads exactly as formatNumber (it/en, units, signs, compact)", () => {
    const values = [0, 7, 999, 12500, -1250000, 0.0042, 20800];
    const formats: NumberFormat[] = [
      {},
      { unit: "€" },
      { unit: "$", format: "full" },
      { unit: "%", decimals: 1 },
      { unit: "token", format: "compact" },
      { decimals: 4 },
    ];
    for (const locale of ["it", "en"]) {
      for (const value of values) {
        for (const f of formats) {
          const format = { ...f, locale };
          expect(joined(value, format)).toBe(formatNumber(value, format));
        }
      }
    }
  });
});
