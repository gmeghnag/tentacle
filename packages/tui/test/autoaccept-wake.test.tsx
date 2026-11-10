/**
 * docs/fix/autoaccept-wake-turns.md T4: the TUI frame. With auto-accept on, a
 * `wake-…` ask (the session's OWN wake turn on a trusted `serve` daemon) must
 * be answered with NO dialog, while another device's turn still asks — and a
 * wake dialog already on screen is granted by Shift+Tab.
 *
 * RED before the fix: the App's own test was `ownsTurn` alone, so a wake ask
 * prompted. MUTATION: make `autoAcceptTest` return `ownsTurn` first (or ignore
 * `autoAcceptsTurn`) → the first case goes red while T-C3b stays green.
 */
import { describe, expect, test } from "bun:test";
import { PermissionBroker, type PermissionResponse } from "@tentacle/core";
import { render } from "ink-testing-library";
import { App, type SessionController } from "../src/App.tsx";
import type { BackgroundAgentRow } from "../src/background-view.ts";
import { autoAcceptTest } from "../src/permission-ui.ts";

/** A row of the background list as the tests drive it. */
type DockRow = BackgroundAgentRow;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SHIFT_TAB = "\x1b[Z";
const ONCE: PermissionResponse = { allowed: true, scope: "once" };

/**
 * A `serve`-connected session as the TUI sees it: `ownsTurn` is the session's
 * minted ids only, `autoAcceptsTurn` adds the session's own wake turns (what
 * `RemoteSession.autoAcceptsTurn` does with `daemonWakes`).
 */
function wakingSession(opts: { readonly autoAcceptsTurn?: boolean } = {}): SessionController {
  const ctrl: SessionController = {
    async *send() {
      yield { type: "turn_end", reason: "end_turn" };
    },
    enqueue: () => Promise.resolve(),
    watch: () => () => {},
    open: () => Promise.resolve(),
    onQueued: () => () => {},
    ownsTurn: (id) => id.startsWith("own"),
  };
  if (opts.autoAcceptsTurn !== false) {
    ctrl.autoAcceptsTurn = (id) => ctrl.ownsTurn?.(id) === true || id.startsWith("wake-");
  }
  return ctrl;
}

const tool = (title: string) => ({ tool: "shell", level: "ask", title, input: {} }) as const;

async function mount(ctrl: SessionController, permissions: PermissionBroker) {
  const app = render(
    <App createSession={() => ctrl} model="m" cwd="/tmp/work" permissions={permissions} />,
  );
  await delay(30);
  return app;
}

describe("T4: auto-accept answers the session's own wake turn", () => {
  test("auto-accept ON: a wake ask is answered with no dialog; a foreign turn still asks", async () => {
    const permissions = new PermissionBroker();
    const app = await mount(wakingSession(), permissions);
    app.stdin.write(SHIFT_TAB);
    await delay(30);
    expect(app.lastFrame() ?? "").toContain("auto-accept on");

    // The daemon's own wake turn: answered at once, `once`, nothing lasting.
    expect(await permissions.request(tool("Run woke"), { turnId: "wake-1" })).toEqual(ONCE);
    expect(app.lastFrame() ?? "").not.toContain("Run woke");

    // Another device's turn is still foreign (T-C3b holds under the wider test).
    const foreign: PermissionResponse[] = [];
    void permissions.request(tool("Run theirs"), { turnId: "F1" }).then((r) => foreign.push(r));
    await delay(40);
    expect(foreign).toEqual([]);
    expect(app.lastFrame() ?? "").toContain("Run theirs");
    app.stdin.write("n");
    await delay(30);
    expect(foreign).toEqual([{ allowed: false }]);
    app.unmount();
  });

  test("auto-accept OFF, a wake dialog on screen: Shift+Tab grants it and closes it", async () => {
    // `pendingOwnRef` now carries the widenend `own`, so `applyAuto` grants it.
    const permissions = new PermissionBroker();
    const app = await mount(wakingSession(), permissions);
    const answer: PermissionResponse[] = [];
    void permissions
      .request(tool("Run woke now"), { turnId: "wake-2" })
      .then((r) => answer.push(r));
    await delay(40);
    expect(answer).toEqual([]);
    expect(app.lastFrame() ?? "").toContain("Run woke now");
    app.stdin.write(SHIFT_TAB);
    await delay(40);
    expect(answer).toEqual([ONCE]);
    expect(app.lastFrame() ?? "").not.toContain("Run woke now");
    app.unmount();
  });

  test("a session that offers no autoAcceptsTurn (a pod, a local run): a wake ask is foreign again", async () => {
    // Pods and the relay mint their own wake turns (already `own`); a pod's
    // `wake-` id must stay FOREIGN on the laptop (AGENTS §7: a pod is not trusted).
    const permissions = new PermissionBroker();
    const app = await mount(wakingSession({ autoAcceptsTurn: false }), permissions);
    app.stdin.write(SHIFT_TAB);
    await delay(30);
    const asked: PermissionResponse[] = [];
    void permissions.request(tool("Run pod woke"), { turnId: "wake-9" }).then((r) => asked.push(r));
    await delay(40);
    expect(asked).toEqual([]);
    expect(app.lastFrame() ?? "").toContain("Run pod woke");
    app.stdin.write("n");
    await delay(30);
    expect(asked).toEqual([{ allowed: false }]);
    app.unmount();
  });
});

