/**
 * The factories a hop builds its target with (docs/feat/session-hop.md D1 step
 * 2, D5, D6, slice H4). NOT a copy of `run`/`attach`: each one calls the EXISTING
 * builder (`startEngineRuntime`, `attachEngineRuntime`, `startWorkerRuntime`)
 * with the shared broker and saver, and adds only what a hop needs:
 *
 *   - a hop's container is created KEPT (`keptMetadata` + a laptop index entry,
 *     the `run` shape) and never armed with an exit net — every exit path leaves
 *     something `tentacle ps` lists and `tentacle rm` can verify (D5);
 *   - a delete is ONLY `removeVerifiedKept`, and only of what THIS hop created;
 *   - provisioning runs with `logTerm: {tty: false}` and every line goes to the
 *     hop's status/notice sinks: nothing is written raw while Ink owns the
 *     terminal (AGENTS §7, P8, D6);
 *   - the mount gate's `ask` becomes ONE laptop-originated `session_hop` broker
 *     prompt (D6) — through the same instance the runtime's daemon asks through
 *     (P2). It is asked BEFORE anything is created.
 *
 * The rollback a build returns is the ONE undo the orchestrator calls (D1 step
 * 2): dispose what was built, and remove the workload this hop created.
 */
import type { PermissionBroker } from "@tentacle/core";
import type { EngineEndpoint } from "@tentacle/docker";
import type { HopSpec, HopWorkload } from "@tentacle/tui";
import type { TentacleConfig } from "./config.ts";
import type { EngineHost, EngineKind } from "./engine-host.ts";
import { attachEngineRuntime, startEngineRuntime } from "./engine-runtime.ts";
import { engineNoun, laptopWorkspaceInput } from "./engine-select.ts";
import type { HopShared } from "./hop-runtime.ts";
import { removeVerifiedKept } from "./kept-cmd.ts";
import { forgetKept, keptDir, recordKept } from "./kept-index.ts";
import { KEPT_SCHEMA_VERSION, type KeptEntry, keptMetadata } from "./kept.ts";
import { type LocalRuntime, startWorkerRuntime } from "./local-runtime.ts";
import { type HopBuild, type HopBuilt, errorText } from "./session-hop.ts";
import type { StreamTerm } from "./streams.ts";
import { untrustedText } from "./untrusted-text.ts";
import { mountGate, planWorkspace } from "./workspace-mount.ts";

/** How long a rollback lets a dispose settle before it gives up (D1 step 2). */
export const HOP_ROLLBACK_TIMEOUT_MS = 3_000;

/**
 * Never a terminal (D6/P8): the engine's spinner and its per-phase lines are
 * switched OFF at the source, so provisioning cannot write a raw byte while Ink
 * owns the screen. What it would have printed goes to the hop's sinks instead.
 */
const HOP_TERM: StreamTerm = { tty: false, colour: false, columns: () => undefined };

/** The engine-facing half a factory needs from a host (`buildEngineHost`'s result). */
export interface HopEngineHost {
  readonly host: EngineHost;
  /**
   * docker/podman: the endpoint `buildEngineHost` resolved — `planWorkspace`
   * decides from it whether the folder CAN be mounted (a unix socket is local, a
   * `tcp://`/`ssh://` one is not). Absent for kubernetes (a pod never mounts).
   */
  readonly endpoint?: EngineEndpoint;
  /** The locators the kept index entry records (`keptLocation`'s facts). */
  readonly locators: {
    readonly endpoint?: string;
    readonly context?: string;
    readonly server?: string;
    readonly namespace?: string;
    readonly insecureTcp?: boolean;
  };
}

