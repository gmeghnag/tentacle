/**
 * The key router at the App SEAM (docs/feat/app-decomposition.md S3).
 *
 * S0/S0b already pin the precedence matrix, the frames and the freshness rows;
 * they stay green and UNEDITED and remain the behaviour-preservation proof. What
 * is new here is the ROUTER's own two risks, asked through the real components:
 *
 * 1. **Freshness through the snapshot's getters.** Two keys delivered with no
 *    render between must behave as they did inline: `/quit`'s dialog raised and
 *    answered in one tick. If the router read a render VALUE instead of the live
 *    ref, the second key would see `null` and the first key's dialog would never
 *    be answered — silently.
 * 2. **A passing layer's effects land before the layers below decide.** The
 *    chord is the act-and-pass site: arming it and then typing must leave the
 *    typed key intact (the state write did not swallow it).
 */
import { describe, expect, test } from "bun:test";
import { PermissionBroker } from "@tentacle/core";
import { render } from "ink-testing-library";
import { App, type AppProps, type SessionController } from "../src/App.tsx";
import type { DockJobRow } from "../src/background-list.ts";
import { BACKGROUND_ROW, type DockTestRow } from "./subagent-row.ts";

const ENTER = "\r";
const CTRL_C = "\x03";
const CTRL_X = "\x18";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fake(opts: { agents?: readonly DockTestRow[]; jobs?: readonly DockJobRow[] } = {}): {
  session: SessionController;
  prompts: string[];
} {
  const prompts: string[] = [];
  const session = {
    async *send(prompt: string) {
      prompts.push(prompt);
      yield { type: "text", delta: `reply to ${prompt}` };
      yield { type: "turn_end", reason: "end_turn" };
    },
    enqueue: () => Promise.resolve(),
    onSubagents(listener: (rows: readonly DockTestRow[]) => void) {
      listener(opts.agents ?? []);
      return () => {};
    },
    onJobs(listener: (r: { rows: readonly DockJobRow[]; count: number }) => void) {
      const rows = opts.jobs ?? [];
      listener({ rows, count: rows.length });
      return () => {};
    },
    killJob: () => Promise.resolve({ killed: true }),
    killSubagent: () => Promise.resolve({ killed: true }),
    ownsTurn: () => true,
    cancel: () => Promise.resolve(),
  } as unknown as SessionController;
  return { session, prompts };
}

async function mount(f: { session: SessionController }, extra: Partial<AppProps> = {}) {
  const permissions = new PermissionBroker();
  const app = render(
    <App
      createSession={() => f.session}
      permissions={permissions}
      model="m"
      cwd="/tmp/work"
      {...extra}
    />,
  );
  await delay(40);
  /** Write keys with NO settle between them: React cannot commit in between. */
  const keysInOneTick = async (...chunks: string[]) => {
    for (const c of chunks) {
      app.stdin.write(c);
    }
    await delay(80);
  };
  const keys = async (...chunks: string[]) => {
    for (const c of chunks) {
      app.stdin.write(c);
      await delay(25);
    }
    await delay(40);
  };
  const frame = () => app.lastFrame() ?? "";
  return { app, keys, keysInOneTick, frame, permissions };
}

describe("the snapshot reads the live refs (freshness through the router)", () => {
  test("Ctrl+C twice in ONE tick: the dialog it just raised is seen and dismissed (`quitConfirmRef` is live)", async () => {
    // The child makes the first Ctrl+C ASCII `confirm` (`ctrlCQuitStep`). With NO
    // render between the two keys, the second can only answer the dialog if the
    // router read `quitConfirmRef` live. A snapshot carrying a render VALUE would
    // see `null` and the dialog would be stuck on screen forever.
    const f = fake({ agents: [BACKGROUND_ROW.sa1] });
    const t = await mount(f);
    await t.keysInOneTick(CTRL_C, CTRL_C);
    expect(t.frame()).not.toContain("(y/N)");
    // Dismissed as "No": nothing closed, so the TUI is still there.
    expect(t.frame()).toContain("Tentacle ready");
    // And it still asks once a render has happened — never a trap, and proof the
    // first dialog really was up.
    await t.keys(CTRL_C);
    expect(t.frame()).toContain("(y/N)");
    t.app.unmount();
  });

  test("with a render between the keys the same pair behaves identically", async () => {
    const f = fake({ agents: [BACKGROUND_ROW.sa1] });
    const t = await mount(f);
    await t.keys(CTRL_C);
    expect(t.frame()).toContain("(y/N)");
    await t.keys(CTRL_C);
    expect(t.frame()).not.toContain("(y/N)");
    expect(t.frame()).toContain("Tentacle ready");
    t.app.unmount();
  });
});

describe("a passing layer's effects do not swallow the key", () => {
  test("ctrl+x arms the chord and the next typed key is still typed", async () => {
    // The chord layer ACTS (writes its state) and PASSES: the following letter
    // must reach the input. A `consumed` verdict here would swallow it.
    const f = fake();
    const t = await mount(f);
    await t.keys(CTRL_X);
    await t.keys("a");
    expect(t.frame()).toContain("a");
    t.app.unmount();
  });

  test("after the chord was armed, a typed key still submits normally", async () => {
    const f = fake();
    const t = await mount(f);
    await t.keys(CTRL_X);
    await t.keys("hello");
    await t.keys(ENTER);
    expect(f.prompts).toEqual(["hello"]);
    t.app.unmount();
  });
});

describe("line editing is untouched by the router", () => {
  test("Enter with text submits it (nothing claimed the key)", async () => {
    const f = fake();
    const t = await mount(f);
    await t.keys("hi there");
    await t.keys(ENTER);
    expect(f.prompts).toEqual(["hi there"]);
    t.app.unmount();
  });
});
