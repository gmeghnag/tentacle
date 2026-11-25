/**
 * The workflow driver (docs/feat/agent-workflows.md D3): ONE per session, like
 * `AgentJobs`. The pure machine (`workflow-machine.ts`) decides the order; this
 * runs each step it names and feeds the outcome back. No agent loop of its own:
 * an agent step is a call of the session's sub-agent runner, a run step goes
 * through the session's `PermissionGate`, an approve step is a broker ask.
 *
 * Every ask a step raises goes through `stepRequester`: the session's ONE
 * requester (single broker), tagged with the step's agent id (so the daemon holds
 * it on its background path, attributed to the run's start turn, A2) and armed
 * with `budget.wait` — expiry withdraws it and stops the run `timeout`.
 */
import {
  type ExecResult,
  PROJECT_PATHS,
  type PermissionRequest,
  type PermissionRequestOptions,
  type PermissionRequester,
  type PermissionResponse,
  SubagentFailure,
  WORKFLOW_APPROVE_TOOL,
  WORKFLOW_FILE_MAX_BYTES,
  type WorkflowAction,
  type WorkflowContext,
  type WorkflowEndBody,
  type WorkflowEvent,
  type WorkflowHasher,
  type WorkflowPromptFile,
  type WorkflowRunState,
  type WorkflowSpec,
  type WorkflowStartBody,
  type WorkflowStep,
  type WorkflowStepBody,
  anySignal,
  asDraft,
  capWorkflowText,
  edgeKey,
  endReason,
  isCanonical,
  missingInputs,
  next as nextAction,
  passTarget,
  rerunAt,
  shortHash,
  start as startMachine,
  validateWorkflow,
  validateWorkflowValue,
  workflowApprovalSummary,
  workflowEndBody,
  workflowHash,
  workflowStartBody,
  workflowStepBody,
  workflowWhereLabel,
  workflowYaml,
} from "@tentacle/core";
import type { SubagentRunner } from "./subagent.ts";
import { createStepVerdict } from "./workflow-verdict.ts";

/**
 * One step of a run as the wire's `WorkflowStepRow` carries it
 * (`@tentacle/protocol`, which this package does not depend on: the daemon's
 * schema judges it on the way out).
 */
export interface WorkflowStepRow {
  readonly id: string;
  readonly kind: string;
  readonly model?: string;
  readonly where: string;
  readonly state: string;
  readonly attempt: number;
  readonly round: number;
  readonly maxRound?: number;
  readonly reason?: string;
  readonly live?: string;
  readonly durationMs?: number;
  /** The RESOLVED pass target (`passTarget` over the run's frozen spec); `null` = the run ends here. */
  readonly next: string | null;
  /** Its `on_fail` with the counter as it stands; `null` = a failure stops the run. */
  readonly onFail: { readonly goto: string; readonly max: number; readonly taken: number } | null;
  /** Re-runs of this step after a `fail` (`0..5`). */
  readonly retry: number;
}

/** One finished execution, as the run row's `history` carries it (latest 64). */
export interface WorkflowHistoryRow {
  readonly step: string;
  readonly attempt: number;
  readonly round: number;
  readonly state: string;
  readonly durationMs?: number;
}

/** How many finished executions a row's `history` keeps — the protocol's own cap. */
export const WORKFLOW_HISTORY_MAX = 64;

/** One run as the wire's `WorkflowRow` carries it. */
export interface WorkflowRow {
  readonly runId: string;
  readonly name: string;
  readonly version: number;
  readonly hash: string;
  readonly state: string;
  readonly stopReason?: string;
  readonly reason?: string;
  readonly tokens: number;
  readonly budget?: number;
  readonly startedAt: number;
  readonly endedAt?: number;
  /** Every FINISHED execution, in order — the latest `WORKFLOW_HISTORY_MAX`. */
  readonly history: readonly WorkflowHistoryRow[];
  /** How many earlier executions the cap dropped. */
  readonly historyDropped: number;
  readonly steps: readonly WorkflowStepRow[];
}

/** A workflow file as read from disk: the YAML and every prompt file it names. */
export interface WorkflowSource {
  /** `.tentacle/workflows/<name>.yaml`, project-relative (recorded, and keyed in the approval store). */
  readonly path: string;
  readonly text: string;
  /** Prompt files by their path relative to `.tentacle/workflows/`; absent → validation names it. */
  readonly prompts: Readonly<Record<string, string>>;
}

/** The laptop's approval store (D2): per project + path + hash. */
export interface WorkflowApprovals {
  has(path: string, hash: string): Promise<boolean>;
  add(path: string, hash: string): Promise<void>;
}

/**
 * One file of the project's workflow folder, as the walk found it
 * (docs/feat/workflows-ui.md D6): a readable source, or the reason it cannot be
 * one. A file that cannot be a workflow is a ROW with its reason, never a silent
 * skip — a user who can see it in the folder must see why tentacle will not run
 * it.
 */
export type WorkflowSourceRow =
  | { readonly kind: "source"; readonly name: string; readonly source: WorkflowSource }
  | {
      readonly kind: "invalid";
      readonly name: string;
      readonly path: string;
      readonly problem: string;
    };

/** One walk of the project's workflow folder. */
export interface WorkflowListing {
  /** The ABSOLUTE folder read: a user in the wrong folder sees where tentacle looks. */
  readonly dir: string;
  readonly rows: readonly WorkflowSourceRow[];
  /** More YAML files than the walk keeps: what a catalogue shows is not all of it. */
  readonly truncated: boolean;
  /** git ignores the folder (the "not versioned" notice); absent = unknown, never claimed. */
  readonly gitIgnored?: boolean;
  /**
   * Where workflows WERE found higher up, given only when `dir` listed none
   * (docs/feat/workflows-ui.md D7 v5). DISPLAY ONLY: nothing it names can be
   * loaded, hashed, approved or started.
   */
  readonly elsewhere?: { readonly dir: string; readonly count: number };
}

/**
 * One row of `session/workflow_catalogue` (D6), structurally the wire's
 * `WorkflowDefRow` (this package does not depend on `@tentacle/protocol`: the
 * daemon's schema judges it on the way out). `ok:false` carries `errors` and
 * nothing else beyond `name`/`path`.
 */
export interface WorkflowDef {
  readonly name: string;
  readonly path: string;
  readonly ok: boolean;
  readonly version?: number;
  readonly description?: string;
  readonly hash?: string;
  readonly approved?: boolean;
  readonly inputs?: readonly {
    readonly name: string;
    readonly required: boolean;
    readonly default?: string;
  }[];
  readonly steps?: readonly {
    readonly id: string;
    readonly kind: string;
    readonly model?: string;
    readonly where: string;
    readonly command?: string;
  }[];
  readonly errors?: readonly string[];
}

/** The whole catalogue of one project: the wire's `WorkflowCatalogueResult`. */
export interface WorkflowCatalogue {
  readonly workflows: readonly WorkflowDef[];
  readonly truncated?: true;
  /** This session cannot run workflows at all — NOT "the folder is empty". */
  readonly unavailable?: string;
  readonly gitIgnored?: boolean;
  readonly dir: string;
  readonly elsewhere?: { readonly dir: string; readonly count: number };
}

/**
 * A `where: {docker: …}` target of a `run` step, structurally the
 * `workload_shell` tool's `target` (this package may not depend on `@tentacle/tools`).
 * No `container`: a docker target has none, and the spec refuses one (fix round 1).
 */
export interface WorkflowContainerTarget {
  readonly engine: "docker";
  readonly name: string;
}

/** What running one command in a container gave back (structurally `RunOutcome`). */
export interface WorkflowContainerOutcome {
  readonly exitCode: number;
  readonly output: string;
  /**
   * The seam's sentences that say the command did NOT simply run to its end (a
   * kill after the timeout, whose exit code is 0; a lost stream; a shell the
   * command ended). Any of them fails the step. Informational notices (a
   * reopened shell) belong in `output`, not here.
   */
  readonly notes?: readonly string[];
}

