/**
 * Item A (docs/fix/connect-functest-batch.md): under `connect`, a finished
 * background shell job's drawer says `✗ stopped` instead of `✗ exited (3)`, and
 * its duration keeps counting.
 *
 * The stack is the real one (`connect-functest-stack.tsx`): a real `serve`
 * daemon, the real `connectTui` (which decides what the TUI is HANDED), and the
 * real `App` on a real terminal. The observable is the drawer's own head line,
 * read once while the job runs, once when it has ended, and once 2 s later: the
 * outcome must be the exit code the daemon reported, and the figure FROZEN.
 */
import { afterEach, expect, test } from "bun:test";
import {
  DOWN,
  ENTER,
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

/** The drawer's head line (the `─ bg-… ─` rule). */
function drawerHead(frame: string): string {
  return frame.split("\n").find((line) => line.includes("─ bg-")) ?? "(no drawer head)";
}

/** The outcome figure the head ends with (`running · 1s` / `✗ exited (3) · 4s`). */
function headFigure(frame: string): string {
  const head = drawerHead(frame);
  const at = head.lastIndexOf(" ─");
  if (at < 0) {
    return "(none)";
  }
  const body = head.slice(0, at);
  const cut = body.lastIndexOf("─");
  return body.slice(cut + 1).trim();
}

test("A: a finished shell job's drawer shows its exit code, and its clock freezes", async () => {
  const { root, clean } = await tempRoot("a");
  cleanup = clean;
  // 1: start a background job that exits 3 after 4 s; 2+: the turn ends (and a
  // wake may answer — the drawer's observable is the exit record either way).
  const stack = await serveStack(root, (n) =>
    n === 1
      ? callTool("shell", { command: "sh -c 'echo out; sleep 4; exit 3'", run_in_background: true })
      : say("ok"),
  );
  stops.push(stack.stop);

  let running = "";
  let ended = "";
  let later = "";
  await connectAndMount(stack.url, async (m: Mounted) => {
    // Auto-accept on: the `shell` ask must not park the turn on a prompt.
    m.app.stdin.write(SHIFT_TAB);
    await delay(60);
    await m.type("start the job");
    await delay(1200);
    // DOWN onto the pill, ENTER into the dropdown, ENTER on the job row.
    m.app.stdin.write(DOWN);
    await delay(100);
    m.app.stdin.write(ENTER);
    await delay(150);
    m.app.stdin.write(ENTER);
    await delay(300);
    running = m.frame();
    // The job ends (`sleep 4`) with its drawer open.
    await delay(5000);
    ended = m.frame();
    await delay(2200);
    later = m.frame();
  });

  // The drawer opened on a LIVE job (the precondition the item's report states).
  expect(headFigure(running)).toContain("running");
  // The outcome is the daemon's real one, never the `stopped` fallback…
  expect(headFigure(ended)).toContain("exited (3)");
  expect(headFigure(ended)).not.toContain("stopped");
  // …and the figure is FROZEN: the same 2 s later.
  expect(headFigure(later)).toBe(headFigure(ended));
}, 90_000);
