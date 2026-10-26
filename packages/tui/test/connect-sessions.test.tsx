import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { App, type SessionController, type SessionDirectory } from "../src/App.tsx";
import type { SessionsView } from "../src/sessions-panel.ts";
import type { SessionEvent } from "../src/state.ts";
import type { SessionActivity } from "../src/turn-feed.ts";

// docs/feat/connect-sessions.md, TUI side: quit detaches on `connect`,
// `/sessions` switches through ONE swap path, `/close` ends and quits, `/clear`
// stays close + new (owner QN1), a session closed elsewhere hands the next
// prompt to a fresh one. Fake controllers and a fake directory.

const ESC = "\x1b";
const DOWN = "\x1b[B";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rpcError = (code: number, message: string) => Object.assign(new Error(message), { code });
const METHOD_NOT_FOUND = -32601;

interface Fake {
  readonly ctrl: SessionController;
  readonly name: string;
  readonly log: string[];
  readonly raise: (a: SessionActivity) => void;
  /** Resolves the hanging send of "hang" (its signal is observed). */
  aborted: () => boolean;
}

/** A controller that logs what the App does to it; "hang" never ends by itself. */
function fake(
  name: string,
  journal: string[],
  o: { readonly detach?: () => Promise<void>; readonly staying?: number } = {},
): Fake {
  const log: string[] = [];
  let listener: ((a: SessionActivity) => void) | null = null;
  let abortedFlag = false;
  const note = (what: string) => {
    log.push(what);
    journal.push(`${name}.${what}`);
  };
  const ctrl: SessionController = {
    sessionId: name,
    async *send(prompt, signal) {
      note(`send:${prompt}`);
      if (prompt === "hang") {
        signal?.addEventListener("abort", () => {
          abortedFlag = true;
        });
        yield { type: "text", delta: "partial" } as SessionEvent;
        await new Promise(() => {});
      }
      yield { type: "text", delta: `${name} replies to ${prompt}` } as SessionEvent;
      yield { type: "turn_end", reason: "end_turn" } as SessionEvent;
    },
    close() {
      note("close");
    },
    detach() {
      note("detach");
      return o.detach ? o.detach() : Promise.resolve();
    },
    watch(l) {
      note("watch");
      listener = l;
      return () => {
        if (listener === l) {
          listener = null;
          note("unwatch");
        }
      };
    },
    open() {
      note("open");
      return Promise.resolve();
    },
    stayingRows: () => o.staying ?? 0,
  };
  return { ctrl, name, log, raise: (a) => listener?.(a), aborted: () => abortedFlag };
}

function directory(view: SessionsView, journal: string[], next: Map<string, Fake>) {
  const dir: SessionDirectory = {
    list: () => Promise.resolve(view),
    open: (id, reopen) => {
      journal.push(`dir.open:${id}:${reopen}`);
      const f = next.get(id);
      if (!f) throw new Error(`no fake for ${id}`);
      return f.ctrl;
    },
    remove: (id) => {
      journal.push(`dir.remove:${id}`);
      return Promise.resolve();
    },
  };
  return dir;
}

const entry = (id: string, o: Partial<SessionsView["sessions"][number]> = {}) => ({
  id,
  title: `title ${id}`,
  updatedAt: Date.now(),
  running: false,
  attached: 0,
  archived: false,
  ...o,
});

/** Mount with a sequence of controllers handed out by `createSession`. */
async function mount(fakes: Fake[], extra: Record<string, unknown> = {}) {
  const queue = [...fakes];
  const exits: string[] = [];
  const notices = { onNotice: () => () => exits.push("unmounted") };
  const app = render(
    <App
      createSession={() => {
        const f = queue.shift();
        if (!f) throw new Error("no more fakes");
        return f.ctrl;
      }}
      model="m"
      cwd="/tmp/work"
      notices={notices}
      {...extra}
    />,
  );
  await delay(30);
  return { app, exits };
}

async function type(stdin: { write(d: string): void }, text: string) {
  stdin.write(text);
  await delay(20);
  stdin.write("\r");
  await delay(40);
}

