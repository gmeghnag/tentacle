/**
 * docs/feat/workflows-ui.md slice 5a (D6) — the catalogue and the start-by-hash
 * contract. Three properties, each pinned by a mutation:
 *
 * 1. **A catalogue ASKS nothing and STARTS nothing.** It is a read: the driver's
 *    spy broker must see zero requests and no run may appear (mutation: route the
 *    hash check through `approveHash` → red).
 * 2. **A stale `hash` refuses the start.** `changed`, zero asks, no row
 *    (mutation: drop the hash comparison → red).
 * 3. **A current `hash` on an unapproved file asks exactly ONCE, through the
 *    session's ONE requester** — never a private one (mutation: build the ask
 *    with `deps.request` directly instead of the run's requester → the
 *    attribution/`SpyBroker` assertions go red).
 */
import { describe, expect, test } from "bun:test";
import type { PermissionRequest, PermissionRequester, PermissionResponse } from "@tentacle/core";
import {
  WorkflowDriver,
  type WorkflowDriverDeps,
  type WorkflowHost,
  type WorkflowListing,
  type WorkflowRow,
  type WorkflowSource,
  type WorkflowSourceRow,
} from "../src/workflow-driver.ts";

const YAML = (body: string, extra = ""): string =>
  `schemaVersion: 1\nname: task\nversion: 3${extra}\nsteps:\n${body}`;
const TWO_AGENTS = YAML(
  "  - id: plan\n    agent: { prompt_text: plan it }\n  - id: exec\n    agent: { prompt_text: do it, model: opus }\n",
);
const BROKEN = "schemaVersion: 1\nname: task\nversion: 0\nsteps: []\n";

interface Ask {
  readonly req: PermissionRequest;
  answer(response: PermissionResponse): void;
}

/** The session's ONE requester: records every ask, answered by the test. */
class SpyBroker {
  readonly asks: Ask[] = [];
  readonly request: PermissionRequester = (req, options) =>
    new Promise<PermissionResponse>((resolve) => {
      options?.signal?.addEventListener(
        "abort",
        () => resolve({ allowed: false, dismissed: true }),
        {
          once: true,
        },
      );
      this.asks.push({ req, answer: resolve });
    });
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
};

function setup(
  over: {
    readonly rows?: readonly WorkflowSourceRow[];
    readonly dir?: string;
    readonly truncated?: boolean;
    /** Every hash counts as already approved (`approvals.has` true), for the non-ask tests. */
    readonly approved?: boolean;
    readonly listing?: () => Promise<WorkflowListing>;
  } = {},
) {
  const broker = new SpyBroker();
  const approvals = new Set<string>();
  const sources = new Map<string, WorkflowSource>();
  for (const row of over.rows ?? []) {
    if (row.kind === "source") {
      sources.set(row.name, row.source);
    }
  }
  const host = {
    rows: [] as WorkflowRow[][],
    entries: [] as { type: string; body: Record<string, unknown> }[],
  };
  const hostImpl: WorkflowHost = {
    logStart: (body) => host.entries.push({ type: "workflow_start", body }),
    logStep: (body) => host.entries.push({ type: "workflow_step", body }),
    logEnd: (body) => host.entries.push({ type: "workflow_end", body }),
    attribute: () => {},
    release: () => {},
    publish: (rows) => host.rows.push([...rows]),
    ended: () => {},
  };
  const listing: () => Promise<WorkflowListing> =
    over.listing ??
    (async () => ({
      dir: over.dir ?? "/proj/.tentacle/workflows",
      rows: over.rows ?? [],
      truncated: over.truncated ?? false,
    }));
  const required: WorkflowDriverDeps = {
    load: async (name) => {
      const source = sources.get(name);
      if (source === undefined) {
        throw new Error(`no workflow ${name}`);
      }
      return source;
    },
    list: listing,
    context: () => ({ models: ["opus", "deepseek"], agentTypes: ["general"] }),
    approvals: {
      has: async (path, hash) => over.approved === true || approvals.has(`${path}#${hash}`),
      add: async (path, hash) => void approvals.add(`${path}#${hash}`),
    },
    request: broker.request,
    runnerFor: () => async () => ({ report: "ok", toolUses: 1, stopReason: "end_turn" }),
  };
  const driver = new WorkflowDriver(required);
  driver.bind(hostImpl);
  const withApproval = async (path: string, hash: string): Promise<void> => {
    approvals.add(`${path}#${hash}`);
  };
  return { driver, broker, host, approvals, withApproval, required };
}

