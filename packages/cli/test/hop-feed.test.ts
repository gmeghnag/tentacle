/**
 * docs/feat/session-hop.md D5 — `createHopFeed`: the bridge's ONE decision (what
 * a hop does with the place it leaves), and the shape of its `done`.
 *
 * The review of H3+H4 found that this path had no test, which is how a HIGH
 * shipped: the feed computed `keep` from `spec.target`, so a plain `/move local`
 * (target `local`, `keep: true`) arrived at the leave as `keep: false` and
 * deleted the container the hop had created — against D5's "keep is the default".
 * Every row here drives the REAL `createHopFeed` over a fake facade.
 */
import { describe, expect, test } from "bun:test";
import type { HopSpec } from "@tentacle/tui";
import { createHopFeed } from "../src/hop-feed.ts";
import type { HopPlace } from "../src/hop-plan.ts";
import type { HopOutcome } from "../src/session-hop.ts";

const ON_CONTAINER: HopPlace = { kind: "workload", engine: "docker", name: "box" };
const MOVED: HopOutcome = {
  kind: "moved",
  built: { runtime: {}, place: { kind: "local" }, daemonInPod: false, preexisting: false } as never,
  controller: {} as never,
  notice: "moved to local",
};

/** The real feed over a fake facade, recording what the leave was asked. */
function rig(
  opts: { place?: HopPlace; outcome?: HopOutcome; leave?: () => Promise<string | null> } = {},
) {
  const left: Array<{ place: HopPlace; keep: boolean }> = [];
  const notices: string[] = [];
  const place = opts.place ?? { kind: "local" };
  const view = createHopFeed({
    facade: {
      current: () => ({}) as never,
      target: () => ({ place, daemonInPod: false }),
      onTarget: () => () => {},
      createSession: () => ({}) as never,
      hop: async () => opts.outcome ?? { kind: "failed", notice: "not moved: nope" },
    } as never,
    place: () => place,
    notify: (text) => notices.push(text),
    leave: async (before, keep) => {
      left.push({ place: before, keep });
      return opts.leave === undefined ? null : opts.leave();
    },
  });
  return { feed: view.hop, left, notices };
}

const CONTAINER: HopSpec = { target: "container", image: "img", keep: true };
const BACK_PLAIN: HopSpec = { target: "local", keep: true };
const BACK_RM: HopSpec = { target: "local", keep: false };

/** Drive one hop to its settle; returns what the leave was asked. */
async function hopOnce(
  spec: HopSpec,
  place: HopPlace,
  outcome: HopOutcome = MOVED,
): Promise<Array<{ place: HopPlace; keep: boolean }>> {
  const r = rig({ place, outcome });
  await r.feed.start(spec, "uid-1").done;
  return r.left;
}

describe("D5 the feed hands the leave the SPEC's own keep (finding 1)", () => {
  test("a plain `/move local` KEEPS the container (the default is keep)", async () => {
    // Mutation: `spec.target !== "local" && spec.keep !== false` → `keep` comes
    // out `false` for every hop back, and this row fails.
    expect(await hopOnce(BACK_PLAIN, ON_CONTAINER)).toEqual([{ place: ON_CONTAINER, keep: true }]);
  });

  test("`/move local --rm` is the ONE way a hop back deletes", async () => {
    expect(await hopOnce(BACK_RM, ON_CONTAINER)).toEqual([{ place: ON_CONTAINER, keep: false }]);
  });

  test("a hop between containers carries its own `keep`, about the OLD one", async () => {
    const rm: HopSpec = { target: "container", image: "img", keep: false };
    expect(await hopOnce(rm, ON_CONTAINER)).toEqual([{ place: ON_CONTAINER, keep: false }]);
    expect(await hopOnce(CONTAINER, ON_CONTAINER)).toEqual([{ place: ON_CONTAINER, keep: true }]);
  });

  test("a hop FROM local leaves nothing to decide", async () => {
    expect(await hopOnce(CONTAINER, { kind: "local" })).toEqual([]);
  });

  test("a FAILED hop leaves nothing either (the old place is still live)", async () => {
    const failed: HopOutcome = { kind: "failed", notice: "not moved: nope" };
    const r = rig({ place: ON_CONTAINER, outcome: failed });
    expect(await r.feed.start(BACK_RM, "uid-1").done).toEqual({ failed: "not moved: nope" });
    expect(r.left).toEqual([]);
  });

  test("a leave's notice reaches the notice sink, once", async () => {
    const r = rig({
      place: ON_CONTAINER,
      outcome: MOVED,
      leave: async () => "docker:box not ours: left alone",
    });
    await r.feed.start(BACK_RM, "uid-1").done;
    expect(r.notices).toEqual(["docker:box not ours: left alone"]);
  });

  test("session-hop-live D2: the outcome's note rides `done`, the controller is the outcome's, and no outcome text is notified", async () => {
    // Mutation: drop `note` from the feed's `done` → the note is lost (the App's
    // one moved line can no longer say it); notify `outcome.notice` → duplicated.
    const controller = { sessionId: "uid-1" } as never;
    const r = rig({
      outcome: {
        ...MOVED,
        controller,
        notice: "moved to local — the old session did not close",
        note: "the old session did not close",
      },
    });
    const done = await r.feed.start(BACK_PLAIN, "uid-1").done;
    expect("moved" in done && done.moved).toBe(controller);
    expect("moved" in done ? done.note : undefined).toBe("the old session did not close");
    expect(r.notices).toEqual([]);
    const failed = rig({ outcome: { kind: "failed", notice: "not moved: nope" } });
    expect(await failed.feed.start(BACK_PLAIN, "uid-1").done).toEqual({
      failed: "not moved: nope",
    });
    expect(failed.notices).toEqual([]);
  });

  test("`done` never rejects: a facade that throws is one `not moved:` line", async () => {
    const view = createHopFeed({
      facade: {
        current: () => ({}) as never,
        target: () => ({ place: { kind: "local" }, daemonInPod: false }),
        onTarget: () => () => {},
        createSession: () => ({}) as never,
        hop: async () => {
          throw new Error("the build exploded");
        },
      } as never,
      place: () => ({ kind: "local" }),
    });
    expect(await view.hop.start(CONTAINER, "uid-1").done).toEqual({
      failed: "not moved: the build exploded",
    });
  });
});