describe("T4b: autoAcceptTest picks the widest test the session offers", () => {
  test("autoAcceptsTurn over ownsTurn; ownsTurn when it is the only one; undefined when there is none", () => {
    const wake = { ownsTurn: () => false, autoAcceptsTurn: () => true };
    expect(autoAcceptTest(wake)?.("anything")).toBe(true);
    const only = { ownsTurn: (id: string) => id === "own" };
    expect(autoAcceptTest(only)?.("own")).toBe(true);
    expect(autoAcceptTest(only)?.("wake-1")).toBe(false);
    expect(autoAcceptTest(undefined)).toBeUndefined();
    expect(autoAcceptTest(null)).toBeUndefined();
    expect(autoAcceptTest({})).toBeUndefined();
  });
});

// docs/fix/autoaccept-wake-turns.md T10, the FRAME: a message the user sent to a
// child moves from today's `· read before its next step` to `✓ read` when the
// daemon's next `subagents` row reports the read. MUTATION: drop `userRead` from
// the `noteSent`/row path (or the `n <= userRead` comparison) → the frame stays
// on the old text and this goes red.
describe("T10: the drawer's `✓ read` follows the daemon's row", () => {
  const DOWN = "\u001B[B";
  const ENTER = "\r";

  /** A session with one background child, a live row feed and a message feed. */
  function childSession(rows0: readonly DockRow[]) {
    const rowListeners = new Set<(rows: readonly DockRow[]) => void>();
    const messageListeners = new Set<(m: { agentId: string; text: string; n?: number }) => void>();
    const ctrl = {
      async *send() {
        yield { type: "turn_end", reason: "end_turn" };
      },
      enqueue: () => Promise.resolve(),
      onSubagents(listener: (rows: readonly DockRow[]) => void) {
        rowListeners.add(listener);
        listener(rows0);
        return () => rowListeners.delete(listener);
      },
      onSubagentMessage(listener: (m: { agentId: string; text: string; n?: number }) => void) {
        messageListeners.add(listener);
        return () => messageListeners.delete(listener);
      },
      messageSubagent: () => Promise.resolve({ ok: true }),
      ownsTurn: () => true,
    } as unknown as SessionController;
    return {
      ctrl,
      setRows: (rows: readonly DockRow[]) => {
        for (const l of rowListeners) l(rows);
      },
      pushMessage: (m: { agentId: string; text: string; n?: number }) => {
        for (const l of messageListeners) l(m);
      },
    };
  }

  test("`read before its next step` → `✓ read` once the row counts the message", async () => {
    const base: DockRow = {
      id: "sa-1",
      agentType: "explore",
      description: "find callers",
      state: "running",
      toolUses: 1,
      tokens: 10,
      startedAt: Date.now(),
      tail: [],
      userRead: 0,
    };
    const s = childSession([base]);
    const app = render(<App createSession={() => s.ctrl} model="m" cwd="/tmp/work" />);
    await delay(40);
    // Open the drawer: DOWN (the pill) → ENTER (the dropdown) → ENTER (the row).
    app.stdin.write(DOWN);
    await delay(30);
    app.stdin.write(ENTER);
    await delay(40);
    app.stdin.write(ENTER);
    await delay(40);
    // The daemon broadcasts the message with its index, then a row that counts it.
    s.pushMessage({ agentId: "sa-1", text: "skip the tests folder", n: 1 });
    await delay(40);
    expect(app.lastFrame() ?? "").toContain("read before its next step");
    s.setRows([{ ...base, userRead: 1 }]);
    await delay(60);
    const f = app.lastFrame() ?? "";
    expect(f).toContain("✓ read");
    expect(f).not.toContain("read before its next step");
    app.unmount();
  });
});
