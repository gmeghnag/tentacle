/**
 * The landing's actions on `workflow-start-controller.ts`
 * (docs/feat/mobile-workflows-landing.md D7.4–7): Start now or the form,
 * Approve → «Asking…» → the ask leaves the sheet → one re-read, the two-step
 * delete, and a dimmed action that sends nothing.
 */
import { describe, expect, test } from "bun:test";
import type { WorkflowAction } from "@tentacle/client";
import type {
  WorkflowApproveResult,
  WorkflowCatalogueResult,
  WorkflowDefRow,
  WorkflowDeleteResult,
  WorkflowResult,
} from "@tentacle/protocol";
import type { CardAsk } from "../src/workflow-run-controller.ts";
import {
  type StartSessionHandle,
  createWorkflowStartController,
} from "../src/workflow-start-controller.ts";
import { startBannerChanged } from "../src/workflow-start.ts";

const HASH = "a".repeat(64);
const KEY = ".tentacle/workflows/demo.yaml";
const BROKEN_KEY = ".tentacle/workflows/bad.yaml";

const row = (over: Partial<WorkflowDefRow> = {}): WorkflowDefRow => ({
  name: "demo",
  path: `.tentacle/workflows/${over.name ?? "demo"}.yaml`,
  ok: true,
  hash: HASH,
  approved: false,
  ...over,
});
const brokenRow: WorkflowDefRow = { name: "bad", path: BROKEN_KEY, ok: false, errors: ["x"] };
const catalogue = (rows: WorkflowDefRow[] = [row(), brokenRow]): WorkflowCatalogueResult => ({
  workflows: rows,
  dir: "/p/.tentacle/workflows",
});

/** The approval ask a file's Approve raises (no run). */
const approvalAsk = (requestId: string, name = "demo"): CardAsk => ({
  requestId,
  agent: { id: `approval:${name}` },
  origin: { kind: "workflow", name, runId: null, stepId: null, position: null },
  title: `Approve workflow ${name}`,
  detail: "",
});

type Reply<T> = T | { unsupported: true } | Promise<T>;

async function harness(
  opts: {
    reads?: WorkflowCatalogueResult[];
    approve?: Reply<WorkflowApproveResult>;
    remove?: Reply<WorkflowDeleteResult>;
    start?: WorkflowResult;
    noSheet?: boolean;
  } = {},
) {
  const reads = [...(opts.reads ?? [catalogue()])];
  let readCount = 0;
  const sent: unknown[][] = [];
  const runs: string[] = [];
  let current: CardAsk | null = null;
  const listeners = new Set<() => void>();
  const session: StartSessionHandle = {
    async workflowCatalogue() {
      readCount += 1;
      const next = reads.length > 1 ? reads.shift() : reads[0];
      return next ?? catalogue();
    },
    async workflow(action: WorkflowAction) {
      sent.push(["workflow", action]);
      return opts.start ?? { ok: true, runId: "wf-1" };
    },
    async workflowApprove(name: string, hash: string) {
      sent.push(["approve", name, hash]);
      return opts.approve ?? { ok: true, asked: true as const };
    },
    async workflowDelete(name: string, hash?: string) {
      sent.push(["delete", name, hash]);
      return opts.remove ?? { ok: true, path: `.tentacle/workflows/${name}.yaml` };
    },
  };
  const controller = createWorkflowStartController({
    sessionId: "s1",
    open: async () => ({ ok: true as const, session }),
    leave: () => {},
    borrowed: true,
    onOpenRun: (runId) => runs.push(runId),
    asks:
      opts.noSheet === true
        ? null
        : {
            current: () => current,
            subscribe: (listener: () => void) => {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
          },
  });
  const flush = async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  };
  controller.start();
  await flush();
  const sheet = async (ask: CardAsk | null) => {
    current = ask;
    for (const listener of [...listeners]) listener();
    await flush();
  };
  return {
    controller,
    flush,
    sheet,
    sent,
    runs,
    listeners,
    reads: () => readCount,
    state: () => controller.state(),
  };
}

