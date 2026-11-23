/**
 * A `workflow_approve` dialog shows the WHOLE step list
 * (docs/fix/workflow-approve-detail.md D2, owner answer Q1): every `run` command
 * verbatim — wrapped, never cut, never `… N more lines` — and a list taller than
 * the dialog is scrolled a window at a time with a row saying how much is left.
 * Yes stays allowed at any scroll position (the owner's decision): this decides
 * what is on SCREEN only.
 *
 * The bug it pins: `permissionDetailLines` capped the list at 10 rows AND
 * `permissionView` `truncateCells`'d each row, so a workflow of 11+ steps (or one
 * long command) was approved with its commands missing from the dialog — a
 * LASTING, hash-bound approval, against AGENTS §7.
 */
import { describe, expect, test } from "bun:test";
import { type PermissionRequest, WORKFLOW_APPROVE_TOOL } from "@tentacle/core";
import { render } from "ink-testing-library";
import {
  type ApprovalScroll,
  NO_APPROVAL_SCROLL,
  approvalRows,
  stepApprovalScroll,
} from "../src/approval-scroll.ts";
import { PermissionPrompt, permissionPromptRows } from "../src/components/PermissionPrompt.tsx";
import { PURE_LAYERS } from "../src/keys/layers.ts";
import { routeKey } from "../src/keys/route.ts";
import { MAX_DETAIL_ROWS, permissionView } from "../src/permission-ui.ts";
import { NO_KEY, snap } from "./key-snapshot.ts";

const COLUMNS = 60;
const OPTIONS = ["Yes", "No"];

/** A hash-approval ask whose detail is `steps` joined by newlines, as the daemon sends it. */
const workflowAsk = (steps: readonly string[]): PermissionRequest => ({
  kind: "workflow_approve",
  tool: WORKFLOW_APPROVE_TOOL,
  level: "ask",
  title: "Run workflow demo v1 (hash 12345678)",
  detail: steps.join("\n"),
  input: {},
});

/** `n` steps, step `i`'s command `cmd(i)`, each on the one-line approval format. */
const steps = (n: number, cmd: (i: number) => string): string[] =>
  Array.from({ length: n }, (_, i) => `step-${i + 1}: run \`${cmd(i + 1)}\` (local)`);

const frameOf = (req: PermissionRequest, approvalScroll?: ApprovalScroll): string[] => {
  const { lastFrame, unmount } = render(
    <PermissionPrompt
      req={req}
      options={OPTIONS}
      selected={0}
      cwd="/w"
      columns={COLUMNS}
      {...(approvalScroll ? { approvalScroll } : {})}
    />,
  );
  const lines = (lastFrame() ?? "").split("\n");
  unmount();
  return lines;
};

