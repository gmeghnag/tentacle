import { describe, expect, test } from "bun:test";
import { PermissionBroker, type PermissionResponse } from "@tentacle/core";
import { render } from "ink-testing-library";
import { App, type SessionController } from "../src/App.tsx";

// docs/feat/session-auto-accept.md T4: auto-accept is the SESSION's. Two TUIs on
// one session follow each other's flips, an auto-answer is always `allow_once`,
// a `hooks_trust` ask still prompts, and a POD session (the trust bit off) keeps
// prompting whatever the daemon claims — the §7 red-team.

const SHIFT_TAB = "\x1b[Z";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A session that answers prompts at once and watches nothing. */
function controller(): SessionController {
  return {
    async *send(prompt) {
      yield { type: "text", delta: `reply to ${prompt}` };
      yield { type: "turn_end", reason: "end_turn" };
    },
    enqueue: () => Promise.resolve(),
    watch: () => () => {},
  };
}

/**
 * ONE session's auto-accept, as both TUIs see it: the two `App`s share one
 * routing feed, exactly as the CLI wires it (`session-auto-accept.ts`).
 */
function sharedFeed(shared: boolean, initial = false) {
  const sent: boolean[] = [];
  let value = initial;
  let by: string | undefined;
  /** Did THIS TUI make the last change (its own flip, or its echo)? */
  let ownChange = true;
  const listeners = new Set<(on: boolean) => void>();
  const notify = (on: boolean): void => {
    if (value === on) return;
    value = on;
    for (const listener of [...listeners]) listener(on);
  };
  const feed = {
    current: () => value,
    set(on: boolean) {
      ownChange = true;
      notify(on);
      // With the trust bit off nothing is sent: the client's link fails closed.
      if (shared) sent.push(on);
    },
    onChange(listener: (on: boolean) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    lastBy: () => by,
    // Whether the last change came from ANOTHER device: the fake's `receive` is
    // another device by construction, and this TUI's own `set` is not.
    remote: () => !ownChange,
  };
  return {
    feed,
    sent,
    /** The daemon's `auto_accept`: applied when this client shares it, else DROPPED. */
    receive(on: boolean, label?: string) {
      if (!shared) return;
      by = label;
      ownChange = false;
      notify(on);
    },
  };
}

async function mount(feed: ReturnType<typeof sharedFeed>, permissions: PermissionBroker) {
  const app = render(
    <App
      createSession={controller}
      model="m"
      cwd="/tmp/work"
      permissions={permissions}
      autoAccept={feed.feed}
      autoAcceptShared={feed.feed}
    />,
  );
  await delay(30);
  return app;
}

const req = { tool: "shell", level: "ask", title: "Run rm", input: {} } as const;

describe("T4: the session's auto-accept across two terminals", () => {
  test("Shift+Tab in A turns it on for B too; B answers its own ask allow_once, never allow_always", async () => {
    // Mutation: give each TUI its own feed → B's ask is asked, not answered.
    const session = sharedFeed(true);
    const pa = new PermissionBroker();
    const pb = new PermissionBroker();
    const a = await mount(session, pa);
    const b = await mount(session, pb);
    a.stdin.write(SHIFT_TAB);
    await delay(40);
    // B's status bar says on, without B being touched.
    expect(b.lastFrame() ?? "").toContain("auto-accept on");
    expect(await pb.request(req, { turnId: "own-1" })).toEqual({ allowed: true, scope: "once" });
    expect(session.sent).toEqual([true]);
    a.unmount();
    b.unmount();
  });

  test("a hooks_trust ask still prompts with the session's auto-accept on", async () => {
    const session = sharedFeed(true, true);
    const permissions = new PermissionBroker();
    const app = await mount(session, permissions);
    const held: PermissionResponse[] = [];
    void permissions
      .request({ ...req, kind: "hooks_trust" }, { turnId: "own-1" })
      .then((r) => held.push(r));
    await delay(50);
    expect(held).toEqual([]);
    expect(app.lastFrame() ?? "").toContain("Run rm");
    app.stdin.write("n");
    await delay(30);
    expect(held).toEqual([{ allowed: false }]);
    app.unmount();
  });

  test("§7 red-team: a POD session keeps prompting, whatever value it reports", async () => {
    // Mutation: default the trust bit to on → the pod's ON widens and auto-answers.
    const pod = sharedFeed(false, false);
    // The daemon claims ON — a pod's claim, on a client with the bit off.
    pod.receive(true, "pod");
    expect(pod.feed.current()).toBe(false);
    const permissions = new PermissionBroker();
    const app = await mount(pod, permissions);
    const held: PermissionResponse[] = [];
    void permissions.request(req, { turnId: "own-1" }).then((r) => held.push(r));
    await delay(50);
    // Asked, never auto-answered: the screen shows it.
    expect(held).toEqual([]);
    expect(app.lastFrame() ?? "").toContain("Run rm");
    app.stdin.write("n");
    await delay(30);
    expect(held).toEqual([{ allowed: false }]);
    // And nothing was ever sent to it.
    expect(pod.sent).toEqual([]);
    app.unmount();
  });

  test("THIS TUI's own Shift+Tab adds no notice (the status bar says it)", async () => {
    // The bug the real `connect` stack found (connect-functest-a): a TUI's own
    // flip came back through the feed and was announced as "from another device"
    // — a notice about the person's own keypress. Mutation: drop the `remote()`
    // test in App.tsx → it reappears.
    const session = sharedFeed(true, false);
    const permissions = new PermissionBroker();
    const app = await mount(session, permissions);
    app.stdin.write(SHIFT_TAB);
    await delay(60);
    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("auto-accept on");
    expect(frame).not.toContain("auto-accept turned on from");
    app.unmount();
  });

  test("a flip from another device shows one notice naming it, and moves the switch", async () => {
    const session = sharedFeed(true, false);
    const permissions = new PermissionBroker();
    const app = await mount(session, permissions);
    // Another device's update, through the link (its own echo path).
    session.receive(true, "phone");
    await delay(60);
    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("auto-accept turned on from phone");
    expect(frame).toContain("auto-accept on");
    app.unmount();
  });

  test("the setter's label is sanitized before it reaches the transcript (§7, pod text)", async () => {
    const session = sharedFeed(true, false);
    const permissions = new PermissionBroker();
    const app = await mount(session, permissions);
    // A control character and a bidi override: one line, and neither SURVIVES
    // (their printable remains, `[2J`, is inert text once the ESC is gone).
    session.receive(true, "po\u001b[2Jd\u202eevil");
    await delay(60);
    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("auto-accept turned on from");
    // No escape byte and no bidi override reached the screen.
    expect(frame).not.toContain("\u001b");
    expect(frame).not.toContain("\u202e");
    app.unmount();
  });
});
