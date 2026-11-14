/**
 * The session screen's view-model (docs/feat/mobile-session-view.md 12c): the
 * banners per state, the archived → Reopen rule (Owner Q4), the header's state
 * line, and the composer the screen draws. Pure — no React, no simulator.
 */
import { describe, expect, test } from "bun:test";
import { type Banner, type SessionViewInput, sessionView } from "../src/session-view.ts";
import type { Row, TurnRow } from "../src/transcript-rows.ts";

const ROWS: readonly Row[] = [
  { kind: "user", key: "r1", text: "Alpha", images: [] },
  { kind: "assistant", key: "r2", text: "Hello from the mock model.", version: 26 },
];
const TURN: TurnRow = { kind: "turn", key: "r3", turnId: "t1", own: false };

const input = (over: Partial<SessionViewInput> = {}): SessionViewInput => ({
  title: "Alpha",
  project: "e2e-mac",
  status: { phase: "open" },
  rows: ROWS,
  turn: null,
  link: "up",
  ended: null,
  draft: "",
  ...over,
});

const kind = (banner: Banner | null): string | null => (banner === null ? null : banner.kind);

describe("the header and the banner per state", () => {
  test("opening: Loading…, no banner, nothing editable, no action", () => {
    const view = sessionView(input({ status: { phase: "opening" } }));
    expect(view.state).toBe("Loading…");
    expect(view.banner).toBeNull();
    expect(view.editable).toBe(false);
    expect(view.composer.button).toBe("disabled");
  });

  test("open + link up: Live, no banner, rows shown, send offered for a draft", () => {
    const view = sessionView(input({ draft: "hello" }));
    expect(view.state).toBe("Live");
    expect(view.banner).toBeNull();
    expect(view.retry).toBe(false);
    expect(view.reopen).toBe(false);
    expect(view.editable).toBe(true);
    expect(view.rows).toEqual(ROWS);
    expect(view.composer).toMatchObject({ button: "send", blockedBy: null, running: false });
  });

  test("link down: Reconnecting… with the banner, and the rows are KEPT (F8, F12)", () => {
    const view = sessionView(input({ link: "down", draft: "kept" }));
    expect(view.state).toBe("Reconnecting…");
    expect(kind(view.banner)).toBe("reconnecting");
    expect(view.rows).toEqual(ROWS); // the last truth the daemon gave us
    expect(view.editable).toBe(true);
    expect(view.composer).toMatchObject({ button: "disabled", blockedBy: "link", text: "kept" });
  });

  test("a running turn shows the indicator and offers Stop on an empty field", () => {
    const running = sessionView(input({ turn: TURN }));
    expect(running.turn).toEqual(TURN);
    expect(running.composer).toMatchObject({ button: "stop", running: true });
    const typed = sessionView(input({ turn: TURN, draft: "typed" }));
    expect(typed.composer).toMatchObject({ button: "disabled", blockedBy: "turn" });
  });
});

describe("the attach's failure reasons (F14–F16, F24)", () => {
  const failed = (reason: SessionViewInput["status"]["failure"], reopenRequested?: boolean) =>
    sessionView(
      input({
        status: {
          phase: "failed",
          ...(reason === undefined ? {} : { failure: reason }),
          ...(reopenRequested === true ? { reopenRequested: true } : {}),
        },
      }),
    );

  test("archived: its own banner, Reopen offered, no Retry (Owner Q4 — only the button reopens)", () => {
    const view = failed("archived");
    expect(kind(view.banner)).toBe("archived");
    expect(view.reopen).toBe(true);
    expect(view.retry).toBe(false);
    expect(view.state).toBe("Closed");
    expect(view.editable).toBe(false);
  });

  test("a reopen that failed as archived again: no second Reopen button, the text says why", () => {
    const view = failed("archived", true);
    expect(kind(view.banner)).toBe("archived");
    expect(view.reopen).toBe(false); // tapping Reopen twice must not loop
    expect(view.state).toBe("Reopening…");
  });

  test("deleted: its own banner, no Retry, no Reopen (it cannot come back)", () => {
    const view = failed("deleted");
    expect(kind(view.banner)).toBe("deleted");
    expect(view.retry).toBe(false);
    expect(view.reopen).toBe(false);
  });

  test("gone: a retry can re-attach (a serve restart brings the id back)", () => {
    const view = failed("gone");
    expect(kind(view.banner)).toBe("failed");
    expect(view.retry).toBe(true);
  });

  test("too many sessions: said plainly, no retry, Reopen stays off (F15)", () => {
    const view = failed("too-many");
    expect(kind(view.banner)).toBe("too-many");
    expect(view.retry).toBe(false);
    expect(view.reopen).toBe(false);
  });

  test("timeout: its own banner WITH Retry, and nothing was created (F16)", () => {
    const view = failed("timeout");
    expect(kind(view.banner)).toBe("timeout");
    expect(view.retry).toBe(true);
  });

  test("link / an absent reason: the generic failure, retryable", () => {
    expect(kind(failed("link").banner)).toBe("failed");
    expect(failed("link").retry).toBe(true);
    expect(kind(failed(undefined).banner)).toBe("failed");
  });

  test("no failure text carries daemon-supplied wording (a pod chooses its messages)", () => {
    // Every wording above is the APP's own; nothing is `error.message`.
    for (const reason of ["archived", "deleted", "gone", "too-many", "timeout", "link"] as const) {
      const banner = failed(reason).banner;
      expect(banner).not.toBeNull();
      expect(banner?.text ?? "").not.toContain("archived session"); // never the raw daemon text
    }
  });
});

describe("the daemon's own end of a session we reached (F14)", () => {
  test("closed: Ended + the closed banner, not editable", () => {
    const view = sessionView(input({ ended: "closed" }));
    expect(view.state).toBe("Ended");
    expect(kind(view.banner)).toBe("ended");
    expect(view.editable).toBe(false);
    expect(view.composer.blockedBy).toBe("ended");
  });

  test("deleted: its own banner, and nothing can be typed into it", () => {
    const view = sessionView(input({ ended: "deleted" }));
    expect(kind(view.banner)).toBe("deleted");
    expect(view.composer.button).toBe("disabled");
    expect(view.composer.blockedBy).toBe("ended");
  });

  test("gone (vanished while the link was down): reconnecting, since a re-open may find it", () => {
    const view = sessionView(input({ ended: "gone" }));
    expect(kind(view.banner)).toBe("reconnecting");
    expect(view.editable).toBe(false);
  });

  test("the attach's failure outranks the daemon's end (we never reached it)", () => {
    const view = sessionView(
      input({ status: { phase: "failed", failure: "archived" }, ended: "closed" }),
    );
    expect(kind(view.banner)).toBe("archived");
  });
});
