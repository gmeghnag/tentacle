import { describe, expect, test } from "bun:test";
import { PermissionBroker, type PermissionResponse } from "@tentacle/core";
import { render } from "ink-testing-library";
import { App, type AutoAcceptFeed, type SessionController } from "../src/App.tsx";

// docs/fix/detach-live.md B3: a detached run's auto-accept is per SESSION,
// shared by every TUI on it, held on the laptop. The App gets it as a feed:
// its state at mount, a flip from another TUI (`onChange`), its own flips (`set`).

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SHIFT_TAB = "\x1b[Z";

/** A session whose own turns are `own…` (the adopted run's turn included), others foreign. */
const session = (): SessionController => ({
  async *send() {
    yield { type: "turn_end", reason: "end_turn" };
  },
  enqueue: () => Promise.resolve(),
  watch: () => () => {},
  open: () => Promise.resolve(),
  onQueued: () => () => {},
  ownsTurn: (id) => id.startsWith("own"),
});

function feedOf(initial: boolean) {
  let on = initial;
  const listeners = new Set<(on: boolean) => void>();
  const sets: boolean[] = [];
  const feed: AutoAcceptFeed = {
    current: () => on,
    set: (next) => {
      on = next;
      sets.push(next);
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  /** Another TUI flipped it (the shared file changed). */
  const flip = (next: boolean): void => {
    on = next;
    for (const listener of listeners) listener(next);
  };
  return { feed, flip, sets };
}

const tool = (title: string) => ({ tool: "shell", level: "ask", title, input: {} }) as const;
const trust = {
  kind: "hooks_trust",
  tool: "hooks",
  level: "ask",
  title: "Trust the hooks of this project?",
  detail: "/repo",
  input: { storeBacked: false },
} as const;
const ONCE: PermissionResponse = { allowed: true, scope: "once" };

describe("D18 auto-accept ON at mount (inherited, B3)", () => {
  test("own and adopted asks answered with no dialog; foreign and hooks_trust shown; a held ask answered once", async () => {
    // Mutations: seed the state, not the ref (the held ask and the first ones
    // prompt); ignore `own` (the foreign ask is answered).
    const { feed } = feedOf(true);
    const permissions = new PermissionBroker(undefined, { holdUntilSet: true });
    const held: PermissionResponse[] = [];
    // Raised before the TUI mounts: the hand-over replays it, held until mount.
    void permissions.request(tool("held one"), { turnId: "own-run" }).then((r) => held.push(r));
    const app = render(
      <App
        createSession={session}
        model="m"
        cwd="/tmp/work"
        permissions={permissions}
        autoAccept={feed}
      />,
    );
    await delay(40);
    expect(held).toEqual([ONCE]);
    expect(app.lastFrame() ?? "").toContain("auto-accept on");
    expect(await permissions.request(tool("mine"), { turnId: "own-1" })).toEqual(ONCE);
    expect(await permissions.request(tool("the run's"), { turnId: "own-run" })).toEqual(ONCE);
    const foreign: PermissionResponse[] = [];
    void permissions.request(tool("Run theirs"), { turnId: "F1" }).then((r) => foreign.push(r));
    await delay(40);
    expect(foreign).toEqual([]);
    expect(app.lastFrame() ?? "").toContain("Run theirs");
    app.stdin.write("n");
    await delay(30);
    const trusted: PermissionResponse[] = [];
    void permissions.request(trust, { turnId: "own-1" }).then((r) => trusted.push(r));
    await delay(40);
    expect(trusted).toEqual([]);
    expect(app.lastFrame() ?? "").toContain("Trust the hooks");
    expect(held).toHaveLength(1);
    app.unmount();
  });

  test("OFF at mount (a session turned off stays off): an own ask prompts", async () => {
    const { feed } = feedOf(false);
    const permissions = new PermissionBroker();
    const app = render(
      <App
        createSession={session}
        model="m"
        cwd="/tmp/work"
        permissions={permissions}
        autoAccept={feed}
      />,
    );
    await delay(30);
    const answers: PermissionResponse[] = [];
    void permissions.request(tool("Run mine"), { turnId: "own-1" }).then((r) => answers.push(r));
    await delay(40);
    expect(answers).toEqual([]);
    expect(app.lastFrame() ?? "").toContain("Run mine");
    expect(app.lastFrame() ?? "").toContain("auto-accept off");
    app.unmount();
  });

  test("a flip to OFF between the render's read and the subscription: not lost, an own ask prompts", async () => {
    // Mutation: subscribe with no re-read (the feed's event is gone, this TUI stays ON).
    const f = feedOf(true);
    const onChange = f.feed.onChange;
    const feed: AutoAcceptFeed = {
      ...f.feed,
      onChange: (listener) => {
        f.flip(false); // landed just before the listener is in
        return onChange(listener);
      },
    };
    const permissions = new PermissionBroker();
    const app = render(
      <App
        createSession={session}
        model="m"
        cwd="/tmp/work"
        permissions={permissions}
        autoAccept={feed}
      />,
    );
    await delay(30);
    const answers: PermissionResponse[] = [];
    void permissions.request(tool("Run mine"), { turnId: "own-1" }).then((r) => answers.push(r));
    await delay(40);
    expect(answers).toEqual([]);
    expect(app.lastFrame() ?? "").toContain("auto-accept off");
    app.unmount();
  });
});

describe("D19 a flip of the shared state (B3's table)", () => {
  const mount = (initial: boolean) => {
    const f = feedOf(initial);
    const permissions = new PermissionBroker();
    const app = render(
      <App
        createSession={session}
        model="m"
        cwd="/tmp/work"
        permissions={permissions}
        autoAccept={f.feed}
      />,
    );
    return { ...f, permissions, app };
  };
  const ask = (
    permissions: PermissionBroker,
    req: Parameters<PermissionBroker["request"]>[0],
    turnId: string,
  ) => {
    const answers: PermissionResponse[] = [];
    void permissions.request(req, { turnId }).then((r) => answers.push(r));
    return answers;
  };

  test("ON from another TUI: an own (or the run's) ask on screen is granted once; the footer flips", async () => {
    // Mutation: `applyAuto` not granting → it stays on screen.
    const m = mount(false);
    await delay(30);
    const answers = ask(m.permissions, tool("Run x"), "own-run");
    await delay(40);
    expect(m.app.lastFrame() ?? "").toContain("Run x");
    m.flip(true);
    await delay(40);
    expect(answers).toEqual([ONCE]);
    expect(m.app.lastFrame() ?? "").toContain("auto-accept on");
    expect(m.sets).toEqual([]); // a flip that came from the file is not written back
    m.app.unmount();
  });

  test("ON: a foreign ask and a hooks_trust stay on screen", async () => {
    // Mutation: grant `hooks_trust` (or ignore `own`) on the flip.
    for (const [req, turnId] of [
      [tool("Run theirs"), "F1"],
      [trust, "own-1"],
    ] as const) {
      const m = mount(false);
      await delay(30);
      const answers = ask(m.permissions, req, turnId);
      await delay(40);
      m.flip(true);
      await delay(40);
      expect(answers).toEqual([]);
      m.app.stdin.write("n");
      await delay(30);
      expect(answers).toEqual([{ allowed: false }]);
      m.app.unmount();
    }
  });

  test("OFF: an ask on screen stays for a person; the next own ask prompts", async () => {
    const m = mount(true);
    await delay(30);
    m.flip(false);
    await delay(30);
    const answers = ask(m.permissions, tool("Run y"), "own-1");
    await delay(40);
    expect(answers).toEqual([]);
    expect(m.app.lastFrame() ?? "").toContain("auto-accept off");
    m.app.unmount();
  });

  test("Shift+Tab here: applied at once and written to the shared state", async () => {
    // Mutation: the toggle stays local (no `set`) → the other TUIs never see it.
    const m = mount(true);
    await delay(30);
    m.app.stdin.write(SHIFT_TAB);
    await delay(30);
    expect(m.sets).toEqual([false]);
    expect(m.app.lastFrame() ?? "").toContain("auto-accept off");
    const answers = ask(m.permissions, tool("Run z"), "own-1");
    await delay(40);
    expect(answers).toEqual([]);
    m.app.stdin.write(SHIFT_TAB); // ON again: the ask on screen is granted
    await delay(40);
    expect(m.sets).toEqual([false, true]);
    expect(answers).toEqual([ONCE]);
    m.app.unmount();
  });
});
