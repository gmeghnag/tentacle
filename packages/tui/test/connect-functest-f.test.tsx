/**
 * Item F (docs/fix/connect-functest-batch.md): the report observed an ended
 * child's open drawer head still reading `running · 26s` for ~2 min under
 * `connect`, although `sleep 30` had finished and the child had ended.
 *
 * Same family as item A (a head that never learned the child ended), so it is
 * verified on the SAME real stack: a real `serve` daemon, the real `connectTui`,
 * the real `App`; the child is a real background sub-agent (`agent_task`), its
 * drawer opened from the pill, and its head read twice, 3 s apart, once the
 * child has ended.
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
  slowSay,
  tempRoot,
} from "./connect-functest-stack.tsx";

const stops: (() => Promise<void>)[] = [];
let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  await cleanup?.();
  cleanup = null;
});

/** The open drawer's head line (the `─ sa-… ─` rule). */
function drawerHead(frame: string): string {
  return frame.split("\n").find((line) => line.includes("─ sa-")) ?? "(no drawer head)";
}

/** Its right-hand figure (`running · 0 tools · 3s`, `✓ finished · …`, `✗ stopped`). */
function headFigure(frame: string): string {
  const head = drawerHead(frame);
  const at = head.lastIndexOf(" ─");
  if (at < 0) {
    return "(none)";
  }
  const body = head.slice(0, at);
  return body.slice(body.lastIndexOf("─") + 1).trim();
}

test("F: an ended child's open drawer head says it finished, and stops counting", async () => {
  // A child's exit rides the SAME `jobs.onExit` feed as a shell job's (its
  // `job.agent` says which), so item A's missing feed also left a child's head
  // on `running · Ns` — counting — or froze it on the `✗ stopped` fallback: the
  // report's `running · 26s` for a child that had ended. NOT reproduced as a
  // SEPARATE bug: it is item A. Mutation: remove `jobs` from `connect.ts` → the
  // ended head reads `✗ stopped`, not `✓ finished` (measured, §Execution).
  const { root, clean } = await tempRoot("f");
  cleanup = clean;
  // The parent's first turn launches a background child. The CHILD's own round
  // is held 4 s (recognised by its prompt: a parent and a child model call race,
  // so arrival ORDER cannot script them), so the child is really running and its
  // drawer can be opened live. Everything else answers at once.
  const stack = await serveStack(root, (n, request) => {
    const last = String(request.messages.at(-1)?.content ?? "");
    if (n === 1) {
      return callTool("agent_task", {
        description: "count the lines",
        prompt: "count the lines",
        background: true,
      });
    }
    return last.includes("count the lines") ? slowSay("done counting", 4000) : say("ok");
  });
  stops.push(stack.stop);

  let open = "";
  let ended = "";
  let later = "";
  await connectAndMount(stack.url, async (m: Mounted) => {
    m.app.stdin.write(SHIFT_TAB);
    await delay(60);
    await m.type("start a child");
    // The parent's turn ends; the child is running its own (held) round. The
    // dock is only reachable once no turn of OURS streams (the fork needs the
    // child's drawer open, so wait for the parent's turn to end).
    await delay(2000);
    // DOWN onto the pill, ENTER into the dropdown, ENTER on the child's row.
    m.app.stdin.write(DOWN);
    await delay(120);
    m.app.stdin.write(ENTER);
    await delay(200);
    m.app.stdin.write(ENTER);
    await delay(500);
    open = m.frame();
    // The child's round answers and the child ends; its report wakes the parent.
    await delay(5000);
    ended = m.frame();
    await delay(3000);
    later = m.frame();
  });

  // The drawer really opened on a RUNNING child (the state the report saw).
  expect(headFigure(open)).toContain("running");
  // Once it ended, the head says it FINISHED (a clean `end_turn`) — never
  // `running` for a child that is gone, and never the `stopped` fallback…
  expect(headFigure(ended)).toContain("finished");
  // …and its figure does not keep counting.
  expect(headFigure(later)).toBe(headFigure(ended));
}, 90_000);
