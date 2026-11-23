/**
 * Workflow files (`workflows/<name>.yaml`) — the ONE reader, and the hash an
 * approval is bound to (docs/feat/agent-workflows.md D1/D2).
 *
 * A workflow is a repo file the model writes and the user approves; the CODE
 * then executes the sequence (owner decision 2). So nothing here decides
 * anything at run time: `validateWorkflow` refuses a file before any ask, and
 * `workflowHash` says which exact bytes were approved. The executor is
 * `workflow-machine.ts` and the driver that calls it is daemon-side.
 *
 * Pure: no I/O, no clock, no React. Prompts are read by the CALLER and handed
 * in (a `prompt:` path is checked here, its bytes are not read here), and
 * sha-256 comes from the runtime instead of `node:crypto` — `@tentacle/core` is
 * in the phone's bundle, where neither `node:` nor `Bun` exists.
 *
 * Errors speak plain sentences, every one at once, each naming its YAML path
 * (`steps[3].on_fail.goto: no step "fx" (did you mean "fix"?)`): the reader is
 * the model's repair loop, and a small model fixes a sentence, not a zod dump.
 */
import { z } from "zod";

/** The on-disk format version. An unknown one is refused, the file untouched. */
export const WORKFLOW_SCHEMA_VERSION = 1;

/** Bumped only when the hash's pre-image shape changes — a new approval for all. */
export const WORKFLOW_HASH_SEED = "tentacle-workflow-v1\0";

/** `name`: lowercase alnum + single hyphens (matches the file stem). */
export const WORKFLOW_NAME_MAX = 64;
/** Steps per workflow. */
export const WORKFLOW_MAX_STEPS = 64;
export const WORKFLOW_MAX_DESCRIPTION = 200;
/** `retry: 0..5` — re-runs of the SAME step after `fail`. */
export const WORKFLOW_MAX_RETRY = 5;
/** `on_fail.goto.max: 1..10` — how many times one goto edge may be taken. */
export const WORKFLOW_MAX_GOTO = 10;
export const WORKFLOW_DEFAULT_MAX_STEP_RUNS = 50;
/** Owner Q5 / decision 3: how long a step's ask waits before the run stops. */
export const WORKFLOW_DEFAULT_WAIT_MS = 12 * 3_600_000;
/** A `run` step's own default. */
export const WORKFLOW_DEFAULT_TIMEOUT_MS = 20 * 60_000;
export const WORKFLOW_MAX_TIMEOUT_MS = 24 * 3_600_000;
/** `budget.wait`'s ceiling: well under a timer's 2^31 ms (~24.8 days) overflow. */
export const WORKFLOW_MAX_WAIT_MS = 7 * 24 * 3_600_000;
export const WORKFLOW_MAX_APPROVE_TITLE = 200;
export const WORKFLOW_MAX_APPROVE_DETAIL = 2000;
/**
 * The longest step list an approval may SHOW (docs/fix/workflow-approve-detail.md
 * D1): the hash ask's `detail` is never cut, so a workflow whose list would not
 * fit here is refused at validation — never asked with a command missing. About
 * 64 steps of 250 characters, ~200 rows at 80 columns: a list a human can read.
 */
export const WORKFLOW_MAX_APPROVE_SUMMARY = 16_000;
/** A step's reason (the verdict's justification) as the log and the views carry it. */
export const WORKFLOW_MAX_REASON = 2000;
/** A run's `inputs` — strings only in v1. */
export const WORKFLOW_MAX_INPUTS_BYTES = 4 * 1024;

/** A step's reason/report, capped the way the log caps it. */
export function capWorkflowText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** `30s` | `20m` | `12h` → ms; null when it is not a duration. */
export function parseWorkflowDuration(text: string): number | null {
  const m = /^(\d{1,7})([smh])$/.exec(text.trim());
  if (!m) {
    return null;
  }
  const n = Number(m[1]);
  const unit = m[2] === "s" ? 1_000 : m[2] === "m" ? 60_000 : 3_600_000;
  return n * unit;
}

/** One declared input: a string, either required or defaulted. */
export interface WorkflowInput {
  readonly required: boolean;
  readonly default?: string;
}