describe("connect: quit detaches", () => {
  test("(a) RED: /exit mid-own-turn with detachOnQuit exits at once and aborts nothing", async () => {
    // Mutation: drop `detachOnQuit` from the /exit call site → "Stopping the turn…" + an abort.
    const journal: string[] = [];
    const a = fake("A", journal);
    const { app, exits } = await mount([a], { detachOnQuit: true });
    await type(app.stdin, "hang");
    expect(app.lastFrame() ?? "").toContain("working…");
    await type(app.stdin, "/exit");
    await delay(30);
    expect(exits).toEqual(["unmounted"]);
    expect(a.aborted()).toBe(false);
    expect(a.log).not.toContain("close");
    expect(a.log).not.toContain("detach");
    app.unmount();
  });

  test("without detachOnQuit (worker/pods) /exit mid-turn still stops first", async () => {
    const journal: string[] = [];
    const a = fake("A", journal);
    const { app, exits } = await mount([a]);
    await type(app.stdin, "hang");
    await type(app.stdin, "/exit");
    expect(exits).toEqual([]);
    expect(a.aborted()).toBe(true);
    app.unmount();
  });
});

describe("/sessions", () => {
  test("(d) RED: no directory → it says the runtime cannot list", async () => {
    const { app } = await mount([fake("A", [])]);
    await type(app.stdin, "/sessions");
    expect(app.lastFrame() ?? "").toContain("Sessions aren't available on this runtime.");
    app.unmount();
  });

  test("(b) RED: the rows; Enter on another row → detach THEN open, the new one watched and opened, its history on screen", async () => {
    // Mutation: open before detach → the order assertion fails.
    const journal: string[] = [];
    const a = fake("A", journal);
    const b = fake("B", journal);
    const view = {
      sessions: [entry("A", { attached: 1 }), entry("B", { running: false })],
      more: false,
    };
    const { app } = await mount([a], {
      detachOnQuit: true,
      sessions: directory(view, journal, new Map([["B", b]])),
    });
    await type(app.stdin, "first");
    await type(app.stdin, "/sessions");
    let frame = app.lastFrame() ?? "";
    expect(frame).toContain("title A");
    expect(frame).toContain("current");
    expect(frame).toContain("title B");
    journal.length = 0;
    app.stdin.write(DOWN);
    await delay(30);
    app.stdin.write("\r");
    await delay(60);
    expect(journal).toEqual(["A.unwatch", "A.detach", "dir.open:B:false", "B.watch", "B.open"]);
    b.raise({
      kind: "history",
      reason: null,
      messages: [
        { role: "user", content: "b question" },
        { role: "assistant", content: "b answer" },
      ],
    } as SessionActivity);
    await delay(60);
    frame = app.lastFrame() ?? "";
    expect(frame).toContain("b answer");
    expect(frame).not.toContain("A replies to first");
    // The next prompt goes to B.
    await type(app.stdin, "next");
    expect(b.log).toContain("send:next");
    expect(a.log).not.toContain("send:next");
    app.unmount();
  });

  test("(b2) a rejected detach (older daemon) → the notice; A unchanged and still watched; nothing opened", async () => {
    const journal: string[] = [];
    const a = fake("A", journal, {
      detach: () => Promise.reject(rpcError(METHOD_NOT_FOUND, "method not found")),
    });
    const b = fake("B", journal);
    const view = { sessions: [entry("A"), entry("B")], more: false };
    const { app } = await mount([a], {
      detachOnQuit: true,
      sessions: directory(view, journal, new Map([["B", b]])),
    });
    await type(app.stdin, "/sessions");
    app.stdin.write(DOWN);
    await delay(30);
    app.stdin.write("\r");
    await delay(60);
    expect(journal).not.toContain("dir.open:B:false");
    expect(app.lastFrame() ?? "").toContain("This daemon can't switch sessions on one connection");
    expect(a.log.filter((x) => x === "watch")).toHaveLength(2); // re-watched
    await type(app.stdin, "still here");
    expect(a.log).toContain("send:still here");
    app.unmount();
  });

  test("(c) Enter while another device's turn streams → refused, no detach", async () => {
    const journal: string[] = [];
    const a = fake("A", journal);
    const view = { sessions: [entry("A"), entry("B")], more: false };
    const { app } = await mount([a], {
      detachOnQuit: true,
      sessions: directory(view, journal, new Map()),
    });
    let wake: () => void = () => {};
    const events: AsyncIterable<SessionEvent> = {
      async *[Symbol.asyncIterator]() {
        yield { type: "user_message", text: "theirs" } as SessionEvent;
        await new Promise<void>((r) => {
          wake = r;
        });
      },
    };
    a.raise({ kind: "turn", turnId: "F", events, cancel: () => {} } as SessionActivity);
    await delay(40);
    await type(app.stdin, "/sessions");
    app.stdin.write(DOWN);
    await delay(30);
    app.stdin.write("\r");
    await delay(40);
    expect(app.lastFrame() ?? "").toContain("Can't switch while a turn is running");
    expect(a.log).not.toContain("detach");
    wake();
    app.unmount();
  });

  test("x twice deletes a non-current row through the directory, then re-lists", async () => {
    const journal: string[] = [];
    const a = fake("A", journal);
    const view = { sessions: [entry("A"), entry("B")], more: false };
    const { app } = await mount([a], {
      detachOnQuit: true,
      sessions: directory(view, journal, new Map()),
    });
    await type(app.stdin, "/sessions");
    app.stdin.write(DOWN);
    await delay(30);
    app.stdin.write("x");
    await delay(30);
    expect(app.lastFrame() ?? "").toContain("press x again to delete title B");
    expect(journal).not.toContain("dir.remove:B");
    app.stdin.write("x");
    await delay(40);
    expect(journal).toContain("dir.remove:B");
    app.stdin.write(ESC);
    app.unmount();
  });

  test("QN2: switching with rows of mine still on the daemon says so", async () => {
    const journal: string[] = [];
    const a = fake("A", journal, { staying: 2 });
    const b = fake("B", journal);
    const view = { sessions: [entry("A"), entry("B")], more: false };
    const { app } = await mount([a], {
      detachOnQuit: true,
      sessions: directory(view, journal, new Map([["B", b]])),
    });
    await type(app.stdin, "/sessions");
    app.stdin.write(DOWN);
    await delay(30);
    app.stdin.write("\r");
    await delay(60);
    expect(app.lastFrame() ?? "").toContain("2 queued messages stay on the daemon");
    app.unmount();
  });
});

