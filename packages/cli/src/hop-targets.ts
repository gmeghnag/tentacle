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
import { workloadText } from "@tentacle/tui";
import type { TentacleConfig } from "./config.ts";
import { WorkloadNotFoundError } from "./engine-host.ts";
import type { EngineHost, EngineKind } from "./engine-host.ts";
import { attachEngineRuntime, startEngineRuntime } from "./engine-runtime.ts";
import { type KubeNamespace, engineNoun, laptopWorkspaceInput } from "./engine-select.ts";
import { type HopLiveLine, createHopLiveLine } from "./hop-live-line.ts";
import { type AttachVerdict, attachVerdict } from "./hop-plan.ts";
import type { HopPlace } from "./hop-plan.ts";
import type { HopPromptEngine, HopPromptFacts } from "./hop-proposal.ts";
import { namespaceTrace } from "./hop-proposal.ts";
import type { HopRuntimeDeps, HopShared } from "./hop-runtime.ts";
import type { HopFolderFate } from "./hop-turn.ts";
import { removeVerifiedKept } from "./kept-cmd.ts";
import { forgetKept, keptDir, recordKept } from "./kept-index.ts";
import { KEPT_SCHEMA_VERSION, type KeptEntry, keptMetadata } from "./kept.ts";
import { type LocalRuntime, startWorkerRuntime } from "./local-runtime.ts";
import { type HopBuild, type HopBuilt, errorText } from "./session-hop.ts";
import { untrustedText } from "./untrusted-text.ts";
import { mountGate, planWorkspace } from "./workspace-mount.ts";

/** How long a rollback lets a dispose settle before it gives up (D1 step 2). */
export const HOP_ROLLBACK_TIMEOUT_MS = 3_000;

/**
 * Never a terminal (D6/P8), but ONE line (docs/feat/session-hop-ux slice 2): the
 * engine is handed a `liveLine` instead of `logTerm.tty`, so provisioning paints
 * the hop's own status row — one text updated in place — and never writes a raw
 * byte while Ink owns the screen. Its `log`/`info` keep only what is really a
 * notice (a warning, an error, the dispose's `quitReport`).
 */
function hopLiveLine(deps: HopTargetDeps): HopLiveLine {
  return createHopLiveLine({ emit: (text) => deps.status(text) });
}

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
  /**
   * k8s only: the namespace this host really dialled, WITH its provenance (OD3).
   * A build reports it so the live row and a miss can say why, and so a place
   * knows the namespace it is IN — which the spec of a typed `/move attach
   * kubernetes:<pod>` cannot (`kubeNamespace` decides it, OD2). Absent: not k8s,
   * or a test's fake (which then simply shows no provenance).
   */
  readonly namespace?: KubeNamespace;
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
  readonly host: (engine: EngineKind, where?: HopHostWhere) => HopEngineHost;
  /** The image `/move container` uses when none was named (`run`'s own default). */
  readonly defaultImage?: () => string | undefined;
  /** Whether a mount may be planned at all (a test turns it off; `run --no-mount`). */
  readonly mount?: boolean;
  /**
   * D7(a): does a laptop DETACHED RUN own this workload? `detached-run-of.ts` in
   * production (`detachedRunOf` ≠ null). That run's relay and TUIs own the
   * session and the workload's whole lifecycle (docs/feat/detached-runs.md), so a
   * hop that joined it would be a second owner. Absent: no run check is possible,
   * and D7(a) then reads as "no run" — which is why `main.ts` always passes it.
   */
  readonly detachedRun?: (workload: HopWorkload) => boolean;
}

/** What a build NAMES about the place it dials, so the host is built WHERE it was shown (OD1). */
export interface HopHostWhere {
  /** k8s only: the namespace a `pinNamespace`/typed `/move` resolved and the owner saw. */
  readonly namespace?: string;
}

/**
 * What a build may be TOLD, not what it may invent (D9/M6: ONE prompt). When the
 * owner's approval of a PROPOSAL already carried the mount gate's warning
 * (`hopPromptFacts` → `gate`), that Yes answered the gate too: asking again at
 * build time is the second prompt the review found (H5 finding 2).
 */