/** What a factory may not invent: the config, the sinks, the shared pair, the host. */
export interface HopTargetDeps {
  readonly config: TentacleConfig;
  /** The ONE broker and the ONE saver, handed to every runtime (AGENTS §7, P2). */
  readonly shared: HopShared;
  /** A phase line; never the terminal (§7, P8, D6). */
  readonly status: (line: string) => void;
  /** One notice (a warning, a kept line); never the terminal (D6). */
  readonly notify: (text: string) => void;
  /** The engine host for `engine`, built by the caller (a test injects a fake). */
  readonly host: (engine: EngineKind) => HopEngineHost;
  /** The image `/move container` uses when none was named (`run`'s own default). */
  readonly defaultImage?: () => string | undefined;
  /** Whether a mount may be planned at all (a test turns it off; `run --no-mount`). */
  readonly mount?: boolean;
}

/**
 * The ONE build a hop calls (D1 step 2). Every failure is `{kind: "failed"}` with
 * one short line: the old session is untouched, and nothing this hop created is
 * left behind.
 */
export function createHopTargets(deps: HopTargetDeps) {
  return async (spec: HopSpec, sessionId: string): Promise<HopBuild> => {
    if (spec.target === "local") {
      return workerTarget(deps, sessionId);
    }
    if (spec.target === "attach") {
      return attachTarget(deps, spec.workload, sessionId);
    }
    return containerTarget(deps, spec.image, sessionId);
  };
}

/** A fresh worker (D1 step 2): nothing engine-side, so the undo is the dispose. */
async function workerTarget(deps: HopTargetDeps, _sessionId: string): Promise<HopBuild> {
  const { config, shared } = deps;
  deps.status("moving to local — starting the local agent");
  try {
    const runtime = await startWorkerRuntime(
      config,
      { permissions: shared.permissions, saver: shared.saver, resume: null },
      // The worker's own lines (MCP errors, a fallback) are the hop's notices: a
      // raw write here would corrupt Ink's frame (AGENTS §7).
      (line) => deps.notify(untrustedText(line)),
    );
    if (runtime === null) {
      return { kind: "failed", notice: "not moved: the local agent could not start" };
    }
    return {
      kind: "built",
      built: builtOf(runtime, { kind: "local" }, { preexisting: false, daemonInPod: false }),
    };
  } catch (error) {
    return { kind: "failed", notice: `not moved: ${errorText(error, "the local agent failed")}` };
  }
}

/**
 * A NEW docker/podman container (D1 step 2, D5, D6): the mount plan and its gate
 * first (nothing is created for a refusal), then `startEngineRuntime` — kept.
 * A pod is attach-only (decision 1), so it is refused here rather than built.
 */