describe("a workflow approval shows every command, wrapped and uncut", () => {
  test("a long command is drawn in full, not cut at the dialog's width", () => {
    // Mutation: `truncateCells(line, width)` on each row → the tail is never on
    // screen (the row ends at the width and the command's end is lost).
    const command = `bun run deploy --target ${"segment/".repeat(12)}LAST-SEGMENT`;
    const view = permissionView(workflowAsk(steps(1, () => command)), null, COLUMNS);
    const joined = view.detailRows.join("").replace(/\s/g, "");
    expect(joined).toContain(command.replace(/\s/g, ""));
    expect(view.detailRows.length).toBeGreaterThan(1);
    // And through the real component, on screen.
    expect(frameOf(workflowAsk(steps(1, () => command))).join("\n")).toContain("LAST-SEGMENT");
  });

  test("a 20-step list is a SCROLLABLE window, never `… N more lines`", () => {
    // Mutation: `permissionDetailLines`' `capRows` → the later steps are replaced
    // by one `… N more lines` row and can never be reached.
    const req = workflowAsk(steps(20, (i) => `echo step-${i}`));
    const view = permissionView(req, null, COLUMNS);
    expect(view.detailTotal).toBe(20);
    expect(view.detailWindow).toBe(MAX_DETAIL_ROWS - 1);
    // The window + the one hint row: the dialog is no taller than today's cap.
    expect(view.detailRows.length).toBe(MAX_DETAIL_ROWS);
    expect(view.detailRows.join("\n")).not.toContain("…");
    expect(view.detailRows[view.detailRows.length - 1]).toContain("more lines below");
  });

  test("paging to the end shows the LAST step's command", () => {
    // Mutation: a window that never advances (offset stuck at 0) → red here.
    const req = workflowAsk(steps(20, (i) => (i === 20 ? "echo LAST-COMMAND" : `echo step-${i}`)));
    let scroll: ApprovalScroll = NO_APPROVAL_SCROLL;
    // Drive it the way the layer does: window from the view, key from the scan.
    for (let i = 0; i < 5; i += 1) {
      const view = permissionView(req, null, COLUMNS, scroll);
      scroll = stepApprovalScroll(
        scroll,
        " ",
        { ...NO_KEY },
        view.detailTotal,
        view.detailWindow,
      ).scroll;
    }
    const end = permissionView(req, null, COLUMNS, scroll);
    expect(end.detailRows.join("\n")).toContain("LAST-COMMAND");
    expect(end.detailRows[end.detailRows.length - 1]).toContain("all shown");
    // The hint says how to get back, and paging back reaches the top again.
    const back = stepApprovalScroll(scroll, "", { ...NO_KEY, pageUp: true }, end.detailTotal, 9);
    expect(back.taken).toBe(true);
    expect(back.scroll.offset).toBeLessThan(scroll.offset);
  });

  test("a short list is shown whole, with no hint row and no scroll", () => {
    // Mutation: always draw the hint → a 2-step approval grows a useless row.
    const view = permissionView(workflowAsk(steps(2, (i) => `echo ${i}`)), null, COLUMNS);
    expect(view.detailTotal).toBe(2);
    expect(view.detailRows).toEqual(steps(2, (i) => `echo ${i}`));
    expect(stepApprovalScroll(NO_APPROVAL_SCROLL, " ", { ...NO_KEY }, 2, 2)).toEqual({
      scroll: NO_APPROVAL_SCROLL,
      taken: true,
    });
  });

  test("the dialog height is the one the layout counts (single decision)", () => {
    // Mutation: the layout keeps counting `permissionDetailLines` for the ask →
    // the frame is taller than `activeRows` says and the dialog overflows.
    const req = workflowAsk(steps(20, (i) => `echo step-${i}`));
    const view = permissionView(req, null, COLUMNS);
    expect(frameOf(req).length).toBe(
      permissionPromptRows(OPTIONS.length, view.detailRows.length, true),
    );
  });

  test("every offset draws a full window, even a stale one (the view clamps)", () => {
    // Mutation: `slice(offset, offset + window)` unclamped → a blank dialog.
    const rows = Array.from({ length: 30 }, (_, i) => `r${i}`);
    for (const offset of [0, 5, 21, 22, 999]) {
      const got = approvalRows(rows, offset, 10);
      expect(got.rows.length).toBe(10);
    }
    expect(approvalRows(rows, 999, 10).start).toBe(20);
  });

  test("a multi-line `run: |` keeps its newlines, wrapped, and nothing is lost", () => {
    // Mutation: `oneLine()` the detail (collapse newlines) → the two commands
    // merge into one unreadable row.
    const req: PermissionRequest = {
      ...workflowAsk([]),
      detail: "s: run `echo one\necho two\n` (local)",
    };
    const view = permissionView(req, null, COLUMNS);
    expect(view.detailTotal).toBe(3);
    expect(view.detailRows).toEqual(["s: run `echo one", "echo two", "` (local)"]);
  });

  test("a narrow terminal wraps MORE rows and stays scrollable, not cut", () => {
    // Mutation: a fixed wrap width (or a cut at the width) → a narrow terminal
    // loses the command's tail.
    const command = `bun run deploy --target ${"segment/".repeat(6)}TAIL-END`;
    const narrow = permissionView(workflowAsk(steps(1, () => command)), null, 24);
    const wide = permissionView(workflowAsk(steps(1, () => command)), null, COLUMNS);
    expect(narrow.detailTotal).toBeGreaterThan(wide.detailTotal);
    expect(narrow.detailRows.join("").replace(/\s/g, "")).toContain("TAIL-END");
  });
});

