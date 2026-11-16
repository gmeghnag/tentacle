/**
 * The Activity wiring ON THE SCREEN (docs/feat/mobile-chrome.md S8): the
 * controller follows the handle's `onSubagents`/`onJobs` from the attach, keeps
 * the Finished memory, marks a report opened, and drops both subscriptions on
 * leave. The fake handle stands for `RemoteSession` (a seam, AGENTS §9).
 */
import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@tentacle/client";
import { PermissionBroker } from "@tentacle/core";
import type { JobRow, SubagentRow } from "@tentacle/protocol";
import { reportsOf } from "../src/activity-memory.ts";
import { activityView } from "../src/activity.ts";
import { createSessionController } from "../src/session-controller.ts";
import { type SendableHandle, createSessionScreen } from "../src/session-screen-controller.ts";

function child(id: string): SubagentRow {
  return {
    id,
    callId: `call-${id}`,
    agentType: "general",
    description: `task ${id}`,
    state: "running",
    toolUses: 2,
    tokens: 10,
    startedAt: 0,
    tail: ["read x"],
  };
}

function harness(options: { readonly activity: boolean; readonly initial?: SubagentRow[] }) {
  let agents: ((rows: readonly SubagentRow[]) => void) | null = null;
  let jobs: ((r: { rows: readonly JobRow[]; count: number }) => void) | null = null;
  let clock = 100;
  const handle: SendableHandle = {
    open: () => Promise.resolve(),
    detach: () => Promise.resolve(),
    watch: () => () => {},
    async *send(): AsyncIterable<SessionEvent> {
      yield { type: "turn_end", reason: "end_turn" } as never;
    },
    ...(options.activity
      ? {
          onSubagents: (fn: (rows: readonly SubagentRow[]) => void) => {
            agents = fn;
            if (options.initial !== undefined) {
              fn(options.initial); // the snapshot's list, given at once
            }
            return () => {
              agents = null;
            };
          },
          onJobs: (fn: (r: { rows: readonly JobRow[]; count: number }) => void) => {
            jobs = fn;
            return () => {
              jobs = null;
            };
          },
        }
      : {}),
  };
  const screen = createSessionScreen({
    sessionId: "s1",
    archived: false,
    title: "Alpha",
    project: "e2e-mac",
    controller: createSessionController<SendableHandle>({ newSession: () => handle }),
    broker: new PermissionBroker(undefined, { holdUntilSet: true }),
    now: () => clock,
  });
  return {
    screen,
    agents: (rows: SubagentRow[]) => agents?.(rows),
    jobs: (rows: JobRow[], count: number) => jobs?.({ rows, count }),
    subscribed: () => agents !== null || jobs !== null,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

const view = (state: ReturnType<ReturnType<typeof harness>["screen"]["state"]>) =>
  activityView(
    {
      subagents: state.activity.subagents,
      jobs: state.activity.jobs,
      finished: state.activity.memory.finished,
      reports: reportsOf(state.transcript.rows),
      opened: state.activity.memory.opened,
    },
    0,
  );

describe("the screen follows background work from the attach", () => {
  test("the open snapshot's live child shows the pill on the first frame (F13)", async () => {
    const h = harness({ activity: true, initial: [child("sa-1")] });
    await h.screen.open();
    const v = view(h.screen.state());
    expect(v.badge).toBe(true);
    expect(v.count).toBe(1);
  });

  test("a live replace and a jobs report both reach the state", async () => {
    const h = harness({ activity: true });
    await h.screen.open();
    h.agents([child("sa-1"), child("sa-2")]);
    h.jobs([{ id: "bg-1", command: "sleep 30", startedAt: 0, status: "running" }], 1);
    expect(view(h.screen.state()).count).toBe(3);
  });

  test("a child that leaves becomes Finished, stamped with the screen's clock", async () => {
    const h = harness({ activity: true, initial: [child("sa-1")] });
    await h.screen.open();
    h.tick(50);
    h.agents([]);
    const s = h.screen.state();
    expect(s.activity.memory.finished.map((f) => [f.row.id, f.endedAt])).toEqual([["sa-1", 150]]);
    expect(view(s).count).toBe(0);
  });

  test("openReport marks it opened", async () => {
    const h = harness({ activity: true });
    await h.screen.open();
    h.screen.openReport("sa-7");
    expect(h.screen.state().activity.memory.opened).toEqual(["sa-7"]);
  });

  test("leave drops both subscriptions", async () => {
    const h = harness({ activity: true });
    await h.screen.open();
    expect(h.subscribed()).toBe(true);
    await h.screen.leave();
    expect(h.subscribed()).toBe(false);
  });

  test("dispose drops both subscriptions", async () => {
    const h = harness({ activity: true });
    await h.screen.open();
    h.screen.dispose();
    expect(h.subscribed()).toBe(false);
  });

  test("a handle without the members (older client): nothing, no throw (F15)", async () => {
    const h = harness({ activity: false });
    await h.screen.open();
    const s = h.screen.state();
    expect(s.activity.subagents).toBeNull();
    expect(s.activity.jobs).toBeNull();
    expect(view(s).badge).toBe(false);
  });
});