async function containerTarget(
  deps: HopTargetDeps,
  image: string | undefined,
  _sessionId: string,
): Promise<HopBuild> {
  const { config } = deps;
  const engine = containerEngine(config);
  if (engine === null) {
    return { kind: "failed", notice: "not moved: no docker or podman engine is set" };
  }
  const resolved = image ?? deps.defaultImage?.();
  if (resolved === undefined || resolved === "") {
    return {
      kind: "failed",
      notice: "not moved: no image — use /move container <image>, or set TENTACLE_POD_IMAGE",
    };
  }
  let target: HopEngineHost;
  try {
    target = deps.host(engine);
  } catch (error) {
    return { kind: "failed", notice: `not moved: ${errorText(error, "no engine")}` };
  }
  const noun = engineNoun(engine);
  const plan = planWorkspace(
    laptopWorkspaceInput({
      kind: engine,
      ...(target.endpoint === undefined ? {} : { endpoint: target.endpoint }),
      noMount: deps.mount === false,
      cwd: config.cwd,
      configDir: config.configDir,
      binDir: "/usr/local/bin",
      // A key file in the cwd is the dangerous thing to expose (D6's warnings);
      // the hop has no `run` flags to mask anything else.
      hide: [],
    }),
  );
  if (plan.kind === "refuse") {
    return { kind: "failed", notice: `not moved: ${untrustedText(plan.message)}` };
  }
  if (plan.kind === "none" && plan.warning !== undefined) {
    deps.notify(untrustedText(plan.warning));
  }
  const gate = mountGate(plan, { interactive: true, confirmed: false });
  if (gate.action === "refuse") {
    return { kind: "failed", notice: `not moved: ${untrustedText(gate.message)}` };
  }
  if (gate.action === "ask") {
    // D6: ONE laptop prompt, through the SAME broker the target's daemon asks on.
    const mountPath = plan.kind === "mount" ? plan.mount.target : config.cwd;
    const answer = await deps.shared.permissions.request(mountAsk(engine, mountPath, gate.prompt));
    if (!answer.allowed) {
      return { kind: "failed", notice: "not moved: the mount was not confirmed" };
    }
  }

  const created = new Date().toISOString();
  const meta = keptMetadata({ engine, model: config.model, created });
  deps.status(`moving to a container (${untrustedText(resolved)}) — creating the ${noun}`);
  let runtime: LocalRuntime | undefined;
  let entry: KeptEntry | undefined;
  let entryFile: string | undefined;
  try {
    runtime = await startEngineRuntime(config, {
      host: target.host,
      image: resolved,
      // Kept (D5): `resumeHint` + `recordKept` are the two halves of the `run`
      // shape — the engine keeps it, and `tentacle ps` lists it.
      resumeHint: (name) => `tentacle attach ${name}`,
      labels: meta.labels,
      annotations: meta.annotations,
      recordKept: (name) => {
        entry = keptEntry(engine, target, name, config, created);
        entryFile = recordKept(keptDir(config.configDir), entry);
        const file = entryFile;
        return () => forgetKept(file);
      },
      permissions: deps.shared.permissions,
      saver: deps.shared.saver,
      resume: null,
      // Everything the engine says goes to the hop's sinks: no spinner, no raw
      // line while Ink owns the terminal (§7, P8, D6).
      logTerm: HOP_TERM,
      log: (line) => deps.notify(untrustedText(line)),
      // DRIFT from D6's wording ("log/info → the hop status feed"): `info` goes to
      // the NOTICE sink. `quitReport` — the ONE line a faulted run must not lose
      // (M4) — is emitted through `info` at DISPOSE time, when the transient row
      // is already gone; the phases therefore land in the transcript, exactly as
      // a piped `run` prints them, and the status row carries the hop's own
      // phases. Losing that line silently is the worse bug.
      info: (line) => deps.notify(untrustedText(line)),
      notify: deps.notify,
    });
  } catch (error) {
    // Nothing is ours to delete blindly: `startEngineRuntime` left the workload
    // KEPT (D5), so the failure says where its log is and `rm` can reach it.
    return {
      kind: "failed",
      notice: `not moved: ${errorText(error, `the ${noun} could not start`)}`,
    };
  }
  const name = entry?.name ?? "";
  const built = builtOf(
    runtime,
    name === "" ? { kind: "workload", engine, name: "" } : { kind: "workload", engine, name },
    { preexisting: false, daemonInPod: true },
  );
  return {
    kind: "built",
    built: {
      ...built,
      rollback: async () => {
        await bounded(runtime?.dispose(), HOP_ROLLBACK_TIMEOUT_MS);
        // Only what THIS hop created, and only through the verified delete (D5).
        if (entry !== undefined && entryFile !== undefined) {
          await removeVerifiedKept(entry, entryFile, {
            hostFor: () => target.host,
          }).catch(() => undefined);
        }
      },
    },
  };
}

/**
 * An EXISTING workload (D1 step 2): `attachEngineRuntime` — it never creates,
 * starts or deletes. Nothing is ours to remove, so the undo is only the dispose.
 */
