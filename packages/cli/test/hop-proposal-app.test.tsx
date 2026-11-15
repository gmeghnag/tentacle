/**
 * The production path from a `move_session` PROPOSAL to the view moving
 * (docs/feat/session-hop.md D9, slice H5, review finding 4): the REAL `App` and
 * the REAL `createHopFeed`, driven by a controller that streams a `move_session`
 * tool call.
 *
 * The review's own mutation is the reason this file exists: deleting
 * `hopTurn?.event(...)` from `useTurnDriver.ts` — i.e. no event ever reaching the
 * fold, so no proposal could ever be asked — left `bun test packages/tui` plus
 * the two cli turn files at 2011 pass / 0 fail. Every half was covered; the seam
 * between them was not. So this asserts the whole chain at the App's frame:
 *
 *   tool_start/tool_result (own turn) → ONE `session_hop` broker request at the
 *   turn's end → a Yes → the status row says `moving to …`.
 *
 * Lives in `cli` because `createHopFeed` is there and `tui` may not import it
 * (the `attach-durable-app.test.tsx` precedent).
 */
import { describe, expect, test } from "bun:test";
import type { PermissionRequest, PermissionResponse } from "@tentacle/core";
import { PermissionBroker } from "@tentacle/core";
import { App, type HopSpec, type SessionController } from "@tentacle/tui";
import { render } from "ink-testing-library";
import { inertSession } from "../../tui/test/session-stub.ts";
import { createHopFeed } from "../src/hop-feed.ts";
import type { HopOutcome } from "../src/session-hop.ts";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const ENTER = "\r";
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR codes
const strip = (s: string | undefined): string => (s ?? "").replace(/\x1b\[[0-9;]*m/g, "");

const type = async (stdin: { write(s: string): void }, text: string, ms = 60): Promise<void> => {
  stdin.write(text);
  await delay(ms);
  stdin.write(ENTER);
  await delay(ms);
};

/** Every prompt the session a hop MOVED TO receives: where OD6's wake lands. */
const movedLog: { sends: string[] } = { sends: [] };

const MOVED: HopOutcome = {
  kind: "moved",
  built: {
    runtime: {} as never,
    place: { kind: "workload", engine: "docker", name: "box" },
    folder: "not shared",
    daemonInPod: true,
    preexisting: false,
    rollback: async () => {},
  },
  // The MOVED session is an ordinary one: since OD6 a settled hop wakes the model,
  // so a controller that proposed again on every turn would loop (by design — the
  // chain cap stops it; that is `hop-wake.test.ts`'s subject, not this rig's).
  // Its sends go to `movedLog`: the wake is a prompt of the NEW session.
  controller: plainSession(movedLog) as never,
  notice: "moved to docker:box",
};

/**
 * A session whose ONE turn streams a `move_session` call and succeeds: exactly
 * what the daemon sends when the model proposes a hop.
 *
 * It proposes on its FIRST send only, and then just answers: since OD6 a settled
 * hop WAKES the model, so a session that re-proposed on every turn would loop
 * (the chain cap stops it at `HOP_WAKE_CHAIN_MAX`, which is the point of the cap,
 * not of these rows).
 */
function proposingSession(log: { sends: string[] }): SessionController {
  let turns = 0;
  return {
    ...inertSession(),
    async *send(prompt) {
      log.sends.push(prompt);
      turns += 1;
      if (turns > 1) {
        yield { type: "text", delta: "ok" };
        yield { type: "turn_end", reason: "end_turn" };
        return;
      }
      yield {
        type: "tool_start",
        id: "c1",
        name: "move_session",
        arguments: JSON.stringify({ target: "container", image: "img:1" }),
      };
      yield {
        type: "tool_result",
        id: "c1",
        name: "move_session",
        result: {
          content: "Proposed; the user will be asked when this turn ends.",
          isError: false,
        },
      };
      yield { type: "turn_end", reason: "end_turn" };
    },
    watch() {
      return () => {};
    },
    async openForReset() {},
  };
}

/** A session that just answers: what a moved-to session does on a wake. */
function plainSession(log: { sends: string[] }): SessionController {
  return {
    ...inertSession(),
    async *send(prompt) {
      log.sends.push(prompt);
      yield { type: "text", delta: "ok" };
      yield { type: "turn_end", reason: "end_turn" };
    },
    watch() {
      return () => {};
    },
    async openForReset() {},
  };
}

/**
 * A broker that records every ask and answers as the test set it — the
 * `session-hop-targets.test.ts` pattern. A SUBCLASS on purpose: the App installs
 * its own interactive requester on `setRequester`, so a spy passed as the initial
 * requester would be replaced the moment App mounts.
 */
class SpyBroker extends PermissionBroker {
  readonly asked: PermissionRequest[] = [];
  answer: PermissionResponse = { allowed: true, scope: "once" };
  override async request(req: PermissionRequest): Promise<PermissionResponse> {
    this.asked.push(req);
    return this.answer;
  }
}

/**
 * The same as `proposingSession`, but the model proposes an ATTACH with no
 * namespace — the owner's scenario in fix round 2: the model omits the namespace,
 * the pin resolves it, and the build must state WHY that one.
 */
function proposingAttach(log: { sends: string[] }): SessionController {
  const base = proposingSession(log);
  return {
    ...base,
    async *send(prompt) {
      log.sends.push(prompt);
      yield {
        type: "tool_start",
        id: "c1",
        name: "move_session",
        arguments: JSON.stringify({
          target: "attach",
          workload: { engine: "kubernetes", name: "etcd-0" },
        }),
      };
      yield {
        type: "tool_result",
        id: "c1",
        name: "move_session",
        result: { content: "Proposed", isError: false },
      };
      yield { type: "turn_end", reason: "end_turn" };
    },
  } as SessionController;
}

/** The REAL feed over a fake facade: the same broker the App's prompt lands on. */
function rig(answer: PermissionResponse) {
  const broker = new SpyBroker();
  broker.answer = answer;
  const hopCalls: string[] = [];
  const view = createHopFeed({
    facade: {
      current: () => ({}) as never,
      target: () => ({ place: { kind: "local" }, daemonInPod: false }),
      onTarget: () => () => {},
      createSession: () => proposingSession({ sends: [] }),
      hop: async () => {
        hopCalls.push("hop");
        return MOVED;
      },
    } as never,
    place: () => ({ kind: "local" }),
    notify: () => {},
    permissions: broker,
    promptFacts: () => ({ mount: "/home/me/work", engine: "docker" }),
  });
  return { feed: view.hop, asked: broker.asked, hopCalls, broker };
}

describe("H5 review 4: a proposal really reaches the owner and really moves, in the App", () => {
  test("tool events → ONE prompt at the turn's end → a Yes → `moving to`", async () => {
    const r = rig({ allowed: true, scope: "once" });
    const log = { sends: [] as string[] };
    const app = render(
      <App
        createSession={() => proposingSession(log)}
        model="m"
        cwd="/tmp/work"
        hop={r.feed}
        permissions={r.broker}
        columns={80}
      />,
    );
    await delay(60);
    await type(app.stdin, "please move me", 150);
    // The proposal reached the owner: exactly ONE request, the laptop's kind.
    // Mutation: drop `hopTurn?.event(...)` (`useTurnDriver.ts`) → `asked` is empty.
    expect(r.asked).toHaveLength(1);
    expect(r.asked[0]?.kind).toBe("session_hop");
    expect(r.asked[0]?.detail ?? "").toContain("img:1");
    // A Yes starts the ONE move path (the App's `startHop`), so the hop itself
    // ran, and its notice says where the session now is. (The transient
    // `moving to …` row is gone by the time a settled frame is read: the notice
    // is the durable half of the same fact.)
    expect(r.hopCalls).toHaveLength(1);
    expect(strip(app.lastFrame())).toContain("Moved to local");
    app.unmount();
  });

  test("a NO asks once and moves nothing (the model is told next turn)", async () => {
    const r = rig({ allowed: false });
    const log = { sends: [] as string[] };
    const app = render(
      <App
        createSession={() => proposingSession(log)}
        model="m"
        cwd="/tmp/work"
        hop={r.feed}
        permissions={r.broker}
        columns={80}
      />,
    );
    await delay(60);
    await type(app.stdin, "please move me", 150);
    expect(r.asked).toHaveLength(1);
    expect(r.hopCalls).toHaveLength(0);
    expect(strip(app.lastFrame())).not.toContain("Moved to");
    app.unmount();
  });
});

/**
 * docs/feat/session-hop-ux OD4/OD5/OD6, at the App's frame — the three owner
 * decisions that changed this path, each one asserted where it can actually break.
 */
describe("session-hop-ux: auto-accept answers a move, survives it, and the session continues", () => {
  test("OD4: auto-accept ON + a local-origin proposal ⇒ NO dialog, and it moves", async () => {
    // The requester the App installs is the REAL `autoApproves`
    // (`permission-ui.ts`), and the feed asks the SAME broker instance (the
    // single-broker invariant) — so this row is the gate itself, not a spy.
    // Mutation: `hopAuto` unset (or `autoApproves` ignoring it) ⇒ the ask is held
    // for a human, nothing starts, and `hopCalls` stays 0.
    const real = new PermissionBroker();
    const hopCalls: string[] = [];
    const view = createHopFeed({
      facade: {
        current: () => ({}) as never,
        target: () => ({ place: { kind: "local" }, daemonInPod: false }),
        onTarget: () => () => {},
        createSession: () => proposingSession({ sends: [] }),
        hop: async () => {
          hopCalls.push("hop");
          return MOVED;
        },
      } as never,
      place: () => ({ kind: "local" }),
      notify: () => {},
      permissions: real,
      promptFacts: () => ({ mount: "/home/me/work", engine: "docker" }),
    });
    const log = { sends: [] as string[] };
    const app = render(
      <App
        createSession={() => proposingSession(log)}
        model="m"
        cwd="/tmp/work"
        hop={view.hop}
        permissions={real}
        autoAccept={{ current: () => true, set: () => {}, onChange: () => () => {} }}
        columns={80}
      />,
    );
    await delay(60);
    await type(app.stdin, "please move me", 200);
    expect(hopCalls).toHaveLength(1);
    const frame = strip(app.lastFrame());
    expect(frame).toContain("Moved to local");
    // OD4's "logged allow-once": the transcript says no prompt was shown.
    expect(frame).toContain("auto-accepted");
    app.unmount();
  });

  test("OD5: auto-accept is STILL ON after the move (D9 reversed)", async () => {
    const sets: boolean[] = [];
    const r = rig({ allowed: true, scope: "once" });
    const app = render(
      <App
        createSession={() => proposingSession({ sends: [] })}
        model="m"
        cwd="/tmp/work"
        hop={r.feed}
        permissions={r.broker}
        autoAccept={{
          current: () => true,
          set: (on: boolean) => sets.push(on),
          onChange: () => () => {},
        }}
        columns={80}
      />,
    );
    await delay(60);
    await type(app.stdin, "please move me", 200);
    // Nothing turned it off, and the frame still says on.
    expect(sets).toEqual([]);
    expect(strip(app.lastFrame())).toContain("auto-accept on");
    app.unmount();
  });

  test("OD6: after a PROPOSED move the session continues by itself, once", async () => {
    // Mutation: drop `hopOriginRef.current = "proposal"` in the App's port ⇒ the
    // origin is `idle`, no wake fires, and `sends` has one entry.
    const r = rig({ allowed: true, scope: "once" });
    const log = { sends: [] as string[] };
    const app = render(
      <App
        createSession={() => proposingSession(log)}
        model="m"
        cwd="/tmp/work"
        hop={r.feed}
        permissions={r.broker}
        columns={80}
      />,
    );
    await delay(60);
    movedLog.sends.length = 0;
    await type(app.stdin, "please move me", 250);
    // The user's prompt went to the OLD session; the hop's own wake is ONE real
    // prompt to the NEW one, whose text starts with the moved line and ends with
    // OD6's short message.
    expect(log.sends).toHaveLength(1);
    expect(movedLog.sends).toHaveLength(1);
    const wake = movedLog.sends[0] ?? "";
    expect(wake.startsWith("[session moved to")).toBe(true);
    expect(wake.endsWith("Continue the task from here.")).toBe(true);
    // No user bubble for the wake: the dim row says why the turn ran.
    const frame = strip(app.lastFrame());
    expect(frame).toContain("continuing after the move");
    app.unmount();
  });

  test("OD3: the pin's provenance reaches the build from a REAL App turn (TUI half)", async () => {
    // The finding (fix round 2): under auto-accept no prompt is shown, so the row
    // and the outcome were the only record of WHY a namespace — and they said
    // `explicit`, because the build re-resolved the value the pin wrote. This drives
    // the whole App chain (turn events → the port → `startHop` → `hop.start`) and
    // asserts what the FEED was handed: the pin, untouched.
    // Mutation: drop `outcome.namespace` in `useTurnDriver`'s approved branch, or
    // the `namespace` field on `startHop`'s opts → the feed sees `{}`.
    const pin = {
      namespace: "openshift-etcd",
      source: "context" as const,
      kubeconfig: "/k",
      context: "c",
    };
    const handed: Array<{ gateAnswered?: true; namespace?: unknown }> = [];
    // The owner's YES, on the one broker (the App installs its own requester on it).
    const real = new SpyBroker();
    real.answer = { allowed: true, scope: "once" };
    const view = createHopFeed({
      facade: {
        current: () => ({}) as never,
        target: () => ({ place: { kind: "local" }, daemonInPod: false }),
        onTarget: () => () => {},
        createSession: () => proposingAttach({ sends: [] }),
        hop: async (_spec: HopSpec, _id: string | null, opts: never) => {
          handed.push(opts);
          return MOVED;
        },
      } as never,
      place: () => ({ kind: "local" }),
      notify: () => {},
      permissions: real,
      pinNamespace: (spec) =>
        spec.target === "attach"
          ? {
              kind: "pinned",
              spec: { ...spec, workload: { ...spec.workload, namespace: "openshift-etcd" } },
              namespace: pin,
            }
          : { kind: "pinned", spec },
      promptFacts: () => ({}),
    });
    const log = { sends: [] as string[] };
    const app = render(
      <App
        createSession={() => proposingAttach(log)}
        model="m"
        cwd="/tmp/work"
        hop={view.hop}
        permissions={real}
        columns={80}
      />,
    );
    await delay(60);
    await type(app.stdin, "please move me", 300);
    expect(handed).toHaveLength(1);
    expect(handed[0]?.namespace).toEqual(pin);
    app.unmount();
  });

  test("OD6: a proposal whose namespace cannot be resolved wakes it to read the failure", async () => {
    // Failure mode 1: nothing is asked, nothing moves — and silence would read as
    // success, so the model is woken with `[move failed: …]`.
    const real = new PermissionBroker();
    const hopCalls: string[] = [];
    const view = createHopFeed({
      facade: {
        current: () => ({}) as never,
        target: () => ({ place: { kind: "local" }, daemonInPod: false }),
        onTarget: () => () => {},
        createSession: () => proposingSession({ sends: [] }),
        hop: async () => {
          hopCalls.push("hop");
          return MOVED;
        },
      } as never,
      place: () => ({ kind: "local" }),
      notify: () => {},
      permissions: real,
      // The pin a kubeconfig nobody can read produces: no context, nothing to ask.
      pinNamespace: () => ({
        kind: "failed",
        line: "kubeconfig has no current-context and none was requested",
      }),
      promptFacts: () => ({}),
    });
    const log = { sends: [] as string[] };
    const app = render(
      <App
        createSession={() => proposingSession(log)}
        model="m"
        cwd="/tmp/work"
        hop={view.hop}
        permissions={real}
        columns={80}
      />,
    );
    await delay(60);
    await type(app.stdin, "please move me", 250);
    expect(hopCalls).toHaveLength(0);
    expect(log.sends).toHaveLength(2);
    expect(log.sends[1]).toContain("[move failed: kubeconfig has no current-context");
    app.unmount();
  });

  test("OD6: a DECLINED proposal wakes the model to read `[move declined]`", async () => {
    const r = rig({ allowed: false });
    const log = { sends: [] as string[] };
    const app = render(
      <App
        createSession={() => proposingSession(log)}
        model="m"
        cwd="/tmp/work"
        hop={r.feed}
        permissions={r.broker}
        columns={80}
      />,
    );
    await delay(60);
    movedLog.sends.length = 0;
    await type(app.stdin, "please move me", 250);
    // Nothing moved, so the wake is the SAME session's second prompt.
    expect(log.sends).toHaveLength(2);
    expect(log.sends[1]?.startsWith("[move declined]")).toBe(true);
    expect(r.hopCalls).toHaveLength(0);
    app.unmount();
  });
});
