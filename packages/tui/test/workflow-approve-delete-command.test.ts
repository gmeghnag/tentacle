/**
 * `/workflow approve <name>` and `/workflow delete <name> [confirm]`
 * (docs/feat/mobile-workflows-landing.md D6): the TUI's half of the phone's two
 * actions. Approve pins the hash the catalogue shows; a delete sends NOTHING
 * until it is confirmed.
 */
import { describe, expect, test } from "bun:test";
// The registry first: `commands/workflow.ts` sits in its import cycle.
import "../src/commands.ts";
import { command } from "../src/commands/workflow.ts";
import { WORKFLOW_USAGE, catalogueSection, parseWorkflowCommand } from "../src/workflow-view.ts";

const HASH = "a".repeat(64);
const row = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  ok: true,
  path: `.tentacle/workflows/${name}.yaml`,
  hash: HASH,
  approved: false,
  ...extra,
});
const broken = { name: "bad", ok: false, path: ".tentacle/workflows/bad.yaml", errors: ["x"] };
const catalogue = { dir: "/p/.tentacle/workflows", workflows: [row("task"), broken] };

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
};

type Ctx = Parameters<typeof command.run>[0];

function harness(replies: { approve?: unknown; remove?: unknown } = {}) {
  const sent: unknown[][] = [];
  const notices: string[] = [];
  const prefills: string[] = [];
  let refreshes = 0;
  const session = {
    onWorkflows: () => () => {},
    workflow: async () => ({ ok: true }),
    workflowApprove: async (...args: unknown[]) => {
      sent.push(["approve", ...args]);
      return replies.approve ?? { ok: true, asked: true };
    },
    workflowDelete: async (...args: unknown[]) => {
      sent.push(["delete", ...args]);
      return replies.remove ?? { ok: true, path: ".tentacle/workflows/task.yaml" };
    },
  };
  const ctx = {
    sessionRef: { current: session },
    workflowsRef: { current: undefined },
    workflowCatalogueRef: { current: catalogue },
    openPanel: () => {},
    pushNotice: (text: string) => void notices.push(text),
    prefill: (text: string) => void prefills.push(text),
    refreshCatalogue: () => {
      refreshes += 1;
    },
  } as unknown as Ctx;
  const run = async (line: string): Promise<void> => {
    command.run(ctx, line);
    await flush();
  };
  return { ctx, session, sent, notices, prefills, run, refreshes: () => refreshes };
}

describe("parseWorkflowCommand: approve and delete", () => {
  test("the shapes", () => {
    expect(parseWorkflowCommand("approve task")).toEqual({ kind: "approve", name: "task" });
    expect(parseWorkflowCommand("delete task")).toEqual({
      kind: "delete",
      name: "task",
      confirmed: false,
    });
    expect(parseWorkflowCommand("delete task confirm")).toEqual({
      kind: "delete",
      name: "task",
      confirmed: true,
    });
    for (const bad of ["approve", "approve a b", "delete", "delete a yes", "delete a confirm x"]) {
      expect(parseWorkflowCommand(bad)).toEqual({ kind: "refused", text: WORKFLOW_USAGE });
    }
  });

  test("the usage line and the catalogue section name both verbs", () => {
    expect(WORKFLOW_USAGE).toContain("approve <name>");
    expect(WORKFLOW_USAGE).toContain("delete <name>");
    const text = catalogueSection(catalogue, 120)
      .map((r) => r.text)
      .join("\n");
    expect(text).toContain("/workflow approve <name>");
    expect(text).toContain("/workflow delete <name>");
  });
});

describe("/workflow approve", () => {
  test("sends the name and the catalogue row's hash, and says the dialog is coming", async () => {
    const h = harness();
    await h.run("/workflow approve task");
    expect(h.sent).toEqual([["approve", "task", HASH]]);
    expect(h.notices.join()).toContain("Approval asked for task");
  });

  test("a name the catalogue does not have is refused: nothing sent", async () => {
    const h = harness();
    await h.run("/workflow approve nope");
    expect(h.sent).toEqual([]);
    expect(h.notices.join()).toContain("not in this project's workflows");
  });

  test("a broken row says its errors: nothing sent", async () => {
    const h = harness();
    await h.run("/workflow approve bad");
    expect(h.sent).toEqual([]);
    expect(h.notices.join()).toContain("x");
  });

  test("already approved, a refusal and an older daemon each say so", async () => {
    const approved = harness({ approve: { ok: true, approved: true } });
    await approved.run("/workflow approve task");
    expect(approved.notices.join()).toContain("task is already approved");
    const running = harness({
      approve: { ok: false, refusal: "running", reason: "task (wf-2) is waiting", runId: "wf-2" },
    });
    await running.run("/workflow approve task");
    expect(running.notices.join()).toContain("wf-2");
    const old = harness({ approve: { unsupported: true } });
    await old.run("/workflow approve task");
    expect(old.notices.join()).toContain("update tentacle");
  });
});

describe("/workflow delete", () => {
  test("without `confirm` sends NOTHING and pre-fills the confirming line", async () => {
    const h = harness();
    await h.run("/workflow delete task");
    expect(h.sent).toEqual([]);
    expect(h.prefills).toEqual(["/workflow delete task confirm"]);
    expect(h.notices.join()).toContain(
      "Deletes .tentacle/workflows/task.yaml (prompt files stay) — press enter to confirm",
    );
  });

  test("with `confirm` sends the row's hash (none for a broken row) and re-reads", async () => {
    const h = harness();
    await h.run("/workflow delete task confirm");
    const before = h.refreshes();
    await h.run("/workflow delete bad confirm");
    expect(h.sent).toEqual([
      ["delete", "task", HASH],
      ["delete", "bad", undefined],
    ]);
    expect(h.notices.join()).toContain("Deleted .tentacle/workflows/task.yaml");
    // One read for the command, one after the answer.
    expect(h.refreshes() - before).toBe(2);
  });

  test("schedules that still start it are said", async () => {
    const h = harness({
      remove: { ok: true, path: ".tentacle/workflows/task.yaml", schedules: ["sc-1", "sc-2"] },
    });
    await h.run("/workflow delete task confirm");
    expect(h.notices.join()).toContain("2 schedules still start task — they will be skipped");
  });

  test("an unknown name is refused before any prompt; a refusal says its reason", async () => {
    const h = harness({ remove: { ok: false, refusal: "changed", reason: "it moved" } });
    await h.run("/workflow delete nope");
    await h.run("/workflow delete nope confirm");
    expect(h.sent).toEqual([]);
    expect(h.prefills).toEqual([]);
    await h.run("/workflow delete task confirm");
    expect(h.notices.join()).toContain("it moved");
  });

  test("a session that cannot (no seam) says so", async () => {
    const h = harness();
    Reflect.deleteProperty(h.session, "workflowApprove");
    Reflect.deleteProperty(h.session, "workflowDelete");
    await h.run("/workflow approve task");
    await h.run("/workflow delete task confirm");
    expect(h.sent).toEqual([]);
    expect(h.notices).toHaveLength(2);
  });
});
