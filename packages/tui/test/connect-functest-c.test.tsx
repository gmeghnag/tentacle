/**
 * Item C (docs/fix/connect-functest-batch.md): after `/compact` the session's
 * TITLE became the compaction summary in `/sessions` — the auto title is derived
 * from the FIRST user message, and after a compaction that message IS the
 * summary.
 *
 * The stack is the real one (`connect-functest-stack.tsx`): a real `serve`
 * daemon, the real `connectTui`, the real `App`, and the title read through the
 * TUI's OWN directory (`options.sessions.list()` — exactly what `/sessions`
 * paints).
 */
import { afterEach, expect, test } from "bun:test";
import {
  ENTER,
  type Mounted,
  SHIFT_TAB,
  connectAndMount,
  delay,
  say,
  serveStack,
  strip,
  tempRoot,
} from "./connect-functest-stack.tsx";

const stops: (() => Promise<void>)[] = [];
let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  await cleanup?.();
  cleanup = null;
});

/** What the compaction put at the head of the history (the summary's own prefix). */
const SUMMARY_HEAD = "Summary of the earlier conversation";

test("C: after /compact the title is the original message, never the summary", async () => {
  const { root, clean } = await tempRoot("c");
  cleanup = clean;
  // 1: the first reply; 2: the compaction's summary; anything later: a reply.
  const stack = await serveStack(root, (n) =>
    n === 1 ? say("happy to help") : n === 2 ? say("the gist of it") : say("ok"),
  );
  stops.push(stack.stop);

  let before = "";
  let after = "";
  await connectAndMount(stack.url, async (m: Mounted) => {
    m.app.stdin.write(SHIFT_TAB);
    await delay(60);
    await m.type("fix the login bug in the parser");
    await delay(1500);
    before = (await m.options.sessions?.list())?.sessions[0]?.title ?? "";
    // `/compact`: the daemon summarises and replaces the history.
    await m.type("/compact");
    await delay(2500);
    after = (await m.options.sessions?.list())?.sessions[0]?.title ?? "";
    // `/sessions` as the user reads it (the panel paints `title`).
    await m.type("/sessions");
    await delay(400);
    const panel = m.frame();
    // Close the panel again so the app is left as it was.
    m.app.stdin.write("\u001b");
    await delay(150);
    expect(strip(panel)).toContain("fix the login bug");
    // ONE more turn, so the history the daemon now holds reaches the model:
    // its first message is the summary the compaction installed.
    await m.type("thanks");
    await delay(2000);
  });

  // The chat really WAS compacted (the summary is the new first message).
  const history = stack.requests.at(-1)?.messages ?? [];
  expect(history.some((msg) => String(msg.content).includes(SUMMARY_HEAD))).toBe(true);
  // Before the compaction the title is the first user message.
  expect(before).toContain("fix the login bug");
  // After it, the SAME title — never the summary the compaction wrote.
  expect(after).toContain("fix the login bug");
  expect(after).not.toContain(SUMMARY_HEAD);
}, 60_000);