/** A run step's command: authorised by the session's gate, then executed. */
export interface WorkflowCommands {
  /**
   * `call.target` names the workload the approval is SCOPED to (a `docker` run
   * step): the gate then asks the `workload_shell` tool, whose "always" rule is
   * keyed per workload (`session-grants.ts` `workloadTargetKey`), so an approval
   * given for one container can never cover another.
   *
   * The answer is the form that was ACTUALLY approved — a `tool_call` hook may
   * rewrite the input (`PermissionGate.authorize` returns `outcome.input`, and
   * the ask then shows the rewritten form), and the agent loop runs
   * `outcome.input` rather than the model's original. So `command` is what the
   * step runs and `target` (when present) is where: never the step's own text.
   */
  authorize(
    command: string,
    requester: PermissionRequester,
    call: {
      readonly toolCallId: string;
      readonly signal: AbortSignal;
      readonly target?: WorkflowContainerTarget;
    },
  ): Promise<
    | {
        readonly allowed: true;
        /** The command that was approved — always present, never the file's own. */
        readonly command: string;
        readonly target?: WorkflowContainerTarget;
      }
    | { readonly allowed: false; readonly reason: string }
  >;
  exec(
    command: string,
    options: { readonly signal: AbortSignal; readonly timeoutMs: number },
  ): Promise<ExecResult>;
  /**
   * Run one bounded command IN a container, through the workload exec seam
   * (`workload_shell`, docs/feat/workload-shell.md). Absent → a `docker` step
   * fails honestly (this build offers no way to reach a container).
   */
  execOn?(
    target: WorkflowContainerTarget,
    command: string,
    options: { readonly signal: AbortSignal; readonly timeoutMs: number },
  ): Promise<WorkflowContainerOutcome>;
}

/** One slot of the session's ONE sub-agent cap (`AgentJobs.acquire`). */
export interface WorkflowSlots {
  acquire(
    description: string,
  ): { readonly ok: true; release(): void } | { readonly ok: false; readonly reason: string };
}

export interface WorkflowClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** What the hosting session gives the driver (bound once, like `AgentJobHost`). */
export interface WorkflowHost {
  /** The durable facts (D4), always built by the core builders. */
  logStart(body: WorkflowStartBody): void;
  logStep(body: WorkflowStepBody): void;
  logEnd(body: WorkflowEndBody): void;
  /** A step's asks name this agent id: attribute them to `turnId` (A2). */
  attribute(agentId: string, turnId: string | undefined): void;
  release(agentId: string): void;
  /**
   * The turn running NOW, if any. A start that names no turn (the model's
   * `workflow` tool: `by: "model"`) is attributed to it, captured at start —
   * so its steps' asks carry a turn and auto-accept can answer them
   * (docs/fix/workflow-model-start-turn.md).
   */
  currentTurn?(): string | undefined;
  /** The full `workflows` state changed. */
  publish(rows: readonly WorkflowRow[]): void;
  /** A run ended: leave `note` in the conversation and wake. */
  ended(runId: string, note: string): void;
}

export interface WorkflowDriverDeps {
  readonly load: (name: string) => Promise<WorkflowSource>;
  /**
   * Every workflow FILE of the project, or why one cannot be one
   * (docs/feat/workflows-ui.md D6): the catalogue's one walk. Absent → this
   * session has no catalogue (`workflow_catalogue` says `unavailable`); a start
   * and a run are unaffected.
   */
  readonly list?: () => Promise<WorkflowListing>;
  /** The session's `models` names and agent types (validated at start). */
  readonly context: () => Pick<WorkflowContext, "models" | "agentTypes" | "harnessTypes">;
  readonly approvals: WorkflowApprovals;
  /** The session's ONE requester (`permissions.request`). */
  readonly request: PermissionRequester;
  /** The session's sub-agent runner, built with `requester` as its asker. */
  readonly runnerFor: (requester: PermissionRequester) => SubagentRunner;
  readonly commands?: WorkflowCommands;
  readonly slots?: WorkflowSlots;
  readonly clock?: WorkflowClock;
  readonly hasher?: WorkflowHasher;
  /** How long to wait before retrying a full sub-agent cap. */
  readonly slotRetryMs?: number;
  /**
   * The ONE workflow writer (`writeWorkflowFiles`, docs/feat/workflow-editor.md
   * D4), wired beside `load`/`list` and nowhere else: absent → this session
   * cannot edit workflows (`source`/`save` answer `unavailable`). Synchronous,
   * so its base check and its last rename are one block. It WRITES and nothing
   * else: it never reaches the approval store.
   */
  readonly save?: (
    plan: WorkflowSaveWritePlan,
    currentHash: (source: WorkflowSource) => string,
  ) => WorkflowSaveWriteResult;
}

/** What the driver hands the writer: structurally the writer's `WorkflowWritePlan`. */
export interface WorkflowSaveWritePlan {
  readonly mode: "create" | "replace";
  readonly name: string;
  readonly draft: Readonly<Record<string, unknown>>;
  /** Relative to `.tentacle/workflows/`. */
  readonly prompts: Readonly<Record<string, string>>;
  readonly baseHash?: string;
  /** The prompt paths the loaded base's steps read: the user's own to rewrite. */
  readonly basePrompts?: readonly string[];
  readonly dryRun: boolean;
}

/** One file the writer wrote (or would): structurally its `WorkflowWriteRow`. */
export interface WorkflowSaveFileRow {
  readonly path: string;
  readonly status: "new" | "changed" | "unchanged";
  readonly patch?: string;
  readonly added: number;
  readonly removed: number;
}

/** The writer's answer: structurally its `WorkflowWriteResult`. */
export type WorkflowSaveWriteResult =
  | { readonly ok: true; readonly files: readonly WorkflowSaveFileRow[] }
  | {
      readonly ok: false;
      readonly refusal: string;
      readonly reason: string;
      readonly files: readonly WorkflowSaveFileRow[];
    };

/** A `session/workflow_save`, decoded (the draft is already a value, not JSON text). */
export interface WorkflowSaveRequest {
  readonly name: string;
  readonly mode: "create" | "replace";
  readonly draft: unknown;
  readonly prompts: Readonly<Record<string, string>>;
  readonly baseHash?: string;
  readonly dryRun: boolean;
}

/**
 * The save's answer, structurally the wire's `WorkflowSaveResult` minus
 * `schedules` (the session's, added by the daemon). `files[].path` is
 * project-relative. `approved` is display only: the save never approves.
 */
export interface WorkflowSaveOutcome {
  readonly ok: boolean;
  readonly refusal?: string;
  readonly reason?: string;
  readonly errors?: readonly string[];
  readonly hash?: string;
  readonly version?: number;
  readonly path?: string;
  readonly files?: readonly WorkflowSaveFileRow[];
  readonly approved?: boolean;
  readonly alsoChanges?: readonly string[];
  readonly running?: string;
}

/**
 * What an editor opens, structurally the wire's `WorkflowSourceResult` with the
 * draft as a value and the prompts as a record (the daemon encodes both).
 */
export interface WorkflowSourceView {
  readonly ok: boolean;
  readonly path?: string;
  readonly text?: string;
  readonly draft?: Readonly<Record<string, unknown>>;
  /** Only the files the draft's steps read. */
  readonly prompts?: Readonly<Record<string, string>>;
  readonly hash?: string;
  readonly version?: number;
  readonly canonical?: boolean;
  readonly errors?: readonly string[];
  readonly unreadable?: string;
  readonly context?: Pick<WorkflowContext, "models" | "agentTypes" | "harnessTypes">;
  readonly unavailable?: string;
}

const NOT_EDITABLE_HERE = "workflows can be edited only on a laptop or serve session";

/** `Bun.YAML.parse`, or undefined off-Bun (the daemon always has it). */
function yamlParser(): ((text: string) => unknown) | undefined {
  const runtime = (globalThis as { Bun?: { YAML?: { parse(text: string): unknown } } }).Bun?.YAML;
  return runtime === undefined ? undefined : (text) => runtime.parse(text);
}

/** Structural equality of two parsed YAML/JSON values (`-0` equals `0`, as YAML reads it). */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  return ka.every((k) => Object.hasOwn(rb, k) && sameValue(ra[k], rb[k]));
}

/**
 * The bytes a save writes, PROVED to read back as the draft (docs/feat/
 * workflow-editor.md D4, review round 1 #2): the emitter refusing (a lone
 * surrogate) or bytes that parse to anything else are a reason, never a file
 * that cannot load. `emit` / `parse` are seams for that proof's test.
 */
export function checkedWorkflowBytes(
  draft: Readonly<Record<string, unknown>>,
  emit: (draft: Readonly<Record<string, unknown>>) => string = workflowYaml,
  parse: ((text: string) => unknown) | undefined = yamlParser(),
): { readonly text: string } | { readonly reason: string } {
  let text: string;
  try {
    text = emit(draft);
  } catch (error) {
    return { reason: error instanceof Error ? error.message : String(error) };
  }
  // The loader lists a file over its cap `too-large` and never reads it: such
  // bytes would save "ok" under a hash no catalogue ever reports (review #2).
  const size = new TextEncoder().encode(text).length;
  if (size > WORKFLOW_FILE_MAX_BYTES) {
    return {
      reason: `the YAML would be ${size} bytes, over the ${WORKFLOW_FILE_MAX_BYTES} a workflow file can be: nothing was written`,
    };
  }
  if (parse === undefined) {
    return { reason: "cannot read YAML here — workflows are saved on the laptop" };
  }
  let back: unknown;
  try {
    back = parse(text);
  } catch (error) {
    return { reason: `the emitted YAML does not parse: ${String(error).split("\n")[0]}` };
  }
  return sameValue(back, draft)
    ? { text }
    : { reason: "the emitted YAML does not read back as this draft: nothing was written" };
}

