/**
 * H5's laptop half end to end (docs/feat/session-hop.md D9): a `move_session`
 * proposal, streamed through the REAL `createHopFeed`, becomes ONE `session_hop`
 * request on the broker the feed was given — the same instance the facade hands to
 * every runtime it builds (AGENTS §7, the single-broker invariant).
 *
 * The plan's own mutation is here: **let `autoApproves` answer `session_hop`** →
 * the row asserting auto-accept leaves the prompt PENDING fails. Its truth is
 * `tui/src/permission-ui.ts`'s (`autoApproves`), so the row reads that function
 * against the request this feed actually raises.
 *
 * Also pinned: No builds nothing (no facade hop), a yes builds exactly once, and
 * the model is told afterwards through the next prompt's consumed line (M7).
 */
import { describe, expect, test } from "bun:test";
import type { PermissionRequest, PermissionResponse } from "@tentacle/core";
import { type HopSpec, type SessionEvent, autoApproves } from "@tentacle/tui";
import { createHopFeed } from "../src/hop-feed.ts";
import type { HopPlace } from "../src/hop-plan.ts";
import type { HopOutcome } from "../src/session-hop.ts";

const MOVED_LOCAL: HopOutcome = {
  kind: "moved",
  built: { runtime: {}, place: { kind: "local" }, daemonInPod: false, preexisting: false } as never,
  notice: "moved to local",
};

const start = (id: string, args: unknown): SessionEvent => ({
  type: "tool_start",
  id,
  name: "move_session",
  arguments: JSON.stringify(args),
});
const done = (id: string, isError = false): SessionEvent => ({
  type: "tool_result",
  id,
  name: "move_session",
  result: { content: "Proposed", isError },
});

/** A broker whose `request` is the spy: the ONE instance a hop would ask on. */
function spyBroker(answer: PermissionResponse) {
  const asked: PermissionRequest[] = [];
  const request = async (req: PermissionRequest): Promise<PermissionResponse> => {
    asked.push(req);
    return answer;
  };
  return { asked, request };
}

/** The REAL feed, over a fake facade, with the broker under test. */
function rig(opts: { answer?: PermissionResponse; place?: HopPlace; outcome?: HopOutcome } = {}) {
  const broker = spyBroker(opts.answer ?? { allowed: false });
  const hopCalls: HopSpec[] = [];
  const place = opts.place ?? { kind: "local" };
  const view = createHopFeed({
    facade: {
      current: () => ({}) as never,
      target: () => ({ place: { kind: "local" }, daemonInPod: false }),
      onTarget: () => () => {},
      createSession: () => ({}) as never,
      hop: async (spec: HopSpec) => {
        hopCalls.push(spec);
        return opts.outcome ?? MOVED_LOCAL;
      },
    } as never,
    place: () => place,
    // The single broker the facade also hands every runtime (P2).
    permissions: broker as never,
    promptFacts: () => ({ mount: "/home/me/work", workload: "box" }),
  });
  return { feed: view.hop, asked: broker.asked, hopCalls };
}

/** Stream a whole own turn that proposed `spec`, then ask at its end. */
async function proposeAndAsk(
  spec: unknown,
  opts: { answer?: PermissionResponse; own?: boolean; isError?: boolean } = {},
) {
  const r = rig({ answer: opts.answer ?? { allowed: false } });
  const own = opts.own ?? true;
  r.feed.turn?.(start("c1", spec), own);
  r.feed.turn?.(done("c1", opts.isError ?? false), own);
  const outcome = await r.feed.turnEnd?.(own);
  return { ...r, outcome };
}

