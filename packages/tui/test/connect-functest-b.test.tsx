/**
 * Item B (docs/fix/connect-functest-batch.md): the pill read `0 agents · 1 shell`
 * — a zero count must be omitted, not printed.
 *
 * The pure rule (`status-view.ts` `pillView`), plus the real frame on the REAL
 * `serve` + `connect` + `App` stack: the fix must show on the stack the owner
 * saw it on, not only in a unit test.
 */
import { afterEach, expect, test } from "bun:test";
import { PILL_DONE_MS, type PillInput, pillText, pillView } from "../src/status-view.ts";
import {
  type Mounted,
  SHIFT_TAB,
  callTool,
  connectAndMount,
  delay,
  say,
  serveStack,
  tempRoot,
} from "./connect-functest-stack.tsx";

const stops: (() => Promise<void>)[] = [];
let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  await cleanup?.();
  cleanup = null;
});

const base: PillInput = { agents: 2, now: 1_000_000, focus: "input", width: 190 };
const text = (over: Partial<PillInput> = {}): string => pillText(pillView({ ...base, ...over }));

test("B (pure): a zero count is omitted, in every focus state", () => {
  // A shell alone: `1 shell`, never `0 agents · 1 shell` (the owner's screenshot).
  expect(text({ agents: 0, jobs: 1 })).toBe("1 shell ↓");
  expect(text({ agents: 0, jobs: 3 })).toBe("3 shells ↓");
  // Two shells, singular/plural, still no agent half.
  expect(text({ agents: 0, jobs: 1, focus: "pill" })).toBe(" 1 shell ⏎ ");
  expect(text({ agents: 0, jobs: 1, focus: "dropdown" })).toBe(" 1 shell ▴ ");
  // A child alone keeps its own words (the agents half is not zero there).
  expect(text({ agents: 1, jobs: 0 })).toBe("1 agent ↓");
  // Both kinds present: both halves, unchanged.
  expect(text({ agents: 2, jobs: 1 })).toBe("2 agents · 1 shell ↓");
  // The notice prefix keeps working with the omitted half.
  expect(text({ agents: 0, jobs: 1, finished: { id: "bg-9", at: 1_000_000 - 10 } })).toBe(
    "✓ bg-9 done · 1 shell ↓",
  );
  expect(text({ agents: 1, jobs: 0, finished: { id: "sa-1", at: 1_000_000 - 10 } })).toBe(
    "✓ sa-1 done · 1 agent ↓",
  );
  // Nothing at all: still no pill.
  expect(pillView({ ...base, agents: 0, jobs: 0 })).toEqual({ kind: "none" });
  // The finished window is still the pill's own (`PILL_DONE_MS`).
  expect(text({ agents: 0, jobs: 1, finished: { id: "bg-9", at: 0 } })).toBe("1 shell ↓");
  expect(PILL_DONE_MS).toBeGreaterThan(0);
});

test("B (stack): a shell alone makes the pill read `1 shell`, never `0 agents`", async () => {
  const { root, clean } = await tempRoot("b");
  cleanup = clean;
  // 1: a background job that outlives the observation; 2+: the turn's end.
  const stack = await serveStack(root, (n) =>
    n === 1 ? callTool("shell", { command: "sleep 30", run_in_background: true }) : say("ok"),
  );
  stops.push(stack.stop);

  let frame = "";
  await connectAndMount(stack.url, async (m: Mounted) => {
    m.app.stdin.write(SHIFT_TAB);
    await delay(60);
    await m.type("start the job");
    await delay(1500);
    frame = m.frame();
  });

  // The pill's own line: the status bar's last row.
  const status =
    frame
      .split("\n")
      .filter((line) => line.includes("auto-accept"))
      .at(-1) ?? "";
  expect(status).toContain("1 shell");
  expect(status).not.toContain("0 agents");
  expect(status).not.toContain("0 shell");
}, 60_000);
