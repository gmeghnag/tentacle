/**
 * docs/feat/workflow-editor.md D2 — the draft's edit operations.
 *
 * A draft is the parsed workflow mapping (`WorkflowDraft`, D1). Every operation
 * here is `(draft, …) → {draft, …}`: PURE and IMMUTABLE, never mutating the value
 * it is handed (so undo is just keeping the previous value). They live in
 * `@tentacle/core`, not in the app, because the parked TUI editor
 * (eval/tui-workflow-editor) and the phone share them unchanged.
 *
 * The refusal shape is a returned `refused` string, not a thrown error: a UI
 * shows it in the bar and keeps going (the goto sheet's "itself — use Retry").
 *
 * One rule is load-bearing and deliberate: **only `renameStep` follows
 * references.** `deleteStep` leaves every `next:`/`on_fail.goto:` that named the
 * step EXACTLY as it was, so the validator reports it and the graph draws a ghost
 * pill. Silently rewriting them would change what the user did not ask for, and
 * would hide a broken link they might want to see before deleting.
 *
 * Pure: no I/O, no clock, no React.
 */
import {
  WORKFLOW_MAX_GOTO,
  WORKFLOW_MAX_RETRY,
  promptPathProblem,
  validateWorkflowValue,
} from "./workflow-spec.ts";
import type { WorkflowContext } from "./workflow-spec.ts";
import type { WorkflowDraft } from "./workflow-yaml.ts";

export type StepKind = "agent" | "run" | "approve";

/** Where `＋` inserts: on the edge after `after`, or at the end of the list. */
export type InsertAt = { readonly after: string } | { readonly end: true };

/** Every operation's answer: the new draft, plus what happened or why not. */
export interface DraftEdit {
  readonly draft: WorkflowDraft;
  /** The step a created / renamed operation produced. */
  readonly id?: string;
  /** Why the operation did nothing; the draft is then the one passed in. */
  readonly refused?: string;
  /** Steps that still reference the one a `deleteStep` removed. */
  readonly dangling?: readonly string[];
  /** The prompt files after a `renameStep` (its `{{steps.<id>.…}}` rewritten). */
  readonly prompts?: Readonly<Record<string, string>>;
}

/** The editor's prompt files, by path (`prompts/review.md` → its text). */
export type DraftPrompts = Readonly<Record<string, string>>;

/**
 * `{{steps.<id>.reason|report}}`, blanks allowed inside the braces — exactly the
 * shape the validator's `readRef` resolves after `templateRefs` trims it. Groups
 * 1 and 2 are the text around the id, so a rename keeps the user's spacing.
 */
function stepRefPattern(id: string): RegExp {
  const escaped = id.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  return new RegExp(`(\\{\\{\\s*steps\\.)${escaped}(\\.(?:reason|report)\\s*\\}\\})`, "g");
}

/** A step's `prompt:` file, when it has one. */
function promptPathOf(step: Step): string | undefined {
  const agent = step.agent as Mapping | undefined;
  return typeof agent?.prompt === "string" ? agent.prompt : undefined;
}

/**
 * Every text the driver templates for a step (`workflow-machine.ts` `stepText`)
 * or the validator checks: its command, inline prompt, prompt FILE, ask title and
 * detail.
 */
function templatedTexts(step: Step, prompts: DraftPrompts): string[] {
  const agent = step.agent as Mapping | undefined;
  const approve = step.approve as Mapping | undefined;
  const path = promptPathOf(step);
  const file = path === undefined ? undefined : prompts[path];
  return [step.run, agent?.prompt_text, file, approve?.title, approve?.detail].filter(
    (text): text is string => typeof text === "string",
  );
}

/** `step` with every templated reference to `oldId` pointing at `newId`. */
function renameRefsIn(step: Step, oldId: string, newId: string): Step {
  const swap = (text: unknown): unknown =>
    typeof text === "string" ? text.replace(stepRefPattern(oldId), `$1${newId}$2`) : text;
  const out: Step = { ...step };
  if (typeof step.run === "string") {
    out.run = swap(step.run);
  }
  const agent = step.agent as Mapping | undefined;
  if (agent !== undefined && typeof agent.prompt_text === "string") {
    out.agent = { ...agent, prompt_text: swap(agent.prompt_text) };
  }
  const approve = step.approve as Mapping | undefined;
  if (approve !== undefined) {
    const next: Mapping = { ...approve };
    for (const key of ["title", "detail"] as const) {
      if (typeof approve[key] === "string") {
        next[key] = swap(approve[key]);
      }
    }
    out.approve = next;
  }
  return out;
}

