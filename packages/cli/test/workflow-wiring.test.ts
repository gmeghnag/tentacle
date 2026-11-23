/**
 * The workflow driver's wiring (docs/feat/agent-workflows.md Slice 4): built,
 * with the model's `workflow` tool, only where the caller opts in (the worker
 * and `serve`) and NEVER on a tunnelled session (a pod's asks and approvals are
 * not the laptop's to keep, AGENTS §7); never offered to a child.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowRow } from "@tentacle/agent";
import {
  type ModelProvider,
  PROJECT_PATHS,
  PermissionBroker,
  type PermissionRequest,
} from "@tentacle/core";
import { NOTICES, WORKFLOW_TOOL_NAME, type WorkloadShellBackend } from "@tentacle/tools";
import { type TentacleConfig, loadConfig } from "../src/config.ts";
import { buildAgent, workerSessionBuild, workflowContainerOutcome } from "../src/wiring.ts";

let dir: string;
let config: TentacleConfig;
let saved: string | undefined;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-workflow-"));
  saved = process.env.TENTACLE_CONFIG_DIR;
  process.env.TENTACLE_CONFIG_DIR = join(dir, "config"); // never the user's config
  config = { ...(await loadConfig({ cwd: dir })), subagentsEnabled: true };
});

afterAll(async () => {
  if (saved === undefined) {
    Reflect.deleteProperty(process.env, "TENTACLE_CONFIG_DIR");
  } else {
    process.env.TENTACLE_CONFIG_DIR = saved;
  }
  await rm(dir, { recursive: true, force: true });
});

const offers = (wired: ReturnType<typeof buildAgent>): boolean =>
  wired.tools.definitions().some((d) => d.name === WORKFLOW_TOOL_NAME);

describe("workflow wiring", () => {
  test("opted in (worker / serve): a driver, carried to the session host, and the tool", () => {
    const wired = buildAgent(config, { workflows: true });
    const driver = wired.workflows;
    expect(driver).toBeDefined();
    expect(offers(wired)).toBe(true);
    if (driver) expect(workerSessionBuild(wired).workflows).toBe(driver);
  });

  test("not opted in (one-shot, pod builds): no driver, no tool", () => {
    const wired = buildAgent(config);
    expect(wired.workflows).toBeUndefined();
    expect(offers(wired)).toBe(false);
  });

  test("a tunnelled session never gets one, even opted in", () => {
    const wired = buildAgent(config, {
      workflows: true,
      modelOverride: {} as ModelProvider,
    });
    expect(wired.workflows).toBeUndefined();
    expect(offers(wired)).toBe(false);
  });

  test("a missing workflow file is refused before any ask, naming the path", async () => {
    const wired = buildAgent(config, { workflows: true });
    const started = await wired.workflows?.start({ name: "nope", by: "user" });
    expect(started?.ok).toBe(false);
    expect(started?.ok === false ? started.reason : "").toContain(
      `${join(dir, PROJECT_PATHS.workflows, "nope.yaml")}`,
    );
  });
});

describe("a `run` step runs what the GATE approved (fix round 1, HIGH)", () => {
  /** A backend that records a dial: the refusal tests must never reach it. */
  let dialled = false;
  const dialledOnce: WorkloadShellBackend = {
    open() {
      dialled = true;
      throw new Error("not dialled in this test");
    },
    oneShot() {
      dialled = true;
      throw new Error("not dialled in this test");
    },
    async explain(error: unknown) {
      return error instanceof Error ? error : new Error(String(error));
    },
  };
  /**
   * A real build, a real `PermissionGate`, a real `HookRunner`: the `shell` hook
   * below rewrites the input (`{"input": {"command": …}}`), which
   * `PermissionGate.authorize` shows in the ask and returns as `outcome.input`.
   * The step must run THAT command — the file's `make test` would exit 127 here.
   */
  async function rewrittenRun(hookCommand: string, options: { readonly docker?: boolean } = {}) {
    const configDir = join(dir, "config-hook");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "config.jsonc"),
      JSON.stringify({
        hooks: [{ event: "tool_call", matcher: "shell|workload_shell", command: hookCommand }],
      }),
    );
    await mkdir(join(dir, PROJECT_PATHS.workflows), { recursive: true });
    await writeFile(
      join(dir, PROJECT_PATHS.workflows, "rewrite.yaml"),
      `schemaVersion: 1\nname: rewrite\nversion: 1\nsteps:\n  - id: gate\n    run: make test\n${options.docker === true ? "    where: { docker: devbox }\n" : ""}`,
    );
    const saved = process.env.TENTACLE_CONFIG_DIR;
    process.env.TENTACLE_CONFIG_DIR = configDir;
    let configWithHook: TentacleConfig;
    try {
      configWithHook = await loadConfig({ cwd: dir });
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, "TENTACLE_CONFIG_DIR");
      else process.env.TENTACLE_CONFIG_DIR = saved;
    }
    const asks: PermissionRequest[] = [];
    const broker = new PermissionBroker(async (req) => {
      asks.push(req);
      return { allowed: true };
    });
    const wired = buildAgent(
      { ...configWithHook, workloadShell: { ...configWithHook.workloadShell, tool: true } },
      {
        workflows: true,
        permissions: broker,
        ...(options.docker === true ? { workloadShell: { backend: dialledOnce } } : {}),
      },
    );
    let rows: readonly WorkflowRow[] = [];
    const done = new Promise<void>((resolve) => {
      wired.workflows?.bind({
        logStart: () => {},
        logStep: () => {},
        logEnd: () => {},
        attribute: () => {},
        release: () => {},
        publish: (r) => {
          rows = r;
        },
        ended: () => resolve(),
      });
    });
    const started = await wired.workflows?.start({ name: "rewrite", by: "user" });
    expect(started?.ok).toBe(true);
    await done;
    return { asks, step: rows[0]?.steps[0] };
  }

  test("a hook's rewritten command is the one that runs, and the one that was asked", async () => {
    const { asks, step } = await rewrittenRun('printf \'{"input":{"command":"echo rewritten"}}\'');
    // The ask showed the REWRITE (never the file's original command)…
    const toolAsk = asks.find((a) => a.kind !== "workflow_approve");
    expect(toolAsk?.tool).toBe("shell");
    expect(toolAsk?.input).toMatchObject({ command: "echo rewritten" });
    // …and the rewrite is what ran: `make test` would have exited 127 here.
    expect(step?.state).toBe("ok");
    expect(step?.reason).toBe("exit 0");
  });

  test("a rewrite that drops the command is refused, never run as the file's own", async () => {
    // `shell` refuses that rewrite at its own schema (the command is required)…
    const local = await rewrittenRun('printf \'{"input":{"action":"close"}}\'');
    expect(local.step?.state).toBe("error");
    expect(local.step?.reason).toContain("unusable");
    // …and `workload_shell` lets `command` be absent (its other actions take
    // none), so the rewrite PARSES there: the gate's own guard must refuse it,
    // because the file's command was never what was approved.
    const container = await rewrittenRun(
      'printf \'{"input":{"action":"close","target":{"engine":"docker","name":"devbox"}}}\'',
      { docker: true },
    );
    expect(container.step?.state).toBe("error");
    expect(container.step?.reason).toContain("names no command");
    // Never dialled: the refusal happens before any exec.
    expect(dialled).toBe(false);
  });

  test("a rewrite that retargets the step elsewhere is refused, never the file's own", async () => {
    // A `run` step's `where` is `local | {docker}` only, so a rewrite naming a
    // pod parses (the tool supports it) but cannot run as a step. Reading that
    // as "no target" would dial the FILE's `devbox` instead — the same mismatch.
    const { step } = await rewrittenRun(
      'printf \'{"input":{"action":"run","command":"echo elsewhere","target":{"engine":"kubernetes","name":"pod"}}}\'',
      { docker: true },
    );
    expect(step?.state).toBe("error");
    expect(step?.reason).toContain("target is unusable");
    expect(dialled).toBe(false);
  });
});

