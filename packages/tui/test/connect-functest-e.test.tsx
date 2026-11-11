/**
 * Item E (docs/fix/connect-functest-batch.md): under `connect`, `/clear` showed
 * NO confirmation, and the ctx meter stayed at the cleared chat's figure until
 * the next turn measured one.
 *
 * The stack is the real one (`connect-functest-stack.tsx`): a real `serve`
 * daemon, the real `connectTui`, the real `App`. The observables are the frame's
 * notice row and its status line (the meter).
 */
import { afterEach, expect, test } from "bun:test";
import {
  type Mounted,
  SHIFT_TAB,
  connectAndMount,
  delay,
  sayWithUsage,
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

/** The status line's ctx figure: `~2.3k/128k`, or null when the meter is unknown. */
function meter(frame: string): string | null {
  const line = frame.split("\n").find((row) => row.includes("ctx "));
  if (line === undefined) {
    return null;
  }
  return /[(~]?[\d.]+k?\/[\d.]+k\)/.exec(line)?.[0] ?? null;
}

test("E: /clear confirms itself and refreshes the ctx meter", async () => {
  const { root, clean } = await tempRoot("e");
  cleanup = clean;
  // The model reports usage (a measured fill): 4000 prompt tokens, then none.
  const stack = await serveStack(root, (n) =>
    sayWithUsage(n === 1 ? "happy to help" : "ok", n === 1 ? 4000 : 20),
  );
  stops.push(stack.stop);

  let beforeMeter: string | null = null;
  let after = "";
  await connectAndMount(stack.url, async (m: Mounted) => {
    m.app.stdin.write(SHIFT_TAB);
    await delay(60);
    // A LONG first message: its fill is clearly above the system prompt's, so
    // the meter has a figure to lose when the chat is cleared.
    await m.type(`fix the login bug in the parser ${"x".repeat(4000)}`);
    await delay(1800);
    // A real, measured ctx figure (the first turn's usage).
    beforeMeter = meter(m.frame());
    await m.type("/clear");
    await delay(2000);
    after = m.frame();
  });

  // A measured figure before the clear (so "stale" has something to be stale about).
  expect(beforeMeter).not.toBeNull();
  // 1. A CONFIRMATION: the user is told the conversation went.
  expect(after.toLowerCase()).toContain("cleared");
  // 2. The cleared chat is gone from the transcript.
  expect(after).not.toContain("fix the login bug");
  // 3. The meter follows the clear at once — an empty chat is no longer the old
  //    chat's fill (never the stale figure the report saw until the next turn).
  expect(meter(after)).not.toBe(beforeMeter);
}, 60_000);