/**
 * Where a `run` step executes. `local` is the daemon's own shell; `docker` is
 * that named container through the workload exec seam. `agent` steps are
 * `local` ONLY (owner decision 4: no agent step in a pod).
 *
 * A docker target carries NO `container`: a docker workload has no
 * sub-containers, as `workload_shell`'s schema (`engineOnlyFields`) and the
 * engine (`engine-docker.ts` `noSubContainer`) both say. Accepting one would
 * validate the file, approve its hash and ask its command, and only then fail
 * the step.
 */
export type WorkflowWhere =
  | { readonly engine: "local" }
  | { readonly engine: "docker"; readonly name: string };

interface WorkflowStepBase {
  readonly id: string;
  /** `retry: 0..5` — re-runs of the same step after `fail` (default 0). */
  readonly retry: number;
  /** After `fail` and retries exhausted: stop, or jump with a counter. */
  readonly onFail:
    | { readonly kind: "stop" }
    | { readonly kind: "goto"; readonly id: string; readonly max: number };
  /** Replaces the fall-through after `pass`. */
  readonly next?: string;
  /** The YAML path of this step in its file (`steps[2]`), for errors and the UI. */
  readonly at: string;
}

/** An agent step: one sub-agent run, verdict typed by the child's tool call. */
export interface WorkflowAgentStep extends WorkflowStepBase {
  readonly kind: "agent";
  /** As written in the file, relative to `workflows/`; absent for `prompt_text`. */
  readonly promptPath?: string;
  /** The prompt text: the `prompt:` file's bytes, or the inline `prompt_text`. */
  readonly promptText?: string;
  readonly model?: string;
  readonly type?: string;
  /** This step's token cap; the run's `budget.tokens` caps the sum. */
  readonly tokens?: number;
}

/** A command step: exit 0 is `pass`, anything else is `fail`. */
export interface WorkflowRunStep extends WorkflowStepBase {
  readonly kind: "run";
  readonly command: string;
  readonly where: WorkflowWhere;
  readonly timeoutMs: number;
}

/** A human decision: allow-once or deny, never auto-accepted. */
export interface WorkflowApproveStep extends WorkflowStepBase {
  readonly kind: "approve";
  readonly title: string;
  readonly detail?: string;
}

export type WorkflowStep = WorkflowAgentStep | WorkflowRunStep | WorkflowApproveStep;

/** A run step's target as an approval line names it: `local`, or `docker:<name>`. */
export function workflowWhereLabel(step: WorkflowStep): string {
  if (step.kind !== "run" || step.where.engine === "local") {
    return "local";
  }
  return `docker:${step.where.name}`;
}

/**
 * One line per step — what a hash approval SHOWS (and what the validator bounds):
 * a `run` step's command verbatim, in backticks, with its target. The ONE reader
 * of this shape, so the driver can never disagree with the validator about how
 * long an approval list is (docs/fix/workflow-approve-detail.md D1).
 */
export function workflowApprovalSummary(steps: readonly WorkflowStep[]): string {
  return steps
    .map((s) =>
      s.kind === "run"
        ? `${s.id}: run \`${s.command}\` (${workflowWhereLabel(s)})`
        : s.kind === "agent"
          ? `${s.id}: agent${s.model !== undefined ? ` ${s.model}` : ""}`
          : `${s.id}: approve`,
    )
    .join("\n");
}

/** The run-wide caps, defaults resolved. */
export interface WorkflowBudget {
  /** The run's token sum; reaching it stops the run before the next step. */
  readonly tokens?: number;
  /** How long a step's ask waits before the run stops `timeout`. */
  readonly waitMs: number;
  /** Step executions per run — the belt behind the goto counters. */
  readonly maxStepRuns: number;
}

/** One prompt file the workflow references — part of what the hash covers. */
export interface WorkflowPromptFile {
  /** As written in the file, relative to `workflows/`. */
  readonly path: string;
  readonly text: string;
}

/** A validated workflow: the ONLY shape the executor and the driver see. */
export interface WorkflowSpec {
  readonly schemaVersion: number;
  readonly name: string;
  readonly version: number;
  readonly description?: string;
  readonly inputs: Readonly<Record<string, WorkflowInput>>;
  readonly budget: WorkflowBudget;
  readonly steps: readonly WorkflowStep[];
  /** The `prompt:` files, deduped and sorted by path (the hash's pre-image). */
  readonly prompts: readonly WorkflowPromptFile[];
}

