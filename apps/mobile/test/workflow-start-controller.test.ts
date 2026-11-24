/**
 * `workflow-start-controller.ts` (docs/feat/workflows-ui.md D6, slice 5b): the
 * attach (never `reopen`), the catalogue read and its states, the inputs form,
 * Start's gate, and what a refusal does — `changed` reloads keeping the values
 * that still exist, `running` opens the run that holds the slot. Nothing lands
 * after `dispose`, one read/start in flight at a time.
 */
import { describe, expect, test } from "bun:test";
import type { WorkflowAction } from "@tentacle/client";
import type { WorkflowCatalogueResult, WorkflowDefRow, WorkflowResult } from "@tentacle/protocol";
import { SESSION_ENDED } from "../src/workflow-run-controller.ts";
import {
  type StartSessionHandle,
  type StartState,
  createWorkflowStartController,
} from "../src/workflow-start-controller.ts";
import { startBannerChanged } from "../src/workflow-start.ts";

const HASH = "a".repeat(64);

const row = (over: Partial<WorkflowDefRow> = {}): WorkflowDefRow => ({
  name: "demo",
  // The row's KEY is its path: a fixture with two rows must not share one.
  path: `.tentacle/workflows/${over.name ?? "demo"}.yaml`,
  ok: true,
  version: 1,
  hash: HASH,
  approved: false,
  inputs: [
    { name: "slug", required: true },
    { name: "note", required: false, default: "hello" },
  ],
  steps: [{ id: "build", kind: "agent", where: "local" }],
  ...over,
});

const catalogue = (over: Partial<WorkflowCatalogueResult> = {}): WorkflowCatalogueResult => ({
  workflows: [row()],
  dir: "/work/proj/.tentacle/workflows",
  ...over,
});

/** The `unsupported` answer an older daemon gives (no `workflow_catalogue`). */
const UNSUPPORTED = { unsupported: true } as const;

function harness(
  opts: {
    open?: "ok" | "archived" | "gone" | "link";
    borrowed?: boolean;
    /** Each catalogue read answers with the next of these (the last one repeats). */
    reads?: readonly (WorkflowCatalogueResult | { unsupported: true })[];
    /** A read that never answers, until the test settles it. */
    hangFirstRead?: boolean;
    reply?: WorkflowResult | { ok: false; reason: string };
  } = {},
) {
  const reads = [...(opts.reads ?? [catalogue()])];
  const readKeys: string[] = [];
  const sent: WorkflowAction[] = [];
  const openCalls: unknown[][] = [];
  const runs: { runId: string; name: string }[] = [];
  let leaves = 0;
  let changes = 0;
  let settle: ((value: WorkflowCatalogueResult | { unsupported: true }) => void) | null = null;
  let first = true;
  const session: StartSessionHandle = {
    workflowCatalogue() {
      readKeys.push("read");
      if (opts.hangFirstRead === true && first) {
        first = false;
        return new Promise((resolve) => {
          settle = resolve;
        });
      }
      const next = reads.length > 1 ? reads.shift() : reads[0];
      return Promise.resolve(next ?? catalogue());
    },
    async workflow(action: WorkflowAction) {
      sent.push(action);
      return opts.reply ?? { ok: true, runId: "wf-1" };
    },
  };
  const controller = createWorkflowStartController({
    sessionId: "s1",
    open: async (...args: unknown[]) => {
      openCalls.push(args);
      const o = opts.open ?? "ok";
      return o === "ok" ? { ok: true as const, session } : { ok: false as const, reason: o };
    },
    leave: () => {
      leaves += 1;
    },
    borrowed: opts.borrowed ?? false,
    onOpenRun: (runId, name) => {
      runs.push({ runId, name });
    },
    onChange: () => {
      changes += 1;
    },
  });
  const flush = async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  };
  return {
    controller,
    flush,
    settle: (value: WorkflowCatalogueResult | { unsupported: true }) => settle?.(value),
    sent,
    openCalls,
    runs,
    readKeys,
    get leaves() {
      return leaves;
    },
    get changes() {
      return changes;
    },
    state: (): StartState => controller.state(),
  };
}

