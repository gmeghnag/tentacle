import { describe, expect, test } from "bun:test";
import {
  type AttachVerdictInput,
  type HopPlace,
  type HopPlanInput,
  attachVerdict,
  hopCancelPlan,
  hopDelete,
  hopPlan,
} from "../src/hop-plan.ts";

// docs/feat/session-hop.md slice H1: D1 step 1 (may this hop run), D7 (join a
// workload) and D5 (what happens to the workload we leave), pure.

const local: HopPlace = { kind: "local" };
const container: HopPlace = { kind: "workload", engine: "docker", name: "box" };

const base: HopPlanInput = {
  spec: { target: "container", keep: true },
  current: local,
  capable: true,
  hopping: false,
  linkUp: true,
  switching: false,
  compacting: false,
  subagents: 0,
  jobs: 0,
  running: false,
  queued: 0,
};
const plan = (over: Partial<HopPlanInput>) => hopPlan({ ...base, ...over });

describe("hopPlan: the happy path", () => {
  test("an idle, capable session on a live link may hop", () => {
    expect(plan({})).toEqual({ kind: "hop" });
    expect(plan({ spec: { target: "local", keep: true }, current: container })).toEqual({
      kind: "hop",
    });
  });

  test("a running turn queues the hop; nothing is built before the turn ends (D4)", () => {
    expect(plan({ running: true })).toEqual({ kind: "queue" });
  });

  test("queued messages run first: the hop takes the first true idle (D4)", () => {
    // Mutation: drop the `queued` row → this fails (the hop would cut the queue).
    expect(plan({ queued: 2 })).toEqual({ kind: "queue" });
    expect(plan({ running: true, queued: 1 })).toEqual({ kind: "queue" });
  });
});

describe("hopPlan: refusals (one notice, nothing built)", () => {
  test("an origin that is not hop-capable says so, whatever else is going on (D8)", () => {
    // Mutation: check `capable` after the queue rows → the second row queues.
    expect(plan({ capable: false })).toEqual({ kind: "notice", text: "not available here" });
    expect(plan({ capable: false, running: true })).toEqual({
      kind: "notice",
      text: "not available here",
    });
  });

  test("the target already is the current one", () => {
    expect(plan({ current: local, spec: { target: "local", keep: true } })).toEqual({
      kind: "notice",
      text: "already local",
    });
    expect(
      plan({
        current: container,
        spec: { target: "attach", workload: { engine: "docker", name: "box" }, keep: true },
      }),
    ).toEqual({ kind: "notice", text: "already in docker:box" });
  });

  test("the same k8s pod with another container is a different place", () => {
    const pod: HopPlace = {
      kind: "workload",
      engine: "kubernetes",
      name: "web-0",
      container: "app",
    };
    expect(
      plan({
        current: pod,
        spec: {
          target: "attach",
          workload: { engine: "kubernetes", name: "web-0", container: "guard" },
          keep: true,
        },
      }),
    ).toEqual({ kind: "hop" });
    expect(
      plan({
        current: pod,
        spec: {
          target: "attach",
          workload: { engine: "kubernetes", name: "web-0", container: "app" },
          keep: true,
        },
      }),
    ).toEqual({ kind: "notice", text: "already in kubernetes:web-0/app" });
  });

  test("a hop already running refuses a second one", () => {
    expect(plan({ hopping: true })).toEqual({ kind: "notice", text: "a move is already running" });
  });

  test("a dropped link refuses the hop (the target could not be reached anyway)", () => {
    expect(plan({ linkUp: false })).toEqual({
      kind: "notice",
      text: "can't move: the link is down",
    });
  });

  test("a switch or a compaction in flight refuses it", () => {
    expect(plan({ switching: true })).toEqual({
      kind: "notice",
      text: "can't move: switching sessions",
    });
    expect(plan({ compacting: true })).toEqual({
      kind: "notice",
      text: "can't move: a compaction is running",
    });
  });

  test("background work is refused, never killed (Q2)", () => {
    // Mutation: let a running job through → the hop kills it silently.
    expect(plan({ jobs: 1 })).toEqual({
      kind: "notice",
      text: "can't move: a background job is still running",
    });
    expect(plan({ subagents: 2 })).toEqual({
      kind: "notice",
      text: "can't move: a background sub-agent is still running",
    });
    // Both, and a running turn: the refusal wins over the queue.
    expect(plan({ jobs: 1, subagents: 1, running: true })).toEqual({
      kind: "notice",
      text: "can't move: a background job is still running",
    });
  });
});