/** What the caller can tell the validator about this session. */
export interface WorkflowContext {
  /** The file stem; when given, `name` must equal it. */
  readonly name?: string;
  /** The session's `models` names (the runner resolves a step's model from these). */
  readonly models?: readonly string[];
  /** The agent types this session offers (the runner's `types`). */
  readonly agentTypes?: readonly string[];
  /**
   * Text of a `prompt:` file, relative to `workflows/`. Absent → paths are
   * checked but their bytes are left unresolved (`promptText` undefined).
   */
  readonly readPrompt?: (path: string) => string | undefined;
}

export type WorkflowValidation =
  | { readonly ok: true; readonly spec: WorkflowSpec }
  | { readonly ok: false; readonly errors: readonly string[] };

// ---------------------------------------------------------------------------
// The schema: structure only. Polymorphic fields (`where`, `on_fail`, and which
// of `agent`/`run`/`approve` is present) stay `unknown` here and are read by
// hand below — a zod union reports "invalid_union", which names neither the
// field's fix nor the YAML path, and this reader exists to be repaired from.
// ---------------------------------------------------------------------------

const zDuration = z.string().refine((t) => parseWorkflowDuration(t) !== null, {
  message: "should be a duration like 30s, 20m or 12h",
});

const zInput = z
  .object({ required: z.boolean().optional(), default: z.string().optional() })
  .strict()
  .superRefine((v, ctx) => {
    if (v.required === true && v.default !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["required"],
        message: 'an input is either required or has a "default", never both',
      });
    }
  });

const zAgentFields = z
  .object({
    prompt: z.string().optional(),
    prompt_text: z.string().optional(),
    model: z.string().optional(),
    type: z.string().optional(),
    tokens: z.number().int().positive().optional(),
  })
  .strict();

const zApproveFields = z
  .object({ title: z.string(), detail: z.string().optional() })
  .strict()
  .superRefine((v, ctx) => {
    if (v.title.trim() === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["title"],
        message: "should not be empty",
      });
    }
    if (v.title.length > WORKFLOW_MAX_APPROVE_TITLE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["title"],
        message: `is longer than ${WORKFLOW_MAX_APPROVE_TITLE} characters`,
      });
    }
    if (v.detail !== undefined && v.detail.length > WORKFLOW_MAX_APPROVE_DETAIL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["detail"],
        message: `is longer than ${WORKFLOW_MAX_APPROVE_DETAIL} characters`,
      });
    }
  });

const zStep = z
  .object({
    id: z.string(),
    agent: zAgentFields.optional(),
    run: z.string().optional(),
    approve: zApproveFields.optional(),
    where: z.unknown().optional(),
    timeout: zDuration.optional(),
    retry: z.number().int().min(0).max(WORKFLOW_MAX_RETRY).optional(),
    on_fail: z.unknown().optional(),
    next: z.string().optional(),
  })
  .strict();

const zWorkflow = z
  .object({
    schemaVersion: z.number().int(),
    name: z.string(),
    version: z.number().int().positive(),
    description: z.string().max(WORKFLOW_MAX_DESCRIPTION).optional(),
    inputs: z.record(zInput).optional(),
    budget: z
      .object({
        tokens: z.number().int().positive().optional(),
        wait: zDuration.optional(),
        max_step_runs: z.number().int().positive().max(1000).optional(),
      })
      .strict()
      .optional(),
    steps: z.array(zStep).min(1).max(WORKFLOW_MAX_STEPS),
  })
  .strict();

/** `steps[3].on_fail.goto` from zod's `["steps", 3, "on_fail", "goto"]`. */
function joinPath(path: readonly (string | number)[]): string {
  let out = "";
  for (const part of path) {
    if (typeof part === "number") {
      out += `[${part}]`;
    } else {
      out += out === "" ? part : `.${part}`;
    }
  }
  return out;
}

/** One sentence per issue, its YAML path in front. */
function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const at = joinPath(issue.path);
    return at === "" ? issue.message : `${at}: ${issue.message}`;
  });
}

/** Edit distance, for a "did you mean" on a mistyped step id. */
function distance(a: string, b: string): number {
  const prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] ?? 0;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j] ?? 0;
      const up = prev[j - 1] ?? 0;
      const here = prev[j] ?? 0;
      prev[j] = Math.min(here + 1, up + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length] ?? 0;
}