/** The prompt files a draft's steps name (`agent.prompt`), in step order, once each. */
function draftPromptPaths(draft: Readonly<Record<string, unknown>>): string[] {
  const steps = Array.isArray(draft.steps) ? draft.steps : [];
  const paths: string[] = [];
  for (const step of steps) {
    const agent = (step as { agent?: unknown } | null)?.agent;
    const prompt = (agent as { prompt?: unknown } | null | undefined)?.prompt;
    if (typeof prompt === "string" && !paths.includes(prompt)) paths.push(prompt);
  }
  return paths;
}

/** A file's text as an editor's draft (`asDraft`), or why it cannot be one. */
function draftOf(
  text: string,
): { draft: Readonly<Record<string, unknown>> } | { unreadable: string } {
  const parse = yamlParser();
  if (parse === undefined) {
    return { unreadable: "cannot read YAML here — workflows load on the laptop" };
  }
  let raw: unknown;
  try {
    raw = parse(text.startsWith("﻿") ? text.slice(1) : text);
  } catch (error) {
    return { unreadable: `not valid YAML: ${String(error).split("\n")[0]}` };
  }
  return asDraft(raw);
}

/** The entries of `from` named by `paths` that exist there (own keys only). */
function pick(
  from: Readonly<Record<string, string>>,
  paths: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of paths) {
    const text = Object.hasOwn(from, p) ? from[p] : undefined;
    if (text !== undefined) out[p] = text;
  }
  return out;
}

/** Whether `text` is the emitter's own bytes; a draft it cannot emit is not. */
function canonical(text: string, draft: Readonly<Record<string, unknown>>): boolean {
  try {
    return isCanonical(text, draft);
  } catch {
    return false;
  }
}

export type WorkflowStartResult =
  | { readonly ok: true; readonly runId: string }
  | {
      readonly ok: false;
      readonly reason: string;
      /** The machine-readable half (D6): `changed` | `running` | `invalid` | `inputs` | `unavailable`. */
      readonly refusal?: string;
      /** The run that is in flight, on a `running` refusal. */
      readonly runId?: string;
    };

/** Who started a run (the `workflow_start` `by` word). */
export type WorkflowStartedBy = "user" | "model" | "schedule";

/**
 * A scheduled start (slice 10): a run, or why none was made. `skipped` = a run
 * in flight; the rest are the schedule's `ScheduleOutcome` words a human fixes.
 */
export type WorkflowScheduledStartResult =
  | { readonly ok: true; readonly runId: string }
  | {
      readonly ok: false;
      readonly outcome: "skipped" | "invalid" | "changed" | "unapproved" | "unavailable";
      readonly reason: string;
    };

/** The input problem a start refuses with, or undefined. */
function inputsProblem(
  spec: WorkflowSpec,
  given: Readonly<Record<string, string>>,
): string | undefined {
  const unknown = Object.keys(given).filter((k) => !(k in spec.inputs));
  if (unknown.length > 0) {
    return `unknown input(s): ${unknown.join(", ")}`;
  }
  const missing = missingInputs(spec, given);
  return missing.length > 0 ? `missing required input(s): ${missing.join(", ")}` : undefined;
}

/** The runs kept on the wire beside the current one. */
export const WORKFLOW_RECENT_RUNS = 5;

interface Run {
  readonly runId: string;
  readonly source: WorkflowSource;
  readonly spec: WorkflowSpec;
  readonly hash: string;
  turnId: string | undefined;
  /** Set iff a schedule started it (slice 10): its hash was checked, it never asks for it. */
  readonly scheduleId?: string;
  state: WorkflowRunState;
  row: WorkflowRow;
  controller: AbortController;
  /** Set by an ask's wait expiry: the step ends `timeout`, not `fail`. */
  timedOut: boolean;
  /** Open asks of the current step (`waiting` while > 0). */
  asks: number;
  done: boolean;
  /** The current step's own abort (a timed-out ask cuts the step). */
  stepAbort?: AbortController;
  /** The `workflow_start` it logged (once approved): re-logged at a new segment. */
  startBody?: WorkflowStartBody;
  /**
   * The step execution in flight, for `session/workflow_step`
   * (docs/feat/workflows-ui.md D1): its resolved prompt and the row's `live`
   * text. Only the LIVE half is here — the ledger's entry is the durable one.
   */
  liveStep?: {
    readonly id: string;
    readonly attempt: number;
    readonly round: number;
    readonly prompt: string;
    live: string | undefined;
  };
}

const systemClock: WorkflowClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** A label for a `line()`-bounded wire field: whitespace runs (newlines too) collapsed. */
function oneLine(text: string, max: number): string {
  return capWorkflowText(text.replace(/\s+/g, " ").trim(), max);
}

export class WorkflowDriver {
  private readonly runs = new Map<string, Run>();
  private host: WorkflowHost | undefined;
  private seq = 0;
  private disposed = false;
  private readonly clock: WorkflowClock;

