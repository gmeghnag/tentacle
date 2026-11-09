import { describe, expect, test } from "bun:test";
import { PermissionBroker, type PermissionResponse } from "@tentacle/core";
import { render } from "ink-testing-library";
import { App, type NoticeFeed, type RunQuit, type SessionController } from "../src/App.tsx";
import type { SessionEvent } from "../src/state.ts";
import type { SessionActivity } from "../src/turn-feed.ts";

// docs/fix/detach-live.md A2/A6: a detached run's TUI. `/quit` closes the
// session for every TUI on it (a y/N confirmation with others attached); a
// session closed by another TUI makes this one leave; the host's notices
// survive the attach's history.

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A turn's events the test drives. */
function stream() {
  const queue: SessionEvent[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  const events: AsyncIterable<SessionEvent> = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (queue.length > 0) {
          const next = queue.shift();
          if (next) yield next;
        }
        if (done) return;
        await new Promise<void>((r) => {
          wake = r;
        });
      }
    },
  };
  const poke = (): void => {
    const w = wake;
    wake = null;
    w?.();
  };
  return {
    events,
    push: (...e: SessionEvent[]) => {
      queue.push(...e);
      poke();
    },
    end: () => {
      done = true;
      poke();
    },
  };
}

function shared(onOpen?: (raise: (a: SessionActivity) => void) => void) {
  const log = { cancels: [] as string[], made: 0 };
  let listener: ((a: SessionActivity) => void) | null = null;
  const make = (): SessionController => {
    log.made += 1;
    return {
      async *send(prompt) {
        yield { type: "text", delta: `reply to ${prompt}` };
        yield { type: "turn_end", reason: "end_turn" };
      },
      enqueue: () => Promise.resolve(),
      watch(l) {
        listener = l;
        return () => {
          listener = null;
        };
      },
      open() {
        if (listener && onOpen) onOpen(listener);
        return Promise.resolve();
      },
      onQueued: () => () => {},
      ownsTurn: (id) => id.startsWith("own"),
    };
  };
  const raise = (a: SessionActivity): void => listener?.(a);
  const foreign = (turnId: string) => {
    const s = stream();
    raise({ kind: "turn", turnId, events: s.events, cancel: () => log.cancels.push(turnId) });
    return s;
  };
  return { make, log, raise, foreign };
}

/** `exited` flips when the App unmounts (its notice subscription ends). */
function exitProbe(): { notices: NoticeFeed; exited: () => boolean } {
  let gone = false;
  return {
    notices: {
      onNotice: () => () => {
        gone = true;
      },
    },
    exited: () => gone,
  };
}

function runQuitSpy(others: number) {
  const calls: string[] = [];
  const runQuit: RunQuit = {
    othersOnSession: () => others,
    closeForAll: () => calls.push("closeForAll"),
    closedElsewhere: (reason) =>
      calls.push(reason === "closed" ? "closedElsewhere" : `closedElsewhere(${reason})`),
  };
  return { runQuit, calls };
}

async function type(stdin: { write(d: string): void }, text: string) {
  stdin.write(text);
  await delay(20);
  stdin.write("\r");
  await delay(40);
}

const TEXT = "2 other terminals attached — close the session for all? (y/N)";

