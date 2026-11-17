/**
 * docs/feat/harness-notices.md S3 — the compaction lives in the SPINNER SLOT,
 * and the transcript gets a separator rule instead of two lines of its own.
 *
 * These are App-seam frames (ink-testing-library, the `app.test.tsx` rig): the
 * decision itself is pinned purely in `spinner-slot.test.ts` and
 * `compaction-separator.test.ts`; what is pinned HERE is what the person sees,
 * and the one property a second slot rule would break — the frame's HEIGHT.
 *
 * Red before the code (the honest evidence, `s3-check.ts` on the pre-S3 tree):
 * a running compaction projected to the transcript rows
 * `["◇ Compacting the conversation…", "  Context compacted — 97 → 2 messages."]`
 * and `app-layout` reserved the slot row from a SECOND rule
 * (`st.running || loading ? 1 : 0`), so a compaction had no slot row at all.
 * Each case below also names the mutation that reddens it (the slice's table).
 */
import { describe, expect, jest, test } from "bun:test";
import { PermissionBroker } from "@tentacle/core";
import { render } from "ink-testing-library";
import { App, type SessionController } from "../src/App.tsx";
import { inertSession } from "./session-stub.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ENTER = "\r";
/** Bun's fake timers, declared here (the pinned `bun-types` predates them) — the `app.test.tsx` shape. */
const clock = jest as unknown as {
  useFakeTimers(): void;
  useRealTimers(): void;
  advanceTimersByTime(ms: number): void;
};

/** The sizes the daemon measures (S1): 182k in, 9k out, counted by the provider. */
const SIZES = { before: 97, after: 2, fromTokens: 182_000, toTokens: 9_000, toExact: true };

/**
 * A session whose `/compact` settles only when the test says so, whose `hold`
 * prompt reasons and then stays open (so the slot is `Thinking…`), and whose
 * `watch` hands back the activity listener.
 */
function rig() {
  const log = { sends: [] as string[], compacted: 0 };
  let settleCompaction: () => void = () => {};
  let releaseTurn: () => void = () => {};
  const ctrl = {
    ...inertSession(),
    async *send(prompt: string) {
      log.sends.push(prompt);
      yield { type: "reasoning" as const, delta: "hmm" };
      await new Promise<void>((resolve) => {
        releaseTurn = resolve;
      });
      yield { type: "turn_end" as const, reason: "end_turn" as const };
    },
    compact() {
      log.compacted += 1;
      return new Promise<typeof SIZES>((resolve) => {
        settleCompaction = () => resolve(SIZES);
      });
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
  return { app, log, settle: () => settleCompaction(), release: () => releaseTurn() };
}

const strip = (s: string | undefined) =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: SGR stripping
  (s ?? "").replace(/\x1b\[[0-9;]*m/g, "");

describe("S3 — /compact in the slot, a separator in the transcript", () => {
  test("while it runs: the slot says Compacting…, the transcript says nothing", async () => {
    // Mutations (red): push `_Compacting the conversation…_` in `startCompaction`
    // again → the transcript assertion fails; leave the slot to `st.running` →
    // there is no `Compacting…` row at all.
    const r = rig();
    await delay(30);
    expect(r.app.lastFrame() ?? "").not.toContain("Compacting");
    r.app.stdin.write("/compact");
    await delay(20);
    r.app.stdin.write(ENTER);
    await delay(80);
    expect(r.log.compacted).toBe(1);
    const frame = strip(r.app.lastFrame());
    expect(frame).toContain("Compacting…");
    // Not one row of the transcript's own: neither the old start line nor a
    // settle line that has not happened.
    expect(frame).not.toContain("Compacting the conversation");
    expect(frame).not.toContain("Context compacted");
    r.app.unmount();
  });

  test("on success: one separator rule with the daemon's figures + Compacted ✓ in the slot", async () => {
    // Mutation (red): return the old `_Context compacted — 9 → 2 messages._`
    // notice on success (`send-now.ts`) → no separator row and a transcript
    // line; `compactionSeparatorText` given the message counts instead of the
    // token sizes → `compacted` with no figures.
    const r = rig();
    await delay(30);
    r.app.stdin.write("/compact");
    await delay(20);
    r.app.stdin.write(ENTER);
    await delay(80);
    r.settle();
    await delay(120);
    const frame = strip(r.app.lastFrame());
    expect(frame).toMatch(/^── compacted · ctx 182k → 9k /m);
    expect(frame).toContain("Compacted ✓");
    expect(frame).not.toContain("Context compacted");
    // The separator is ONE row, not a transcript line pair.
    expect(frame.split("── compacted").length - 1).toBe(1);
    r.app.unmount();
  });

  test("the frame height is CONSTANT: idle → running → Compacted ✓ → gone", async () => {
    // The property a second slot rule breaks (AGENTS §2: prove the exact
    // property, not a correlate). Mutation (red): restore
    // `(st.running || loading ? 1 : 0)` for the slot row in `app-layout.ts` →
    // the running and `Compacted ✓` frames are one row SHORTER than idle, so
    // the set of heights has 2+ entries.
    clock.useFakeTimers();
    try {
      const settle = (): Promise<void> => new Promise<void>((r) => setImmediate(r));
      const r = rig();
      await settle();
      const rows = (): number => (r.app.lastFrame() ?? "").split("\n").length;
      const heights: { phase: string; rows: number; slot: string }[] = [];
      const record = (phase: string): void => {
        const frame = strip(r.app.lastFrame());
        heights.push({
          phase,
          rows: rows(),
          slot: frame.includes("Compacted ✓")
            ? "compacted"
            : frame.includes("Compacting…")
              ? "compacting"
              : "none",
        });
      };
      record("idle");
      r.app.stdin.write("/compact");
      await settle();
      r.app.stdin.write(ENTER);
      await settle();
      record("compacting");
      r.settle();
      await settle();
      await settle();
      record("compacted");
      clock.advanceTimersByTime(2_999);
      await settle();
      record("still compacted");
      clock.advanceTimersByTime(1);
      await settle();
      await settle();
      record("gone");

      // Non-vacuity: the four states really were the states we claim.
      expect(heights.map((h) => h.slot)).toEqual([
        "none",
        "compacting",
        "compacted",
        "compacted",
        "none",
      ]);
      // …and nothing moved: one height for all of them.
      expect(new Set(heights.map((h) => h.rows)).size).toBe(1);
      r.app.unmount();
    } finally {
      clock.useRealTimers();
    }
  });

  test("a prompt typed during the 3 s replaces Compacted ✓ at once", async () => {
    // The priority (owner decision 3): a running turn outranks `Compacted ✓`, so
    // the slot is not a second thing to hide. Mutation (red): check
    // `compactedAt` before `running` in `slotView` → the frame keeps
    // `Compacted ✓` while the turn reasons.
    const r = rig();
    await delay(30);
    r.app.stdin.write("/compact");
    await delay(20);
    r.app.stdin.write(ENTER);
    await delay(80);
    r.settle();
    await delay(120);
    expect(strip(r.app.lastFrame())).toContain("Compacted ✓");
    r.app.stdin.write("hi");
    await delay(20);
    r.app.stdin.write(ENTER);
    await delay(80);
    const frame = strip(r.app.lastFrame());
    expect(frame).toContain("Thinking…");
    expect(frame).not.toContain("Compacted ✓");
    r.release();
    r.app.unmount();
  });
});
