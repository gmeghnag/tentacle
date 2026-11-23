/**
 * A `workflow_approve` through the REAL App (ink-testing-library, AGENTS §6):
 * the whole step list on screen a window at a time, in a dialog no taller than
 * the layout says, and Yes allowed at any scroll position
 * (docs/fix/workflow-approve-detail.md D2, the owner's Q1 answer: «devo poter
 * premere yes anche senza averla vista tutta»).
 *
 * The unit view is pinned by `workflow-approve-view.test.tsx`; this proves the
 * wiring: the key path writes the scroll, the frame repaints, `y` answers.
 */
import { describe, expect, test } from "bun:test";
import {
  PermissionBroker,
  type PermissionRequest,
  type PermissionResponse,
  WORKFLOW_APPROVE_TOOL,
} from "@tentacle/core";
import { render } from "ink-testing-library";
import { App, type SessionController } from "../src/App.tsx";
import { ARM_MS } from "../src/permission-reply.ts";
import { MAX_DETAIL_ROWS, permissionView } from "../src/permission-ui.ts";
import { inertSession } from "./session-stub.ts";

const COLUMNS = 60;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** PgDn as a terminal sends it (`ESC [ 6 ~`). */
const PAGE_DOWN = "\x1b[6~";

/** A hash approval of `count` run steps, each command naming itself. */
const workflowAsk = (count: number): PermissionRequest => ({
  kind: "workflow_approve",
  tool: WORKFLOW_APPROVE_TOOL,
  level: "ask",
  title: "Run workflow demo v1 (hash 12345678)",
  detail: Array.from(
    { length: count },
    (_, i) =>
      `step-${i + 1}: run \`echo ${i === count - 1 ? "LAST-COMMAND" : `step-${i + 1}`}\` (local)`,
  ).join("\n"),
  input: {},
});

const OPTIONS = { options: [{ label: "Yes" }, { label: "No" }] } as const;

async function mount(req: PermissionRequest) {
  const permissions = new PermissionBroker();
  const session = (): SessionController => ({
    ...inertSession(),
    async *send(prompt) {
      // The dialog's answers are what this test reads; the turn itself is inert.
      yield { type: "text", delta: `reply to ${prompt}` };
      yield { type: "turn_end", reason: "end_turn" };
    },
    ownsTurn: () => true,
  });
  const app = render(
    <App
      createSession={session}
      permissions={permissions}
      model="m"
      cwd="/tmp/work"
      columns={COLUMNS}
    />,
  );
  await delay(30);
  const answers: PermissionResponse[] = [];
  void permissions.request(req, { turnId: "own-1", ...OPTIONS }).then((r) => answers.push(r));
  await delay(ARM_MS + 60);
  const keys = async (...chunks: string[]) => {
    for (const c of chunks) {
      app.stdin.write(c);
      await delay(20);
    }
    await delay(30);
  };
  const frame = () => app.lastFrame() ?? "";
  const askAgain = async (next: PermissionRequest) => {
    void permissions.request(next, { turnId: "own-1", ...OPTIONS }).then((r) => answers.push(r));
    await delay(ARM_MS + 60);
  };
  return { app, answers, keys, frame, askAgain };
}

describe("a 20-step workflow approval in the real App", () => {
  test("Space pages the list until the LAST command is on screen", async () => {
    // Mutation: no scroll wiring (`layer-dialog`) → the last command never paints.
    const req = workflowAsk(20);
    const { app, keys, frame } = await mount(req);
    expect(frame()).not.toContain("LAST-COMMAND");
    await keys(" ", " ");
    expect(frame()).toContain("LAST-COMMAND");
    app.unmount();
  });

  test("`y` answers allow-once from the top of the list (Yes is never gated)", async () => {
    // Mutation: a `reviewed` gate on the approve path → `answers` stays empty.
    const req = workflowAsk(20);
    const { app, answers, keys } = await mount(req);
    await keys("y");
    expect(answers).toEqual([{ allowed: true, scope: "once" }]);
    app.unmount();
  });

  test("PgDn scrolls too, and scrolling never resizes the frame", async () => {
    // Mutation: a scrolled window that changes the dialog's row count → the
    // transcript viewport jumps under the person reading the list.
    const req = workflowAsk(20);
    const { app, keys, frame } = await mount(req);
    const view = permissionView(req, null, COLUMNS);
    // The dialog is no taller than today's cap, however long the list is.
    expect(view.detailRows.length).toBe(MAX_DETAIL_ROWS);
    const rows = frame().split("\n").length;
    await keys(PAGE_DOWN, PAGE_DOWN);
    expect(frame().split("\n").length).toBe(rows);
    expect(frame()).toContain("LAST-COMMAND");
    app.unmount();
  });

  test("a NEW request opens at the top (the scroll resets with the dialog)", async () => {
    // Mutation: drop the reset beside `shownAt` in `usePermissionBroker` → the
    // next workflow's dialog opens already scrolled past its first steps.
    const { app, answers, keys, frame, askAgain } = await mount(workflowAsk(20));
    await keys(" ", " ");
    expect(frame()).toContain("LAST-COMMAND");
    await keys("n");
    expect(answers).toEqual([{ allowed: false }]);
    await askAgain(workflowAsk(20));
    expect(frame()).toContain("step-1: run");
    expect(frame()).not.toContain("LAST-COMMAND");
    app.unmount();
  });
});