describe("closed elsewhere → a fresh session", () => {
  test("(e) RED: closed{deleted} while idle → the notice, and the next prompt goes to a NEW controller", async () => {
    // Mutation: notice only (no swap) → A gets the prompt.
    const journal: string[] = [];
    const a = fake("A", journal);
    const fresh = fake("N", journal);
    const { app } = await mount([a, fresh], { detachOnQuit: true });
    await type(app.stdin, "before");
    a.raise({ kind: "closed", reason: "deleted" });
    await delay(40);
    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("this session was deleted on another device");
    expect(frame).toContain("what you type next starts a new session");
    expect(frame).toContain("A replies to before"); // the transcript stays as scrollback
    await type(app.stdin, "after");
    expect(fresh.log).toContain("send:after");
    expect(a.log).not.toContain("send:after");
    app.unmount();
  });
});

describe("/close and /clear", () => {
  test("(f) RED: /close ends the session and quits", async () => {
    const journal: string[] = [];
    const a = fake("A", journal);
    const { app, exits } = await mount([a], { detachOnQuit: true });
    await type(app.stdin, "/close");
    await delay(30);
    expect(a.log).toContain("close");
    expect(exits).toEqual(["unmounted"]);
    app.unmount();
  });

  test("(g) QN1: /clear on connect still closes (close + new), never detaches; refused while another device's turn runs", async () => {
    const journal: string[] = [];
    const a = fake("A", journal);
    const n = fake("N", journal);
    const { app } = await mount([a, n], { detachOnQuit: true });
    let wake: () => void = () => {};
    const events: AsyncIterable<SessionEvent> = {
      async *[Symbol.asyncIterator]() {
        yield { type: "user_message", text: "theirs" } as SessionEvent;
        await new Promise<void>((r) => {
          wake = r;
        });
        yield { type: "turn_end", reason: "end_turn" } as SessionEvent;
      },
    };
    a.raise({ kind: "turn", turnId: "F", events, cancel: () => {} } as SessionActivity);
    await delay(40);
    await type(app.stdin, "/clear");
    expect(app.lastFrame() ?? "").toContain("Can't run /clear while a turn is running");
    expect(a.log).not.toContain("close");
    wake();
    await delay(40);
    await type(app.stdin, "/clear");
    expect(a.log).toContain("close");
    expect(a.log).not.toContain("detach");
    await type(app.stdin, "fresh");
    expect(n.log).toContain("send:fresh");
    app.unmount();
  });
});

