/**
 * docs/feat/app-decomposition.md S9a — the TURN DRIVER executes through
 * `useTurnDriver`.
 *
 * These are the App-seam cases: the hook is exercised through the REAL `App`
 * (ink-testing-library), so what is pinned is the behaviour the move could have
 * broken — never the hook's internals. Each case names the mutation that turns
 * it red (the slice's mutation table), and each is one of the plan's failure
 * modes for this slice:
 *
 * 1. **Freshness (H3) — a ref read must stay a ref read.** The send-now decides
 *    on `rowsRef`/`sendNowRef`/`streamCtrlRef`/`compactingRef` read at the moment
 *    of the chord, and `streamTurn`'s settle reads `exitPendingRef`,
 *    `clearAfterTurnRef`, `sendNowRef` at the moment the turn ends. Wired to a
 *    render value instead, the outcome changes.
 * 2. **The settle is the ONE place a turn's fate is decided** (`streamTurn`'s
 *    `finally`): a held activity is drained there, a mid-turn quit exits there, a
 *    stopped `/clear` runs there.
 * 3. **`runRef`/`streamTurnRef` keep their late binding** (the plan's "cycle
 *    breakage"): the initial prompt is fired by `App`'s mount effect through
 *    `runRef`, and a send-now's successor starts through `streamTurnRef` from
 *    inside `settleSendNow`.
 * 4. **`/compact` is still ONE executor** (plan M5): its latch, its one settle,
 *    and the compaction-time queue it ends.
 */