type Step = Record<string, unknown>;
type Mapping = Record<string, unknown>;

/** Steps array. A structurally-broken draft has none; the editor never gets here. */
function stepsOf(draft: WorkflowDraft): Step[] {
  const steps = draft.steps;
  return Array.isArray(steps) ? (steps as Step[]) : [];
}

/** Copy the draft with a new `steps` array (never mutating the input). */
function withSteps(draft: WorkflowDraft, steps: readonly Step[]): WorkflowDraft {
  return { ...draft, steps: steps.map((step) => ({ ...step })) };
}

/** `id` of every step, in draft order. */
function idsOf(steps: readonly Step[]): string[] {
  return steps.map((step) => String(step.id));
}

/** The reason `map` refused, when it did: the plan's wording, one place. */
function refusal(draft: WorkflowDraft, why: string): DraftEdit {
  return { draft, refused: why };
}

/** The refusal an operation with no such step returns, untouched otherwise. */
function noStep(id: string): string {
  return `no step "${id}"`;
}

/** A step id the validator accepts (`idProblem`'s rule, phrased for a person). */
function idProblem(id: string): string | undefined {
  if (id === "") {
    return "should not be empty";
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) {
    return "lowercase letters, digits and single hyphens";
  }
  return undefined;
}

/** `"a run step"` / `"an agent step"` — a refusal a person would write. */
function kindText(kind: StepKind): string {
  return kind === "agent" ? "an agent step" : `a ${kind} step`;
}

/** Package managers whose next word is a script name, not the command's verb. */
const RUNNERS = new Set(["bun", "npm", "pnpm", "yarn", "npx", "deno"]);
/** A runner's verb that only introduces the script (`bun run lint` → `lint`). */
const RUNNER_VERBS = new Set(["run", "exec", "x"]);

/** The one word a seed is named after: `bun run lint` → `lint`, `git diff` → `git`. */
function seedWord(seed: string): string {
  const words = seed
    .trim()
    .split(/\s+/)
    .filter((word) => word !== "");
  if (words.length === 0) {
    return "";
  }
  if (!RUNNERS.has(words[0] as string)) {
    return words[0] as string;
  }
  const script = words[1] ?? "";
  if (RUNNER_VERBS.has(script)) {
    return words[2] ?? script;
  }
  return script;
}

/**
 * A fresh step id from a seed: the command's first meaningful word
 * (`bun run lint` → `lint`), or a prompt file's stem (`prompts/review.md` →
 * `review`), else the kind's own name. Unique against `taken` (`lint-2`).
 */
export function stepIdFor(kind: StepKind, seed: string, taken: readonly string[]): string {
  const trimmed = seed.trim();
  const fromFile = trimmed.replace(/\\/g, "/").split("/").pop() ?? "";
  const candidate = trimmed.toLowerCase().endsWith(".md")
    ? fromFile.replace(/\.md$/i, "")
    : seedWord(trimmed);
  const slug = (candidate === "" ? kind : candidate)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = slug === "" ? kind : slug;
  if (!taken.includes(base)) {
    return base;
  }
  let n = 2;
  while (taken.includes(`${base}-${n}`)) {
    n += 1;
  }
  return `${base}-${n}`;
}

/** The empty body a kind starts from: a visible problem, never a placeholder. */
function newBody(kind: StepKind): Step {
  if (kind === "agent") {
    return { agent: { prompt_text: "" } };
  }
  if (kind === "approve") {
    return { approve: { title: "" } };
  }
  return { run: "" };
}

/**
 * `＋` on an edge: insert a new step after `after` (or at the end).
 *
 * On a fall-through edge the new step simply lands between the two: array order
 * IS the edge. On an explicit `next:` edge it has to be rewritten, or the new
 * step would be unreachable — `A.next = S`, `S.next = B`, which is exactly what
 * the user drew (a step in the middle of that arrow).
 */
