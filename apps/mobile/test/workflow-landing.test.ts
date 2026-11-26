/**
 * `workflow-landing.ts` (docs/feat/mobile-workflows-landing.md D7): the run
 * bands, which actions each file has, and the one line that says why an action is
 * dimmed.
 */
import { describe, expect, test } from "bun:test";
import type { WorkflowDefRow } from "@tentacle/protocol";
import {
  LANDING_BAD_NAME,
  LANDING_NO_SHEET,
  LANDING_OFFLINE,
  LANDING_OLD_DAEMON,
  type LandingContext,
  blockedWhy,
  landingItems,
  landingRuns,
  schedulesNotice,
} from "../src/workflow-landing.ts";
import type { ElencoRun } from "../src/workflow-list.ts";
import { catalogueRows, needsValues } from "../src/workflow-start.ts";

const HASH = "a".repeat(64);
const row = (name: string, over: Partial<WorkflowDefRow> = {}): WorkflowDefRow => ({
  name,
  path: `.tentacle/workflows/${name}.yaml`,
  ok: true,
  hash: HASH,
  approved: false,
  ...over,
});
const broken = (name: string): WorkflowDefRow => ({
  name,
  path: `.tentacle/workflows/${name}.yaml`,
  ok: false,
  errors: ["steps: required"],
});
const view = (rows: WorkflowDefRow[]) => catalogueRows({ workflows: rows, dir: "/p/w" });
const entryOf = (def: WorkflowDefRow) => {
  const entry = view([def]).valid[0];
  if (entry === undefined) {
    throw new Error("expected a valid row");
  }
  return entry;
};

const context = (over: Partial<LandingContext> = {}): LandingContext => ({
  offline: false,
  ready: true,
  canAnswer: true,
  actUnsupported: false,
  starting: false,
  busy: {},
  ...over,
});

const ids = (items: ReturnType<typeof landingItems>) =>
  items.map((i) => [i.name, i.actions.map((a) => a.id)]);
const enabled = (item: ReturnType<typeof landingItems>[number] | undefined) =>
  (item?.actions ?? []).filter((a) => a.enabled).map((a) => a.id);