describe("D2 /quit on a run TUI with others on the session", () => {
  test("the confirmation; `n` and Enter change nothing; no closeForAll", async () => {
    // Mutation: drop the `confirm` row → it exits at once.
    const s = shared();
    const probe = exitProbe();
    const spy = runQuitSpy(2);
    const app = render(
      <App
        createSession={s.make}
        model="m"
        cwd="/tmp/work"
        notices={probe.notices}
        runQuit={spy.runQuit}
      />,
    );
    await delay(30);
    for (const key of ["n", "\r"]) {
      await type(app.stdin, "/quit");
      expect(app.lastFrame() ?? "").toContain(TEXT);
      app.stdin.write(key);
      await delay(40);
      expect(app.lastFrame() ?? "").not.toContain(TEXT);
      expect(probe.exited()).toBe(false);
    }
    expect(spy.calls).toEqual([]);
    app.unmount();
  });

  test("`y` mid-foreign-turn: closeForAll, the turn is cancelled, exit at the stream's end", async () => {
    // Mutation: `y` skips the stop (exits at once) → no cancel, exited early.
    const s = shared();
    const probe = exitProbe();
    const spy = runQuitSpy(2);
    const app = render(
      <App
        createSession={s.make}
        model="m"
        cwd="/tmp/work"
        notices={probe.notices}
        runQuit={spy.runQuit}
      />,
    );
    await delay(30);
    const f = s.foreign("F1");
    f.push({ type: "user_message", text: "the run's" });
    await delay(40);
    await type(app.stdin, "/quit");
    expect(app.lastFrame() ?? "").toContain(TEXT);
    app.stdin.write("y");
    await delay(40);
    expect(spy.calls).toEqual(["closeForAll"]);
    expect(s.log.cancels).toEqual(["F1"]);
    expect(probe.exited()).toBe(false);
    f.push({ type: "turn_end", reason: "cancelled" });
    f.end();
    await delay(40);
    expect(probe.exited()).toBe(true);
    app.unmount();
  });

  test("an ask opening behind the dialog: `y` never answers it", async () => {
    // Mutation: the permission dialog takes keys first → `y` approves the tool.
    const s = shared();
    const probe = exitProbe();
    const spy = runQuitSpy(1);
    const permissions = new PermissionBroker();
    const app = render(
      <App
        createSession={s.make}
        model="m"
        cwd="/tmp/work"
        notices={probe.notices}
        runQuit={spy.runQuit}
        permissions={permissions}
      />,
    );
    await delay(30);
    const f = s.foreign("F1");
    f.push({ type: "user_message", text: "the run's" });
    await delay(40);
    await type(app.stdin, "/quit");
    const answers: PermissionResponse[] = [];
    void permissions
      .request({ tool: "shell", level: "ask", title: "Run rm", input: {} }, { turnId: "F1" })
      .then((r) => answers.push(r));
    await delay(40);
    expect(app.lastFrame() ?? "").toContain("1 other terminal attached");
    app.stdin.write("y");
    await delay(40);
    expect(answers).toEqual([]);
    expect(spy.calls).toEqual(["closeForAll"]);
    expect(s.log.cancels).toEqual(["F1"]);
    f.push({ type: "turn_end", reason: "cancelled" });
    f.end();
    app.unmount();
  });

  test("alone on the session: no dialog; a running foreign turn stops first", async () => {
    // Mutation: `endsSession` honours `foreign` → exit at once, nothing stopped (FAIL 39).
    const s = shared();
    const probe = exitProbe();
    const spy = runQuitSpy(0);
    const app = render(
      <App
        createSession={s.make}
        model="m"
        cwd="/tmp/work"
        notices={probe.notices}
        runQuit={spy.runQuit}
      />,
    );
    await delay(30);
    const f = s.foreign("F1");
    f.push({ type: "user_message", text: "the run's" });
    await delay(40);
    await type(app.stdin, "/quit");
    expect(app.lastFrame() ?? "").not.toContain("close the session for all");
    expect(s.log.cancels).toEqual(["F1"]);
    expect(probe.exited()).toBe(false);
    f.push({ type: "turn_end", reason: "cancelled" });
    f.end();
    await delay(40);
    expect(probe.exited()).toBe(true);
    expect(spy.calls).toEqual([]);
    app.unmount();
  });
});