  constructor(private readonly deps: WorkflowDriverDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  bind(host: WorkflowHost): void {
    this.host = host;
  }

  /**
   * Never mint `wf-N` for `N <= highest`: the host seeds it from the session's
   * history (`workflowRunSeqFromHistory`), so a restarted process cannot reuse
   * an id an older run's end note already closed (review round 1 #1).
   */
  reserveRunIds(highest: number): void {
    if (Number.isSafeInteger(highest) && highest > this.seq) {
      this.seq = highest;
    }
  }

  /** The `workflows` update / snapshot rows: the running run + the last ended ones. */
  rows(): WorkflowRow[] {
    const all = [...this.runs.values()];
    const live = all.filter((r) => !r.done);
    const ended = all.filter((r) => r.done).slice(-WORKFLOW_RECENT_RUNS);
    return [...ended, ...live].map((r) => r.row);
  }

  /**
   * The live run's logged `workflow_start`, if it has one (approved, not
   * ended): the host logs it again at every new segment, so a crash after a
   * compaction still finds an open run to close at the next load.
   */
  liveStart(): WorkflowStartBody | undefined {
    return [...this.runs.values()].find((r) => !r.done)?.startBody;
  }

  /** The run in flight, if any (one per session). */
  current(): string | undefined {
    return [...this.runs.values()].find((r) => !r.done)?.runId;
  }

  /**
   * The step execution running NOW, if any (docs/feat/workflows-ui.md D1): what
   * `session/workflow_step` adds to a run whose step has no entry yet. `runId`
   * narrows it to that run; without one, the single run in flight is used (a
   * session runs one at a time), and a run that already ended has none.
   */
  liveStep(runId?: string):
    | {
        readonly runId: string;
        readonly stepId: string;
        readonly attempt: number;
        readonly round: number;
        readonly prompt: string;
        readonly live?: string;
      }
    | undefined {
    for (const run of this.runs.values()) {
      if (run.done || (runId !== undefined && run.runId !== runId)) {
        continue;
      }
      const step = run.liveStep;
      if (step !== undefined) {
        return {
          runId: run.runId,
          stepId: step.id,
          attempt: step.attempt,
          round: step.round,
          prompt: step.prompt,
          ...(step.live !== undefined ? { live: step.live } : {}),
        };
      }
    }
    return undefined;
  }

  /**
   * Validate and start `name`. Resolves once the run is under way (its hash
   * approval, when needed, is the run's first wait — never this call's).
   *
   * `hash` is what the caller SAW (the catalogue's row, D6): present and
   * different from the file's hash now → refused `changed` — nothing asked,
   * nothing run, no row — before the slot is claimed. Absent → the file is read
   * afresh as before (the TUI's `/workflow run`, the model's tool).
   */
  async start(request: {
    readonly name: string;
    readonly inputs?: Readonly<Record<string, string>>;
    readonly hash?: string;
    readonly by: "user" | "model";
    readonly turnId?: string;
  }): Promise<WorkflowStartResult> {
    if (this.disposed) {
      return { ok: false, reason: "the session is closing", refusal: "unavailable" };
    }
    const running = this.current();
    if (running !== undefined) {
      const run = this.runs.get(running);
      return {
        ok: false,
        reason: `workflow ${run?.spec.name ?? ""} (${running}) is already running: stop it first`,
        refusal: "running",
        runId: running,
      };
    }
    const prepared = await this.prepare(request.name);
    if (!prepared.ok) {
      return prepared;
    }
    if (request.hash !== undefined && request.hash !== prepared.hash) {
      return {
        ok: false,
        refusal: "changed",
        reason: `${prepared.source.path} changed since you opened it: review it and start again`,
      };
    }
    const given = request.inputs ?? {};
    const bad = inputsProblem(prepared.spec, given);
    if (bad !== undefined) {
      return { ok: false, reason: bad, refusal: "inputs" };
    }
    // Claimed synchronously after the last await: two starts cannot both pass.
    const raced = this.current();
    if (raced !== undefined || this.disposed) {
      return {
        ok: false,
        reason: "another workflow started meanwhile",
        refusal: "running",
        ...(raced !== undefined ? { runId: raced } : {}),
      };
    }
    // The model's tool names no turn: the one running now owns the run's asks.
    const turnId =
      request.turnId ?? (request.by === "model" ? this.host?.currentTurn?.() : undefined);
    return {
      ok: true,
      runId: this.begin(prepared, given, {
        by: request.by,
        ...(turnId !== undefined ? { turnId } : {}),
      }),
    };
  }

  /**
   * Validate `name` + `inputs` against the CURRENT file, without starting or
   * asking anything: its hash and whether that hash is approved. What a schedule
   * create pins (slice 10 S10-4).
   */
  async inspect(
    name: string,
    inputs: Readonly<Record<string, string>>,
  ): Promise<
    | { readonly ok: true; readonly hash: string; readonly approved: boolean }
    | { readonly ok: false; readonly reason: string }
  > {
    const prepared = await this.prepare(name);
    if (!prepared.ok) {
      return prepared;
    }
    const bad = inputsProblem(prepared.spec, inputs);
    if (bad !== undefined) {
      return { ok: false, reason: bad };
    }
    const approved = await this.deps.approvals.has(prepared.source.path, prepared.hash);
    return { ok: true, hash: prepared.hash, approved };
  }

  /**
   * The project's workflows, for `session/workflow_catalogue` (D6): ONE walk
   * (`deps.list`), then for each readable file the SAME validation and hash an
   * `inspect` does, plus whether that hash is approved. Model-free and
   * deterministic — no LLM, no ask, no write, no run: a listing must never park
   * on a permission prompt or start anything.
   *
   * A file that cannot be a workflow, or does not validate, is a row with its
   * errors (each naming its YAML path) — never a silent skip and never a throw,
   * so one bad file cannot hide the rest. A session with no `list` (a pod's
   * daemon) answers `unavailable`: distinct from "this folder has none".
   */
  async catalogue(): Promise<WorkflowCatalogue> {
    const list = this.deps.list;
    if (list === undefined) {
      return {
        workflows: [],
        dir: "",
        unavailable: "workflows run only on a laptop or serve session",
      };
    }
    const listing = await list();
    const workflows: WorkflowDef[] = [];
    for (const row of listing.rows) {
      if (row.kind === "invalid") {
        workflows.push({ name: row.name, path: row.path, ok: false, errors: [row.problem] });
        continue;
      }
      const prepared = await this.prepareSource(row.name, row.source);
      if (!prepared.ok) {
        workflows.push({
          name: row.name,
          path: row.source.path,
          ok: false,
          errors: prepared.errors,
        });
        continue;
      }
      const { spec, hash } = prepared;
      workflows.push({
        name: spec.name,
        path: row.source.path,
        ok: true,
        version: spec.version,
        ...(spec.description !== undefined ? { description: spec.description } : {}),
        hash,
        approved: await this.deps.approvals.has(row.source.path, hash),
        inputs: Object.entries(spec.inputs).map(([name, input]) => ({
          name,
          required: input.required,
          ...(input.default !== undefined ? { default: input.default } : {}),
        })),
        steps: spec.steps.map((step) => ({
          id: step.id,
          kind: step.kind,
          ...(step.kind === "agent" && step.model !== undefined ? { model: step.model } : {}),
          where: workflowWhereLabel(step),
          ...(step.kind === "run" ? { command: step.command } : {}),
        })),
      });
    }
    return {
      workflows,
      ...(listing.truncated ? { truncated: true as const } : {}),
      ...(listing.gitIgnored !== undefined ? { gitIgnored: listing.gitIgnored } : {}),
      dir: listing.dir,
      ...(listing.elsewhere !== undefined ? { elsewhere: listing.elsewhere } : {}),
    };
  }

  /**
   * What an editor opens (docs/feat/workflow-editor.md D3/D4): the file's
   * bytes, its draft (present iff the mapping is STRUCTURALLY a workflow, so a
   * file with a dangling `next` still opens and shows it), only the prompt files
   * its steps read, its hash (iff it validates — the SAME `prepareSourceSync` a
   * catalogue row and a start use) or its errors, and the session's picker
   * vocabulary. A read: no ask, no write, no store write.
   */
  async source(name: string): Promise<WorkflowSourceView> {
    if (this.deps.save === undefined || this.disposed) {
      return { ok: false, unavailable: NOT_EDITABLE_HERE };
    }
    const path = `${PROJECT_PATHS.workflows}/${name}.yaml`;
    const context = this.deps.context();
    let source: WorkflowSource;
    try {
      source = await this.deps.load(name);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, path, unreadable: reason, context };
    }
    const opened = draftOf(source.text);
    const prepared = this.prepareSourceSync(name, source);
    const draft = "draft" in opened ? opened.draft : undefined;
    const version = prepared.ok ? prepared.spec.version : draft?.version;
    return {
      ok: true,
      path: source.path,
      text: source.text,
      ...(draft !== undefined
        ? {
            draft,
            prompts: pick(source.prompts, draftPromptPaths(draft)),
            canonical: canonical(source.text, draft),
          }
        : { unreadable: "unreadable" in opened ? opened.unreadable : "" }),
      ...(prepared.ok ? { hash: prepared.hash } : { errors: prepared.errors }),
      ...(typeof version === "number" && Number.isSafeInteger(version) && version >= 0
        ? { version }
        : {}),
      context,
    };
  }