const sourceRow = (name: string, text: string): WorkflowSourceRow => ({
  kind: "source",
  name,
  source: { path: `.tentacle/workflows/${name}.yaml`, text, prompts: {} },
});

describe("catalogue (D6)", () => {
  test("valid rows carry the hash of the SAME bytes start{hash} checks, and the approval", async () => {
    const { driver, withApproval } = setup({ rows: [sourceRow("task", TWO_AGENTS)] });
    const first = await driver.catalogue();
    const row = first.workflows[0];
    expect(row?.ok).toBe(true);
    expect(row?.name).toBe("task");
    expect(row?.path).toBe(".tentacle/workflows/task.yaml");
    expect(row?.version).toBe(3);
    expect(row?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.approved).toBe(false);
    // The hash a start is given is the catalogue's: an approved hash starts
    // without an ask, and the two values are the same string.
    if (row?.hash === undefined) throw new Error("no hash");
    await withApproval(".tentacle/workflows/task.yaml", row.hash);
    const again = await driver.catalogue();
    expect(again.workflows[0]?.approved).toBe(true);
    expect(again.workflows[0]?.hash).toBe(row.hash);
    // Mutation: hash the file's text but with a different prompt list → the
    // start below is refused `changed` and this equality goes red.
    const started = await driver.start({ name: "task", hash: row.hash, by: "user" });
    expect(started).toEqual({ ok: true, runId: "wf-1" });
  });

  test("the row carries every step, a run command verbatim, and the declared inputs", async () => {
    const withInputs = YAML(
      "  - id: build\n    run: make test\n  - id: gate\n    approve: { title: Merge it }\n",
      "\nname: task\ninputs:\n  slug: { required: true }\n  note: { default: hi }",
    );
    const { driver } = setup({ rows: [sourceRow("task", withInputs)] });
    const row = (await driver.catalogue()).workflows[0];
    expect(row?.steps).toEqual([
      { id: "build", kind: "run", where: "local", command: "make test" },
      { id: "gate", kind: "approve", where: "local" },
    ]);
    expect(row?.inputs).toEqual([
      { name: "slug", required: true },
      { name: "note", required: false, default: "hi" },
    ]);
  });

  test("an INVALID file is a row with its errors, and the valid ones beside it still list", async () => {
    const { driver } = setup({
      rows: [sourceRow("task", TWO_AGENTS), sourceRow("broken", BROKEN)],
    });
    const { workflows } = await driver.catalogue();
    const broken = workflows.find((w) => w.name === "broken");
    expect(broken?.ok).toBe(false);
    expect(broken?.hash).toBeUndefined();
    expect(broken?.approved).toBeUndefined();
    // The error names its YAML path (the validator's own words), so a user
    // sees WHICH line is wrong — never a bare "invalid".
    expect(broken?.errors?.[0]).toContain("steps");
    expect(workflows.find((w) => w.name === "task")?.ok).toBe(true);
  });

  test("a file that cannot be a workflow arrives as its invalid row, never dropped", async () => {
    const { driver } = setup({
      rows: [
        {
          kind: "invalid",
          name: "Bad Name",
          path: ".tentacle/workflows/Bad Name.yaml",
          problem: "not a workflow name",
        },
      ],
    });
    const { workflows } = await driver.catalogue();
    expect(workflows).toEqual([
      {
        name: "Bad Name",
        path: ".tentacle/workflows/Bad Name.yaml",
        ok: false,
        errors: ["not a workflow name"],
      },
    ]);
  });

  test("it ASKS NOTHING and STARTS NOTHING: zero broker requests, no run, no row", async () => {
    // The load-bearing property: a listing must never park on a prompt or begin
    // a run. Mutation: have `catalogue` reuse `approveHash` → one ask appears
    // here and the TUI would open a prompt just for opening `/workflow`.
    const { driver, broker, host } = setup({ rows: [sourceRow("task", TWO_AGENTS)] });
    const catalogue = await driver.catalogue();
    await flush();
    expect(catalogue.workflows).toHaveLength(1);
    expect(broker.asks).toHaveLength(0);
    expect(driver.current()).toBeUndefined();
    expect(host.rows).toEqual([]);
    expect(host.entries).toEqual([]);
  });

  test("the folder, the truncation flag and the display-only hint reach the answer", async () => {
    const { driver } = setup({
      dir: "/proj/apps/mobile/.tentacle/workflows",
      truncated: true,
      listing: async () => ({
        dir: "/proj/apps/mobile/.tentacle/workflows",
        rows: [],
        truncated: true,
        gitIgnored: false,
        elsewhere: { dir: "/proj/.tentacle/workflows", count: 3 },
      }),
    });
    expect(await driver.catalogue()).toEqual({
      workflows: [],
      truncated: true,
      gitIgnored: false,
      dir: "/proj/apps/mobile/.tentacle/workflows",
      elsewhere: { dir: "/proj/.tentacle/workflows", count: 3 },
    });
  });

  test("a session with no `list` (a pod's daemon) answers unavailable, never an empty folder", async () => {
    const { required } = setup({ rows: [sourceRow("task", TWO_AGENTS)] });
    const { list: _list, ...withoutList } = required;
    const driver = new WorkflowDriver(withoutList);
    const catalogue = await driver.catalogue();
    expect(catalogue.workflows).toEqual([]);
    expect(catalogue.unavailable).toBe("workflows run only on a laptop or serve session");
  });
});