describe("landingItems: which actions a file has", () => {
  test("Approve only when the daemon said approved:false; broken = Delete only", () => {
    const items = landingItems(
      view([
        row("a"),
        row("b", { approved: true }),
        row("c", { approved: undefined }),
        broken("d"),
      ]),
      context(),
      null,
    );
    expect(ids(items)).toEqual([
      ["a", ["start", "approve", "delete"]],
      ["b", ["start", "delete"]],
      ["c", ["start", "delete"]],
      ["d", ["delete"]],
    ]);
    expect(items.map((i) => i.status?.word ?? null)).toEqual([
      "Needs approval",
      "Approved",
      null,
      "Cannot run",
    ]);
    expect(items[3]?.errors).toEqual(["steps: required"]);
    expect(items.every((i) => i.why === null)).toBe(true);
    // In their drawn order, each said in a word; the look is the component's.
    expect(items.map((i) => i.actions.map((a) => a.label))).toEqual([
      ["Start", "Approve", "Delete"],
      ["Start", "Delete"],
      ["Start", "Delete"],
      ["Delete"],
    ]);
    expect(Object.keys(items[0]?.actions[0] ?? {}).sort()).toEqual(["enabled", "id", "label"]);
  });

  test("`summary` is the state and the description on one line", () => {
    const items = landingItems(
      view([
        row("a", { description: "Build and deploy\na preview" }),
        row("b", { approved: true }),
        row("c", { approved: undefined, description: "Plain" }),
        row("e", { approved: undefined }),
        broken("d"),
      ]),
      context(),
      null,
    );
    expect(items.map((i) => i.summary)).toEqual([
      "? Needs approval · Build and deploy a preview",
      "✓ Approved",
      "Plain",
      "",
      "✗ Cannot run",
    ]);
  });

  test("offline dims everything and repeats no reason (one banner says it)", () => {
    const [item] = landingItems(view([row("a")]), context({ offline: true }), null);
    expect(enabled(item)).toEqual([]);
    expect(item?.actions).toHaveLength(3);
    expect(item?.why).toBeNull();
    // Offline hides no OTHER reason by accident: the gate still refuses.
    expect(blockedWhy(entryOf(row("a")), "start", context({ offline: true }))).toBe(
      LANDING_OFFLINE,
    );
  });

  test("an older daemon dims Approve and Delete only", () => {
    const [item] = landingItems(view([row("a")]), context({ actUnsupported: true }), null);
    expect(enabled(item)).toEqual(["start"]);
    expect(item?.why).toBe(LANDING_OLD_DAEMON);
  });

  test("no Session screen: only Approve is dimmed (nobody could answer its ask)", () => {
    const [item] = landingItems(view([row("a")]), context({ canAnswer: false }), null);
    expect(enabled(item)).toEqual(["start", "delete"]);
    expect(item?.why).toBe(LANDING_NO_SHEET);
  });

  test("«Asking…» is said by the Approve button and blocks only it", () => {
    const rows = view([row("a"), row("b")]);
    const key = ".tentacle/workflows/a.yaml";
    const asking = landingItems(rows, context({ busy: { [key]: "asking" } }), null);
    expect(enabled(asking[0])).toEqual(["start", "delete"]);
    expect(asking[0]?.actions.map((a) => a.label)).toEqual(["Start", "Asking…", "Delete"]);
    expect(asking[0]?.why).toBeNull();
    expect(enabled(asking[1])).toEqual(["start", "approve", "delete"]);
    expect(asking[1]?.actions[1]?.label).toBe("Approve");
    // Another reason beside it is still said.
    const old = landingItems(
      rows,
      context({ busy: { [key]: "asking" }, actUnsupported: true }),
      null,
    );
    expect(old[0]?.why).toBe(LANDING_OLD_DAEMON);
  });

  test("a start or delete in flight dims its item; a start dims every Start", () => {
    const rows = view([row("a"), row("b")]);
    const key = ".tentacle/workflows/a.yaml";
    const deleting = landingItems(rows, context({ busy: { [key]: "deleting" } }), null);
    expect(enabled(deleting[0])).toEqual([]);
    expect(deleting[0]?.why).toBe("Deleting…");
    const starting = landingItems(
      rows,
      context({ starting: true, busy: { [key]: "starting" } }),
      null,
    );
    expect(enabled(starting[1])).toEqual(["approve", "delete"]);
    expect(starting[1]?.why).toBe("Starting…");
  });

  test("every dimmed action carries a why, offline excepted (the banner says it)", () => {
    const rows = view([row("a"), broken("b"), broken("Bad Name")]);
    const contexts = [
      context({ offline: true }),
      context({ ready: false }),
      context({ actUnsupported: true }),
      context({ canAnswer: false }),
      context({ starting: true }),
      context(),
    ];
    for (const each of contexts) {
      for (const item of landingItems(rows, each, null)) {
        const dimmed = item.actions.some((a) => !a.enabled);
        expect([item.name, item.why !== null]).toEqual([item.name, dimmed && !each.offline]);
      }
    }
    const bad = landingItems(rows, context(), null).find((i) => i.name === "Bad Name");
    expect(bad?.why).toBe(LANDING_BAD_NAME);
  });

  test("the delete question sits on the asked item only, naming the file", () => {
    const items = landingItems(view([row("a"), row("b")]), context(), ".tentacle/workflows/b.yaml");
    expect(items.map((i) => i.confirm)).toEqual([null, "Delete `b.yaml`? Its prompt files stay."]);
  });
});

describe("landingRuns: live runs on top, the rest counted", () => {
  const run = (runId: string, over: Partial<ElencoRun>): ElencoRun => ({
    runId,
    name: "task",
    state: "running",
    done: 0,
    total: 1,
    needsUser: false,
    startedAt: 1,
    sessionId: "s",
    ...over,
  });

  test("Needs you and In progress only; ended runs are the Recent runs count", () => {
    const bands = landingRuns(
      [
        run("wf-1", { state: "ok", endedAt: 2 }),
        run("wf-2", { state: "needs-approval", needsUser: true }),
        run("wf-3", {}),
        run("wf-4", { state: "error", endedAt: 3 }),
      ],
      10,
    );
    expect(bands.needYou).toHaveLength(1);
    expect(bands.inProgress).toHaveLength(1);
    expect(bands.recent).toBe(2);
  });
});

describe("needsValues and the schedules notice", () => {
  test("only a required input without a default asks for the form", () => {
    expect(needsValues({})).toBe(false);
    expect(needsValues({ inputs: [{ name: "a", required: false }] })).toBe(false);
    expect(needsValues({ inputs: [{ name: "a", required: true, default: "x" }] })).toBe(false);
    expect(needsValues({ inputs: [{ name: "a", required: true }] })).toBe(true);
  });

  test("the notice counts them, and says nothing for none", () => {
    expect(schedulesNotice("task", [])).toBeNull();
    expect(schedulesNotice("task", ["sc-1"])).toBe(
      "1 schedule still starts task — it will be skipped",
    );
    expect(schedulesNotice("task", ["sc-1", "sc-2"])).toBe(
      "2 schedules still start task — they will be skipped",
    );
  });
});