describe("run steps in a container (Slice 5)", () => {
  test("only a kill / lost / exited notice fails; a reopened shell is information", () => {
    // The ladder reports a timeout kill with exit code 0: the notice IS the failure.
    const killed = workflowContainerOutcome(
      { exitCode: 0, body: "partial", notices: [NOTICES.killedSurvived(20)] },
      20_000,
    );
    expect(killed.notes).toEqual([NOTICES.killedSurvived(20)]);
    const lost = workflowContainerOutcome(
      { exitCode: 1, body: "", notices: [NOTICES.lost] },
      5_000,
    );
    expect(lost.notes).toEqual([NOTICES.lost]);
    // An idle close between two steps reopens the shell: that must not fail a step.
    const reopened = workflowContainerOutcome(
      { exitCode: 0, body: "built", notices: [NOTICES.newShell], shellStderr: "warn" },
      5_000,
    );
    expect(reopened.notes).toEqual([]);
    expect(reopened.output).toBe(`${NOTICES.newShell}\nbuilt\nwarn`);
  });

  /** A real build (real gate, real `WorkloadShells`) over a backend that cannot dial. */
  async function dockerRun(withBackend: boolean) {
    await mkdir(join(dir, PROJECT_PATHS.workflows), { recursive: true });
    await writeFile(
      join(dir, PROJECT_PATHS.workflows, "ship.yaml"),
      "schemaVersion: 1\nname: ship\nversion: 1\nsteps:\n  - id: gate\n    run: make test\n    where: { docker: devbox }\n",
    );
    const asks: PermissionRequest[] = [];
    const broker = new PermissionBroker(async (req) => {
      asks.push(req);
      return { allowed: true };
    });
    const backend: WorkloadShellBackend = {
      open() {
        throw new Error("raw dial error");
      },
      oneShot() {
        throw new Error("raw dial error");
      },
      async explain() {
        return new Error("container devbox is not running (explained)");
      },
    };
    const wired = buildAgent(
      { ...config, workloadShell: { ...config.workloadShell, tool: true } },
      {
        workflows: true,
        permissions: broker,
        ...(withBackend ? { workloadShell: { backend } } : {}),
      },
    );
    const notes: string[] = [];
    let rows: readonly WorkflowRow[] = [];
    const done = new Promise<void>((resolve) => {
      wired.workflows?.bind({
        logStart: () => {},
        logStep: () => {},
        logEnd: () => {},
        attribute: () => {},
        release: () => {},
        publish: (r) => {
          rows = r;
        },
        ended: (_id, note) => {
          notes.push(note);
          resolve();
        },
      });
    });
    const started = await wired.workflows?.start({ name: "ship", by: "user" });
    expect(started?.ok).toBe(true);
    await done;
    return { asks, step: rows[0]?.steps[0] };
  }

  test("the ask is the container's `workload_shell` call; a dial failure is the seam's sentence", async () => {
    const { asks, step } = await dockerRun(true);
    // Approved AS the workload call it is, naming the workload: the session's
    // "always" rule is keyed per workload there, never shared with the laptop shell.
    const toolAsk = asks.find((a) => a.kind !== "workflow_approve");
    expect(toolAsk?.tool).toBe("workload_shell");
    expect(toolAsk?.input).toMatchObject({
      action: "run",
      command: "make test",
      target: { engine: "docker", name: "devbox" },
    });
    expect(step?.state).toBe("error");
    expect(step?.reason).toContain("container devbox is not running (explained)");
  });

  test("no container backend: the step fails before any tool ask, never on the laptop", async () => {
    const { asks, step } = await dockerRun(false);
    expect(asks.filter((a) => a.kind !== "workflow_approve")).toEqual([]);
    expect(step?.state).toBe("error");
    expect(step?.reason).toContain("no workload seam");
  });
});