describe("Start from the list", () => {
  test("no input needs a value: starts at once, pinned to the hash, and opens the run", async () => {
    const h = await harness({
      reads: [catalogue([row({ inputs: [{ name: "n", required: false, default: "1" }] })])],
    });
    h.controller.startNow(KEY);
    await h.flush();
    expect(h.sent).toEqual([
      [
        "workflow",
        { action: "start", name: "demo", hash: HASH, inputs: [{ name: "n", value: "1" }] },
      ],
    ]);
    expect(h.runs).toEqual(["wf-1"]);
    expect(h.state().openKey).toBeNull();
    expect(h.state().busy).toEqual({});
  });

  test("an input that needs a value opens the form instead: nothing sent", async () => {
    const h = await harness({
      reads: [catalogue([row({ inputs: [{ name: "slug", required: true }] })])],
    });
    h.controller.startNow(KEY);
    await h.flush();
    expect(h.sent).toEqual([]);
    expect(h.state().openKey).toBe(KEY);
  });

  test("two taps are one start; a `changed` refusal re-reads and says so", async () => {
    const h = await harness({ start: { ok: false, refusal: "changed" } });
    h.controller.startNow(KEY);
    h.controller.startNow(KEY);
    await h.flush();
    expect(h.sent).toHaveLength(1);
    expect(h.state().banner).toBe(startBannerChanged);
    expect(h.reads()).toBe(2);
    expect(h.state().busy).toEqual({});
  });
});

describe("Approve", () => {
  test("«Asking…» until the ask leaves the sheet, then ONE re-read", async () => {
    const h = await harness();
    h.controller.approve(KEY);
    expect(h.state().busy).toEqual({ [KEY]: "asking" });
    await h.flush();
    expect(h.sent).toEqual([["approve", "demo", HASH]]);
    await h.sheet(approvalAsk("r1"));
    // The same ask again (a re-render, a park) is not an edge.
    await h.sheet(approvalAsk("r1"));
    expect(h.state().busy).toEqual({ [KEY]: "asking" });
    expect(h.reads()).toBe(1);
    await h.sheet(null);
    expect(h.state().busy).toEqual({});
    expect(h.reads()).toBe(2);
    await h.sheet(null);
    expect(h.reads()).toBe(2);
  });

  test("another ask leaving the sheet is not this one's edge", async () => {
    const h = await harness();
    h.controller.approve(KEY);
    await h.flush();
    await h.sheet({ requestId: "m", origin: { kind: "main" }, title: "shell", detail: "" });
    await h.sheet(null);
    expect(h.state().busy).toEqual({ [KEY]: "asking" });
    expect(h.reads()).toBe(1);
  });

  test("an ask answered BEFORE the reply lands leaves nothing stuck", async () => {
    let answer: (result: WorkflowApproveResult) => void = () => {};
    const h = await harness({
      approve: new Promise<WorkflowApproveResult>((resolve) => {
        answer = resolve;
      }),
    });
    h.controller.approve(KEY);
    await h.sheet(approvalAsk("r1"));
    await h.sheet(null);
    answer({ ok: true, asked: true });
    await h.flush();
    expect(h.state().busy).toEqual({});
  });

  test("already approved re-reads at once", async () => {
    const h = await harness({ approve: { ok: true, approved: true } });
    h.controller.approve(KEY);
    await h.flush();
    expect(h.state().busy).toEqual({});
    expect(h.reads()).toBe(2);
  });

  test("a read that says approved ends «Asking…» (an answer nobody here saw)", async () => {
    const h = await harness({ reads: [catalogue(), catalogue([row({ approved: true })])] });
    h.controller.approve(KEY);
    await h.flush();
    h.controller.pull();
    await h.flush();
    expect(h.state().busy).toEqual({});
  });

  test("refusals branch on the word: changed, running, anything else", async () => {
    const changed = await harness({ approve: { ok: false, refusal: "changed" } });
    changed.controller.approve(KEY);
    await changed.flush();
    expect(changed.state().banner).toBe(startBannerChanged);
    expect(changed.reads()).toBe(2);
    const running = await harness({
      approve: { ok: false, refusal: "running", runId: "wf-7" },
    });
    running.controller.approve(KEY);
    await running.flush();
    expect(running.runs).toEqual(["wf-7"]);
    expect(running.state().busy).toEqual({});
    const other = await harness({
      approve: { ok: false, refusal: "invalid", reason: "steps: required" },
    });
    other.controller.approve(KEY);
    await other.flush();
    expect(other.state().notice).toBe("steps: required");
    expect(other.state().busy).toEqual({});
    expect(other.reads()).toBe(2);
  });

  test("an older daemon dims approve and delete for good", async () => {
    const h = await harness({ approve: { unsupported: true } });
    h.controller.approve(KEY);
    await h.flush();
    expect(h.state().actUnsupported).toBe(true);
    h.controller.approve(KEY);
    h.controller.askDelete(KEY);
    await h.flush();
    expect(h.sent).toHaveLength(1);
    expect(h.state().confirm).toBeNull();
  });

  test("nothing is sent with no sheet, offline, or for an approved or broken file", async () => {
    const noSheet = await harness({ noSheet: true });
    noSheet.controller.approve(KEY);
    expect(noSheet.sent).toEqual([]);
    const offline = await harness();
    offline.controller.setOffline(true);
    offline.controller.approve(KEY);
    offline.controller.startNow(KEY);
    offline.controller.askDelete(KEY);
    expect(offline.sent).toEqual([]);
    expect(offline.state().confirm).toBeNull();
    const done = await harness({ reads: [catalogue([row({ approved: true }), brokenRow])] });
    done.controller.approve(KEY);
    done.controller.approve(BROKEN_KEY);
    expect(done.sent).toEqual([]);
  });

  test("back online: «Asking…» is cleared and the list re-read once", async () => {
    const h = await harness();
    h.controller.approve(KEY);
    await h.flush();
    h.controller.setOffline(true);
    h.controller.setOffline(false);
    h.controller.setOffline(false);
    await h.flush();
    expect(h.state().busy).toEqual({});
    expect(h.reads()).toBe(2);
  });

  test("a lost link says so and frees the item", async () => {
    const h = await harness({ approve: Promise.reject(new Error("link down")) });
    h.controller.approve(KEY);
    await h.flush();
    expect(h.state().notice).toContain("link down");
    expect(h.state().busy).toEqual({});
  });

  test("dispose drops the sheet subscription", async () => {
    const h = await harness();
    expect(h.listeners.size).toBe(1);
    h.controller.dispose();
    expect(h.listeners.size).toBe(0);
  });
});