export function insertStep(
  draft: WorkflowDraft,
  at: InsertAt,
  kind: StepKind,
  /** What the new id is named after: the command, or a prompt file's path. */
  seed = "",
): DraftEdit {
  const steps = stepsOf(draft);
  const taken = idsOf(steps);
  const id = stepIdFor(kind, seed, taken);
  const body: Step = { id, ...newBody(kind) };
  if (!("after" in at)) {
    return { draft: withSteps(draft, [...steps, body]), id };
  }
  const anchorAt = steps.findIndex((step) => step.id === at.after);
  if (anchorAt === -1) {
    return refusal(draft, noStep(at.after));
  }
  const anchor = steps[anchorAt] as Step;
  const oldNext = anchor.next;
  const inserted: Step = typeof oldNext === "string" ? { ...body, next: oldNext } : body;
  const anchorAfter: Step = typeof oldNext === "string" ? { ...anchor, next: id } : anchor;
  const next = [...steps];
  next[anchorAt] = anchorAfter;
  next.splice(anchorAt + 1, 0, inserted);
  return { draft: withSteps(draft, next), id };
}

/**
 * The `✗` port dropped on a step: `on_fail: {goto, max}`. Dropping it on itself
 * is refused (the mockup's own words — a self-goto is what `retry:` is for).
 * `"stop"` removes the key, so a default never lands in the file.
 */
export function setFailTarget(
  draft: WorkflowDraft,
  id: string,
  target: string | "stop",
  max?: number,
): DraftEdit {
  const steps = stepsOf(draft);
  const at = steps.findIndex((step) => step.id === id);
  if (at === -1) {
    return refusal(draft, noStep(id));
  }
  if (target !== "stop") {
    if (target === id) {
      return refusal(draft, "itself — use Retry");
    }
    if (!idsOf(steps).includes(target)) {
      return refusal(draft, noStep(target));
    }
  }
  const step = steps[at] as Step;
  const next = [...steps];
  if (target === "stop") {
    const { on_fail: _stop, ...rest } = step;
    next[at] = rest;
    return { draft: withSteps(draft, next) };
  }
  const current = step.on_fail as Mapping | undefined;
  const currentMax = typeof current?.max === "number" ? current.max : undefined;
  const wanted = max ?? currentMax ?? 1;
  const clamped = Math.min(WORKFLOW_MAX_GOTO, Math.max(1, Math.round(wanted)));
  next[at] = { ...step, on_fail: { goto: target, max: clamped } };
  return { draft: withSteps(draft, next) };
}

/** `↻ ×n`: re-runs of the same step after `fail`. 0 drops the key (the default). */
export function setRetry(draft: WorkflowDraft, id: string, retry: number): DraftEdit {
  const steps = stepsOf(draft);
  const at = steps.findIndex((step) => step.id === id);
  if (at === -1) {
    return refusal(draft, noStep(id));
  }
  const clamped = Math.min(WORKFLOW_MAX_RETRY, Math.max(0, Math.round(retry)));
  const step = steps[at] as Step;
  const next = [...steps];
  if (clamped === 0) {
    const { retry: _retry, ...rest } = step;
    next[at] = rest;
  } else {
    next[at] = { ...step, retry: clamped };
  }
  return { draft: withSteps(draft, next) };
}

/** `✗ ×n`: the goto edge's counter. It needs a fail target to be on at all. */
export function setGotoMax(draft: WorkflowDraft, id: string, max: number): DraftEdit {
  const steps = stepsOf(draft);
  const at = steps.findIndex((step) => step.id === id);
  if (at === -1) {
    return refusal(draft, noStep(id));
  }
  const step = steps[at] as Step;
  const onFail = step.on_fail as Mapping | undefined;
  const target = onFail?.goto;
  if (typeof target !== "string") {
    return refusal(draft, "no fail target — drop the ✗ port first");
  }
  const clamped = Math.min(WORKFLOW_MAX_GOTO, Math.max(1, Math.round(max)));
  const next = [...steps];
  next[at] = { ...step, on_fail: { goto: target, max: clamped } };
  return { draft: withSteps(draft, next) };
}