/** ` — did you mean "fix"?`, or "" when nothing is close enough. */
function didYouMean(given: string, ids: readonly string[]): string {
  const best = ids
    .map((id) => ({ id, d: distance(given, id) }))
    .sort((x, y) => x.d - y.d || x.id.localeCompare(y.id))[0];
  if (best === undefined || best.d > Math.max(1, Math.floor(given.length / 3))) {
    return "";
  }
  return ` (did you mean "${best.id}"?)`;
}

/** A step id: lowercase alnum + single hyphens, like a workflow name. */
function idProblem(id: string): string | undefined {
  if (id === "") {
    return "should not be empty";
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) {
    return "should be lowercase letters, digits and single hyphens";
  }
  return undefined;
}

/**
 * A `prompt:` path relative to `workflows/`: no absolute path, no `..` segment,
 * no empty segment. Returns the reason when it must be refused.
 */
export function promptPathProblem(path: string): string | undefined {
  if (path.trim() === "") {
    return "should not be empty";
  }
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) {
    return "should be relative to workflows/, not an absolute path";
  }
  const parts = path.split(/[\\/]/);
  if (parts.some((p) => p === "..")) {
    return "should stay inside workflows/ — remove the ..";
  }
  if (parts.some((p) => p === "" || p === ".")) {
    return "should be a plain relative path (no empty or . segments)";
  }
  return undefined;
}

/**
 * The templating references a text uses: `{{inputs.k}}`, `{{steps.id.reason}}`,
 * `{{steps.id.report}}`. Anything else is refused — substitution only, never an
 * expression (the model writes a workflow, not a language).
 */
export function templateRefs(text: string): string[] {
  return [...text.matchAll(/\{\{([^}]*)\}\}/g)].map((m) => (m[1] ?? "").trim());
}

/** One reference, resolved: `inputs.slug`, `steps.plan.reason`, `steps.plan.report`. */
type Ref =
  | { readonly kind: "input"; readonly key: string }
  | { readonly kind: "reason"; readonly step: string }
  | { readonly kind: "report"; readonly step: string };

function readRef(raw: string): Ref | undefined {
  const input = /^inputs\.([A-Za-z0-9_-]+)$/.exec(raw);
  if (input) {
    return { kind: "input", key: input[1] as string };
  }
  const step = /^steps\.([a-z0-9-]+)\.(reason|report)$/.exec(raw);
  if (step) {
    const id = step[1] as string;
    return step[2] === "reason" ? { kind: "reason", step: id } : { kind: "report", step: id };
  }
  return undefined;
}

/**
 * Every `{{…}}` in `text`, checked: unknown shapes and dangling step ids are
 * errors (the driver would otherwise render a literal brace at run time).
 */
function refsProblem(
  text: string,
  at: string,
  inputs: Readonly<Record<string, WorkflowInput>>,
  ids: readonly string[],
): string[] {
  const errors: string[] = [];
  for (const raw of templateRefs(text)) {
    const ref = readRef(raw);
    if (ref === undefined) {
      errors.push(
        `${at}: "{{${raw}}}" is not a reference — use {{inputs.<name>}}, {{steps.<id>.reason}} or {{steps.<id>.report}}`,
      );
      continue;
    }
    if (ref.kind === "input") {
      if (!Object.hasOwn(inputs, ref.key)) {
        const known = Object.keys(inputs);
        errors.push(
          `${at}: no input "${ref.key}"${didYouMean(ref.key, known)} — declare it under inputs:`,
        );
      }
      continue;
    }
    if (!ids.includes(ref.step)) {
      errors.push(
        `${at}: no step "${ref.step}"${didYouMean(ref.step, ids)} — {{steps.<id>.…}} must name a step that runs before it`,
      );
    }
  }
  return errors;
}

/** What a text is rendered FROM: the run's inputs and each step's latest outcome. */
export interface WorkflowRenderContext {
  readonly inputs: Readonly<Record<string, string>>;
  readonly steps: Readonly<Record<string, { readonly reason?: string; readonly report?: string }>>;
}

/**
 * Substitute `{{…}}` references. An unresolved one renders EMPTY (never the
 * literal braces): validation already refused the unknown ones, so what is left
 * is a step that has not run — and a prompt saying nothing beats a prompt
 * showing `{{steps.fix.report}}` to the model.
 */
export function renderTemplate(text: string, ctx: WorkflowRenderContext): string {
  return text.replace(/\{\{([^}]*)\}\}/g, (_whole, inner: string) => {
    const ref = readRef(inner.trim());
    if (ref === undefined) {
      return "";
    }
    if (ref.kind === "input") {
      return ctx.inputs[ref.key] ?? "";
    }
    const step = ctx.steps[ref.step];
    return (ref.kind === "reason" ? step?.reason : step?.report) ?? "";
  });
}