/** Open, read, and open the demo row — everything a tap sequence does. */
async function opened(h: ReturnType<typeof harness>): Promise<void> {
  h.controller.start();
  await h.flush();
  h.controller.openRow(".tentacle/workflows/demo.yaml");
}

describe("the attach", () => {
  test("opens the session WITHOUT reopen, then reads the catalogue", async () => {
    const h = harness();
    h.controller.start();
    await h.flush();
    expect(h.openCalls).toEqual([["s1"]]);
    expect(h.readKeys).toHaveLength(1);
    expect(h.state().kind).toBe("ready");
    expect(h.state().catalogue?.valid.map((e) => e.name)).toEqual(["demo"]);
  });

  test("a session that ended between the list and the tap says so — it is never reopened", async () => {
    for (const reason of ["archived", "gone"] as const) {
      const h = harness({ open: reason });
      h.controller.start();
      await h.flush();
      expect(h.state().kind).toBe("ended");
      expect(h.state().error).toBe(SESSION_ENDED);
      expect(h.readKeys).toHaveLength(0);
    }
  });

  test("a link failure is its own state with its reason", async () => {
    const h = harness({ open: "link" });
    h.controller.start();
    await h.flush();
    expect(h.state().kind).toBe("failed");
    expect(h.state().error).toContain("link");
    expect(h.state().catalogue).toBeNull();
  });

  test("an older daemon is `unsupported`, never an empty folder", async () => {
    const h = harness({ reads: [UNSUPPORTED] });
    h.controller.start();
    await h.flush();
    expect(h.state().kind).toBe("unsupported");
    expect(h.state().catalogue?.kind).toBe("unsupported");
  });

  test("a session that cannot run workflows says WHY, apart from an empty folder", async () => {
    const h = harness({ reads: [catalogue({ workflows: [], unavailable: "a pod cannot" })] });
    h.controller.start();
    await h.flush();
    expect(h.state().kind).toBe("unavailable");
    expect(h.state().catalogue?.kind).toBe("unavailable");
    expect(h.state().catalogue?.reason).toBe("a pod cannot");
  });

  test("an empty folder is `ready` with no rows (the screen says the folder is empty)", async () => {
    const h = harness({ reads: [catalogue({ workflows: [] })] });
    h.controller.start();
    await h.flush();
    expect(h.state().kind).toBe("ready");
    expect(h.state().catalogue?.kind).toBe("empty");
  });

  test("leaving detaches a session this screen opened — never one another screen follows", async () => {
    const own = harness();
    own.controller.start();
    await own.flush();
    own.controller.dispose();
    expect(own.leaves).toBe(1);

    const borrowed = harness({ borrowed: true });
    borrowed.controller.start();
    await borrowed.flush();
    borrowed.controller.dispose();
    expect(borrowed.leaves).toBe(0);
  });
});

describe("the form", () => {
  test("opening a row prefills the file's default and asks Start only for what is missing", async () => {
    const h = harness();
    await opened(h);
    expect(h.state().openKey).toBe(".tentacle/workflows/demo.yaml");
    expect(h.state().values).toEqual({ slug: "", note: "hello" });
    expect(h.state().problems.map((p) => p.field)).toEqual(["slug"]);
    expect(h.controller.canStart()).toBe(false);

    h.controller.setValue("slug", "s1");
    expect(h.state().problems).toEqual([]);
    expect(h.controller.canStart()).toBe(true);
  });

  test('an optional field emptied to whitespace is fine (it is omitted, not sent as `""`)', async () => {
    const h = harness();
    await opened(h);
    h.controller.setValue("slug", "s1");
    h.controller.setValue("note", "   ");
    expect(h.state().problems).toEqual([]);
    expect(h.controller.canStart()).toBe(true);
    h.controller.beginStart();
    await h.flush();
    expect(h.sent[0]).toEqual({
      action: "start",
      name: "demo",
      hash: HASH,
      inputs: [{ name: "slug", value: "s1" }],
    });
  });

  test("a broken row and a row with no hash can never start", async () => {
    const h = harness({
      reads: [
        catalogue({
          workflows: [
            row({ name: "broken", ok: false, errors: ["version: bad"], hash: undefined }),
            // No required input: the HASH alone must be what blocks this row.
            row({ name: "nohash", hash: undefined, inputs: [] }),
          ],
        }),
      ],
    });
    h.controller.start();
    await h.flush();
    // A broken row is not even openable as a form.
    h.controller.openRow(".tentacle/workflows/broken.yaml");
    expect(h.state().openKey).toBeNull();
    expect(h.controller.canStart()).toBe(false);
    h.controller.openRow(".tentacle/workflows/nohash.yaml");
    expect(h.state().openKey).toBe(".tentacle/workflows/nohash.yaml");
    expect(h.controller.canStart()).toBe(false);
    h.controller.beginStart();
    await h.flush();
    expect(h.sent).toEqual([]);
  });
});