  /**
   * Save a draft (docs/feat/workflow-editor.md D4). `dryRun: true` is the Review
   * screen: every check, every row, nothing written; `false` re-does every check
   * and writes through `deps.save`.
   *
   * 1. the STRICT validator judges the draft VALUE (an unknown field is an error,
   *    never dropped), reading prompts from the request, then from disk;
   * 2. every prompt the request carries must be read by a step: nothing written
   *    can sit outside the hash;
   * 3. the bytes are emitted and proved to read back as the draft;
   * 4. the hash is `prepareSourceSync` over those bytes — the catalogue's own;
   * 5. the writer re-checks the base (`changed` / `exists`) in its one
   *    synchronous block, with `prepareSourceSync` as its hash.
   *
   * NEVER calls `approvals.add` and never asks: a saved hash is new, so the next
   * start asks `workflow_approve` through the session's ONE broker.
   */
  async save(request: WorkflowSaveRequest): Promise<WorkflowSaveOutcome> {
    const write = this.deps.save;
    if (write === undefined || this.disposed) {
      return { ok: false, refusal: "unavailable", reason: NOT_EDITABLE_HERE };
    }
    const { name } = request;
    const path = `${PROJECT_PATHS.workflows}/${name}.yaml`;
    const invalid = (reason: string, errors?: readonly string[]): WorkflowSaveOutcome => ({
      ok: false,
      refusal: "invalid",
      reason,
      path,
      ...(errors !== undefined ? { errors } : {}),
    });
    let base: WorkflowSource | undefined;
    try {
      base = await this.deps.load(name);
    } catch {
      base = undefined; // a `create`, or a file gone: the writer decides
    }
    const disk = base?.prompts ?? {};
    const prompts = request.prompts;
    const readPrompt = (p: string): string | undefined =>
      Object.hasOwn(prompts, p) ? prompts[p] : Object.hasOwn(disk, p) ? disk[p] : undefined;
    const validation = validateWorkflowValue(request.draft, {
      name,
      ...this.deps.context(),
      readPrompt,
    });
    if (!validation.ok) {
      return invalid(`${path}: ${validation.errors.join("; ")}`, validation.errors);
    }
    const draft = request.draft as Readonly<Record<string, unknown>>;
    const used = new Set(validation.spec.prompts.map((p) => p.path));
    const stray = Object.keys(prompts).filter((p) => !used.has(p));
    if (stray.length > 0) {
      return invalid(stray.map((p) => `${p} is not used by any step`).join("; "));
    }
    const bytes = checkedWorkflowBytes(draft);
    if ("reason" in bytes) {
      return invalid(`${path}: ${bytes.reason}`);
    }
    const merged: Record<string, string> = {};
    for (const p of used) {
      const text = readPrompt(p);
      if (text !== undefined) merged[p] = text;
    }
    const prepared = this.prepareSourceSync(name, { path, text: bytes.text, prompts: merged });
    if (!prepared.ok) {
      return invalid(prepared.reason, prepared.errors);
    }
    const hash = prepared.hash;
    const basePrompts =
      request.mode === "replace" && base !== undefined ? this.promptsRead(name, base) : undefined;
    const listing = this.deps.list !== undefined ? await this.deps.list() : undefined;
    const approved = await this.deps.approvals.has(path, hash);
    if (this.disposed) {
      return { ok: false, refusal: "unavailable", reason: "the session is closing" };
    }
    // The write: one synchronous block in the writer, its base hashed by the
    // SAME `prepareSourceSync` (no await between that check and the last rename).
    const written = write(
      {
        mode: request.mode,
        name,
        draft,
        prompts,
        ...(request.baseHash !== undefined ? { baseHash: request.baseHash } : {}),
        ...(basePrompts !== undefined ? { basePrompts } : {}),
        dryRun: request.dryRun,
      },
      (source) => {
        const current = this.prepareSourceSync(name, source);
        if (!current.ok) throw new Error(current.errors.join("; "));
        return current.hash;
      },
    );
    const files = written.files.map((f) => ({
      ...f,
      path: `${PROJECT_PATHS.workflows}/${f.path}`,
    }));
    if (!written.ok) {
      return {
        ok: false,
        refusal: written.refusal,
        reason: written.reason,
        path,
        ...(files.length > 0 ? { files } : {}),
      };
    }
    const touched = new Set(
      written.files
        .filter((f) => f.path !== `${name}.yaml` && f.status !== "unchanged")
        .map((f) => f.path),
    );
    const alsoChanges: string[] = [];
    for (const row of listing?.rows ?? []) {
      if (row.kind !== "source" || row.name === name || touched.size === 0) continue;
      if (this.promptsRead(row.name, row.source).some((p) => touched.has(p))) {
        alsoChanges.push(row.name);
      }
    }
    const running = this.current();
    const runningHere =
      running !== undefined && this.runs.get(running)?.spec.name === name ? running : undefined;
    return {
      ok: true,
      hash,
      version: prepared.spec.version,
      path,
      files,
      approved,
      ...(alsoChanges.length > 0 ? { alsoChanges } : {}),
      ...(runningHere !== undefined ? { running: runningHere } : {}),
    };
  }

  /**
   * The prompt files `source`'s steps read: from its validated spec, else (a
   * file that does not validate) from its draft — never every file of the folder.
   */
  private promptsRead(name: string, source: WorkflowSource): string[] {
    const prepared = this.prepareSourceSync(name, source);
    if (prepared.ok) {
      return prepared.spec.prompts.map((p) => p.path);
    }
    const opened = draftOf(source.text);
    return "draft" in opened ? draftPromptPaths(opened.draft) : [];
  }

  /**
   * A SCHEDULED start (slice 10 S10-3): deterministic, never asks. It refuses —
   * with no run and no row — when a run is in flight (`skipped`, never queued),
   * the file or inputs are bad (`invalid`), the file's hash is not the one the
   * schedule pinned (`changed`), or that hash is not approved (`unapproved`).
   * Otherwise it is an ordinary run (`by: "schedule"`), its asks attributed to
   * the daemon-minted `wake-` turn (A10).
   */
  async startScheduled(request: {
    readonly name: string;
    readonly inputs: Readonly<Record<string, string>>;
    readonly pinnedHash: string;
    readonly scheduleId: string;
    readonly turnId: string;
  }): Promise<WorkflowScheduledStartResult> {
    const busy = (): WorkflowScheduledStartResult | undefined => {
      if (this.disposed) {
        return { ok: false, outcome: "unavailable", reason: "the session is closing" };
      }
      const running = this.current();
      return running === undefined
        ? undefined
        : { ok: false, outcome: "skipped", reason: `${running} running` };
    };
    const before = busy();
    if (before !== undefined) {
      return before;
    }
    const prepared = await this.prepare(request.name);
    if (!prepared.ok) {
      return { ok: false, outcome: "invalid", reason: prepared.reason };
    }
    const bad = inputsProblem(prepared.spec, request.inputs);
    if (bad !== undefined) {
      return { ok: false, outcome: "invalid", reason: bad };
    }
    if (prepared.hash !== request.pinnedHash) {
      return {
        ok: false,
        outcome: "changed",
        reason:
          `${prepared.source.path} changed since ${request.scheduleId} was created ` +
          `(${shortHash(request.pinnedHash)} → ${shortHash(prepared.hash)}): re-create the schedule`,
      };
    }
    if (!(await this.deps.approvals.has(prepared.source.path, prepared.hash))) {
      return {
        ok: false,
        outcome: "unapproved",
        reason: `${prepared.source.path} (hash ${shortHash(prepared.hash)}) was never approved`,
      };
    }
    // Re-checked after the last await: a start that raced us wins, we skip.
    const after = busy();
    if (after !== undefined) {
      return after;
    }
    return {
      ok: true,
      runId: this.begin(prepared, request.inputs, {
        by: "schedule",
        turnId: request.turnId,
        scheduleId: request.scheduleId,
      }),
    };
  }

  /**
   * The hash approval of `name`'s CURRENT file, asked NOW (a schedule's create,
   * while someone is there — never at fire time). A background ask through the
   * ONE requester (agent id `approval:<name>`, attributed to `turnId`), withdrawn
   * after the file's `budget.wait`; on allow the hash is written to the store.
   * Resolves `true` iff that hash is approved at the end.
   */
  async requestApproval(name: string, turnId?: string): Promise<boolean> {
    const prepared = await this.prepare(name);
    if (!prepared.ok) {
      return false;
    }
    const { source, spec, hash } = prepared;
    if (await this.deps.approvals.has(source.path, hash)) {
      return true;
    }
    const agentId = `approval:${spec.name}`;
    const waited = new AbortController();
    const timer = this.clock.setTimeout(() => waited.abort(), spec.budget.waitMs);
    this.host?.attribute(agentId, turnId);
    try {
      const answer = await this.deps.request(
        {
          kind: "workflow_approve",
          tool: WORKFLOW_APPROVE_TOOL,
          level: "ask",
          title: oneLine(
            `Approve workflow ${spec.name} v${spec.version} (hash ${shortHash(hash)}) for its schedule`,
            200,
          ),
          detail: workflowApprovalSummary(spec.steps),
          input: {},
        },
        {
          toolCallId: agentId,
          agent: { type: "workflow", description: `${spec.name}/approval`, id: agentId },
          signal: waited.signal,
        },
      );
      if (!answer.allowed) {
        return false;
      }
      await this.deps.approvals.add(source.path, hash);
      return true;
    } finally {
      this.clock.clearTimeout(timer);
      this.host?.release(agentId);
    }
  }

  /** Create the run row and launch it; the caller has validated and claimed the slot. */
  private begin(
    prepared: { source: WorkflowSource; spec: WorkflowSpec; hash: string },
    given: Readonly<Record<string, string>>,
    origin: {
      readonly by: WorkflowStartedBy;
      readonly turnId?: string;
      readonly scheduleId?: string;
    },
  ): string {
    const { source, spec, hash } = prepared;
    this.seq += 1;
    const runId = `wf-${this.seq}`;
    const begun = startMachine(spec, given);
    const run: Run = {
      runId,
      source,
      spec,
      hash,
      turnId: origin.turnId,
      ...(origin.scheduleId !== undefined ? { scheduleId: origin.scheduleId } : {}),
      state: begun.state,
      row: {
        runId,
        name: spec.name,
        version: spec.version,
        hash,
        state: "needs-approval",
        tokens: 0,
        ...(spec.budget.tokens !== undefined ? { budget: spec.budget.tokens } : {}),
        startedAt: this.clock.now(),
        history: [],
        historyDropped: 0,
        steps: spec.steps.map((step) => this.pendingRow(spec, step)),
      },
      controller: new AbortController(),
      timedOut: false,
      asks: 0,
      done: false,
    };
    this.runs.set(runId, run);
    this.publish();
    void this.launch(run, begun.action, origin.by).catch(() => {});
    return runId;
  }