describe("Delete", () => {
  test("asks first; Cancel sends nothing", async () => {
    const h = await harness();
    h.controller.confirmDelete(KEY);
    expect(h.sent).toEqual([]);
    h.controller.askDelete(KEY);
    expect(h.state().confirm).toBe(KEY);
    h.controller.cancelDelete();
    expect(h.state().confirm).toBeNull();
    h.controller.confirmDelete(KEY);
    await h.flush();
    expect(h.sent).toEqual([]);
  });

  test("confirm sends the hash SEEN when it was asked (none for a broken file), re-reads", async () => {
    const h = await harness({
      reads: [catalogue(), catalogue([row({ hash: "b".repeat(64) }), brokenRow])],
    });
    h.controller.askDelete(KEY);
    // A re-read lands under the question: the hash asked about stays pinned.
    h.controller.pull();
    await h.flush();
    h.controller.confirmDelete(KEY);
    await h.flush();
    h.controller.askDelete(BROKEN_KEY);
    h.controller.confirmDelete(BROKEN_KEY);
    await h.flush();
    expect(h.sent).toEqual([
      ["delete", "demo", HASH],
      ["delete", "bad", undefined],
    ]);
    expect(h.reads()).toBe(4);
    expect(h.state().busy).toEqual({});
  });

  test("schedules left behind are said", async () => {
    const h = await harness({ remove: { ok: true, schedules: ["sc-1", "sc-2"] } });
    h.controller.askDelete(KEY);
    h.controller.confirmDelete(KEY);
    await h.flush();
    expect(h.state().notice).toBe("2 schedules still start demo — they will be skipped");
  });

  test("changed / gone / running: the reason, a re-read, nothing navigated", async () => {
    for (const refusal of ["changed", "gone", "running"]) {
      const h = await harness({ remove: { ok: false, refusal, reason: `why ${refusal}` } });
      h.controller.askDelete(KEY);
      h.controller.confirmDelete(KEY);
      await h.flush();
      expect(h.state().notice).toBe(`why ${refusal}`);
      expect(h.reads()).toBe(2);
      expect(h.runs).toEqual([]);
    }
  });

  test("a row that left the catalogue takes its question with it", async () => {
    const h = await harness({ reads: [catalogue(), catalogue([brokenRow])] });
    h.controller.askDelete(KEY);
    h.controller.pull();
    await h.flush();
    expect(h.state().confirm).toBeNull();
  });
});