describe("D3 the session closed by another terminal", () => {
  test("with runQuit: closedElsewhere, exit, no new session, an open dialog dropped", async () => {
    // Mutation: always swap → a second session is made, nothing exits.
    const s = shared();
    const probe = exitProbe();
    const spy = runQuitSpy(1);
    const app = render(
      <App
        createSession={s.make}
        model="m"
        cwd="/tmp/work"
        notices={probe.notices}
        runQuit={spy.runQuit}
      />,
    );
    await delay(30);
    await type(app.stdin, "/quit");
    expect(app.lastFrame() ?? "").toContain("close the session for all");
    s.raise({ kind: "closed", reason: "closed" });
    await delay(40);
    expect(spy.calls).toEqual(["closedElsewhere"]);
    expect(probe.exited()).toBe(true);
    expect(s.log.made).toBe(1);
    app.unmount();
  });

  test("the reason goes through: a deleted session is not `closed by another terminal`", async () => {
    // Mutation: `closedElsewhere()` with no reason.
    const s = shared();
    const probe = exitProbe();
    const spy = runQuitSpy(0);
    const app = render(
      <App
        createSession={s.make}
        model="m"
        cwd="/tmp/work"
        notices={probe.notices}
        runQuit={spy.runQuit}
      />,
    );
    await delay(30);
    s.raise({ kind: "closed", reason: "deleted" });
    await delay(40);
    expect(spy.calls).toEqual(["closedElsewhere(deleted)"]);
    app.unmount();
  });

  test("mid-foreign-turn: closedElsewhere and exit at once (`closed` is never held behind a stream)", async () => {
    // `nextStep` never holds `closed`: O leaves whatever the order of its
    // `turn_end` and `session_closed` on arrival.
    const s = shared();
    const probe = exitProbe();
    const spy = runQuitSpy(1);
    const app = render(
      <App
        createSession={s.make}
        model="m"
        cwd="/tmp/work"
        notices={probe.notices}
        runQuit={spy.runQuit}
      />,
    );
    await delay(30);
    const f = s.foreign("F1");
    f.push({ type: "user_message", text: "the run's" });
    await delay(40);
    s.raise({ kind: "closed", reason: "closed" });
    await delay(30);
    expect(spy.calls).toEqual(["closedElsewhere"]);
    expect(probe.exited()).toBe(true);
    expect(s.log.made).toBe(1);
    f.push({ type: "turn_end", reason: "cancelled" });
    f.end();
    await delay(30);
    expect(spy.calls).toEqual(["closedElsewhere"]); // the late end changes nothing
    app.unmount();
  });

  test("without runQuit: today's swap to a fresh session", async () => {
    const s = shared();
    const probe = exitProbe();
    const app = render(
      <App createSession={s.make} model="m" cwd="/tmp/work" notices={probe.notices} />,
    );
    await delay(30);
    s.raise({ kind: "closed", reason: "closed" });
    await delay(40);
    expect(s.log.made).toBe(2);
    expect(probe.exited()).toBe(false);
    app.unmount();
  });
});

describe("D15 a host notice survives the attach's history (App)", () => {
  /** `NoticeHub`'s contract: buffered before the first subscription. */
  function hub(pending: string[]): NoticeFeed {
    return {
      onNotice(listener) {
        for (const text of pending.splice(0)) listener(text);
        return () => {};
      },
    };
  }
  const NOTICE = "Quitting removes the container if no other session is in use";
  const messages = [
    { role: "user" as const, content: "ciao" },
    { role: "assistant" as const, content: "Ciao! Come posso aiutarti?" },
  ];

  test("idle attach: the eager open's `history`", async () => {
    // Mutations: `resetHistory` filters everything; no `host` flag in the effect.
    const s = shared((raise) => raise({ kind: "history", messages, reason: null }));
    const app = render(
      <App createSession={s.make} model="m" cwd="/tmp/work" notices={hub([NOTICE])} />,
    );
    await delay(80);
    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("Ciao! Come posso aiutarti?");
    expect(frame).toContain(NOTICE);
    app.unmount();
  });

  test("mid-turn attach: the foreign turn's `history_reset`", async () => {
    const s = stream();
    const shared_ = shared((raise) =>
      raise({ kind: "turn", turnId: "T", events: s.events, cancel: () => {} }),
    );
    const app = render(
      <App createSession={shared_.make} model="m" cwd="/tmp/work" notices={hub([NOTICE])} />,
    );
    await delay(30);
    s.push({ type: "history_reset", messages });
    await delay(80);
    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("Ciao! Come posso aiutarti?");
    expect(frame).toContain(NOTICE);
    s.end();
    app.unmount();
  });
});