  /** Stop the run: its step is aborted, the run ends `stopped: cancelled`. */
  stop(runId: string): WorkflowStartResult {
    const run = this.runs.get(runId);
    if (run === undefined || run.done) {
      return { ok: false, reason: `${runId} is not running` };
    }
    run.controller.abort();
    return { ok: true, runId };
  }

  /**
   * Re-run an ENDED run from `stepId` (owner Q4: explicit only), same run id,
   * attempt +1. The file is re-read: a different hash refuses (`changed`).
   */
  async rerun(
    runId: string,
    stepId: string | undefined,
    turnId?: string,
  ): Promise<WorkflowStartResult> {
    const run = this.runs.get(runId);
    if (run === undefined) {
      return {
        ok: false,
        reason: `${runId} is not a run of this session process (a run a restart cut is not resumed): start a new run`,
      };
    }
    if (!run.done) {
      return { ok: false, reason: `${runId} is still running` };
    }
    if (this.current() !== undefined) {
      return { ok: false, reason: `${this.current()} is running: stop it first` };
    }
    const prepared = await this.prepare(run.spec.name);
    if (!prepared.ok || prepared.hash !== run.hash) {
      return {
        ok: false,
        reason: `stopped · changed: ${run.source.path} changed since ${runId} started — start a new run`,
      };
    }
    const at = stepId ?? run.state.current;
    if (!run.spec.steps.some((s) => s.id === at)) {
      return { ok: false, reason: `${at} is not a step of ${run.spec.name}` };
    }
    if (this.current() !== undefined || this.disposed) {
      return { ok: false, reason: "another workflow started meanwhile" };
    }
    // A NEW run (fresh id, its own `workflow_start` … `workflow_end`) carrying
    // the old one's machine state: reusing the id would let the old run's end
    // note hide a crash during this one at the next load (review round 1 #1).
    const resumed = rerunAt(run.state, at);
    this.seq += 1;
    const nextId = `wf-${this.seq}`;
    const { endedAt: _endedAt, reason: _reason, stopReason: _stop, ...rest } = run.row;
    const next: Run = {
      runId: nextId,
      source: run.source,
      spec: run.spec,
      hash: run.hash,
      turnId: turnId ?? run.turnId,
      state: resumed.state,
      row: {
        ...rest,
        runId: nextId,
        state: "running",
        startedAt: this.clock.now(),
        steps: rest.steps.map((s) =>
          s.state === "stopped" ? { ...s, state: "pending", live: undefined } : s,
        ),
      },
      controller: new AbortController(),
      timedOut: false,
      asks: 0,
      done: false,
    };
    this.runs.set(nextId, next);
    this.publish();
    void this.launch(next, resumed.action, "user").catch(() => {});
    return { ok: true, runId: nextId };
  }

  /** The session closes: every live run is cut and closed `interrupted`. */
  dispose(): void {
    this.disposed = true;
    for (const run of this.runs.values()) {
      if (!run.done) {
        run.controller.abort();
      }
    }
  }

  // --- internals ---

