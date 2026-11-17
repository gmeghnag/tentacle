import { beforeAll, describe, expect, test } from "bun:test";

// The escape codes are the property; they are read from a child started with
// colour on (see notice-palette.test.ts for why).
const ACCENT = "\u001b[38;2;6;182;212m"; // dark accent #06b6d4

let frame = "";
beforeAll(async () => {
  const child = Bun.spawn(
    ["bun", new URL("./thinking-color-probe.tsx", import.meta.url).pathname],
    {
      env: { ...process.env, FORCE_COLOR: "3" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const out = await new Response(child.stdout).text();
  await child.exited;
  frame = (JSON.parse(out) as { frame: string }).frame;
});

describe("turn indicator colour", () => {
  // The label is no longer ONE flat accent run: the shimmer sweeps a brighter
  // highlight across it (docs/feat/tui-thinking-shimmer.md). What must hold is
  // that the label starts in the accent (the spinner + the base tone) and that
  // the sweep never reaches the timer/hint. The sweep's own colours are pinned
  // byte for byte by `thinking-shimmer-sgr.test.ts`.
  test("the label is drawn in the accent colour, with the spinner", () => {
    const start = frame.indexOf(ACCENT);
    expect(start).toBeGreaterThanOrEqual(0);
    // The spinner, its space and at least one base cell are the accent run.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI SGR codes
    expect(frame.slice(start)).toMatch(/^\x1b\[38;2;6;182;212m[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /);
    // The label's own text is whole once the per-span escapes are removed.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI SGR codes
    expect(frame.replace(/\x1b\[[0-9;]*m/g, "")).toContain("Working…");
  });

  test("the timer and the stop hint are not in the accent colour", () => {
    const start = frame.indexOf(ACCENT);
    const close = frame.indexOf("\u001b[39m", start);
    expect(frame.slice(start, close)).not.toContain("esc/ctrl+c to stop");
    expect(frame).toContain("esc/ctrl+c to stop");
  });
});