describe("hopCancelPlan", () => {
  test("cancel aborts a hop in flight", () => {
    expect(hopCancelPlan({ hopping: true })).toEqual({ kind: "cancel" });
  });

  test("cancel with nothing in flight says so, never silently", () => {
    expect(hopCancelPlan({ hopping: false })).toEqual({
      kind: "notice",
      text: "no move is running",
    });
  });
});

describe("attachVerdict: D7", () => {
  const workload = { engine: "docker", name: "box" } as const;
  const use = (over: Partial<{ jobs: number; running: boolean; others: number }>) => ({
    jobs: 0,
    running: false,
    others: 0,
    ...over,
  });
  const verdict = (over: Partial<AttachVerdictInput>) =>
    attachVerdict({ workload, detachedRun: false, use: use({}), ...over });

  test("an idle workload nobody else is in is joinable", () => {
    expect(verdict({})).toEqual({ kind: "allowed" });
    // Our own session running is not "another session".
    expect(verdict({ use: use({ running: true, jobs: 1 }) })).toEqual({ kind: "allowed" });
  });

  test("a laptop detached run owns it: refused (that run's relay and TUIs own it)", () => {
    // Mutation: drop the `detachedRun` branch → the second row allows it, and two owners fight.
    expect(verdict({ detachedRun: true })).toEqual({
      kind: "refuse",
      text: "docker:box is in use by another session",
    });
    expect(verdict({ detachedRun: true, use: use({ others: 1 }) })).toEqual({
      kind: "refuse",
      text: "docker:box is in use by another session",
    });
  });

  test("another session attached, running or holding jobs takes it (the resident is ONE)", () => {
    for (const others of [1, 3]) {
      expect(verdict({ use: use({ others }) })).toEqual({
        kind: "refuse",
        text: "docker:box is in use by another session",
      });
    }
  });

  test("an unreadable use is a doubt, and a doubt does not join", () => {
    expect(verdict({ use: null })).toEqual({
      kind: "refuse",
      text: "can't tell whether docker:box is in use — not joining it",
    });
  });

  test("the refusal names the workload as an engine:name", () => {
    const pod = { engine: "kubernetes", name: "web-0", container: "app" } as const;
    expect(attachVerdict({ workload: pod, detachedRun: true, use: null })).toEqual({
      kind: "refuse",
      text: "kubernetes:web-0/app is in use by another session",
    });
  });

  test("a pod-supplied name is sanitized before it reaches the terminal (AGENTS §7)", () => {
    // Finding 2 of the H1 review: these notices interpolated a proposed
    // workload's name raw. Mutation: drop `untrustedText` from `workloadText`
    // → the escape/newline survive in both rows.
    const nasty = { engine: "docker", name: "box\u001b[31m\ninjected" } as const;
    const worded = verdict({ workload: nasty, detachedRun: true });
    const text = worded.kind === "refuse" ? worded.text : "";
    expect(text).toContain("is in use by another session");
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\n");
    const kept = hopDelete({ workload: nasty, keep: false, createdByHop: false });
    const notice = kept.kind === "keep" ? (kept.notice ?? "") : "";
    expect(notice.endsWith("is not ours: left alone")).toBe(true);
    expect(notice).not.toContain("\u001b");
    expect(notice).not.toContain("\n");
  });
});

describe("hopDelete: D5", () => {
  const workload = { engine: "docker", name: "box" } as const;

  test("keep by default: nothing is deleted", () => {
    expect(hopDelete({ workload, keep: true, createdByHop: true })).toEqual({ kind: "keep" });
    expect(hopDelete({ workload, keep: true, createdByHop: false })).toEqual({ kind: "keep" });
  });

  test("--rm deletes ONLY what this hop created", () => {
    // Mutation: ignore `createdByHop` → a user-owned workload is deleted (D5).
    expect(hopDelete({ workload, keep: false, createdByHop: true })).toEqual({ kind: "delete" });
    expect(hopDelete({ workload, keep: false, createdByHop: false })).toEqual({
      kind: "keep",
      notice: "box is not ours: left alone",
    });
  });
});
