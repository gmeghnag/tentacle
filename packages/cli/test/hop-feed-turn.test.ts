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
  built: {
    runtime: {},
    place: { kind: "local" },
    folder: "local",
    daemonInPod: false,
    preexisting: false,
  } as never,
  controller: {} as never,
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
    const line = feed.takeLine?.({ autoAccept: false });
    expect(line).toContain("[move declined]");
    // CONSUMED: a second read has nothing, so the model is told once.
    expect(feed.takeLine?.({ autoAccept: false })).toBeNull();
  });

  test("a committed hop leaves the moved line, naming the place", async () => {
    const { feed, hopCalls } = await proposeAndAsk(
      { target: "local" },
      { answer: { allowed: true, scope: "once" } },
    );
    // Drive the hop the App would start; then the line is ready for the prompt.
    await feed.start({ target: "local", keep: true }, "uid-1").done;
    expect(hopCalls).toHaveLength(1);
    const line = feed.takeLine?.({ autoAccept: false });
    expect(line).toContain("[session moved to local");
    // OD6: the folder's fate, the reset, and the mode read at THIS moment.
    expect(line).toContain("folder local");
    expect(line).toContain("background jobs and MCP servers were reset");
    expect(line).toContain("auto-accept off");
    // CONSUMED: one prompt, one line.
    expect(feed.takeLine?.({ autoAccept: false })).toBeNull();
  });

  test("a FAILED hop leaves a `[move failed: …]` line (OD6 closes Q6: never a guess)", async () => {
    // RED on the pre-OD6 code: it left NOTHING, so a model whose proposed move
    // quietly failed went on assuming it had moved.
    const r = rig({
      answer: { allowed: true, scope: "once" },
      outcome: { kind: "failed", notice: "not moved: nope" },
    });
    await r.feed.start({ target: "local", keep: true }, "uid-1").done;
    expect(r.feed.takeLine?.({ autoAccept: false })).toBe("[move failed: not moved: nope]");
  });

  test("a hop that THREW leaves a failed line too, and it is consumed once", async () => {
    const r = rig({
      answer: { allowed: true, scope: "once" },
      outcome: { kind: "failed", notice: "not moved: nope" },
    });
    await r.feed.start({ target: "local", keep: true }, "uid-1").done;
    expect(r.feed.takeLine?.({ autoAccept: false })).toContain("[move failed:");
    expect(r.feed.takeLine?.({ autoAccept: false })).toBeNull();
  });

  test("`clearPending` drops the fact: a /clear must not carry the OLD place", async () => {
    const r = rig({ answer: { allowed: true, scope: "once" } });
    await r.feed.start({ target: "local", keep: true }, "uid-1").done;
    r.feed.clearPending?.();
    expect(r.feed.takeLine?.({ autoAccept: false })).toBeNull();
  });

  test("`restoreLine` hands the line back: a send that failed must not eat it", async () => {
    // docs/feat/session-hop-ux, failure mode "Wake prompt fails to send". RED on
    // the pre-fix code (no `restoreLine` at all): the fact was consumed by the
    // failed prompt and the model never learned the session had moved.
    // Mutation: `restoreLine` → `{}` (or `takeLine` not recording `taken`) ⇒ null.
    const r = rig({ answer: { allowed: true, scope: "once" } });
    await r.feed.start({ target: "local", keep: true }, "uid-1").done;
    expect(r.feed.takeLine?.({ autoAccept: false })).toContain("[session moved to local");
    r.feed.restoreLine?.();
    expect(r.feed.takeLine?.({ autoAccept: false })).toContain("[session moved to local");
  });

  test("`restoreLine` never overwrites a NEWER fact (it describes where we are now)", async () => {
    const r = rig({ answer: { allowed: true, scope: "once" } });
    await r.feed.start({ target: "local", keep: true }, "uid-1").done;
    expect(r.feed.takeLine?.({ autoAccept: false })).toContain("[session moved to local");
    // A second hop settles before the restore arrives: its fact is the truth.
    await r.feed.start({ target: "local", keep: true }, "uid-1").done;
    r.feed.restoreLine?.();
    const line = r.feed.takeLine?.({ autoAccept: false });
    expect(line).toContain("[session moved to local");
    // Still exactly ONE line for the next prompt, not two.
    expect(r.feed.takeLine?.({ autoAccept: false })).toBeNull();
  });

  test("the mode is rendered at TAKE time, so it is never stale", async () => {
    const r = rig({ answer: { allowed: true, scope: "once" } });
    await r.feed.start({ target: "local", keep: true }, "uid-1").done;
    // The owner toggles auto-accept between the move and the next prompt.
    expect(r.feed.takeLine?.({ autoAccept: true })).toContain("auto-accept on");
  });

  test("OD4: auto-accept answers a local-origin move, and ONLY one toward local is refused", async () => {
    // docs/feat/session-hop-ux OD4 replaced the old "auto-accept can NEVER answer
    // it" rule. Where the hop comes from is the feed's `place()` — a LAPTOP fact —
    // so the marker is decided here, never by the model's arguments.
    const localOrigin = await proposeAndAsk(
      { target: "container", image: "img:1" },
      { answer: { allowed: true, scope: "once" } },
    );
    const mine = localOrigin.asked[0];
    if (mine === undefined) {
      throw new Error("no request was asked");
    }
    // Mutation: drop the `deps.place()` argument in `hop-feed.ts` ⇒ this is false.
    expect(autoApproves(mine, true)).toBe(true);
    // Still never a FOREIGN turn's move: `own` outranks the marker.
    expect(autoApproves(mine, false)).toBe(false);
    // And no rule a lasting approval could remember, even when auto-answered.
    expect(mine.suggestion).toBeUndefined();

    // From a WORKLOAD, a move toward local is the ONE it must not answer (§7).
    const fromPod = rig({
      answer: { allowed: true, scope: "once" },
      place: { kind: "workload", engine: "kubernetes", name: "web-0" },
    });
    fromPod.feed.turn?.(start("c1", { target: "local" }), true);
    fromPod.feed.turn?.(done("c1"), true);
    await fromPod.feed.turnEnd?.(true);
    const local = fromPod.asked[0];
    if (local === undefined) {
      throw new Error("no request was asked");
    }
    expect(autoApproves(local, true)).toBe(false);
    // Non-vacuity: an ordinary own tool ask WOULD be auto-approved.
    expect(autoApproves({ ...local, kind: "tool" }, true)).toBe(true);
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
    expect(view.hop.takeLine?.({ autoAccept: false })).toContain("[move declined]");
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

// OD1's PIN property (docs/feat/session-hop-ux design 5): a proposal's namespace is
// resolved at the TURN'S END, before the prompt, and is the one shown AND built —
// so a kubeconfig that changes in between cannot move the target.
describe("OD1: a proposal's namespace is pinned before the owner is asked", () => {
  const call = (id = "c1") => ({
    start: {
      type: "tool_start",
      id,
      name: "move_session",
      arguments: JSON.stringify({
        target: "attach",
        workload: { engine: "kubernetes", name: "etcd-0", container: "etcdctl" },
      }),
    } as SessionEvent,
    done: {
      type: "tool_result",
      id,
      name: "move_session",
      result: { content: "Proposed", isError: false },
    } as SessionEvent,
  });

  const rigPinned = (pin: Parameters<typeof createHopFeed>[0]["pinNamespace"]) => {
    const asked: PermissionRequest[] = [];
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
        request: async (request: PermissionRequest) => {
          asked.push(request);
          return { allowed: true, scope: "once" };
        },
      } as never,
      pinNamespace: pin,
      promptFacts: () => ({}),
    });
    return { view, asked };
  };

  test("the request AND the approved spec carry the resolved namespace", async () => {
    const pinned = {
      namespace: "ns-A",
      source: "context" as const,
      context: "c",
      kubeconfig: "/k",
    };
    const seen: string[] = [];
    const { view, asked } = rigPinned((spec) => {
      seen.push("pinned");
      return {
        kind: "pinned",
        spec: {
          ...spec,
          workload: { ...(spec as never as { workload: object }).workload, namespace: "ns-A" },
        } as HopSpec,
        namespace: pinned,
      };
    });
    const { start, done } = call();
    view.hop.turn?.(start, true);
    view.hop.turn?.(done, true);
    const outcome = await view.hop.turnEnd?.(true);
    // Resolved ONCE, at the turn's end (before the ask).
    expect(seen).toEqual(["pinned"]);
    expect(asked).toHaveLength(1);
    // What the owner read: `ns/pod/container` and WHY that namespace.
    expect(asked[0]?.detail).toContain("kubernetes:ns-A/etcd-0/etcdctl");
    expect(asked[0]?.detail).toContain("namespace ns-A (from context; context c, /k)");
    // What would be BUILT: the very spec that was shown (the pin, not a re-read).
    expect(outcome).toEqual({
      kind: "approved",
      spec: {
        target: "attach",
        workload: { engine: "kubernetes", namespace: "ns-A", name: "etcd-0", container: "etcdctl" },
        keep: true,
      },
    });
  });

  test("a pin that FAILS asks nothing, and TELLS the model (failure mode 1, OD6)", async () => {
    // Mutation: ask the spec as the model wrote it → a request appears here.
    // Mutation: return `none` on a failed pin → the line below is null, and the
    // model goes on assuming its move worked.
    const { view, asked } = rigPinned(() => ({
      kind: "failed",
      line: "kubeconfig has no current-context",
    }));
    const { start, done } = call();
    view.hop.turn?.(start, true);
    view.hop.turn?.(done, true);
    // The View says nothing could be asked, so the App wakes the model to read it.
    expect(await view.hop.turnEnd?.(true)).toEqual({ kind: "failed" });
    expect(asked).toHaveLength(0);
    expect(view.hop.takeLine?.({ autoAccept: false })).toBe(
      "[move failed: kubeconfig has no current-context]",
    );
  });

  test("with no pin deps at all the spec is asked for as the model wrote it", async () => {
    const { outcome, asked } = await proposeAndAsk({
      target: "attach",
      workload: { engine: "kubernetes", namespace: "ns1", name: "web-0" },
    });
    expect(asked[0]?.detail).toContain("kubernetes:ns1/web-0");
    expect(outcome).toEqual({ kind: "declined" });
  });
});