// Review R1: while a switch's detach is in flight the view is latched — a new
// switch, `/close`, `/clear` and a prompt are refused until it settles.
describe("an in-flight switch is latched (Review R1)", () => {
  /** A whose first detach waits on `release()` (like RemoteSession, a second call returns at once). */
  function gatedA(journal: string[]) {
    let release = (): void => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    const a = fake("A", journal, {
      detach: () => {
        calls += 1;
        return calls === 1 ? gate : Promise.resolve();
      },
    });
    return { a, release };
  }
  async function startSwitch(extraFakes: Map<string, Fake>, journal: string[], a: Fake) {
    const view = { sessions: [entry("A"), entry("B"), entry("C")], more: false };
    const mounted = await mount([a, fake("N", journal)], {
      detachOnQuit: true,
      sessions: directory(view, journal, extraFakes),
    });
    await type(mounted.app.stdin, "/sessions");
    mounted.app.stdin.write(DOWN);
    await delay(30);
    mounted.app.stdin.write("\r"); // choose B: A's detach is in flight
    await delay(40);
    return mounted;
  }

  test("RED: a second switch while the first detach is in flight is refused; only B is opened and followed", async () => {
    // Mutation: drop the latch check in the switch decision → C is opened too (and B leaks).
    const journal: string[] = [];
    const { a, release } = gatedA(journal);
    const b = fake("B", journal);
    const c = fake("C", journal);
    const { app } = await startSwitch(
      new Map([
        ["B", b],
        ["C", c],
      ]),
      journal,
      a,
    );
    await type(app.stdin, "/sessions");
    app.stdin.write(DOWN);
    await delay(30);
    app.stdin.write(DOWN);
    await delay(30);
    app.stdin.write("\r"); // choose C mid-switch
    await delay(40);
    expect(app.lastFrame() ?? "").toContain("A session switch is in progress");
    app.stdin.write(ESC); // the refusal leaves the panel open (like the busy refusal)
    await delay(30);
    release();
    await delay(60);
    expect(journal.filter((x) => x.startsWith("dir.open"))).toEqual(["dir.open:B:false"]);
    expect(a.log.filter((x) => x === "detach")).toHaveLength(1);
    // B is the one followed: the next prompt goes to it; C was never touched.
    await type(app.stdin, "hello");
    expect(b.log).toContain("send:hello");
    expect(b.log).not.toContain("detach");
    expect(c.log).toEqual([]);
    app.unmount();
  });

  test("RED: /close during the switch is refused (nothing closed, no exit); allowed once it settled", async () => {
    // Mutation: drop the latch check for commands → A.close while it is already detaching.
    const journal: string[] = [];
    const { a, release } = gatedA(journal);
    const b = fake("B", journal);
    const { app, exits } = await startSwitch(new Map([["B", b]]), journal, a);
    await type(app.stdin, "/close");
    expect(app.lastFrame() ?? "").toContain("A session switch is in progress");
    expect(a.log).not.toContain("close");
    expect(exits).toEqual([]);
    release();
    await delay(60);
    await type(app.stdin, "/close");
    expect(b.log).toContain("close");
    expect(exits).toEqual(["unmounted"]);
    app.unmount();
  });

  test("RED: /clear during the switch is refused; a prompt typed then comes back to the input, never sent to A", async () => {
    const journal: string[] = [];
    const { a, release } = gatedA(journal);
    const b = fake("B", journal);
    const { app } = await startSwitch(new Map([["B", b]]), journal, a);
    await type(app.stdin, "/clear");
    expect(app.lastFrame() ?? "").toContain("A session switch is in progress");
    expect(a.log).not.toContain("close");
    await type(app.stdin, "typed meanwhile");
    expect(a.log).not.toContain("send:typed meanwhile");
    expect(app.lastFrame() ?? "").toContain("typed meanwhile"); // back in the input
    release();
    await delay(60);
    expect(journal.filter((x) => x.startsWith("dir.open"))).toEqual(["dir.open:B:false"]);
    app.unmount();
  });

  test("a refused detach clears the latch (the next switch is not refused as in progress)", async () => {
    const journal: string[] = [];
    let first = true;
    const a = fake("A", journal, {
      detach: () => {
        if (first) {
          first = false;
          return Promise.reject(rpcError(METHOD_NOT_FOUND, "method not found"));
        }
        return Promise.resolve();
      },
    });
    const b = fake("B", journal);
    const { app } = await startSwitch(new Map([["B", b]]), journal, a);
    await delay(30);
    expect(app.lastFrame() ?? "").toContain("This daemon can't switch sessions");
    await type(app.stdin, "/sessions");
    app.stdin.write(DOWN);
    await delay(30);
    app.stdin.write("\r");
    await delay(60);
    expect(app.lastFrame() ?? "").not.toContain("A session switch is in progress");
    expect(journal).toContain("dir.open:B:false");
    app.unmount();
  });

  test("RED (R2-1): /sessions is refused mid-switch; after it, the panel's current is the NEW session (x on it refused)", async () => {
    // Mutation: drop "/sessions" from the switch-guarded commands → the panel opens mid-switch.
    const journal: string[] = [];
    const { a, release } = gatedA(journal);
    const b = fake("B", journal);
    const { app } = await startSwitch(new Map([["B", b]]), journal, a);
    await type(app.stdin, "/sessions");
    expect(app.lastFrame() ?? "").toContain("A session switch is in progress");
    expect(app.lastFrame() ?? "").not.toContain("Sessions (3)");
    release();
    await delay(60);
    await type(app.stdin, "/sessions");
    app.stdin.write(DOWN); // the B row: the session being viewed
    await delay(30);
    app.stdin.write("x");
    await delay(30);
    app.stdin.write("x");
    await delay(40);
    expect(journal).not.toContain("dir.remove:B");
    expect(app.lastFrame() ?? "").toContain("This is the session you are in");
    app.unmount();
  });

  test("RED (R2-1): the open panel follows the live session — a swap (closed elsewhere) moves `current`", async () => {
    // Mutation: drop the panel sync in `swapSession` → A stays "current", its x is refused.
    const journal: string[] = [];
    const a = fake("A", journal);
    const view = { sessions: [entry("A"), entry("B")], more: false };
    const { app } = await mount([a, fake("N", journal)], {
      detachOnQuit: true,
      sessions: directory(view, journal, new Map()),
    });
    await type(app.stdin, "/sessions");
    a.raise({ kind: "closed", reason: "closed" });
    await delay(40);
    app.stdin.write("x"); // cursor on A, no longer the session being viewed
    await delay(30);
    expect(app.lastFrame() ?? "").toContain("press x again to delete title A");
    expect(app.lastFrame() ?? "").not.toContain("This is the session you are in");
    app.unmount();
  });

  test("R2-4: a directory whose open throws clears the latch (notice + fresh session)", async () => {
    // Mutation: drop the latch release in the throw branch → /close stays refused.
    const journal: string[] = [];
    const a = fake("A", journal);
    const { app, exits } = await startSwitch(new Map(), journal, a); // no fake for B: open throws
    await delay(40);
    expect(app.lastFrame() ?? "").toContain("could not open the session: no fake for B");
    await type(app.stdin, "/close");
    expect(app.lastFrame() ?? "").not.toContain("A session switch is in progress");
    expect(exits).toEqual(["unmounted"]);
    app.unmount();
  });

  test("a target that fails to open clears the latch too (a fresh session takes the view)", async () => {
    const journal: string[] = [];
    const a = fake("A", journal);
    const b = fake("B", journal);
    b.ctrl.open = () => Promise.reject(new Error("gone"));
    const { app } = await startSwitch(new Map([["B", b]]), journal, a);
    await delay(40);
    expect(app.lastFrame() ?? "").toContain("could not open the session: gone");
    await type(app.stdin, "/close");
    expect(app.lastFrame() ?? "").not.toContain("A session switch is in progress");
    app.unmount();
  });
});

