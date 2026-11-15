/**
 * A transcript table's column alignment (slice-6 visual review V4): a column
 * whose non-empty body cells are all numbers (`1,204`, `+12`, `-3.5%`) is
 * right-aligned so its digits line up; any other column is left-aligned.
 * Pure and React-free (AGENTS §7). Cells are the model's text, read as data.
 */

export type ColumnAlign = "left" | "right";

const NUMBER = /^[+\-−]?\d[\d,]*(\.\d+)?%?$/;

export function columnAlign(table: {
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
}): ColumnAlign[] {
  return table.header.map((_cell, column) => {
    const cells = table.rows.map((row) => (row[column] ?? "").trim()).filter((c) => c !== "");
    return cells.length > 0 && cells.every((c) => NUMBER.test(c)) ? "right" : "left";
  });
}