describe("H5: a proposal becomes ONE session_hop request at the turn's end", () => {
  test("one proposal → exactly one request, on the feed's OWN broker", async () => {
    const { asked, outcome } = await proposeAndAsk({ target: "container", image: "img:1" });
    expect(asked).toHaveLength(1);
    // The request the owner sees: the laptop's prompt kind, and one complete detail.
    const request = asked[0];
    if (request === undefined) {
      throw new Error("no request was asked");
    }
    expect(request.kind).toBe("session_hop");
    expect(request.detail).toContain("img:1");
    expect(request.detail).toContain("/home/me/work");
    expect(outcome).toEqual({ kind: "declined" });
  });

  test("a YES is an approved spec — and the feed does not hop by itself", async () => {
    // The App starts it as a `/move` (one path to the view's move, D3): the feed
    // must NOT build on its own, or there would be two ways into a hop.
    const { outcome, hopCalls } = await proposeAndAsk(
      { target: "local" },
      { answer: { allowed: true, scope: "once" } },
    );
    expect(outcome).toEqual({ kind: "approved", spec: { target: "local", keep: true } });
    expect(hopCalls).toHaveLength(0);
  });

  test("a NO builds nothing, and leaves the declined line for the next prompt", async () => {
    const { outcome, feed } = await proposeAndAsk(
      { target: "local" },
      { answer: { allowed: false } },
    );
    expect(outcome).toEqual({ kind: "declined" });
    const line = feed.takeLine?.();
    expect(line).toContain("[move declined]");
    // CONSUMED: a second read has nothing, so the model is told once.
    expect(feed.takeLine?.()).toBeNull();
  });

  test("a committed hop leaves the moved line, naming the place", async () => {
    const { feed, hopCalls } = await proposeAndAsk(
      { target: "local" },
      { answer: { allowed: true, scope: "once" } },
    );
    // Drive the hop the App would start; then the line is ready for the prompt.
    await feed.start({ target: "local", keep: true }, "uid-1").done;
    expect(hopCalls).toHaveLength(1);
    const line = feed.takeLine?.();
    expect(line).toContain("[session moved to local");
    expect(line).toContain("approvals were reset");
    expect(feed.takeLine?.()).toBeNull();
  });

  test("a FAILED hop leaves no moved line (nothing moved)", async () => {
    const r = rig({
      answer: { allowed: true, scope: "once" },
      outcome: { kind: "failed", notice: "not moved: nope" },
    });
    await r.feed.start({ target: "local", keep: true }, "uid-1").done;
    expect(r.feed.takeLine?.()).toBeNull();
  });

  test("auto-accept can NEVER answer it: the request is one it refuses, so it stays pending", async () => {
    // The plan's mutation: let `autoApproves` answer `session_hop` → this row fails,
    // because auto-accept would then resolve the prompt with no human seeing it.
    const { asked } = await proposeAndAsk(
      { target: "local" },
      { answer: { allowed: true, scope: "once" } },
    );
    const request = asked[0];
    if (request === undefined) {
      throw new Error("no request was asked");
    }
    expect(autoApproves(request, true)).toBe(false);
    // Non-vacuity: an ordinary own tool ask WOULD be auto-approved.
    expect(autoApproves({ ...request, kind: "tool" }, true)).toBe(true);
    // And the request offers no rule a lasting approval could remember.
    expect(request.suggestion).toBeUndefined();
  });

  test("a FOREIGN turn's proposal asks nothing (its owner's terminal is the one)", async () => {
    const { asked, outcome } = await proposeAndAsk({ target: "local" }, { own: false });
    expect(asked).toHaveLength(0);
    expect(outcome).toEqual({ kind: "none" });
  });

  test("a proposal folded as OWN, ended as foreign, is still not asked (the guard)", async () => {
    // The fold's own-view and the turn-end view are two different facts (the
    // driver reports them separately), so the guard at `turnEnd` is what holds when
    // they disagree: the owner is asked on THEIR terminal only. Mutation: drop the
    // `!own` guard in `hop-feed.ts` → this row asks a prompt.
    const r = rig({ answer: { allowed: true, scope: "once" } });
    r.feed.turn?.(start("c1", { target: "local" }), true);
    r.feed.turn?.(done("c1"), true);
    expect(await r.feed.turnEnd?.(false)).toEqual({ kind: "none" });
    expect(r.asked).toHaveLength(0);
  });

  test("a FAILED tool call asks nothing", async () => {
    const { asked, outcome } = await proposeAndAsk(
      { target: "local" },
      { isError: true, answer: { allowed: true } },
    );
    expect(asked).toHaveLength(0);
    expect(outcome).toEqual({ kind: "none" });
  });

  test("TWO turns never share a proposal: each is watched, and each asks its own", async () => {
    const r = rig({ answer: { allowed: false } });
    r.feed.turn?.(start("c1", { target: "local" }), true);
    r.feed.turn?.(done("c1"), true);
    await r.feed.turnEnd?.(true);
    // A second turn with no proposal asks nothing.
    r.feed.turn?.({ type: "text", delta: "hi" }, true);
    await r.feed.turnEnd?.(true);
    expect(r.asked).toHaveLength(1);
  });

  test("a broker that throws is a refusal, never an approval, and never a rejection", async () => {
    const view = createHopFeed({
      facade: {
        current: () => ({}) as never,
        target: () => ({ place: { kind: "local" }, daemonInPod: false }),
        onTarget: () => () => {},
        createSession: () => ({}) as never,
        hop: async () => MOVED_LOCAL,
      } as never,
      place: () => ({ kind: "local" }),
      permissions: {
        request: async () => {
          throw new Error("the broker is gone");
        },
      } as never,
    });
    view.hop.turn?.(start("c1", { target: "local" }), true);
    view.hop.turn?.(done("c1"), true);
    expect(await view.hop.turnEnd?.(true)).toEqual({ kind: "declined" });
    expect(view.hop.takeLine?.()).toContain("[move declined]");
  });

  test("a host with NO broker cannot approve anything (nothing moves without an owner)", async () => {
    const view = createHopFeed({
      facade: {
        current: () => ({}) as never,
        target: () => ({ place: { kind: "local" }, daemonInPod: false }),
        onTarget: () => () => {},
        createSession: () => ({}) as never,
        hop: async () => MOVED_LOCAL,
      } as never,
      place: () => ({ kind: "local" }),
    });
    view.hop.turn?.(start("c1", { target: "local" }), true);
    view.hop.turn?.(done("c1"), true);
    expect(await view.hop.turnEnd?.(true)).toEqual({ kind: "none" });
  });
});