describe("Start", () => {
  test("a start in flight disables Start and a second tap sends NOTHING", async () => {
    const sent: WorkflowAction[] = [];
    let release: (value: WorkflowResult) => void = () => undefined;
    const session: StartSessionHandle = {
      workflowCatalogue: () => Promise.resolve(catalogue()),
      workflow: (action) => {
        sent.push(action);
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    };
    const controller = createWorkflowStartController({
      sessionId: "s1",
      open: () => Promise.resolve({ ok: true, session }),
      leave: () => undefined,
      borrowed: false,
      onOpenRun: () => undefined,
    });
    const flush = async () => {
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    };
    controller.start();
    await flush();
    controller.openRow(".tentacle/workflows/demo.yaml");
    controller.setValue("slug", "s1");
    controller.beginStart();
    await flush();
    expect(controller.state().starting).toBe(true);
    expect(controller.canStart()).toBe(false);
    controller.beginStart();
    await flush();
    expect(sent).toHaveLength(1);
    release({ ok: true, runId: "wf-1" });
    await flush();
    expect(controller.state().starting).toBe(false);
  });

  test("on ok the run screen opens with the new id", async () => {
    const h = harness({ reply: { ok: true, runId: "wf-9" } });
    await opened(h);
    h.controller.setValue("slug", "s1");
    h.controller.beginStart();
    await h.flush();
    expect(h.runs).toEqual([{ runId: "wf-9", name: "demo" }]);
  });

  test("an ok with no run id is a notice, not a navigation to nowhere", async () => {
    const h = harness({ reply: { ok: true } });
    await opened(h);
    h.controller.setValue("slug", "s1");
    h.controller.beginStart();
    await h.flush();
    expect(h.runs).toEqual([]);
    expect(h.state().notice).not.toBeNull();
  });

  test("a start refused `changed` re-reads the catalogue and says so", async () => {
    const h = harness({
      reads: [catalogue(), catalogue({ workflows: [row({ description: "edited" })] })],
      reply: { ok: false, refusal: "changed", reason: "workflows/demo.yaml changed" },
    });
    await opened(h);
    h.controller.setValue("slug", "s1");
    h.controller.setValue("note", "typed");
    h.controller.beginStart();
    await h.flush();
    expect(h.readKeys).toHaveLength(2);
    expect(h.state().banner).toBe(startBannerChanged);
    expect(h.state().notice).toBeNull();
    // The reload kept what was typed (both inputs still exist).
    expect(h.state().values).toEqual({ slug: "s1", note: "typed" });
    // …and the screen no longer claims Start is possible without a fresh review.
    expect(h.controller.canStart()).toBe(true);
  });

  test("a `changed` reload DROPS the value of an input the file no longer declares", async () => {
    const h = harness({
      reads: [
        catalogue(),
        catalogue({
          workflows: [
            row({
              inputs: [{ name: "slug", required: true }],
            }),
          ],
        }),
      ],
      reply: { ok: false, refusal: "changed", reason: "changed" },
    });
    await opened(h);
    h.controller.setValue("slug", "s1");
    h.controller.setValue("note", "typed");
    h.controller.beginStart();
    await h.flush();
    expect(h.state().values).toEqual({ slug: "s1" });
    expect(h.state().values.note).toBeUndefined();
  });

  test("a start refused `running` shows the notice AND opens that run", async () => {
    const h = harness({
      reply: { ok: false, refusal: "running", runId: "wf-7", reason: "already running" },
    });
    await opened(h);
    h.controller.setValue("slug", "s1");
    h.controller.beginStart();
    await h.flush();
    expect(h.runs).toEqual([{ runId: "wf-7", name: "demo" }]);
    expect(h.state().notice).toBe("Workflow demo is already running");
    expect(h.state().banner).toBeNull();
    // The values and the open row survive: coming back must not lose the form.
    expect(h.state().values.slug).toBe("s1");
    expect(h.state().openKey).toBe(".tentacle/workflows/demo.yaml");
  });

  test("any other refusal is the daemon's own reason", async () => {
    const h = harness({
      reply: { ok: false, refusal: "inputs", reason: "missing required input(s): slug" },
    });
    await opened(h);
    h.controller.setValue("slug", "s1");
    h.controller.beginStart();
    await h.flush();
    expect(h.state().notice).toBe("missing required input(s): slug");
    expect(h.runs).toEqual([]);
  });
});

describe("reads", () => {
  test("one read in flight: a pull during a read is ONE more read after it", async () => {
    const h = harness({ hangFirstRead: true });
    h.controller.start();
    await h.flush();
    expect(h.state().kind).toBe("loading");
    h.controller.pull();
    await h.flush();
    expect(h.readKeys).toHaveLength(1);
    h.settle(catalogue());
    await h.flush();
    expect(h.readKeys).toHaveLength(2);
    expect(h.state().kind).toBe("ready");
  });

  test("a failed read keeps the last catalogue and says so (never a spinner loop)", async () => {
    let attempt = 0;
    const session: StartSessionHandle = {
      workflowCatalogue: () => {
        attempt += 1;
        return attempt === 1
          ? Promise.resolve(catalogue())
          : Promise.reject(new Error("link down"));
      },
      workflow: () => Promise.resolve({ ok: true, runId: "wf-1" }),
    };
    const controller = createWorkflowStartController({
      sessionId: "s1",
      open: () => Promise.resolve({ ok: true, session }),
      leave: () => undefined,
      borrowed: false,
      onOpenRun: () => undefined,
    });
    const flush = async () => {
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    };
    controller.start();
    await flush();
    controller.pull();
    await flush();
    expect(attempt).toBe(2);
    expect(controller.state().kind).toBe("ready");
    expect(controller.state().catalogue?.valid.map((e) => e.name)).toEqual(["demo"]);
    expect(controller.state().notice).toContain("link down");
  });

  test("no answer at all (`{unsupported:true}` → a kept form) never starts a spinner loop", async () => {
    const h = harness({ reads: [catalogue(), UNSUPPORTED] });
    h.controller.start();
    await h.flush();
    h.controller.pull();
    await h.flush();
    expect(h.state().kind).toBe("unsupported");
    expect(h.readKeys).toHaveLength(2);
  });
});

describe("dispose", () => {
  test("nothing lands after dispose: a late catalogue read paints nothing", async () => {
    const h = harness({ hangFirstRead: true });
    h.controller.start();
    await h.flush();
    expect(h.state().kind).toBe("loading");
    const before = h.changes;
    h.controller.dispose();
    h.settle(catalogue());
    await h.flush();
    expect(h.changes).toBe(before);
    // Still the frame it was disposed on: no catalogue, no rows.
    expect(h.state().kind).toBe("loading");
    expect(h.state().catalogue).toBeNull();
  });

  test("nothing lands after dispose: a late start result neither navigates nor notices", async () => {
    const h = harness();
    await opened(h);
    h.controller.setValue("slug", "s1");
    h.controller.beginStart();
    const before = h.changes;
    h.controller.dispose();
    await h.flush();
    expect(h.runs).toEqual([]);
    expect(h.changes).toBe(before);
    expect(h.state().notice).toBeNull();
  });
});
