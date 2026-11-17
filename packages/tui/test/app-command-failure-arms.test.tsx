/**
 * docs/feat/app-decomposition.md S2 — the command paths that live in
 * `commands/<name>.ts` and that no existing test reached: the FAILURE arms.
 * `app-commands.test.tsx` (S0) pins every command's happy path and the guards;
 * these are the rejects, which §9 says are where a bug hides. They render the
 * real `App`, so they also prove the registry's executor is really wired to it
 * (a command file that nobody calls would pass every pure test and fail here).
 */
import { describe, expect, test } from "bun:test";
import { PermissionBroker } from "@tentacle/core";
import { render } from "ink-testing-library";
import { App, type AppProps, type SessionController } from "../src/App.tsx";
import { inertSession } from "./session-stub.ts";

const ENTER = "\r";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fake(extra: Partial<SessionController> = {}) {
  const prompts: string[] = [];
  const session = {
    ...inertSession(),
    async *send(prompt: string) {
      prompts.push(prompt);
      yield { type: "text", delta: `reply to ${prompt}` };
      yield { type: "turn_end", reason: "end_turn" };
    },
    onSubagents(listener: (rows: readonly never[]) => void) {
      listener([]);
      return () => {};
    },
    close() {},
    ownsTurn: () => true,
    ...extra,
  } as unknown as SessionController;
  return { session, prompts };
}

async function mount(props: Partial<AppProps> = {}, extra: Partial<SessionController> = {}) {
  const f = fake(extra);
  const app = render(
    <App
      createSession={() => f.session}
      permissions={new PermissionBroker()}
      model="m"
      cwd="/tmp/work"
      {...props}
    />,
  );
  await delay(40);
  const line = async (text: string, settle = 60) => {
    app.stdin.write(text);
    await delay(20);
    app.stdin.write(ENTER);
    await delay(settle);
  };
  return { app, line, frame: () => app.lastFrame() ?? "", prompts: f.prompts };
}

describe("S2 command failure arms (commands/<name>.ts)", () => {
  test("/save's write failing says so instead of claiming success", async () => {
    // Mutation: drop the reject callback in `commands/save.ts` → red here (no
    // notice at all: a silent failure, the §7 "a drop is a bug" case).
    const t = await mount({ saveFile: () => Promise.reject(new Error("disk full")) });
    await t.line("/save");
    expect(t.frame()).toContain("Save failed: Error: disk full");
    expect(t.frame()).not.toContain("Saved transcript");
    t.app.unmount();
  });

  test("/retry of a skill the daemon no longer offers says it is gone", async () => {
    // The last prompt was a skill activation (seeded: this runtime offers no
    // skills, so nothing can be activated live), and `retryPlan` answers `gone`
    // (commands/retry.ts). Mutation: drop the notice, or send `plan.command`
    // (a bare `/deploy-app`, which would leave as a prompt) → red here.
    const t = await mount({ initialItems: [{ kind: "user", text: "/deploy-app the app" }] });
    await t.line("/retry");
    expect(t.frame()).toContain("Can't retry: /deploy-app is no longer available.");
    expect(t.prompts).toEqual([]);
    t.app.unmount();
  });

  test("/compact twice: the second says one is already running", async () => {
    // `busyCompacting()` on the context is App's `compactingRef` (the latch the
    // first `/compact` raised). Mutation: `busyCompacting: () => false` in App's
    // context → red here (a second compaction under the first one).
    let calls = 0;
    const u = await mount(
      {},
      {
        // Held: the latch stays up for the rest of the test.
        compact: () => {
          calls += 1;
          return new Promise<{ before: number; after: number }>(() => {});
        },
      },
    );
    await u.line("/compact");
    // S3: the start is the SLOT's line (one row, framed), not a transcript push.
    expect(u.frame()).toContain("Compacting…");
    expect(u.frame()).not.toContain("Compacting the conversation");
    await u.line("/compact");
    expect(u.frame()).toContain("A compaction is already running.");
    expect(calls).toBe(1);
    u.app.unmount();
  });

  test("/compact says it is compacting exactly once, not twice", async () => {
    // The review's MEDIUM 1: the move left the same notice in BOTH halves of
    // the guard/machinery split — `commands/compact.ts` pushed it and then
    // `startCompaction()` pushed it again (it was copied out of the old `case`
    // body together with the machinery), so the line appeared twice where main
    // shows it once. `toContain` cannot see a doubled line, so this counts it.
    // S3 moved the announcement out of the transcript entirely (it is the
    // slot's `Compacting…` row now, docs/feat/harness-notices.md S3): the
    // count is still 1 — a stale `pushNoticeItem` in either half would make the
    // transcript carry a second, non-slot line — and the transcript must carry
    // no compaction line at all. Mutations: put a `pushNoticeItem("_…Compacting…")`
    // back in `commands/compact.ts` or `startCompaction` → the
    // `not.toContain("Compacting the conversation")` arm goes red; drop the
    // slot's fallback → the count goes to 0 (red).
    const u = await mount(
      {},
      { compact: () => new Promise<{ before: number; after: number }>(() => {}) },
    );
    await u.line("/compact");
    const frame = u.frame();
    expect(frame.split("Compacting…").length - 1).toBe(1);
    expect(frame).not.toContain("Compacting the conversation");
    u.app.unmount();
  });

  test("/copy failing because the clipboard is missing is said out loud", async () => {
    // The reject arm of `commands/copy.ts` (the success arm is S0's).
    const t = await mount({ clipboard: () => Promise.reject(new Error("nope")) });
    await t.line("hello");
    await t.line("/copy");
    expect(t.frame()).toContain("Clipboard unavailable.");
    t.app.unmount();
  });
});