describe("T49/T48: background sub-agents in the TUI (docs/feat/subagent-background-ui.md)", () => {
  /** A session controller that reports a live background list the test drives. */
  function withAgents() {
    const listeners = new Set<(rows: readonly { id: string }[]) => void>();
    let rows: readonly { id: string }[] = [];
    const make = (): SessionController => ({
      async *send() {
        yield { type: "turn_end", reason: "end_turn" };
      },
      enqueue: () => Promise.resolve(),
      onSubagents(listener) {
        listeners.add(listener);
        listener(rows);
        return () => listeners.delete(listener);
      },
      ownsTurn: () => true,
    });
    return {
      make,
      set: (next: readonly { id: string }[]) => {
        rows = next;
        for (const listener of listeners) listener(rows);
      },
      watching: () => listeners.size,
    };
  }

  test("the status line shows the live count, and it clears when the children end", async () => {
    // Mutations: no `onSubagents` subscription → no count; no `background` prop → none.
    const s = withAgents();
    const app = render(<App createSession={s.make} model="m" cwd="/tmp/work" />);
    await delay(30);
    expect(app.lastFrame() ?? "").not.toContain("sub-agent");
    s.set([{ id: "sa-1" }]);
    await delay(30);
    expect(app.lastFrame() ?? "").toContain("· 1 sub-agent");
    s.set([{ id: "sa-1" }, { id: "sa-2" }]);
    await delay(30);
    expect(app.lastFrame() ?? "").toContain("· 2 sub-agents");
    s.set([]);
    await delay(30);
    expect(app.lastFrame() ?? "").not.toContain("sub-agent");
    app.unmount();
  });

  test("/quit with children running asks first and names them; `n` leaves the session open", async () => {
    // Mutation: drop the `agents` row from `quitCommandStep` → it exits silently.
    const s = withAgents();
    const probe = exitProbe();
    const spy = runQuitSpy(0);
    const app = render(
      <App
        createSession={s.make}
        model="m"
        cwd="/tmp/work"
        notices={probe.notices}
        runQuit={spy.runQuit}
      />,
    );
    await delay(30);
    s.set([{ id: "sa-1" }, { id: "sa-2" }]);
    await delay(30);
    await type(app.stdin, "/quit");
    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("2 background sub-agents (sa-1, sa-2) will be lost — quit? (y/N)");
    expect(spy.calls).toEqual([]);
    expect(probe.exited()).toBe(false);
    // `n` changes nothing: the session is still open.
    app.stdin.write("n");
    await delay(40);
    expect(app.lastFrame() ?? "").not.toContain("will be lost");
    expect(spy.calls).toEqual([]);
    expect(probe.exited()).toBe(false);
    app.unmount();
  });

  test("an idle Ctrl+C with children asks; a second Ctrl+C (confirmed) does not trap the user", async () => {
    const s = withAgents();
    const probe = exitProbe();
    const spy = runQuitSpy(0);
    const app = render(
      <App
        createSession={s.make}
        model="m"
        cwd="/tmp/work"
        notices={probe.notices}
        runQuit={spy.runQuit}
      />,
    );
    await delay(30);
    s.set([{ id: "sa-7" }]);
    await delay(30);
    app.stdin.write("\u0003");
    await delay(40);
    expect(app.lastFrame() ?? "").toContain("1 background sub-agent (sa-7) will be lost");
    expect(probe.exited()).toBe(false);
    // A second Ctrl+C, while the dialog is up, is a QUIT REQUEST (not a "no"):
    // it leaves at once. Otherwise the key that asked could only ever dismiss,
    // and the user would be trapped in a dialog they cannot get past.
    const started = Date.now();
    app.stdin.write("\u0003");
    await delay(60);
    expect(probe.exited()).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
    app.unmount();
  });
});