// Review round 3 (R3-1): "current" has ONE source — the live session id, read
// when it is used — and a delete's refresh never re-opens a closed panel.
describe("/sessions current is always the live session (Review R3-1)", () => {
  function gate() {
    let release = (): void => {};
    const p = new Promise<void>((r) => {
      release = r;
    });
    return { p, release };
  }

  test("RED (B1): the session closed elsewhere while the list loads — the loaded panel's x x never deletes the live one", async () => {
    // Mutation: the loader captures `current` when it opens → N's delete goes through.
    const journal: string[] = [];
    const a = fake("A", journal);
    const n = fake("N", journal);
    const listGate = gate();
    const dir: SessionDirectory = {
      list: async () => {
        await listGate.p;
        return { sessions: [entry("A"), entry("N")], more: false };
      },
      open: () => {
        throw new Error("unused");
      },
      remove: (id) => {
        journal.push(`dir.remove:${id}`);
        return Promise.resolve();
      },
    };
    const { app } = await mount([a, n], { detachOnQuit: true, sessions: dir });
    await type(app.stdin, "/sessions"); // the list is in flight
    a.raise({ kind: "closed", reason: "closed" }); // the view swaps to N
    await delay(40);
    listGate.release();
    await delay(40);
    app.stdin.write(DOWN); // the N row: the session being viewed
    await delay(30);
    app.stdin.write("x");
    await delay(30);
    app.stdin.write("x");
    await delay(40);
    expect(journal).not.toContain("dir.remove:N");
    expect(app.lastFrame() ?? "").toContain("This is the session you are in");
    app.unmount();
  });

  test("RED (B3): a delete's refresh never re-opens a panel the switch closed; x x cannot delete the live session", async () => {
    // Mutation: the refresh re-opens the panel unconditionally → the panel is back after the switch.
    const journal: string[] = [];
    const a = fake("A", journal);
    const b = fake("B", journal);
    const removeGate = gate();
    const dir: SessionDirectory = {
      list: () => Promise.resolve({ sessions: [entry("A"), entry("B"), entry("C")], more: false }),
      open: (id) => {
        journal.push(`dir.open:${id}`);
        return b.ctrl;
      },
      remove: async (id) => {
        journal.push(`dir.remove:${id}`);
        if (id === "C") await removeGate.p;
      },
    };
    const { app } = await mount([a], { detachOnQuit: true, sessions: dir });
    await type(app.stdin, "/sessions");
    app.stdin.write(DOWN);
    await delay(20);
    app.stdin.write(DOWN); // C
    await delay(30);
    app.stdin.write("x");
    await delay(30);
    app.stdin.write("x"); // C's delete in flight
    await delay(30);
    app.stdin.write("\x1b[A"); // B
    await delay(30);
    app.stdin.write("\r"); // switch A → B: the panel closes
    await delay(60);
    removeGate.release();
    await delay(60);
    expect(app.lastFrame() ?? "").not.toContain("Sessions (");
    // Keys now go to the input, never to a panel: nothing else is deleted.
    app.stdin.write("x");
    await delay(20);
    app.stdin.write("x");
    await delay(40);
    expect(journal.filter((x) => x.startsWith("dir.remove"))).toEqual(["dir.remove:C"]);
    app.unmount();
  });

  test("R4-1: a delete's re-list that fails after the panel closed leaves no notice", async () => {
    // Mutation: drop the `applies()` guard on the re-list error → the notice lands in the feed.
    const journal: string[] = [];
    const a = fake("A", journal);
    const listGate = gate();
    let calls = 0;
    const dir: SessionDirectory = {
      list: async () => {
        calls += 1;
        if (calls > 1) {
          await listGate.p;
          throw new Error("link down");
        }
        return { sessions: [entry("A"), entry("B")], more: false };
      },
      open: () => {
        throw new Error("unused");
      },
      remove: (id) => {
        journal.push(`dir.remove:${id}`);
        return Promise.resolve();
      },
    };
    const { app } = await mount([a], { detachOnQuit: true, sessions: dir });
    await type(app.stdin, "/sessions");
    app.stdin.write(DOWN); // B
    await delay(30);
    app.stdin.write("x");
    await delay(30);
    app.stdin.write("x"); // B deleted; its re-list hangs
    await delay(40);
    app.stdin.write(ESC); // the panel closes
    await delay(40);
    listGate.release();
    await delay(60);
    expect(journal).toContain("dir.remove:B");
    expect(app.lastFrame() ?? "").not.toContain("Couldn't list sessions");
    app.unmount();
  });

  test("a delete's refresh updates a panel that is still open (rows reloaded, delete disarmed)", async () => {
    const journal: string[] = [];
    const a = fake("A", journal);
    let rows = [entry("A"), entry("B"), entry("C")];
    const dir: SessionDirectory = {
      list: () => Promise.resolve({ sessions: rows, more: false }),
      open: () => {
        throw new Error("unused");
      },
      remove: (id) => {
        journal.push(`dir.remove:${id}`);
        rows = rows.filter((r) => r.id !== id);
        return Promise.resolve();
      },
    };
    const { app } = await mount([a], { detachOnQuit: true, sessions: dir });
    await type(app.stdin, "/sessions");
    app.stdin.write(DOWN);
    await delay(20);
    app.stdin.write(DOWN); // C
    await delay(30);
    app.stdin.write("x");
    await delay(30);
    app.stdin.write("x");
    await delay(60);
    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("Sessions (2)");
    expect(frame).not.toContain("title C");
    app.stdin.write(ESC);
    app.unmount();
  });
});