/** `pass`-edge adjacency: fall-through after `pass` (or `next`), keyed by step id. */
function passSuccessors(steps: readonly WorkflowStep[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  steps.forEach((step, i) => {
    const target = step.next ?? steps[i + 1]?.id;
    out.set(step.id, target === undefined ? [] : [target]);
  });
  return out;
}

/**
 * Every `pass` edge must move forward: a cycle made only of `pass` edges is
 * UNBOUNDED (nothing counts it) and is refused — which is exactly why the
 * review→fix→review loop needs `review.next: gate` to get its counter to bite.
 * A cycle through an `on_fail.goto` edge is fine: that edge has a `max`, and
 * `budget.max_step_runs` backs it up.
 *
 * Returns the offending cycle as a sentence, or null.
 */
function cycleProblem(steps: readonly WorkflowStep[]): string | null {
  const pass = passSuccessors(steps);
  // Colours: 0 unvisited, 1 on the DFS stack, 2 done. A back edge in the PASS
  // graph closes an uncounted loop — so only pass edges are walked here (a
  // goto edge shares endpoints but is counted, and must not launder a cycle).
  const colour = new Map<string, 0 | 1 | 2>(steps.map((s) => [s.id, 0]));
  const stack: string[] = [];
  const walk = (id: string): string | null => {
    colour.set(id, 1);
    stack.push(id);
    for (const to of pass.get(id) ?? []) {
      const colourOf = colour.get(to) ?? 0;
      if (colourOf === 1) {
        const from = stack.indexOf(to);
        const cycle = stack.slice(from === -1 ? 0 : from);
        return `${[...cycle, to].join(" → ")}`;
      }
      if (colourOf === 0) {
        const found = walk(to);
        if (found !== null) {
          return found;
        }
      }
    }
    stack.pop();
    colour.set(id, 2);
    return null;
  };
  for (const step of steps) {
    if ((colour.get(step.id) ?? 0) === 0) {
      const found = walk(step.id);
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
}

/** `where:` of a `run` step → its target, or the reason it is refused. */
function readWhere(
  value: unknown,
): { ok: true; where: WorkflowWhere } | { ok: false; why: string } {
  if (value === undefined || value === "local") {
    return { ok: true, where: { engine: "local" } };
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const raw = value as Record<string, unknown>;
    // A docker target has no sub-containers: said HERE, before the generic
    // unknown-key refusal, because a file carrying one must be refused before
    // any ask — not validated, approved, asked, and then failed at dial time.
    if (raw.container !== undefined) {
      return {
        ok: false,
        why: "does not take a container — a docker target has no sub-containers; use {docker: <container>}",
      };
    }
    const extra = Object.keys(raw).filter((k) => k !== "docker");
    if (extra.length > 0) {
      return {
        ok: false,
        why: `does not know "${extra[0]}" — use local, or {docker: <container>}`,
      };
    }
    const name = raw.docker;
    if (typeof name !== "string" || name.trim() === "") {
      return { ok: false, why: "needs a container name — {docker: <container>}" };
    }
    return { ok: true, where: { engine: "docker", name } };
  }
  return { ok: false, why: 'should be "local" or {docker: <container>}' };
}

/** `on_fail:` → stop, or a counted goto. */
function readOnFail(
  value: unknown,
): { ok: true; onFail: WorkflowStepBase["onFail"] } | { ok: false; why: string } {
  if (value === undefined || value === "stop") {
    return { ok: true, onFail: { kind: "stop" } };
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const raw = value as Record<string, unknown>;
    const extra = Object.keys(raw).filter((k) => k !== "goto" && k !== "max");
    if (extra.length > 0) {
      return { ok: false, why: `does not know "${extra[0]}" — use {goto: <step>, max: 1..10}` };
    }
    const id = raw.goto;
    if (typeof id !== "string" || id === "") {
      return { ok: false, why: "needs a step id — {goto: <step>, max: 1..10}" };
    }
    const max = raw.max ?? 1;
    if (typeof max !== "number" || !Number.isInteger(max) || max < 1 || max > WORKFLOW_MAX_GOTO) {
      return { ok: false, why: `max should be a whole number 1..${WORKFLOW_MAX_GOTO}` };
    }
    return { ok: true, onFail: { kind: "goto", id, max } };
  }
  return { ok: false, why: 'should be "stop" or {goto: <step>, max: 1..10}' };
}

/**
 * Read and CHECK a workflow file. `text` is the YAML; prompt files come from
 * `ctx.readPrompt`. Every problem is returned at once, so one repair round fixes
 * the file instead of one per mistake.
 */
export function validateWorkflow(text: string, ctx: WorkflowContext = {}): WorkflowValidation {
  const yamlText = text.startsWith("\ufeff") ? text.slice(1) : text;
  const runtime = (globalThis as { Bun?: { YAML?: { parse(text: string): unknown } } }).Bun?.YAML;
  if (runtime === undefined) {
    return { ok: false, errors: ["cannot read YAML here — workflows load on the laptop"] };
  }
  let raw: unknown;
  try {
    raw = runtime.parse(yamlText);
  } catch (err) {
    const detail = err instanceof Error ? err.message.split("\n")[0] : String(err);
    return { ok: false, errors: [`not valid YAML: ${detail}`] };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      errors: ["a workflow must be a YAML mapping — start with schemaVersion, name and steps"],
    };
  }
  if ((raw as Record<string, unknown>).schemaVersion !== WORKFLOW_SCHEMA_VERSION) {
    const given = (raw as Record<string, unknown>).schemaVersion;
    return {
      ok: false,
      errors: [
        `schemaVersion: ${given === undefined ? "is missing" : `${JSON.stringify(given)} is not supported`} — this tentacle reads schemaVersion ${WORKFLOW_SCHEMA_VERSION}`,
      ],
    };
  }

  const parsed = zWorkflow.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: formatIssues(parsed.error) };
  }
  const wf = parsed.data;
  const errors: string[] = [];

  if (wf.name.length > WORKFLOW_NAME_MAX) {
    errors.push(`name: is longer than ${WORKFLOW_NAME_MAX} characters`);
  }
  if (idProblem(wf.name) !== undefined) {
    errors.push(`name: ${idProblem(wf.name)}`);
  }
  if (ctx.name !== undefined && wf.name !== ctx.name) {
    errors.push(`name: should be "${ctx.name}" — the file stem is the workflow's name`);
  }

  // --- inputs -------------------------------------------------------------
  const inputs: Record<string, WorkflowInput> = {};
  for (const [key, value] of Object.entries(wf.inputs ?? {})) {
    if (!/^[A-Za-z0-9_-]+$/.test(key)) {
      errors.push(
        `inputs.${key}: should be letters, digits, - or _ (it is referenced as {{inputs.${key}}})`,
      );
      continue;
    }
    inputs[key] =
      value.default === undefined
        ? { required: value.required === true }
        : { required: false, default: value.default };
  }

  // --- steps: kind, ids, per-kind fields ----------------------------------
  const ids: string[] = [];
  const steps: WorkflowStep[] = [];
  for (const [i, step] of wf.steps.entries()) {
    const at = `steps[${i}]`;
    const id = step.id;
    const idWhy = idProblem(id);
    if (idWhy !== undefined) {
      errors.push(`${at}.id: ${idWhy}`);
    } else if (ids.includes(id)) {
      errors.push(`${at}.id: "${id}" is used twice — step ids are unique`);
    } else {
      ids.push(id);
    }
    const present = [
      step.agent === undefined ? null : "agent",
      step.run === undefined ? null : "run",
      step.approve === undefined ? null : "approve",
    ].filter((k): k is string => k !== null);
    if (present.length !== 1) {
      errors.push(
        `${at}: needs exactly ONE of agent:, run: or approve: — found ${present.length === 0 ? "none" : present.join(" and ")}`,
      );
      continue;
    }
    const where = readWhere(step.where);
    if (!where.ok) {
      errors.push(`${at}.where: ${where.why}`);
    }
    const onFail = readOnFail(step.on_fail);
    if (!onFail.ok) {
      errors.push(`${at}.on_fail: ${onFail.why}`);
    }
    if (!where.ok || !onFail.ok || idWhy !== undefined) {
      continue;
    }
    const base: WorkflowStepBase = {
      id,
      retry: step.retry ?? 0,
      onFail: onFail.onFail,
      at,
      ...(step.next === undefined ? {} : { next: step.next }),
    };
    if (step.agent !== undefined) {
      if (where.where.engine !== "local") {
        errors.push(
          `${at}.where: an agent step runs on the laptop only — remove where: (a run step may use docker)`,
        );
      }
      const agent = step.agent;
      if ((agent.prompt === undefined) === (agent.prompt_text === undefined)) {
        errors.push(`${at}.agent: needs exactly ONE of prompt: (a file) or prompt_text: (inline)`);
        continue;
      }
      if (agent.prompt !== undefined) {
        const why = promptPathProblem(agent.prompt);
        if (why !== undefined) {
          errors.push(`${at}.agent.prompt: ${why}`);
        }
      }
      const model = agent.model;
      if (model !== undefined && ctx.models !== undefined && !ctx.models.includes(model)) {
        errors.push(
          `${at}.agent.model: "${model}" is not a model of this session${didYouMean(model, ctx.models)} — one of ${ctx.models.join(", ")}`,
        );
      }
      const type = agent.type;
      if (type !== undefined && ctx.agentTypes !== undefined && !ctx.agentTypes.includes(type)) {
        errors.push(
          `${at}.agent.type: "${type}" is not an agent type${didYouMean(type, ctx.agentTypes)} — one of ${ctx.agentTypes.join(", ")}`,
        );
      }
      steps.push({
        ...base,
        kind: "agent",
        ...(agent.prompt === undefined ? {} : { promptPath: agent.prompt }),
        ...(agent.prompt_text === undefined ? {} : { promptText: agent.prompt_text }),
        ...(model === undefined ? {} : { model }),
        ...(type === undefined ? {} : { type }),
        ...(agent.tokens === undefined ? {} : { tokens: agent.tokens }),
      });
      continue;
    }
    if (step.run !== undefined) {
      if (step.run.trim() === "") {
        errors.push(`${at}.run: should not be empty`);
        continue;
      }
      const timeoutMs =
        step.timeout === undefined
          ? WORKFLOW_DEFAULT_TIMEOUT_MS
          : (parseWorkflowDuration(step.timeout) ?? WORKFLOW_DEFAULT_TIMEOUT_MS);
      if (timeoutMs > WORKFLOW_MAX_TIMEOUT_MS) {
        errors.push(`${at}.timeout: is longer than 24h`);
      } else if (timeoutMs <= 0) {
        errors.push(`${at}.timeout: should be longer than 0`);
      }
      steps.push({ ...base, kind: "run", command: step.run, where: where.where, timeoutMs });
      continue;
    }
    const approve = step.approve;
    if (approve === undefined) {
      continue;
    }
    if (step.where !== undefined || step.timeout !== undefined) {
      errors.push(`${at}: an approve step takes neither where: nor timeout: — a human answers it`);
    }
    steps.push({
      ...base,
      kind: "approve",
      title: approve.title,
      ...(approve.detail === undefined ? {} : { detail: approve.detail }),
    });
  }

  // --- edges: next / goto targets, then termination ------------------------
  for (const step of steps) {
    if (step.next !== undefined && !ids.includes(step.next)) {
      errors.push(`${step.at}.next: no step "${step.next}"${didYouMean(step.next, ids)}`);
    }
    if (step.onFail.kind === "goto" && !ids.includes(step.onFail.id)) {
      errors.push(
        `${step.at}.on_fail.goto: no step "${step.onFail.id}"${didYouMean(step.onFail.id, ids)}`,
      );
    }
  }
  if (errors.length === 0) {
    const cycle = cycleProblem(steps);
    if (cycle !== null) {
      errors.push(
        `steps: ${cycle} is a pass loop with no counter — give a step in the loop an on_fail: {goto: …, max: n}, or a next: that leaves it`,
      );
    }
    // The hash approval shows every step's line, uncut (D1): a list too long to
    // show is refused here, where every path to an ask passes, so no approval is
    // ever granted against a list with a command missing.
    const summary = workflowApprovalSummary(steps).length;
    if (summary > WORKFLOW_MAX_APPROVE_SUMMARY) {
      errors.push(
        `steps: the step list an approval shows is ${summary} characters, over ${WORKFLOW_MAX_APPROVE_SUMMARY} — move long commands into a script and run that`,
      );
    }
  }

  // --- prompt references and the files the hash covers --------------------
  const prompts = new Map<string, WorkflowPromptFile>();
  for (const step of steps) {
    if (step.kind !== "agent") {
      continue;
    }
    const texts: [string, string][] = [];
    if (step.promptPath !== undefined) {
      const read = ctx.readPrompt?.(step.promptPath);
      if (ctx.readPrompt !== undefined && read === undefined) {
        errors.push(`${step.at}.agent.prompt: no file "${step.promptPath}" under workflows/`);
      } else if (read !== undefined) {
        prompts.set(step.promptPath, { path: step.promptPath, text: read });
        texts.push([`${step.at}.agent.prompt`, read]);
      }
    }
    if (step.promptText !== undefined) {
      texts.push([`${step.at}.agent.prompt_text`, step.promptText]);
    }
    for (const [at, body] of texts) {
      errors.push(...refsProblem(body, at, inputs, ids));
    }
  }
  for (const step of steps) {
    if (step.kind !== "approve") {
      continue;
    }
    errors.push(...refsProblem(step.title, `${step.at}.approve.title`, inputs, ids));
    if (step.detail !== undefined) {
      errors.push(...refsProblem(step.detail, `${step.at}.approve.detail`, inputs, ids));
    }
  }
  // A timer past 2^31 ms fires at once in Bun/Node (TimeoutOverflowWarning), so
  // an unbounded wait would time every ask out immediately (review round 1 #3).
  const waitMs =
    wf.budget?.wait === undefined
      ? WORKFLOW_DEFAULT_WAIT_MS
      : (parseWorkflowDuration(wf.budget.wait) ?? WORKFLOW_DEFAULT_WAIT_MS);
  if (waitMs <= 0) {
    errors.push("budget.wait: should be longer than 0");
  } else if (waitMs > WORKFLOW_MAX_WAIT_MS) {
    errors.push("budget.wait: is longer than 7 days");
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const budget: WorkflowBudget = {
    ...(wf.budget?.tokens === undefined ? {} : { tokens: wf.budget.tokens }),
    waitMs,
    maxStepRuns: wf.budget?.max_step_runs ?? WORKFLOW_DEFAULT_MAX_STEP_RUNS,
  };
  return {
    ok: true,
    spec: {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      name: wf.name,
      version: wf.version,
      ...(wf.description === undefined ? {} : { description: wf.description }),
      inputs,
      budget,
      steps,
      prompts: [...prompts.values()].sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
      ),
    },
  };
}

