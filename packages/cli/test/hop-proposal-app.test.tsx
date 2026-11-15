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
import { App, type SessionController } from "@tentacle/tui";
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

const MOVED: HopOutcome = {
  kind: "moved",
  built: {
    runtime: {} as never,
    place: { kind: "workload", engine: "docker", name: "box" },
    daemonInPod: true,
    preexisting: false,
    rollback: async () => {},
  },
  controller: proposingSession({ sends: [] }) as never,
  notice: "moved to docker:box",
};

/**
 * A session whose ONE turn streams a `move_session` call and succeeds: exactly
 * what the daemon sends when the model proposes a hop.
 */
function proposingSession(log: { sends: string[] }): SessionController {
  return {
    ...inertSession(),
    async *send(prompt) {
      log.sends.push(prompt);
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