describe("start{hash} (D6)", () => {
  test("a STALE hash is refused `changed`, with zero asks and no row", async () => {
    // Mutation: drop the `request.hash !== prepared.hash` check → the run starts,
    // a prompt appears for an edit the user never saw, and this goes red.
    const { driver, broker, host } = setup({ rows: [sourceRow("task", TWO_AGENTS)] });
    const row = (await driver.catalogue()).workflows[0];
    const stale = "0".repeat(64);
    expect(row?.hash).not.toBe(stale);
    const started = await driver.start({ name: "task", hash: stale, by: "user", turnId: "t-1" });
    expect(started).toEqual({
      ok: false,
      refusal: "changed",
      reason:
        ".tentacle/workflows/task.yaml changed since you opened it: review it and start again",
    });
    await flush();
    expect(broker.asks).toHaveLength(0);
    expect(driver.current()).toBeUndefined();
    expect(host.rows).toEqual([]);
  });

  test("a CURRENT hash on an unapproved file asks exactly ONE hash approval", async () => {
    const { driver, broker } = setup({ rows: [sourceRow("task", TWO_AGENTS)] });
    const hash = (await driver.catalogue()).workflows[0]?.hash;
    if (hash === undefined) throw new Error("no hash");
    const started = await driver.start({ name: "task", hash, by: "user", turnId: "t-1" });
    expect(started).toEqual({ ok: true, runId: "wf-1" });
    await flush();
    expect(broker.asks).toHaveLength(1);
    expect(broker.asks[0]?.req.kind).toBe("workflow_approve");
    // The ask shows the commands verbatim, before anything runs.
    expect(broker.asks[0]?.req.detail).toContain("plan: agent");
    broker.asks[0]?.answer({ allowed: true, scope: "once" });
    await flush();
  });

  test("no hash at all keeps today's behaviour (the TUI's `/workflow run`, the model's tool)", async () => {
    const { driver, broker } = setup({ rows: [sourceRow("task", TWO_AGENTS)] });
    expect(await driver.start({ name: "task", by: "user" })).toEqual({ ok: true, runId: "wf-1" });
    await flush();
    expect(broker.asks).toHaveLength(1);
  });
});

describe("the refusal words on the existing refusals (D6)", () => {
  test("`running` carries the run in flight", async () => {
    const { driver } = setup({ rows: [sourceRow("task", TWO_AGENTS)], approved: true });
    expect(await driver.start({ name: "task", by: "user" })).toEqual({ ok: true, runId: "wf-1" });
    const second = await driver.start({ name: "task", by: "user" });
    expect(second).toMatchObject({ ok: false, refusal: "running", runId: "wf-1" });
  });

  test("`invalid` for a file that does not validate, `inputs` for a bad input name", async () => {
    const { driver } = setup({
      rows: [sourceRow("task", TWO_AGENTS), sourceRow("broken", BROKEN)],
      approved: true,
    });
    expect(await driver.start({ name: "broken", by: "user" })).toMatchObject({
      ok: false,
      refusal: "invalid",
    });
    expect(await driver.start({ name: "task", by: "user", inputs: { nope: "x" } })).toMatchObject({
      ok: false,
      refusal: "inputs",
    });
  });

  test("`unavailable` once the session is closing", async () => {
    const { driver } = setup({ rows: [sourceRow("task", TWO_AGENTS)] });
    driver.dispose();
    expect(await driver.start({ name: "task", by: "user" })).toMatchObject({
      ok: false,
      refusal: "unavailable",
    });
  });
});