/** sha-256 (hex) of bytes — `Bun.CryptoHasher` when the runtime has one. */
export type WorkflowHasher = (bytes: Uint8Array) => string;

/**
 * The runtime's sha-256, or undefined off-Bun. Exported so a caller can decide
 * BEFORE it reads a file: refusing to hash is the only honest answer where the
 * runtime has none, and a weaker hash would let an unapproved file run.
 */
export function runtimeHasher(): WorkflowHasher | undefined {
  const bun = (
    globalThis as {
      Bun?: {
        CryptoHasher?: new (
          algorithm: string,
        ) => {
          update(bytes: Uint8Array): unknown;
          digest(encoding: "hex"): string;
        };
      };
    }
  ).Bun;
  if (bun?.CryptoHasher === undefined) {
    return undefined;
  }
  const Hasher = bun.CryptoHasher;
  return (bytes) => {
    const hasher = new Hasher("sha256");
    hasher.update(bytes);
    return hasher.digest("hex");
  };
}

/**
 * The hash an approval is bound to (D2): the YAML bytes, then each referenced
 * prompt file sorted by path — the hash covers the prompts because they ARE the
 * workflow. One changed byte anywhere is a new hash, so a new approval.
 */
export function workflowHash(
  text: string,
  prompts: readonly WorkflowPromptFile[] = [],
  /** `null` = this runtime has no sha-256 (never a weaker hash). */
  hasher: WorkflowHasher | null = runtimeHasher() ?? null,
): string {
  if (hasher === null) {
    throw new Error("workflowHash needs a sha-256 hasher (Bun's runtime, or one passed in)");
  }
  const sorted = [...prompts].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  let pre = `${WORKFLOW_HASH_SEED}${text.startsWith("\ufeff") ? text.slice(1) : text}`;
  for (const file of sorted) {
    pre += `${file.path}\0${file.text}\0`;
  }
  return hasher(new TextEncoder().encode(pre));
}

/** `"3f2a1b9c…"` as an ask's title shows it. */
export function shortHash(hash: string): string {
  return hash.slice(0, 8);
}