describe("the scroll decides the screen only — Yes is always allowed", () => {
  test("Space pages the list: a consumed key, one `approvalScroll` effect", () => {
    // Mutation: route the key to `stepPermissionKey` first → Space does nothing.
    const r = routeKey(
      snap(
        {
          permission: {
            pending: workflowAsk(steps(20, (i) => `echo step-${i}`)),
            choices: [],
            selected: 0,
            mode: () => ({ mode: "menu" }),
            shownAt: () => 0,
            approvalScroll: () => NO_APPROVAL_SCROLL,
          },
        },
        " ",
      ),
      PURE_LAYERS,
    );
    expect(r.verdict).toBe("consumed");
    expect(r.effects).toEqual([{ kind: "approvalScroll", scroll: { offset: 9 } }]);
  });

  test("`y` answers allow-once at the TOP of the list too (no gate)", () => {
    // Mutation: a `reviewed` gate on the approve path → nothing is sent here.
    const r = routeKey(
      snap(
        {
          permission: {
            pending: workflowAsk(steps(20, (i) => `echo step-${i}`)),
            choices: OPTIONS.map((label, i) => ({
              label,
              response: i === 0 ? { allowed: true, scope: "once" } : { allowed: false },
            })) as never,
            selected: 0,
            mode: () => ({ mode: "menu" }),
            shownAt: () => 0,
            approvalScroll: () => NO_APPROVAL_SCROLL,
          },
        },
        "y",
      ),
      PURE_LAYERS,
    );
    expect(r.effects).toEqual([
      { kind: "permissionAnswer", response: { allowed: true, scope: "once" } },
    ]);
  });

  test("Space is TEXT in the reply field, never a scroll", () => {
    // Mutation: drop the `mode.mode === "menu"` guard → a space can never be typed.
    const r = routeKey(
      snap(
        {
          permission: {
            pending: workflowAsk(steps(20, (i) => `echo step-${i}`)),
            choices: [],
            selected: 0,
            mode: () => ({ mode: "reply", editor: { value: "", cursor: 0, anchor: null } }),
            shownAt: () => 0,
            approvalScroll: () => NO_APPROVAL_SCROLL,
          },
          replyMaxChars: 2000,
        },
        " ",
      ),
      PURE_LAYERS,
    );
    expect(r.effects.some((e) => e.kind === "approvalScroll")).toBe(false);
    // The dialog's own contract for the field: the key is text (a mode write).
    expect(r.effects).toEqual([
      {
        kind: "setReplyMode",
        mode: { mode: "reply", editor: { value: " ", cursor: 1, anchor: null, desiredCol: null } },
      },
    ]);
  });

  test("another ask's Space is untouched by the scroll", () => {
    // Mutation: route on `pending !== null` instead of the kind → a hooks ask's
    // space is swallowed.
    const r = routeKey(
      snap(
        {
          permission: {
            pending: {
              kind: "hooks_trust",
              tool: "hooks",
              level: "ask",
              title: "Trust these hooks?",
              detail: "a\nb",
              input: {},
            } as never,
            choices: [],
            selected: 0,
            mode: () => ({ mode: "menu" }),
            shownAt: () => 0,
            approvalScroll: () => NO_APPROVAL_SCROLL,
          },
        },
        " ",
      ),
      PURE_LAYERS,
    );
    expect(r.effects.some((e) => e.kind === "approvalScroll")).toBe(false);
  });

  test("a stale offset from a wider terminal still draws rows, not blanks", () => {
    // Mutation: clamp only the top → a resize past the last window blanks it.
    const req = workflowAsk(steps(20, (i) => `echo step-${i}`));
    const view = permissionView(req, null, COLUMNS, { offset: 500 });
    expect(view.detailRows.length).toBe(MAX_DETAIL_ROWS);
    expect(view.detailRows.join("\n")).toContain("step-20");
  });
});

describe("stepApprovalScroll — one window per key, clamped", () => {
  test("PgUp at the top is consumed and stays put", () => {
    expect(stepApprovalScroll(NO_APPROVAL_SCROLL, "", { ...NO_KEY, pageUp: true }, 30, 10)).toEqual(
      {
        scroll: NO_APPROVAL_SCROLL,
        taken: true,
      },
    );
  });

  test("PgDn at the end is consumed and stays put", () => {
    expect(stepApprovalScroll({ offset: 20 }, "", { ...NO_KEY, pageDown: true }, 30, 10)).toEqual({
      scroll: { offset: 20 },
      taken: true,
    });
  });

  test("an ordinary key is not taken, and leaves the offset alone", () => {
    expect(stepApprovalScroll({ offset: 10 }, "x", { ...NO_KEY }, 30, 10)).toEqual({
      scroll: { offset: 10 },
      taken: false,
    });
  });

  test("`b` pages BACK, and Space pages forward (the documented keys)", () => {
    // Mutation: drop `b` from `dir` → it is `taken: false` and the offset stays.
    expect(stepApprovalScroll({ offset: 10 }, "b", { ...NO_KEY }, 30, 10)).toEqual({
      scroll: { offset: 0 },
      taken: true,
    });
    expect(stepApprovalScroll({ offset: 0 }, " ", { ...NO_KEY }, 30, 10)).toEqual({
      scroll: { offset: 10 },
      taken: true,
    });
  });
});