import { describe, expect, test } from "bun:test";
import { PermissionBroker } from "@tentacle/core";
import { render } from "ink-testing-library";
import { App, type SessionController } from "../src/App.tsx";
import type { SessionEvent } from "../src/state.ts";
import type { SessionActivity } from "../src/turn-feed.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const strip = (s: string | undefined) =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: SGR stripping
  (s ?? "").replace(/\x1b\[[0-9;]*m/g, "");
const ENTER = "\r";
const CTRL_X = "\x18";
const CTRL_S = "\x13";
const ESC = "\x1b";

/**
 * A session whose prompt "hold" keeps its turn open until it is aborted or the
 * test releases it, and whose `sendNow` hands back a successor turn. `watch`
 * gives the test the activity listener, exactly as `RemoteSession` calls it.
 */
function rig(opts: { compactHangs?: boolean } = {}) {
  const log = {
    sends: [] as string[],
    enqueues: [] as string[],
    sendNows: [] as string[][],
    compacted: 0,
  };
  let listener: ((a: SessionActivity) => void) | null = null;
  let release: () => void = () => {};
  const ctrl = {
    async *send(prompt: string, signal?: AbortSignal) {
      log.sends.push(prompt);
      if (prompt === "hold") {
        yield { type: "text", delta: "working" };
        await new Promise<void>((resolve) => {
          release = resolve;
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        yield { type: "turn_end", reason: "cancelled" };
        return;
      }
      yield { type: "text", delta: `reply to ${prompt}` };
      yield { type: "turn_end", reason: "end_turn" };
    },
    enqueue(text: string) {
      log.enqueues.push(text);
      return Promise.resolve();
    },
    async sendNow(messages: readonly { readonly text: string }[]) {
      log.sendNows.push(messages.map((m) => m.text));
      return (async function* (): AsyncGenerator<SessionEvent> {
        yield { type: "text", delta: "successor ran" };
        yield { type: "turn_end", reason: "end_turn" };
      })();
    },
    compact() {
      log.compacted += 1;
      if (opts.compactHangs === true) {
        return new Promise(() => {});
      }
      return Promise.resolve({ before: 8, after: 2 });
    },
    watch(l: (a: SessionActivity) => void) {
      listener = l;
      return () => {
        listener = null;
      };
    },
    ownsTurn: () => true,
  };
  const app = render(
    <App
      createSession={() => ctrl as unknown as SessionController}
      model="m"
      cwd="/tmp/work"
      permissions={new PermissionBroker()}
    />,
  );
  return { app, log, release: () => release(), raise: (a: SessionActivity) => listener?.(a) };
}

async function type(stdin: { write(d: string): void }, text: string, settle = 60) {
  stdin.write(text);
  await delay(20);
  stdin.write(ENTER);
  await delay(settle);
}

async function chord(stdin: { write(d: string): void }) {
  stdin.write(CTRL_X);
  await delay(20);
  stdin.write(CTRL_S);
  await delay(80);
}

describe("S9a: a turn streams, and the settle is the one place its fate is decided", () => {
  test("a prompt streams to its end and the running line goes (the ONE streamTurn loop)", async () => {
    // Mutation: the settle's `setRows(onTurnEnd)` dropped → the frame stays
    // "Working…" after the turn's own `turn_end`.
    const r = rig();
    await delay(40);
    await type(r.app.stdin, "hello");
    expect(r.log.sends).toEqual(["hello"]);
    expect(strip(r.app.lastFrame())).toContain("reply to hello");
    expect(strip(r.app.lastFrame())).not.toContain("Working…");
    r.app.unmount();
  });

  test("a mid-turn /exit is carried out by the SETTLE, never by the command itself", async () => {
    // Mutation: `exitPendingRef` read as a render VALUE in the settle → the TUI
    // stays up after the turn it stopped has settled (the quit is lost).
    let gone = false;
    const r = rig();
    r.app.unmount();
    const ctrl = {
      async *send(_prompt: string, signal?: AbortSignal) {
        yield { type: "text", delta: "working" };
        await new Promise<void>((resolve) =>
          signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
        yield { type: "turn_end", reason: "cancelled" };
      },
      ownsTurn: () => true,
    } as unknown as SessionController;
    const app = render(
      <App
        createSession={() => ctrl}
        model="m"
        cwd="/tmp/work"
        notices={{
          onNotice: () => () => {
            gone = true;
          },
        }}
        permissions={new PermissionBroker()}
      />,
    );
    await delay(40);
    await type(app.stdin, "hold", 80);
    expect(strip(app.lastFrame())).toContain("Working…");
    await type(app.stdin, "/exit");
    // Stop first, exit from the settle: the tree unmounted (the notices feed's
    // cleanup is the only in-harness proof that the TUI really left).
    await delay(150);
    expect(gone).toBe(true);
    expect(strip(app.lastFrame())).not.toContain("Working…");
    app.unmount();
  });

  test("Esc stops the running turn through the LIVE controller ref", async () => {
    // Mutation: `abortRef` wired as a render value in `run` → Esc aborts
    // nothing and the turn stays "Working…".
    const r = rig();
    await delay(40);
    await type(r.app.stdin, "hold", 80);
    expect(strip(r.app.lastFrame())).toContain("Working…");
    r.app.stdin.write(ESC);
    await delay(150);
    expect(strip(r.app.lastFrame())).not.toContain("Working…");
    r.app.unmount();
  });
});

describe("S9a: the send-now decides on LIVE refs (freshness, H3)", () => {
  test("the chord names exactly the rows queued at that moment", async () => {
    // Mutation: `rowsRef` wired as a render value in `sendNow` → the chord reads
    // the previous frame's rows and takes the `none` plan.
    const r = rig();
    await delay(40);
    await type(r.app.stdin, "hold", 80);
    await type(r.app.stdin, "steer me", 40);
    expect(r.log.enqueues).toEqual(["steer me"]);
    await chord(r.app.stdin);
    expect(r.log.sendNows).toEqual([["steer me"]]);
    r.app.unmount();
  });

  test("the successor turn streams through streamTurnRef once the old turn ends", async () => {
    // Mutation: the successor started through a VALUE `streamTurn` (declared
    // later, so undefined at that point) → its events never reach the frame.
    const r = rig();
    await delay(40);
    await type(r.app.stdin, "hold", 80);
    await type(r.app.stdin, "steer me", 40);
    await chord(r.app.stdin);
    expect(r.log.sendNows).toEqual([["steer me"]]);
    // The old turn ends: its settle takes the successor's events.
    r.release();
    await delay(200);
    expect(strip(r.app.lastFrame())).toContain("successor ran");
    r.app.unmount();
  });
});

describe("S9a: `run` and its late-bound callers", () => {
  test("the initial prompt goes through runRef (App's mount effect, the driver's run)", async () => {
    // Mutation: `run` not installed into `runRef` → an `initialPrompt` never sends.
    const sends: string[] = [];
    const ctrl = {
      async *send(prompt: string) {
        sends.push(prompt);
        yield { type: "text", delta: "hi" };
        yield { type: "turn_end", reason: "end_turn" };
      },
    } as unknown as SessionController;
    const app = render(
      <App
        createSession={() => ctrl}
        model="m"
        cwd="/tmp/work"
        initialPrompt="first message"
        permissions={new PermissionBroker()}
      />,
    );
    await delay(150);
    expect(sends).toEqual(["first message"]);
    app.unmount();
  });

  test("a held activity is drained from the settle (C2)", async () => {
    // Mutation: `drainHeld` dropped from the settle → the held history is never
    // applied and its transcript never reaches the frame.
    const r = rig();
    await delay(40);
    await type(r.app.stdin, "hold", 80);
    expect(strip(r.app.lastFrame())).toContain("Working…");
    // Another device's history lands while mine streams: it is HELD, not applied.
    r.raise({
      kind: "history",
      reason: null,
      messages: [{ role: "user", content: "from the other device" }],
    } as unknown as SessionActivity);
    await delay(60);
    expect(strip(r.app.lastFrame())).not.toContain("from the other device");
    r.release();
    await delay(250);
    // The settle drained it: the other device's message is on screen now.
    expect(strip(r.app.lastFrame())).toContain("from the other device");
    r.app.unmount();
  });
});

describe("S9a: /compact is still one executor (plan M5)", () => {
  test("/compact asks the session once, starts no turn, and releases its latch", async () => {
    // Mutation: `startCompaction`'s settle dropping `setCompacting(false)` → the
    // latch stays up and the next prompt is queued instead of sent (the TUI
    // deadlocks on a compaction that already ended).
    const r = rig();
    await delay(40);
    await type(r.app.stdin, "/compact", 250);
    expect(r.log.compacted).toBe(1);
    expect(r.log.sends).toEqual([]); // the compaction itself starts no turn
    // Its settle lowered the latch: a prompt now runs as a real turn.
    await type(r.app.stdin, "after it", 150);
    expect(r.log.sends).toEqual(["after it"]);
    r.app.unmount();
  });

  test("a prompt during the compaction is queued for its end, never sent as a turn", async () => {
    // Mutation: `compactingRef` read as a render value in `submit` → the prompt
    // starts a turn the daemon would refuse (and loses its rows).
    const r = rig({ compactHangs: true });
    await delay(40);
    await type(r.app.stdin, "/compact", 120);
    expect(r.log.compacted).toBe(1);
    await type(r.app.stdin, "queued prompt", 120);
    // QUEUED (a local row above the input), not refused and not sent: the row
    // is the promise that the text survives until the compaction ends.
    expect(r.log.sends).toEqual([]);
    expect(strip(r.app.lastFrame())).toContain("queued prompt");
    expect(strip(r.app.lastFrame())).not.toContain("Can't start a turn");
    // A second /compact is refused while the first holds the session.
    await type(r.app.stdin, "/compact", 120);
    expect(r.log.compacted).toBe(1);
    r.app.unmount();
  });
});