/** The pass edge after this step: `undefined` = fall through to the next one. */
export function setNext(draft: WorkflowDraft, id: string, target: string | undefined): DraftEdit {
  const steps = stepsOf(draft);
  const at = steps.findIndex((step) => step.id === id);
  if (at === -1) {
    return refusal(draft, noStep(id));
  }
  if (target !== undefined && target !== id && !idsOf(steps).includes(target)) {
    return refusal(draft, noStep(target));
  }
  const step = steps[at] as Step;
  const next = [...steps];
  if (target === undefined) {
    const { next: _next, ...rest } = step;
    next[at] = rest;
  } else {
    next[at] = { ...step, next: target };
  }
  return { draft: withSteps(draft, next) };
}

/** Move a step one place up (-1) or down (+1). Array order is the fall-through. */
export function moveStep(draft: WorkflowDraft, id: string, by: number): DraftEdit {
  const steps = stepsOf(draft);
  const at = steps.findIndex((step) => step.id === id);
  if (at === -1) {
    return refusal(draft, noStep(id));
  }
  const target = Math.min(steps.length - 1, Math.max(0, at + by));
  if (target === at) {
    return { draft };
  }
  const next = [...steps];
  const [step] = next.splice(at, 1);
  if (step === undefined) {
    return { draft };
  }
  next.splice(target, 0, step);
  return { draft: withSteps(draft, next) };
}

/** Copy a step right after itself, under a fresh id. */
export function duplicateStep(draft: WorkflowDraft, id: string): DraftEdit {
  const steps = stepsOf(draft);
  const at = steps.findIndex((step) => step.id === id);
  if (at === -1) {
    return refusal(draft, noStep(id));
  }
  const step = steps[at] as Step;
  const copy: Step = { ...step, id: stepIdFor("run", id, idsOf(steps)) };
  const out = [...steps];
  out.splice(at + 1, 0, copy);
  return { draft: withSteps(draft, out), id: String(copy.id) };
}

/**
 * Rename a step and follow every reference to it — the user named the step, so
 * rewriting `next:`/`on_fail.goto:` AND every `{{steps.<id>.…}}` (in a command,
 * an inline prompt, an ask, and the prompt files the draft's steps read) is what
 * they asked for (the one op that does). The rewritten files come back in
 * `prompts`; a file no step reads is returned as it was.
 */
export function renameStep(
  draft: WorkflowDraft,
  oldId: string,
  newId: string,
  prompts: DraftPrompts = {},
): DraftEdit {
  const steps = stepsOf(draft);
  const at = steps.findIndex((step) => step.id === oldId);
  if (at === -1) {
    return refusal(draft, noStep(oldId));
  }
  const why = idProblem(newId);
  if (why !== undefined) {
    return refusal(draft, `"${newId}" is not a step id — ${why}`);
  }
  if (newId === oldId) {
    return { draft, prompts: { ...prompts } };
  }
  if (idsOf(steps).includes(newId)) {
    return refusal(draft, `"${newId}" is already a step`);
  }
  const read = new Set(steps.map(promptPathOf).filter((path) => path !== undefined));
  const files = Object.fromEntries(
    Object.entries(prompts).map(([path, text]) => [
      path,
      read.has(path) ? text.replace(stepRefPattern(oldId), `$1${newId}$2`) : text,
    ]),
  );
  const rename = (step: Step): Step => {
    const out: Step = {
      ...renameRefsIn(step, oldId, newId),
      id: step.id === oldId ? newId : step.id,
    };
    if (step.next === oldId) {
      out.next = newId;
    }
    const onFail = step.on_fail as Mapping | undefined;
    if (onFail !== undefined && onFail.goto === oldId) {
      out.on_fail = { ...onFail, goto: newId };
    }
    return out;
  };
  return { draft: withSteps(draft, steps.map(rename)), id: newId, prompts: files };
}

/**
 * Delete a step. **Never rewrites a reference** (see the file's header): the
 * `next:`/`goto:` that named it stay, become validator errors, and are drawn as
 * a ghost pill. `dangling` lists the steps that still point at it — by an edge
 * or by a `{{steps.<id>.…}}` in any text they template, their prompt file
 * included (`prompts`) — so the menu can say "1 link points here" BEFORE the
 * user confirms.
 */