export interface HopBuildOpts {
  /** The owner approved a prompt that already showed this gate's warning. */
  readonly gateAnswered?: true;
}

/**
 * The facade's `build` (`HopRuntimeDeps.build`) over deps that outlive it: the
 * ONE place the hop's `opts` is carried from the owner's answer to the factory
 * (H5 review round 2, finding 1). Written here, not as a lambda at the call
 * site, because this forwarding is INVISIBLE to the compiler — a lambda with
 * fewer parameters type-checks and then silently drops `gateAnswered`, which
 * costs the owner a second prompt for a gate they already answered.
 */
export function hopBuilder(deps: Omit<HopTargetDeps, "shared">): HopRuntimeDeps["build"] {
  return (spec, shared, sessionId, opts) =>
    createHopTargets({ ...deps, shared })(spec, sessionId, opts);
}

/**
 * The ONE build a hop calls (D1 step 2). Every failure is `{kind: "failed"}` with
 * one short line: the old session is untouched, and nothing this hop created is
 * left behind.
 */
export function createHopTargets(deps: HopTargetDeps) {
  return async (spec: HopSpec, sessionId: string, opts: HopBuildOpts = {}): Promise<HopBuild> => {
    if (spec.target === "local") {
      return workerTarget(deps, sessionId);
    }
    if (spec.target === "attach") {
      return attachTarget(deps, spec.workload, sessionId);
    }
    return containerTarget(deps, spec.image, sessionId, opts);
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
 * The workspace plan and its gate for a container hop — the ONE computation, so
 * the prompt the owner approves (`hopPromptFacts`) cannot state a mount, an engine
 * or a warning that the BUILD would not use, and the build cannot raise a second
 * prompt for something the proposal already asked about (H5 review findings 2, 3).
 * `null` when no container engine is configured at all (the build then refuses).
 */
function containerPlan(deps: {
  readonly config: TentacleConfig;
  readonly host: (engine: EngineKind) => HopEngineHost;
  readonly mount?: boolean;
  readonly engine: EngineKind;
  readonly target: HopEngineHost;
}): {
  readonly engine: "docker" | "podman";
  readonly plan: ReturnType<typeof planWorkspace>;
  readonly gate: ReturnType<typeof mountGate>;
} | null {
  const { config } = deps;
  if (deps.engine !== "docker" && deps.engine !== "podman") {
    return null;
  }
  const plan = planWorkspace(
    laptopWorkspaceInput({
      kind: deps.engine,
      ...(deps.target.endpoint === undefined ? {} : { endpoint: deps.target.endpoint }),
      noMount: deps.mount === false,
      cwd: config.cwd,
      configDir: config.configDir,
      binDir: "/usr/local/bin",
      // A key file in the cwd is the dangerous thing to expose (D6's warnings);
      // the hop has no `run` flags to mask anything else.
      hide: [],
    }),
  );
  return {
    engine: deps.engine,
    plan,
    gate: mountGate(plan, { interactive: true, confirmed: false }),
  };
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
  opts: HopBuildOpts = {},
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
  const computed = containerPlan({
    config,
    host: deps.host,
    ...(deps.mount === false ? { mount: false } : {}),
    engine,
    target,
  });
  if (computed === null) {
    return { kind: "failed", notice: "not moved: no docker or podman engine is set" };
  }
  const { plan, gate } = computed;
  if (plan.kind === "refuse") {
    return { kind: "failed", notice: `not moved: ${untrustedText(plan.message)}` };
  }
  if (plan.kind === "none" && plan.warning !== undefined) {
    deps.notify(untrustedText(plan.warning));
  }
  if (gate.action === "refuse") {
    return { kind: "failed", notice: `not moved: ${untrustedText(gate.message)}` };
  }
  if (gate.action === "ask" && opts.gateAnswered !== true) {
    // D6: ONE laptop prompt, through the SAME broker the target's daemon asks on.
    // `gateAnswered`: the owner's approval of the PROPOSAL already showed this
    // very text (`hopPromptFacts`), so that Yes answered it — a second prompt here
    // is the bug H5 review found (finding 2). A typed `/move` has no proposal and
    // reaches this ask as before.
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
      // DECISION 1's bind mount: the SAME plan the gate above approved (`run`'s
      // shape, `main.ts:1504`). Without this the container is created with no
      // workspace at all — the owner approves a mount of their folder and the
      // agent then works on the image's own filesystem. Found by the H7 live test
      // (`session-hop.docker.test.ts`): the file a shell call wrote inside the
      // container never appeared in the cwd.
      ...(plan.kind === "mount" ? { workspace: plan.mount } : {}),
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
      // D8/D9: this runtime's client IS the hop TUI (it has the `/move` feed and
      // the one broker prompt), so it declares `hop` in `initialize` and the pod
      // daemon keeps offering the model `move_session` on this target.
      hop: true,
      // Everything the engine says goes to the hop's sinks: no spinner, no raw
      // line while Ink owns the terminal (§7, P8, D6).
      liveLine: hopLiveLine(deps),
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
      // OD6: the plan BUILT it, so this is the authoritative answer — a mount
      // planned and used is `shared`, `none`/`refuse`-free `none` is not.
      folder: plan.kind === "mount" ? "shared" : "not shared",
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
 *
 * D7 is decided HERE and not in the orchestrator (H2's drift note): its check
 * must run before ANY open on the target, and only the factory can place a check
 * before its own runtime's open. Two calls, each with the facts it has:
 *
 *   - (a) a laptop DETACHED RUN owns the workload — before anything is dialled,
 *     so nothing is injected into a workload that is not ours to touch;
 *   - (b) `residentUse` after the handshake and BEFORE any open: a resident pod
 *     daemon is ONE per workload, so a workload with another live client is not
 *     ours to share (that client can already answer its pod-side asks).
 *
 * Our OWN uid on the target is D1 step 4(a)'s (`hopSession`), which reads it
 * fresh right before the open and closes an idle copy — this factory never joins
 * one, so it passes `own: null` ("not live here") and leaves it to that step.
 */
async function attachTarget(
  deps: HopTargetDeps,
  workload: HopWorkload,
  sessionId: string,
): Promise<HopBuild> {
  const { config } = deps;
  // D7(a) BEFORE any dial (nothing is inspected, nothing injected into a
  // workload another run owns). No `at`: a run of that name and engine is
  // treated as this place's, which is the STRICT side — refusing to join is
  // always safe, joining someone's run is not.
  if (deps.detachedRun?.(workload) === true) {
    const refused = d7Refusal(attachVerdict({ workload, detachedRun: true, own: null, use: null }));
    if (refused !== null) {
      return refused;
    }
  }
  let target: HopEngineHost;
  try {
    // OD1: dial the namespace that was SHOWN, never a fresh resolution — a
    // kubeconfig that changed since the prompt approved a place cannot move it.
    target = deps.host(
      workload.engine,
      workload.namespace === undefined ? {} : { namespace: workload.namespace },
    );
  } catch (error) {
    return { kind: "failed", notice: `not moved: ${errorText(error, "no engine")}` };
  }
  // OD1/OD3: the workload the host REALLY dialled. A typed `/move attach
  // kubernetes:<pod>` cannot name its namespace (OD2 decides it), so without this
  // the row, the badge, the moved line and the miss would all print
  // `kubernetes:<pod>` — a name that now READS as `ns/pod`, and a trace nobody
  // sees under auto-accept (no prompt is shown then).
  const dialled = dialledWorkload(workload, target);
  // Design 1/OD3: the FIRST phase carries the provenance, so a live test answers
  // "why that namespace" from the row it is watching.
  deps.status(
    target.namespace === undefined
      ? `moving to ${workloadText(dialled)} — attaching`
      : `moving to ${workloadText(dialled)} — attaching (${namespaceTrace(target.namespace)})`,
  );
  let runtime: LocalRuntime | undefined;
  try {
    runtime = await attachEngineRuntime(config, {
      host: target.host,
      name: workload.name,
      ...(workload.container === undefined ? {} : { container: workload.container }),
      permissions: deps.shared.permissions,
      saver: deps.shared.saver,
      resume: null,
      sessionId,
      // The same declarative as a new container: this client can ask its owner.
      hop: true,
      liveLine: hopLiveLine(deps),
      log: (line) => deps.notify(untrustedText(line)),
      // The same rule as the container: `info` is the NOTICE sink (D6's spirit,
      // see `containerTarget`'s note — `quitReport` rides it at dispose time).
      info: (line) => deps.notify(untrustedText(line)),
      notify: deps.notify,
    });
  } catch (error) {
    // A user-owned workload is never deleted, and nothing was created here.
    return {
      kind: "failed",
      notice: attachMissNotice(workload, target, error),
    };
  }
  // D7(b): the handshake is done and NOTHING is open yet (a runtime opens its
  // session lazily), so this reads the resident before the hop can join it.
  // `ownMayBeAbsent`: our own session may not be open yet — that is no use of it.
  const use = await runtime.residentUse(sessionId, { ownMayBeAbsent: true }).catch(() => null);
  const refused = d7Refusal(attachVerdict({ workload, detachedRun: false, own: null, use }));
  if (refused !== null) {
    // Dispose and open nothing (D7): the workload and its client are untouched.
    await bounded(runtime.dispose(), HOP_ROLLBACK_TIMEOUT_MS);
    return refused;
  }
  return {
    kind: "built",
    built: {
      ...builtOf(
        runtime,
        {
          kind: "workload",
          engine: workload.engine,
          name: workload.name,
          ...(dialled.namespace === undefined ? {} : { namespace: dialled.namespace }),
          ...(workload.container === undefined ? {} : { container: workload.container }),
        },
        // An existing daemon may already hold our uid: D1 step 4(a) applies.
        { preexisting: true, daemonInPod: true },
      ),
      // OD3: the provenance the outcome line states. Under auto-accept NO prompt
      // is shown and a typed `/move` never asks, so the recorded line is the only
      // place a live test can read WHY this namespace was dialled.
      ...(target.namespace === undefined ? {} : { trace: namespaceTrace(target.namespace) }),
    },
  };
}

/** D7's refusal as a build failure: the ONE wording site is `attachVerdict`'s. */
function d7Refusal(verdict: AttachVerdict): HopBuild | null {
  return verdict.kind === "refuse"
    ? { kind: "failed", notice: `not moved: ${verdict.text}` }
    : null;
}

/**
 * What an attach that could not join says (docs/feat/session-hop-ux design 7). A
 * k8s 404 keeps the engine's diagnosis but replaces its CLI advice, which is a
 * DEAD END in a hop (`pass --namespace <ns>` — a hop has no such flag): the hop's
 * own grammar is the fix, `kubernetes:<namespace>/<pod>`, and the namespace is
 * named so a wrong default is obvious. Everything else keeps its own message.
 */
function attachMissNotice(workload: HopWorkload, target: HopEngineHost, error: unknown): string {
  if (workload.engine === "kubernetes" && error instanceof WorkloadNotFoundError) {
    const namespace = workload.namespace ?? target.namespace?.namespace ?? "default";
    // Design 7: the miss repeats OD3's provenance (`(from <source>)`), so the
    // transcript explains a wrong default even when nothing was prompted for.
    const from =
      workload.namespace !== undefined || target.namespace === undefined
        ? ""
        : ` (from ${namespaceSource(target.namespace)})`;
    return `not moved: no pod "${untrustedText(workload.name)}" in namespace "${untrustedText(namespace)}"${from} — name its namespace: /move attach kubernetes:<namespace>/${untrustedText(workload.name)}`;
  }
  return `not moved: ${errorText(error, "the workload could not be joined")}`;
}

/**
 * The workload as the host REALLY dialled it (OD1/OD3): the spec's own namespace
 * when it named one (a pinned proposal, or a typed `ns/pod`), else the one the
 * host's resolution reports. A `kubernetes:<pod>` typed `/move` therefore gets the
 * namespace OD2 decided, so its label is `kubernetes:<ns>/<pod>`.
 */
function dialledWorkload(workload: HopWorkload, target: HopEngineHost): HopWorkload {
  const namespace = workload.namespace ?? target.namespace?.namespace;
  return namespace === undefined || workload.engine !== "kubernetes"
    ? workload
    : { ...workload, namespace };
}

/** OD3's short form for a miss: WHICH fact decided the namespace. */
function namespaceSource(namespace: KubeNamespace): string {
  return namespace.source;
}

/**
 * The facts a proposed move's prompt shows (docs/feat/session-hop.md D9/M6): the
 * mount the plan would really use, the engine a container hop would build, and the
 * workload this session LEAVES (so a `keep: false` is stated before it happens).
 * PURE (a `planWorkspace` call is a decision, not IO), so `hopPromptDetail` — the
 * text the owner reads — is built from facts and not from the engine's later word.
 *
 * It never throws: a plan that cannot even be made says nothing about a mount,
 * which is exactly what the prompt must then show (never an invented path).
 */
export function hopPromptFacts(
  deps: Pick<HopTargetDeps, "config" | "host" | "mount">,
  spec: HopSpec,
  current: HopPlace,
): HopPromptFacts {
  const { config } = deps;
  const facts: { engine?: HopPromptEngine; mount?: string; workload?: string; gate?: string } = {};
  const engine = containerEngine(config);
  if (current.kind === "workload") {
    facts.workload = workloadLabel(current);
  }
  if (spec.target !== "container" || engine === null) {
    return facts;
  }
  if (engine !== "docker" && engine !== "podman") {
    return facts;
  }
  facts.engine = engine;
  // The SAME plan and gate the BUILD would use (`containerPlan`) — a prompt that
  // states its own mount is a prompt the owner approves blind (H5 review 3), and
  // a gate kept out of it asks the owner twice (finding 2).
  try {
    const computed = containerPlan({
      config,
      host: deps.host,
      ...(deps.mount === false ? { mount: false } : {}),
      engine,
      target: deps.host(engine),
    });
    if (computed === null) {
      return facts;
    }
    const { plan, gate } = computed;
    if (plan.kind === "mount") {
      facts.mount = plan.mount.target;
    }
    // `ask`: the gate's own text, merged into THIS detail (`hopPromptDetail`) so
    // the owner answers one question. `refuse` needs no line here: the build
    // refuses with that message and nothing is created.
    if (gate.action === "ask") {
      facts.gate = gate.prompt;
    } else if (gate.action === "proceed" && gate.warnings !== undefined) {
      facts.gate = gate.warnings.join("\n");
    }
  } catch {
    // No plan (no engine host, an unresolvable path): the prompt says no mount,
    // which is exactly what the build would then do.
  }
  return facts;
}

/** The engine a `/move container` builds on: docker or podman, never a pod. */ function containerEngine(
  config: TentacleConfig,
): EngineKind | null {
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
    // OD6: whether the laptop's folder is visible there — `local` is the laptop,
    // a pod/attached workload was not mounted for, and a CONTAINER hop carries
    // its own answer from the plan it built with.
    folder: folderFate(place),
    daemonInPod: facts.daemonInPod,
    preexisting: facts.preexisting,
    rollback: async () => {
      await bounded(runtime.dispose(), HOP_ROLLBACK_TIMEOUT_MS);
    },
  };
}

/**
 * The default folder fate of a place, from the place alone: `local` is the
 * laptop's own folder, and a workload (a pod, or an attached container nobody
 * mounted for) is `not shared`. A container hop overrides this from its OWN plan
 * (`containerTarget`), because only the build knows whether it mounted.
 */
function folderFate(place: HopBuilt["place"]): HopFolderFate {
  return place.kind === "local" ? "local" : "not shared";
}

/** `docker:box` / `kubernetes:<ns>/web-0/app` — the ONE label (OD1, `workloadText`). */
function workloadLabel(workload: HopWorkload): string {
  return workloadText(workload);
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
    // D5's owner mark: this laptop wrote this entry because a HOP created the
    // workload, which is what makes a hop back with `keep: false` allowed to
    // delete it (`hop-leave.ts`). A `run` never sets it.
    hop: true,
  };
}
