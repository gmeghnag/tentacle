/**
 * The header's model suffix and context bar (docs/feat/mobile-session-info.md
 * Owner decisions 2 and 4), as `sessionView` hands them to the screen.
 *
 * These live in the VIEW-MODEL, not the component (AGENTS §7): the harness
 * cannot import a `.tsx`, so a rule kept in the header's JSX would be untestable.
 */
import { describe, expect, test } from "bun:test";
import { type SessionViewInput, sessionView } from "../src/session-view.ts";
import { initialState } from "../src/transcript.ts";

function input(over: Partial<SessionViewInput> = {}): SessionViewInput {
  return {
    title: "Fix the flaky test",
    project: "MacBook Pro",
    status: { phase: "open" },
    rows: [],
    turn: null,
    link: "up",
    ended: null,
    draft: "",
    archived: false,
    ...over,
  };
}

describe("headerFolder (docs/feat/mobile-header-status.md: `<folder> · <model>`)", () => {
  test("the session's cwd, shaped for the header; the raw path rides along for VoiceOver", () => {
    const view = sessionView(input({ cwd: "/Users/me/tentacle/.tentacle/worktrees/hop/proj" }));
    expect(view.headerFolder).toEqual({
      label: "~/tentacle/…/hop/proj",
      path: "/Users/me/tentacle/.tentacle/worktrees/hop/proj",
    });
  });

  test("no cwd known, or an empty one → null (the subtitle is the model alone)", () => {
    expect(sessionView(input()).headerFolder).toBeNull();
    expect(sessionView(input({ cwd: "" })).headerFolder).toBeNull();
  });

  test("the folder survives the attach phases (opening, failed, ended)", () => {
    const cwd = "/srv/app";
    expect(sessionView(input({ cwd, status: { phase: "opening" } })).headerFolder?.label).toBe(cwd);
    expect(sessionView(input({ cwd, ended: "deleted" })).headerFolder?.label).toBe(cwd);
  });
});

describe("headerModel (Owner decision 2)", () => {
  test("the model the daemon reported, shortened to its last segment", () => {
    const view = sessionView(
      input({
        header: {
          model: "rits/deepseek-ai/DeepSeek-V4.1-Flash-1017",
          measured: null,
          open: null,
          window: undefined,
        },
      }),
    );
    expect(view.headerModel).toBe("DeepSeek-V4.1-Flash-1017");
  });

  test("no model reported → null, so the header shows the status word alone", () => {
    expect(sessionView(input()).headerModel).toBeNull();
    expect(
      sessionView(
        input({ header: { model: undefined, measured: null, open: null, window: undefined } }),
      ).headerModel,
    ).toBeNull();
  });
});

describe("the header's context bar (Owner decision 4: a bar, no text)", () => {
  test("a measured turn fills it, exactly", () => {
    const view = sessionView(
      input({
        header: {
          model: "m",
          measured: 84_000,
          open: { used: 50_000, exact: false },
          window: 200_000,
        },
      }),
    );
    expect(view.headerContext).toEqual({ percent: 42, approx: false });
  });

  test("before a turn measured, the daemon's count at open shows, marked approximate", () => {
    const view = sessionView(
      input({
        header: {
          model: "m",
          measured: null,
          open: { used: 100_000, exact: false },
          window: 200_000,
        },
      }),
    );
    expect(view.headerContext).toEqual({ percent: 50, approx: true });
  });

  test("nothing to fill from → NO bar (never a 0 % bar)", () => {
    expect(sessionView(input()).headerContext).toBeNull();
    expect(
      sessionView(input({ header: { model: "m", measured: null, open: null, window: 200_000 } }))
        .headerContext,
    ).toBeNull();
  });

  test("no window reported (an older daemon) → no bar, but the model still shows", () => {
    const view = sessionView(
      input({
        header: { model: "claude-sonnet-4-5", measured: 84_000, open: null, window: undefined },
      }),
    );
    expect(view.headerContext).toBeNull();
    expect(view.headerModel).toBe("claude-sonnet-4-5");
  });

  test("it is clamped at 100 %", () => {
    const view = sessionView(
      input({ header: { model: "m", measured: 400_000, open: null, window: 200_000 } }),
    );
    expect(view.headerContext?.percent).toBe(100);
  });
});

describe("the header carries nothing the transcript does not", () => {
  test("a failed attach shows no bar either (its own banner is the state)", () => {
    const view = sessionView(
      input({
        status: { phase: "failed", failure: "link" },
        header: { model: "m", measured: 84_000, open: null, window: 200_000 },
      }),
    );
    // The bar is a fact about a live session: it survives the model being shown,
    // because the fill is still the daemon's last true measurement.
    expect(view.headerContext?.percent).toBe(42);
    expect(initialState.lastTurnTokens).toBeNull();
  });
});