async function attachTarget(
  deps: HopTargetDeps,
  workload: HopWorkload,
  sessionId: string,
): Promise<HopBuild> {
  const { config } = deps;
  let target: HopEngineHost;
  try {
    target = deps.host(workload.engine);
  } catch (error) {
    return { kind: "failed", notice: `not moved: ${errorText(error, "no engine")}` };
  }
  deps.status(`moving to ${workloadLabel(workload)} — attaching`);
  try {
    const runtime = await attachEngineRuntime(config, {
      host: target.host,
      name: workload.name,
      ...(workload.container === undefined ? {} : { container: workload.container }),
      permissions: deps.shared.permissions,
      saver: deps.shared.saver,
      resume: null,
      sessionId,
      logTerm: HOP_TERM,
      log: (line) => deps.notify(untrustedText(line)),
      // The same rule as the container: `info` is the NOTICE sink (D6's spirit,
      // see `containerTarget`'s note — `quitReport` rides it at dispose time).
      info: (line) => deps.notify(untrustedText(line)),
      notify: deps.notify,
    });
    return {
      kind: "built",
      built: builtOf(
        runtime,
        {
          kind: "workload",
          engine: workload.engine,
          name: workload.name,
          ...(workload.container === undefined ? {} : { container: workload.container }),
        },
        // An existing daemon may already hold our uid: D1 step 4(a) applies.
        { preexisting: true, daemonInPod: true },
      ),
    };
  } catch (error) {
    // A user-owned workload is never deleted, and nothing was created here.
    return {
      kind: "failed",
      notice: `not moved: ${errorText(error, "the workload could not be joined")}`,
    };
  }
}

/** The engine a `/move container` builds on: docker or podman, never a pod. */
function containerEngine(config: TentacleConfig): EngineKind | null {
  const chosen = config.engine;
  if (chosen === "docker" || chosen === "podman") {
    return chosen;
  }
  // Unset/`kubernetes`: docker is the local default `run` uses when a container
  // is asked for (`tentacle run --engine docker`); a pod never mounts a folder.
  return chosen === undefined ? "docker" : null;
}

/** The mount gate's ask as a laptop-originated `session_hop` request (D6, P5). */
function mountAsk(engine: EngineKind, mountPath: string, prompt: string) {
  return {
    kind: "session_hop" as const,
    tool: "move_session",
    level: "ask" as const,
    title: "Move this session into a container?",
    // The laptop writes these lines itself (D9); only the gate's own warnings are
    // an engine/config-supplied text, sanitized.
    detail: [
      `${engine}: ${untrustedText(mountPath)} mounted read-write`,
      untrustedText(prompt),
    ].join("\n"),
    input: null,
  };
}

/** The runtime as the orchestrator sees it (D1), with the place's facts. */
function builtOf(
  runtime: LocalRuntime,
  place: HopBuilt["place"],
  facts: { readonly preexisting: boolean; readonly daemonInPod: boolean },
): HopBuilt {
  return {
    runtime,
    place,
    daemonInPod: facts.daemonInPod,
    preexisting: facts.preexisting,
    rollback: async () => {
      await bounded(runtime.dispose(), HOP_ROLLBACK_TIMEOUT_MS);
    },
  };
}

/** `docker:box` / `kubernetes:web-0/app` — the workload as the status row says it. */
function workloadLabel(workload: HopWorkload): string {
  const name = untrustedText(workload.name);
  const container = workload.container === undefined ? "" : `/${untrustedText(workload.container)}`;
  return `${workload.engine}:${name}${container}`;
}

/** `promise` inside a bound: a hung dispose must not freeze a hop (D1 step 2). */
async function bounded(promise: Promise<void> | undefined, ms: number): Promise<void> {
  if (promise === undefined) {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise.catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** The kept index entry a hop-created container gets (the `run` shape, D5). */
function keptEntry(
  engine: EngineKind,
  target: HopEngineHost,
  name: string,
  config: TentacleConfig,
  created: string,
): KeptEntry {
  const { locators } = target;
  return {
    schemaVersion: KEPT_SCHEMA_VERSION,
    name,
    engine,
    ...(locators.endpoint === undefined ? {} : { endpoint: locators.endpoint }),
    ...(locators.context === undefined ? {} : { context: locators.context }),
    ...(locators.server === undefined ? {} : { server: locators.server }),
    ...(locators.namespace === undefined ? {} : { namespace: locators.namespace }),
    ...(locators.insecureTcp === true ? { insecureTcp: true as const } : {}),
    cwd: config.cwd,
    model: config.model,
    ...(config.profile === undefined ? {} : { profile: config.profile }),
    created,
  };
}
