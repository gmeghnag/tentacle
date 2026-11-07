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
  test("the label is in the accent colour, with the spinner", () => {
    const start = frame.indexOf(ACCENT);
    expect(start).toBeGreaterThanOrEqual(0);
    const close = frame.indexOf("\u001b[39m", start);
    expect(frame.slice(start, close)).toContain("Working…");
  });

  test("the timer and the stop hint are not in the accent colour", () => {
    const start = frame.indexOf(ACCENT);
    const close = frame.indexOf("\u001b[39m", start);
    expect(frame.slice(start, close)).not.toContain("esc/ctrl+c to stop");
    expect(frame).toContain("esc/ctrl+c to stop");
  });
});
