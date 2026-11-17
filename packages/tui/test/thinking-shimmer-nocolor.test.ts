import { beforeAll, describe, expect, test } from "bun:test";

/**
 * The degradation half of docs/feat/tui-thinking-shimmer.md: with no colour —
 * `NO_COLOR`, a non-TTY, i.e. `chalk.level === 0` — the row must be byte for
 * byte what it is today. A sweep that emitted layout or stray escapes instead of
 * simply resting at `base` would corrupt a piped/redirected TUI, which is the
 * whole reason `blink.ts` degrades the same way.
 *
 * The probe runs in a child because `bun test` itself has colour off but a
 * parent's `FORCE_COLOR` would leak in.
 */
let frames: string[] = [];
let level = -1;
beforeAll(async () => {
  const env: Record<string, string | undefined> = { ...process.env };
  // A computed delete: the parent may carry FORCE_COLOR, the child must not.
  const { FORCE_COLOR: _dropped, ...rest } = env;
  rest.NO_COLOR = "1";
  const child = Bun.spawn(
    ["bun", new URL("./thinking-shimmer-nocolor-probe.tsx", import.meta.url).pathname],
    { env: rest as Record<string, string>, stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(child.stdout).text();
  await child.exited;
  const parsed = JSON.parse(out) as { frames: string[]; level: number };
  frames = parsed.frames;
  level = parsed.level;
});

describe("with colour off the label is plain", () => {
  test("the probe really ran colour-off", () => {
    expect(level).toBe(0);
  });

  // `lastFrame()` strips SGR, so "no escapes in the frame" cannot be asserted
  // here (it would pass even if the component emitted them). What IS observable
  // is the contract that a colour-off sweep must not CHANGE: the plain label,
  // cell for cell, on every tick. The raw-SGR side is `thinking-shimmer-sgr`'s
  // job — and `shimmer.test.ts` pins `color: false` → one base span.
  test("the plain label is on every tick, cell for cell", () => {
    for (const f of frames) {
      expect(f).toMatch(/^[\u2800-\u28ff] Working… \d+s · esc\/ctrl\+c to stop$/);
    }
  });

  // The text is the SAME as with colour on (minus escapes): no layout difference.
  test("the visible text is identical on every tick, spinner apart", () => {
    const bodies = new Set(
      frames.map((f) => f.replace(/^[\u2800-\u28ff]/, "⠿").replace(/\d+s/, "Ns")),
    );
    expect([...bodies]).toEqual(["⠿ Working… Ns · esc/ctrl+c to stop"]);
  });
});