  private async prepare(
    name: string,
  ): Promise<
    | { ok: true; source: WorkflowSource; spec: WorkflowSpec; hash: string }
    | { ok: false; reason: string; refusal: "invalid" }
  > {
    let source: WorkflowSource;
    try {
      source = await this.deps.load(name);
    } catch (error) {
      return {
        ok: false,
        refusal: "invalid",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    return this.prepareSource(name, source);
  }

  /**
   * The SAME validation and hash as `prepare`, over a source the caller already
   * read (a catalogue row): one implementation, so a row's `hash` is exactly the
   * hash `start{hash}` compares against.
   */
  private async prepareSource(
    name: string,
    source: WorkflowSource,
  ): Promise<
    | { ok: true; source: WorkflowSource; spec: WorkflowSpec; hash: string }
    | { ok: false; reason: string; refusal: "invalid"; errors: readonly string[] }
  > {
    return this.prepareSourceSync(name, source);
  }

  /**
   * The ONE validate+hash (docs/feat/workflow-editor.md D4): `prepareSource`
   * (catalogue, start, inspect), a save's preview hash and the writer's base
   * check all run this, so a hash is the same number on every path. Synchronous,
   * so the writer can call it inside its one block.
   */
  prepareSourceSync(
    name: string,
    source: WorkflowSource,
  ):
    | { ok: true; source: WorkflowSource; spec: WorkflowSpec; hash: string }
    | { ok: false; reason: string; refusal: "invalid"; errors: readonly string[] } {
    const validation = validateWorkflow(source.text, {
      name,
      ...this.deps.context(),
      readPrompt: (path) => source.prompts[path],
    });
    if (!validation.ok) {
      return {
        ok: false,
        refusal: "invalid",
        reason: `${source.path}: ${validation.errors.join("; ")}`,
        // Each error on its own (it names its YAML path): a catalogue row lists
        // them, never one joined string cut at the wire's cap (review round 1 #2).
        errors: validation.errors,
      };
    }
    const files: WorkflowPromptFile[] = validation.spec.prompts.map((p) => ({
      path: p.path,
      text: p.text,
    }));
    const hash = workflowHash(source.text, files, this.deps.hasher ?? undefined);
    return { ok: true, source, spec: validation.spec, hash };
  }

  private pendingRow(spec: WorkflowSpec, step: WorkflowStep): WorkflowStepRow {
    return {
      id: step.id,
      kind: step.kind,
      ...(step.kind === "agent" && step.model !== undefined ? { model: step.model } : {}),
      where: workflowWhereLabel(step),
      state: "pending",
      attempt: 0,
      round: 0,
      next: passTarget(spec, step) ?? null,
      onFail:
        step.onFail.kind === "goto"
          ? { goto: step.onFail.id, max: step.onFail.max, taken: 0 }
          : null,
      retry: step.retry,
    };
  }

  private publish(): void {
    this.host?.publish(this.rows());
  }

  private setStep(run: Run, id: string, patch: Partial<WorkflowStepRow>): void {
    // The live half of `session/workflow_step` follows the row it mirrors.
    if (run.liveStep !== undefined && run.liveStep.id === id) {
      run.liveStep.live = patch.live;
    }
    run.row = {
      ...run.row,
      steps: run.row.steps.map((s) => {
        if (s.id !== id) {
          return s;
        }
        // An `undefined` in the patch CLEARS that field (a finished step's `live`).
        const merged: Record<string, unknown> = { ...s, ...patch };
        for (const key of Object.keys(merged)) {
          if (merged[key] === undefined) {
            delete merged[key];
          }
        }
        return merged as unknown as WorkflowStepRow;
      }),
    };
  }

  /**
   * Report the goto edge's counter as it stands (D1): `on_fail.goto` may have
   * been taken by the outcome that just ended. Read from the machine's own
   * `state.counters`, so the row can never disagree with the decision it shows.
   */
  private refreshTaken(run: Run, step: WorkflowStep): void {
    if (step.onFail.kind !== "goto") {
      return;
    }
    const { id, max } = step.onFail;
    this.setStep(run, step.id, {
      onFail: { goto: id, max, taken: run.state.counters[edgeKey(step.id, id)] ?? 0 },
    });
  }

  /** The hash approval (D2), then the steps. */
  private async launch(run: Run, first: WorkflowAction, by: WorkflowStartedBy): Promise<void> {
    // A scheduled run's hash was checked approved by `startScheduled`: it never asks.
    const approved = run.scheduleId !== undefined ? true : await this.approveHash(run);
    if (approved !== true) {
      this.finish(run, approved, false);
      return;
    }
    run.startBody = workflowStartBody({
      runId: run.runId,
      name: run.spec.name,
      version: run.spec.version,
      hash: run.hash,
      path: run.source.path,
      inputs: run.state.inputs,
      by,
      ...(run.turnId !== undefined ? { turnId: run.turnId } : {}),
      ...(run.scheduleId !== undefined ? { scheduleId: run.scheduleId } : {}),
    });
    this.host?.logStart(run.startBody);
    run.row = { ...run.row, state: "running" };
    this.publish();
    await this.drive(run, first);
  }

  /** `true`, or the end the run takes instead (denied, timed out, cancelled). */
  private async approveHash(
    run: Run,
  ): Promise<
    true | { status: "stopped" | "error"; stopReason?: "timeout" | "cancelled"; reason: string }
  > {
    if (await this.deps.approvals.has(run.source.path, run.hash)) {
      return true;
    }
    const steps = workflowApprovalSummary(run.spec.steps);
    const answer = await this.stepRequester(run, null)(
      {
        kind: "workflow_approve",
        tool: WORKFLOW_APPROVE_TOOL,
        level: "ask",
        title: oneLine(
          `Run workflow ${run.spec.name} v${run.spec.version} (hash ${shortHash(run.hash)})`,
          200,
        ),
        detail: steps,
        input: {},
      },
      { toolCallId: run.runId },
    );
    if (answer.allowed) {
      await this.deps.approvals.add(run.source.path, run.hash);
      return true;
    }
    if (run.timedOut) {
      return {
        status: "stopped",
        stopReason: "timeout",
        reason: "the approval was not answered in time",
      };
    }
    if (run.controller.signal.aborted) {
      return {
        status: "stopped",
        stopReason: "cancelled",
        reason: "stopped before it was approved",
      };
    }
    return {
      status: "error",
      reason: `not approved${answer.message !== undefined ? `: ${answer.message}` : ""}`,
    };
  }

  private async drive(run: Run, first: WorkflowAction): Promise<void> {
    let action = first;
    while (action.kind === "run_step") {
      const stepId = action.id;
      const step = run.spec.steps.find((s) => s.id === stepId);
      if (step === undefined) {
        break;
      }
      const startedAt = this.clock.now();
      run.timedOut = false;
      run.asks = 0;
      this.setStep(run, step.id, {
        state: "running",
        attempt: action.attempt,
        round: action.round,
        ...(action.maxRound !== undefined ? { maxRound: action.maxRound } : {}),
        reason: undefined,
        live: undefined,
      });
      run.row = { ...run.row, state: "running" };
      this.publish();
      // What `session/workflow_step` answers while this execution has no entry
      // yet: the prompt it was run with, and the row's live text as it changes.
      run.liveStep = {
        id: step.id,
        attempt: action.attempt,
        round: action.round,
        prompt: action.text,
        live: undefined,
      };
      const outcome = await this.runStep(run, step, action);
      const durationMs = Math.max(0, this.clock.now() - startedAt);
      const logState =
        outcome.event.kind !== "step_result"
          ? "stopped"
          : outcome.event.verdict === "pass"
            ? "ok"
            : "error";
      this.host?.logStep(
        workflowStepBody({
          runId: run.runId,
          stepId: step.id,
          attempt: action.attempt,
          round: action.round,
          state: logState,
          ...(outcome.event.kind === "step_result" ? { verdict: outcome.event.verdict } : {}),
          reason: outcome.reason,
          ...(step.kind === "agent" && step.model !== undefined ? { model: step.model } : {}),
          where: workflowWhereLabel(step),
          tokens: outcome.tokens,
          durationMs,
          prompt: action.text,
          ...(outcome.report !== undefined ? { report: outcome.report } : {}),
        }),
      );
      this.setStep(run, step.id, {
        state: logState,
        reason: capWorkflowText(outcome.reason, 2000),
        live: undefined,
        durationMs,
      });
      // Its `workflow_step` entry IS the detail now: nothing live is left to add.
      run.liveStep = undefined;
      const advanced = nextAction(run.state, outcome.event);
      run.state = advanced.state;
      const entry: WorkflowHistoryRow = {
        step: step.id,
        attempt: action.attempt,
        round: action.round,
        state: logState,
        durationMs,
      };
      // The finished execution, recorded HERE (D1): the step row keeps only a
      // step's LAST state, so a loop or a retry leaves no trace in `steps`. The
      // latest `WORKFLOW_HISTORY_MAX` are kept; the rest is counted, never lost
      // silently.
      const appended = [...run.row.history, entry];
      const history = appended.slice(-WORKFLOW_HISTORY_MAX);
      run.row = {
        ...run.row,
        tokens: run.state.tokens,
        history,
        historyDropped: run.row.historyDropped + appended.length - history.length,
      };
      // AFTER `nextAction`: the goto counter it just moved is the one to report.
      this.refreshTaken(run, step);
      action = advanced.action;
    }
    this.finish(run, undefined, true);
  }

  /** Close the run once: log its end (when it started), the row, the note. */
  private finish(
    run: Run,
    instead:
      | { status: "stopped" | "error"; stopReason?: "timeout" | "cancelled"; reason: string }
      | undefined,
    started: boolean,
  ): void {
    if (run.done) {
      return;
    }
    run.done = true;
    run.liveStep = undefined;
    const status = instead?.status ?? (run.state.status === "running" ? "error" : run.state.status);
    const stopReason = instead !== undefined ? instead.stopReason : run.state.stopReason;
    const reason = instead?.reason ?? endReason(run.state);
    if (started) {
      this.host?.logEnd(
        workflowEndBody({
          runId: run.runId,
          state: status,
          ...(stopReason !== undefined ? { stopReason } : {}),
          reason,
        }),
      );
    }
    run.row = {
      ...run.row,
      state: status,
      ...(stopReason !== undefined ? { stopReason } : {}),
      reason: capWorkflowText(reason, 2000),
      endedAt: this.clock.now(),
      steps: run.row.steps.map((s) =>
        s.state === "running" || s.state === "waiting" || s.state === "needs-approval"
          ? { ...s, state: "stopped", live: undefined }
          : s,
      ),
    };
    this.publish();
    const done = run.row.steps.filter((s) => s.state === "ok").length;
    const word = stopReason !== undefined ? `${status} · ${stopReason}` : status;
    this.host?.ended(
      run.runId,
      `[workflow ${run.runId} ${run.spec.name}: ${word} · ${done}/${run.spec.steps.length} · ${run.state.tokens} tok] ${oneLine(reason, 400)}`,
    );
  }

  /**
   * The asker every step of `run` uses: the session's ONE requester, the ask
   * tagged with the step's agent id (the daemon's background path, attributed
   * to the run's start turn) and armed with `budget.wait` (decision 3).
   */
  private stepRequester(run: Run, stepId: string | null): PermissionRequester {
    // `null`: the run's hash approval, asked before any step (its own id).
    const agentId = stepId !== null ? `${run.runId}.${stepId}` : run.runId;
    return async (
      req: PermissionRequest,
      options?: PermissionRequestOptions,
    ): Promise<PermissionResponse> => {
      const waited = new AbortController();
      const timer = this.clock.setTimeout(() => {
        run.timedOut = true;
        waited.abort();
      }, run.spec.budget.waitMs);
      const own = [run.controller.signal, waited.signal];
      const signal = anySignal(options?.signal !== undefined ? [options.signal, ...own] : own);
      run.asks += 1;
      const waitingState = req.kind === "workflow_approve" ? "needs-approval" : "waiting";
      if (stepId !== null) {
        this.setStep(run, stepId, { state: waitingState });
      }
      run.row = { ...run.row, state: waitingState };
      this.publish();
      this.host?.attribute(agentId, run.turnId);
      try {
        return await this.deps.request(req, {
          ...options,
          agent: options?.agent ?? {
            type: "workflow",
            description: `${run.spec.name}/${stepId ?? "approval"}`,
            id: agentId,
          },
          signal,
        });
      } finally {
        this.clock.clearTimeout(timer);
        run.asks -= 1;
        if (run.asks === 0 && !run.done) {
          if (stepId !== null) {
            this.setStep(run, stepId, { state: "running" });
          }
          run.row = { ...run.row, state: "running" };
          this.publish();
        }
        // A timed-out ask ends the step: the child (or command) stops here.
        if (run.timedOut) {
          run.stepAbort?.abort();
        }
      }
    };
  }

  /** The event a step's end turns into when it was cut short, if it was. */
  private cutEvent(run: Run): WorkflowEvent | undefined {
    if (run.timedOut) {
      return { kind: "timeout" };
    }
    if (run.controller.signal.aborted) {
      return this.disposed ? { kind: "interrupted" } : { kind: "cancel" };
    }
    return undefined;
  }

  private async runStep(
    run: Run,
    step: WorkflowStep,
    action: Extract<WorkflowAction, { kind: "run_step" }>,
  ): Promise<{ event: WorkflowEvent; reason: string; tokens: number; report?: string }> {
    const stepAbort = new AbortController();
    run.stepAbort = stepAbort;
    const signal = anySignal([run.controller.signal, stepAbort.signal]);
    try {
      const result =
        step.kind === "agent"
          ? await this.agentStep(run, step, action, signal)
          : step.kind === "run"
            ? await this.runCommand(run, step, action, signal)
            : await this.approveStep(run, step, action);
      const cut = this.cutEvent(run);
      if (cut !== undefined) {
        return {
          ...result,
          event: cut,
          reason: cut.kind === "timeout" ? "an ask was not answered in time" : result.reason,
        };
      }
      return result;
    } finally {
      run.stepAbort = undefined;
      this.host?.release(`${run.runId}.${step.id}`);
    }
  }

  private async agentStep(
    run: Run,
    step: Extract<WorkflowStep, { kind: "agent" }>,
    action: Extract<WorkflowAction, { kind: "run_step" }>,
    signal: AbortSignal,
  ): Promise<{ event: WorkflowEvent; reason: string; tokens: number; report?: string }> {
    const agentId = `${run.runId}.${step.id}`;
    const release = await this.takeSlot(run, step, signal);
    if (release === undefined) {
      return {
        event: { kind: "cancel" },
        reason: "stopped while waiting for a sub-agent slot",
        tokens: 0,
      };
    }
    const verdict = createStepVerdict();
    let tokens = 0;
    this.host?.attribute(agentId, run.turnId);
    try {
      const result = await this.deps.runnerFor(this.stepRequester(run, step.id))(
        {
          description: `${run.spec.name}/${step.id}`,
          prompt: action.text,
          type: step.type ?? "general",
          ...(step.model !== undefined ? { model: step.model } : {}),
        },
        {
          signal,
          toolCallId: run.runId,
          agentId,
          ...(step.tokens !== undefined ? { maxTokens: step.tokens } : {}),
          extraTools: [verdict.tool],
          onEvent: (event) => {
            if (event.kind === "subagent_usage") {
              tokens += event.promptTokens + event.completionTokens;
            } else if (event.kind === "subagent_tool") {
              this.setStep(run, step.id, { live: oneLine(event.label, 200) });
              this.publish();
            }
          },
        },
      );
      const said = verdict.verdict();
      if (said !== undefined) {
        return {
          event: {
            kind: "step_result",
            verdict: said.verdict,
            reason: said.reason,
            tokens,
            report: result.report,
          },
          reason: said.reason,
          tokens,
          report: result.report,
        };
      }
      if (result.stopReason === "max_token_budget") {
        return {
          event: { kind: "budget_hit", reason: `step ${step.id} reached its token budget` },
          reason: "token budget reached",
          tokens,
          report: result.report,
        };
      }
      return {
        event: {
          kind: "step_result",
          verdict: "fail",
          reason: "no verdict",
          tokens,
          report: result.report,
        },
        reason: "no verdict",
        tokens,
        report: result.report,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const report = error instanceof SubagentFailure ? error.partialReport : undefined;
      const reason = `error: ${message}`;
      return {
        event: {
          kind: "step_result",
          verdict: "fail",
          reason,
          tokens,
          ...(report !== undefined ? { report } : {}),
        },
        reason,
        tokens,
        ...(report !== undefined ? { report } : {}),
      };
    } finally {
      release();
    }
  }

  /** One slot of the ONE sub-agent cap; a full cap waits (`waiting · slot`), never errors. */
  private async takeSlot(
    run: Run,
    step: WorkflowStep,
    signal: AbortSignal,
  ): Promise<(() => void) | undefined> {
    const slots = this.deps.slots;
    if (slots === undefined) {
      return () => {};
    }
    for (;;) {
      if (signal.aborted) {
        return undefined;
      }
      const slot = slots.acquire(`${run.spec.name}/${step.id}`);
      if (slot.ok) {
        this.setStep(run, step.id, { state: "running", live: undefined });
        this.publish();
        return () => slot.release();
      }
      this.setStep(run, step.id, { state: "waiting", live: "slot" });
      this.publish();
      await new Promise<void>((resolve) => {
        const timer = this.clock.setTimeout(() => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        }, this.deps.slotRetryMs ?? 2_000);
        const onAbort = (): void => {
          this.clock.clearTimeout(timer);
          resolve();
        };
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }
  }

  private async runCommand(
    run: Run,
    step: Extract<WorkflowStep, { kind: "run" }>,
    action: Extract<WorkflowAction, { kind: "run_step" }>,
    signal: AbortSignal,
  ): Promise<{ event: WorkflowEvent; reason: string; tokens: number; report?: string }> {
    const fail = (reason: string, report?: string) => ({
      event: {
        kind: "step_result" as const,
        verdict: "fail" as const,
        reason,
        ...(report !== undefined ? { report } : {}),
      },
      reason,
      tokens: 0,
      ...(report !== undefined ? { report } : {}),
    });
    const commands = this.deps.commands;
    if (commands === undefined) {
      return fail("run steps are not available in this session");
    }
    // A container step needs the seam that reaches one; without it the step fails
    // saying what is missing rather than running the command on the LAPTOP.
    if (step.where.engine !== "local" && commands.execOn === undefined) {
      return fail(
        `where: ${workflowWhereLabel(step)} is not available in this session (no workload seam)`,
      );
    }
    const requestedTarget: WorkflowContainerTarget | undefined =
      step.where.engine === "local"
        ? undefined
        : { engine: "docker" as const, name: step.where.name };
    const authorized = await commands.authorize(action.text, this.stepRequester(run, step.id), {
      toolCallId: run.runId,
      signal,
      ...(requestedTarget !== undefined ? { target: requestedTarget } : {}),
    });
    if (!authorized.allowed) {
      return fail(authorized.reason);
    }
    // What runs is what was APPROVED, never the file's own text: a `tool_call`
    // hook may rewrite the input (`PermissionGate.authorize` hands back
    // `outcome.input`, and its ask shows that rewritten form), and the agent
    // loop runs exactly that. Running the file's own text here would show the
    // person the safe rewrite and execute the dangerous original — and the same
    // holds for the workload it runs on. `authorize` guarantees the approved
    // command is present, so there is no fallback to fall back to.
    const command = authorized.command;
    const target =
      requestedTarget === undefined ? undefined : (authorized.target ?? requestedTarget);
    // The container's own run: exit code + output, and the seam's notes, which
    // say a killed/lost/reopened shell did not simply run the command.
    if (target !== undefined) {
      let ran: WorkflowContainerOutcome;
      try {
        ran = await (commands.execOn as NonNullable<WorkflowCommands["execOn"]>)(target, command, {
          signal,
          timeoutMs: step.timeoutMs,
        });
      } catch (error) {
        return fail(`error: ${error instanceof Error ? error.message : String(error)}`);
      }
      const output = ran.output.trimEnd();
      const notes = ran.notes?.filter((n) => n !== "") ?? [];
      if (ran.exitCode === 0 && notes.length === 0) {
        return {
          event: { kind: "step_result", verdict: "pass", reason: "exit 0", report: output },
          reason: "exit 0",
          tokens: 0,
          report: output,
        };
      }
      const why = `exit ${ran.exitCode}${notes.length > 0 ? ` · ${notes.join(" ")}` : ""}`;
      const tail = output.split("\n").slice(-20).join("\n");
      return fail(`${why}${tail !== "" ? `\n${tail}` : ""}`, output);
    }
    let result: ExecResult;
    try {
      result = await commands.exec(command, { signal, timeoutMs: step.timeoutMs });
    } catch (error) {
      return fail(`error: ${error instanceof Error ? error.message : String(error)}`);
    }
    const output = `${result.stdout}${result.stderr !== "" ? `\n${result.stderr}` : ""}`.trimEnd();
    if (result.exitCode === 0) {
      return {
        event: { kind: "step_result", verdict: "pass", reason: "exit 0", report: output },
        reason: "exit 0",
        tokens: 0,
        report: output,
      };
    }
    const tail = output.split("\n").slice(-20).join("\n");
    return fail(`exit ${result.exitCode}${tail !== "" ? `\n${tail}` : ""}`, output);
  }

  /** A human decision: allow-once / deny, through the ONE broker, never auto-accepted. */
  private async approveStep(
    run: Run,
    step: Extract<WorkflowStep, { kind: "approve" }>,
    action: Extract<WorkflowAction, { kind: "run_step" }>,
  ): Promise<{ event: WorkflowEvent; reason: string; tokens: number }> {
    const answer = await this.stepRequester(run, step.id)(
      {
        kind: "workflow_approve",
        tool: WORKFLOW_APPROVE_TOOL,
        level: "ask",
        title: oneLine(action.text, 200),
        ...(step.detail !== undefined ? { detail: step.detail } : {}),
        input: {},
        reply: { maxChars: 2000 },
      },
      { toolCallId: run.runId },
    );
    if (answer.allowed) {
      return {
        event: { kind: "step_result", verdict: "pass", reason: "approved" },
        reason: "approved",
        tokens: 0,
      };
    }
    const reason = `denied${answer.message !== undefined ? `: ${answer.message}` : ""}`;
    return { event: { kind: "step_result", verdict: "fail", reason }, reason, tokens: 0 };
  }
}