export function deleteStep(
  draft: WorkflowDraft,
  id: string,
  prompts: DraftPrompts = {},
): DraftEdit {
  const steps = stepsOf(draft);
  const at = steps.findIndex((step) => step.id === id);
  if (at === -1) {
    return refusal(draft, noStep(id));
  }
  const pattern = stepRefPattern(id);
  const refersByText = (step: Step): boolean =>
    templatedTexts(step, prompts).some((text) => {
      pattern.lastIndex = 0;
      return pattern.test(text);
    });
  const dangling = steps
    .filter(
      (step) =>
        step.id !== id &&
        (step.next === id ||
          (step.on_fail as Mapping | undefined)?.goto === id ||
          refersByText(step)),
    )
    .map((step) => String(step.id));
  return {
    draft: withSteps(
      draft,
      steps.filter((_step, i) => i !== at),
    ),
    dangling,
  };
}

/** What a per-kind field edit may carry: one branch per step kind. */
export type StepPatch =
  | {
      readonly kind: "run";
      readonly run?: string;
      readonly where?: { readonly docker: string } | "local";
      /** `null` = the schema's default, written as no key at all. */
      readonly timeout?: string | null;
    }
  | {
      readonly kind: "agent";
      readonly promptPath?: string;
      readonly promptText?: string;
      readonly model?: string | null;
      readonly type?: string | null;
      readonly tokens?: number | null;
    }
  | {
      readonly kind: "approve";
      readonly title?: string;
      readonly detail?: string | null;
    };

/** The step's kind, or undefined when the body is malformed. */
function kindOf(step: Step): StepKind | undefined {
  if (step.agent !== undefined) {
    return "agent";
  }
  if (step.run !== undefined) {
    return "run";
  }
  if (step.approve !== undefined) {
    return "approve";
  }
  return undefined;
}

/** The fields one step kind owns (everything else on the step is kept). */
const OWNED_FIELDS: Record<StepKind, readonly string[]> = {
  agent: ["agent"],
  run: ["run", "where", "timeout"],
  approve: ["approve"],
};

/**
 * A step's own fields, edited in place of that step alone. A patch for another
 * kind is refused (a UI bug must not silently turn a run step into an agent one).
 */
export function patchStep(draft: WorkflowDraft, id: string, patch: StepPatch): DraftEdit {
  const steps = stepsOf(draft);
  const at = steps.findIndex((step) => step.id === id);
  if (at === -1) {
    return refusal(draft, noStep(id));
  }
  const step = steps[at] as Step;
  const kind = kindOf(step);
  if (kind !== patch.kind) {
    return refusal(draft, `"${id}" is not ${kindText(patch.kind)}`);
  }
  const kept = Object.fromEntries(
    Object.entries(step).filter(([key]) => !OWNED_FIELDS[kind].includes(key)),
  );
  const next = [...steps];
  next[at] = { ...kept, ...editedBody(kind, step, patch) };
  return { draft: withSteps(draft, next) };
}

/** The `id` first (it is the file's first key per step), then the kind's body. */
function editedBody(kind: StepKind, step: Step, patch: StepPatch): Step {
  const out: Step = { id: step.id };
  if (kind === "run" && patch.kind === "run") {
    out.run = patch.run ?? step.run ?? "";
    if (patch.where !== undefined) {
      if (patch.where !== "local") {
        out.where = { docker: patch.where.docker };
      }
    } else if (step.where !== undefined) {
      out.where = step.where;
    }
    if (patch.timeout !== undefined) {
      if (patch.timeout !== null) {
        out.timeout = patch.timeout;
      }
    } else if (step.timeout !== undefined) {
      out.timeout = step.timeout;
    }
  }
  if (kind === "agent" && patch.kind === "agent") {
    const before = (step.agent ?? {}) as Mapping;
    const agent: Mapping = {};
    if (patch.promptPath !== undefined) {
      agent.prompt = patch.promptPath;
    } else if (patch.promptText !== undefined) {
      agent.prompt_text = patch.promptText;
    } else if (before.prompt !== undefined) {
      agent.prompt = before.prompt;
    } else if (before.prompt_text !== undefined) {
      agent.prompt_text = before.prompt_text;
    }
    for (const field of ["model", "type", "tokens"] as const) {
      const given = patch[field];
      const value = given === undefined ? before[field] : given;
      if (value !== undefined && value !== null) {
        agent[field] = value;
      }
    }
    out.agent = agent;
  }
  if (kind === "approve" && patch.kind === "approve") {
    const before = (step.approve ?? {}) as Mapping;
    const approve: Mapping = { title: patch.title ?? before.title ?? "" };
    const detail = patch.detail === undefined ? before.detail : patch.detail;
    if (detail !== undefined && detail !== null) {
      approve.detail = detail;
    }
    out.approve = approve;
  }
  return out;
}

