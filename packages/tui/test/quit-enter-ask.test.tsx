import { describe, expect, test } from "bun:test";
import { PermissionBroker, type PermissionRequest, type PermissionResponse } from "@tentacle/core";
import { render } from "ink-testing-library";
import { App, type SessionController } from "../src/App.tsx";
import { ARM_MS } from "../src/permission-reply.ts";
import { inertSession } from "./session-stub.ts";

// docs/fix/quit-enter-ask.md: the ARMING WINDOW in the real App. The trap is not
// `/quit` alone — a permission dialog that appears while the person is typing
// for the MAIN input used to eat the next approving key (`/quit` + Enter, the
// tail of an ordinary word, `a` mid-word granting a SESSION-scope approval).
// For `ARM_MS` after its dialog is first DRAWN, approving keys are swallowed;
// refusals, arrows, `t` and Ctrl+C stay immediate (owner Q2).

const ENTER = "\r";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Comfortably inside the window: the dialog was drawn a moment ago. */
const INSIDE = 30;
/** Comfortably past it. */
const AFTER = ARM_MS + 150;

const session = (): SessionController => ({
  ...inertSession(),
  async *send(prompt) {
    yield { type: "text", delta: `reply to ${prompt}` };
    yield { type: "turn_end", reason: "end_turn" };
  },
  ownsTurn: () => true,
});

const REQ: PermissionRequest = {
  tool: "shell",
  level: "ask",
  title: "Run a shell command",
  detail: "rm -rf build",
  input: {},
};

/**
 * Mount the App, let `before` be typed into the INPUT (no ask up yet), then open
 * the ask and type `after` `gapMs` later — the repro's shape, which is the real
 * race: the keys of `after` were meant for the input.
 */
async function race(opts: {
  before: string;
  after: string;
  gapMs: number;
  reply?: boolean;
  settle?: number;
}) {
  const permissions = new PermissionBroker();
  const app = render(
    <App createSession={session} permissions={permissions} model="m" cwd="/tmp/work" />,
  );
  await delay(40);
  for (const c of opts.before) {
    app.stdin.write(c);
    await delay(10);
  }
  const answers: PermissionResponse[] = [];
  const req = opts.reply ? { ...REQ, reply: { maxChars: 2000 } } : REQ;
  void permissions.request(req, { turnId: "own-1" }).then((r) => answers.push(r));
  await delay(opts.gapMs);
  for (const c of opts.after) {
    app.stdin.write(c);
    await delay(10);
  }
  await delay(opts.settle ?? 80);
  const frame = () => app.lastFrame() ?? "";
  return { app, answers, frame, permissions };
}

/** The main input's row (its draft). */
const inputRow = (frame: string) =>
  (
    frame
      .split("\n")
      .filter((l) => l.startsWith("❯ "))
      .at(-1) ?? ""
  ).trimEnd();

describe("the arming window in the App", () => {
  test("A: `/quit` + Enter into a dialog that just opened — the ask is NOT approved, nothing quits", async () => {
    // The repro's case A, the one the owner ranked first. Red on 0a534648:
    // answered `{ allowed: true, scope: "once" }` and ran rm -rf build.
    const t = await race({ before: "/quit", after: ENTER, gapMs: INSIDE });
    expect(t.answers).toEqual([]);
    // The dialog is still up and still asking.
    expect(t.frame()).toContain("Run a shell command");
    expect(t.frame()).not.toContain("^C"); // never started a turn: the input is not sent
    t.app.unmount();
  });

  test("C: `/qui` + `t` + Enter into a dialog that just opened — still not approved", async () => {
    const t = await race({ before: "/qui", after: `t${ENTER}`, gapMs: INSIDE });
    expect(t.answers).toEqual([]);
    expect(t.frame()).toContain("Run a shell command");
    t.app.unmount();
  });

  test("E: `a` typed mid-word as the ask opens — no SESSION-scope approval (the widest trap)", async () => {
    // Red on 0a534648: `{ allowed: true, scope: "session" }`, i.e. a standing
    // approval granted by a letter of an ordinary word.
    const t = await race({ before: "s", after: "ay", gapMs: INSIDE });
    expect(t.answers).toEqual([]);
    expect(t.frame()).toContain("Run a shell command");
    t.app.unmount();
  });

  test("the window expires: after ARM_MS the same `y` approves (the guard is a window, not a block)", async () => {
    const t = await race({ before: "/quit", after: "", gapMs: AFTER });
    expect(t.answers).toEqual([]);
    t.app.stdin.write("y");
    await delay(80);
    expect(t.answers).toEqual([{ allowed: true, scope: "once" }]);
    expect(t.frame()).not.toContain("Run a shell command");
    t.app.unmount();
  });

  test("a denial inside the window is immediate: `n` denies at once (owner Q2)", async () => {
    const t = await race({ before: "/quit", after: "", gapMs: INSIDE });
    t.app.stdin.write("n");
    await delay(80);
    expect(t.answers).toEqual([{ allowed: false }]);
    expect(t.frame()).not.toContain("Run a shell command");
    t.app.unmount();
  });

  test("Ctrl+C inside the window stops as before (never guarded)", async () => {
    const t = await race({ before: "", after: "\x03", gapMs: INSIDE });
    // No turn is shown, so Ctrl+C quits the TUI rather than stopping a turn; the
    // point is only that the dialog did not swallow it and nothing was approved.
    expect(t.answers.some((a) => a.allowed)).toBe(false);
    t.app.unmount();
  });

  test("back-to-back asks: the SECOND ask is guarded too (its own stamp)", async () => {
    const permissions = new PermissionBroker();
    const app = render(
      <App createSession={session} permissions={permissions} model="m" cwd="/tmp/work" />,
    );
    await delay(40);
    const first: PermissionResponse[] = [];
    const second: PermissionResponse[] = [];
    void permissions.request(REQ, { turnId: "own-1" }).then((r) => first.push(r));
    await delay(ARM_MS + 150);
    app.stdin.write("y");
    await delay(80);
    expect(first).toEqual([{ allowed: true, scope: "once" }]);
    // A second ask opens at once; an Enter right behind it must not approve it.
    void permissions.request(REQ, { turnId: "own-1" }).then((r) => second.push(r));
    await delay(INSIDE);
    app.stdin.write(ENTER);
    await delay(80);
    expect(second).toEqual([]);
    expect(app.lastFrame() ?? "").toContain("Run a shell command");
    app.unmount();
  });

  test("the swallow is silent: the draft typed before the ask stays in the input, no notice", async () => {
    const t = await race({ before: "/quit", after: ENTER, gapMs: INSIDE });
    // The main input keeps what was typed for it (it is hidden while the dialog
    // is up); the dialog staying up is the only signal (owner Q3: silent).
    expect(t.frame()).toContain("Run a shell command");
    expect(t.frame()).not.toContain("just opened");
    t.app.unmount();
  });
});