/**
 * The path a step's prompt file starts at, `prompts/<step id>.md`: the sheet
 * opens the field pre-filled with it, and a template uses the same rule, so a
 * step `review` and its `prompts/review.md` are never one rename apart.
 */
export function defaultPromptPath(id: string): string {
  return `prompts/${id}.md`;
}

/**
 * An agent step's prompt: a file under `prompts/` (`{path}`) or inline text
 * (`{text}`). A path is relative, has no `..`, and is markdown.
 */
export function setPrompt(
  draft: WorkflowDraft,
  id: string,
  prompt: { readonly path: string } | { readonly text: string },
): DraftEdit {
  const steps = stepsOf(draft);
  const at = steps.findIndex((step) => step.id === id);
  if (at === -1) {
    return refusal(draft, noStep(id));
  }
  const step = steps[at] as Step;
  if (kindOf(step) !== "agent") {
    return refusal(draft, `"${id}" is not ${kindText("agent")}`);
  }
  if ("path" in prompt) {
    const why = promptPathProblem(prompt.path);
    if (why !== undefined) {
      return refusal(draft, why);
    }
    if (!prompt.path.toLowerCase().endsWith(".md")) {
      return refusal(draft, "a prompt file should end with .md");
    }
    return patchStep(draft, id, { kind: "agent", promptPath: prompt.path });
  }
  return patchStep(draft, id, { kind: "agent", promptText: prompt.text });
}

/**
 * The problems the daemon would report, from the draft in hand: the ONE
 * validator (`validateWorkflowValue`), so the phone's bar says the daemon's exact
 * sentence with its YAML path. `prompts` are the texts the editor holds; a
 * `prompt:` file missing from BOTH is a problem, exactly as on the daemon.
 */
export function draftProblems(
  draft: WorkflowDraft,
  prompts: Readonly<Record<string, string>>,
  ctx: Omit<WorkflowContext, "readPrompt"> = {},
): readonly string[] {
  const read = (path: string): string | undefined => prompts[path];
  const result = validateWorkflowValue(draft, { ...ctx, readPrompt: read });
  return result.ok ? [] : result.errors;
}

/** The version a save writes: one more than the file had, never below 1. */
export function nextVersion(version: number): number {
  if (!Number.isFinite(version)) {
    return 1;
  }
  return Math.max(1, Math.floor(version) + 1);
}

/** How many states an `EditHistory` keeps (the plan's cap). */
export const EDIT_HISTORY_LIMIT = 50;

/**
 * Undo/redo over whole draft values (immutable ops make that the cheap way): a
 * `push` per edit, `undo`/`redo`, and a new `push` drops the redo tail. Capped at
 * `EDIT_HISTORY_LIMIT` states, oldest dropped — a phone session never grows.
 */
export class EditHistory<T> {
  private readonly states: T[];
  private readonly limit: number;
  private index: number;

  constructor(initial: T, limit: number = EDIT_HISTORY_LIMIT) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`EditHistory needs a whole limit ≥ 1, got ${limit}`);
    }
    this.states = [initial];
    this.limit = limit;
    this.index = 0;
  }

  get current(): T {
    return this.states[this.index] as T;
  }

  get size(): number {
    return this.states.length;
  }

  get canUndo(): boolean {
    return this.index > 0;
  }

  get canRedo(): boolean {
    return this.index < this.states.length - 1;
  }

  /** Record a new state (drops the redo tail). */
  push(state: T): void {
    this.states.splice(this.index + 1);
    this.states.push(state);
    if (this.states.length > this.limit) {
      this.states.shift();
    }
    this.index = this.states.length - 1;
  }

  /** The previous state, or undefined at the oldest one kept. */
  undo(): T | undefined {
    if (!this.canUndo) {
      return undefined;
    }
    this.index -= 1;
    return this.current;
  }

  /** The state undone last, or undefined when nothing was undone. */
  redo(): T | undefined {
    if (!this.canRedo) {
      return undefined;
    }
    this.index += 1;
    return this.current;
  }
}
