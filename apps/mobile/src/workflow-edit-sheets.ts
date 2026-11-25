/**
 * The editor's SHEETS, as data (docs/feat/workflow-editor.md D8, slice 7b): the
 * kind picker, a step's sheet per kind, the goto picker, the `✗ ×n` counter and
 * the workflow Settings. Pure and React-free (AGENTS §7), so which sheet a
 * gesture opens, what each sheet reads from the draft, what the picker refuses
 * and which controller call a control ends in are all testable with no renderer
 * (`apps/mobile/test/workflow-edit-sheets.test.ts`). `screens/WorkflowEditSheets
 * .tsx` maps a `SheetModel` onto elements and decides nothing.
 *
 * Three rules earn their keep here:
 * - **a sheet never edits what it does not show.** Every value below is read from
 *   the draft on screen, so a refusal (`notice`) or an Undo re-renders the sheet
 *   with the file's own numbers, never with a control's last position.
 * - **the mockup's detents are a table.** `SHEET_DETENT` is the owner's
 *   short/medium/large rule for quick actions, in one place.
 * - **the pick list is the draft's own order**, and the step a `✗` port cannot
 *   point at (itself) is DRAWN dim with its reason — never hidden, never refused
 *   silently (D6's promise: the break is shown).
 */
import {
  type DraftEdit,
  type DraftPrompts,
  type InsertAt,
  type StepKind,
  type StepPatch,
  WORKFLOW_MAX_GOTO,
  WORKFLOW_MAX_RETRY,
  type WorkflowDraft,
  type WorkflowInput,
  defaultPromptPath,
  parseWorkflowDuration,
} from "@tentacle/core";
import type { EditIntent } from "./workflow-edit-actions.ts";
import { type EditLabel, KIND_GLYPH } from "./workflow-edit-graph.ts";

/**
 * The owner's three detents (short / medium / large) as a fraction of the window —
 * the mockup's `--wf-detent-short: 0.3` / `--wf-detent-medium: 0.5` /
 * `--wf-detent-large: 0.92` (`index.html:66-68`).
 */
export const SHEET_DETENT = { short: 0.3, medium: 0.5, large: 0.92 } as const;

export type SheetDetent = keyof typeof SHEET_DETENT;

/** How much of the screen a sheet covers, in points — the mockup's `calc()`.
 *
 * `short` and `medium` are a plain share of the window: their content starts at
 * the sheet's top, so the fraction is all that matters. `large` is a FULL-HEIGHT
 * sheet with a header at its top, and the mockup measures it as
 * `calc((var(--frame-h) - var(--frame-safe-top)) * var(--wf-detent-large) -
 * var(--frame-safe-bottom))` (`index.html:205`): a share of the area BELOW the
 * status bar, so the header (`‹ Graph · Done`) lands below the clock instead of
 * on it. (Its
 * `- safe-bottom` is not applied here: the sheet is anchored to the window's
 * bottom edge, so subtracting it would float the sheet above the home indicator.)
 * A sheet never covers the whole window — the graph must stay visibly underneath.
 */
export function sheetHeight(
  detent: SheetDetent,
  window: { readonly height: number; readonly insetTop: number },
): number {
  const below = Math.max(0, window.height - window.insetTop);
  return Math.round(
    detent === "large" ? below * SHEET_DETENT.large : window.height * SHEET_DETENT[detent],
  );
}

/** Which sheet is up. `null` (nothing) is the graph again. */
export type SheetRequest =
  | { readonly kind: "kind"; readonly at: InsertAt }
  | { readonly kind: "step"; readonly id: string }
  | { readonly kind: "pick"; readonly id: string; readonly purpose: PickPurpose }
  | { readonly kind: "max"; readonly id: string }
  | { readonly kind: "settings" };

/** What the goto picker is choosing: a `✗` target, or the pass edge's `next`. */
export type PickPurpose = "fail" | "next";

/** One option of an inline list (the model / agent-type pickers, the kind picker). */
export interface SheetChoice {
  readonly value: string;
  readonly label: string;
  readonly sub: string | null;
  readonly glyph: string | null;
  /** Chosen now (a tick), so the list says what the file holds. */
  readonly on: boolean;
  /** Shown dim and never selectable (a `✗` pointed at its own step). */
  readonly off: boolean;
}

/** A row's control: what the component draws, and nothing more. */
export type SheetField =
  | {
      readonly control: "text";
      readonly key: string;
      readonly label: string;
      readonly sub: string | null;
      readonly value: string;
      readonly mono: boolean;
      readonly multiline: boolean;
      readonly placeholder: string | null;
    }
  | {
      readonly control: "stepper";
      readonly key: string;
      readonly label: string;
      readonly sub: string | null;
      readonly value: number;
      readonly min: number;
      readonly max: number;
    }
  | {
      readonly control: "segmented";
      readonly key: string;
      readonly label: string;
      /** Two or three options; the chosen one is ALSO bold (never fill alone). */
      readonly options: readonly { readonly label: string; readonly on: boolean }[];
    }
  | {
      readonly control: "pick";
      readonly key: string;
      readonly label: string;
      readonly value: string;
      readonly sub: string | null;
      /** The picker it opens (a `SheetRequest`), so the route never guesses. */
      readonly opens: SheetRequest | null;
    }
  | {
      readonly control: "choice";
      readonly key: string;
      /**
       * The list's heading, or `null` when the BAND already carries it. A heading
       * drawn as a row label sits on no horizontal margin at all — the field's
       * `paddingHorizontal` is the row's, and a stacked field has none — so a
       * picker's heading is the section's, on the band's margin like every other
       * one (validation round 3, N3). Only a list that shares a band with other
       * rows keeps its own.
       */
      readonly label: string | null;
      readonly options: readonly SheetChoice[];
    }
  | {
      readonly control: "value";
      readonly key: string;
      readonly label: string;
      readonly value: string;
      readonly sub: string | null;
    };

/** One band of rows, with the mockup's footnote under it. */
export interface SheetSection {
  readonly label: string | null;
  readonly fields: readonly SheetField[];
  readonly foot: string | null;
  /** The footnote is a problem (`bad`), not advice. */
  readonly footBad: boolean;
}

/** Everything a sheet draws. Built from the draft on screen, never from an edit. */
export interface SheetModel {
  readonly request: SheetRequest;
  readonly title: string;
  /** Left control: `Cancel` / `‹ Graph`. */
  readonly cancel: string;
  /** Right control; `null` = this sheet has nothing to confirm. */
  readonly done: string | null;
  readonly detent: SheetDetent;
  readonly sections: readonly SheetSection[];
  /** The controller's refusal or notice, verbatim, or the sheet's own warning. */
  readonly note: string | null;
}

/** What a control ends in: exactly one `WorkflowEditController` call, or nothing. */
export type SheetAction =
  | { readonly do: "insert"; readonly at: InsertAt; readonly stepKind: StepKind }
  | { readonly do: "patch"; readonly id: string; readonly patch: StepPatch }
  | { readonly do: "rename"; readonly id: string; readonly to: string }
  | {
      readonly do: "prompt";
      readonly id: string;
      readonly prompt: { readonly path: string } | { readonly text: string };
    }
  | { readonly do: "retry"; readonly id: string; readonly retry: number }
  | { readonly do: "then"; readonly id: string; readonly target: string | "stop" }
  | { readonly do: "gotoMax"; readonly id: string; readonly max: number }
  | { readonly do: "next"; readonly id: string; readonly target: string | undefined }
  | { readonly do: "description"; readonly text: string }
  | {
      readonly do: "input";
      readonly name: string;
      readonly input: { readonly required: true } | { readonly default: string } | null;
    };

/** The controller methods a sheet reaches, and nothing else. */
export interface SheetActions {
  readonly insert: (at: InsertAt, kind: StepKind) => void;
  readonly patch: (id: string, patch: StepPatch) => void;
  readonly rename: (id: string, to: string) => void;
  readonly prompt: (
    id: string,
    prompt: { readonly path: string } | { readonly text: string },
  ) => void;
  readonly setRetry: (id: string, retry: number) => void;
  readonly setFail: (id: string, target: string | "stop", max?: number) => void;
  readonly setGotoMax: (id: string, max: number) => void;
  readonly setNext: (id: string, target: string | undefined) => void;
  readonly edit: (change: (draft: WorkflowDraft, prompts: DraftPrompts) => DraftEdit) => void;
}

type Mapping = Record<string, unknown>;

/** The draft's steps as mappings (a structurally broken draft has none). */
function stepsOf(draft: WorkflowDraft): readonly Mapping[] {
  const steps = draft.steps;
  return Array.isArray(steps) ? (steps as Mapping[]) : [];
}

function stepOf(draft: WorkflowDraft, id: string): Mapping | undefined {
  return stepsOf(draft).find((step) => step.id === id);
}

/** The kind a step's body is, or null when it has none yet (an empty body). */
function kindOf(step: Mapping): StepKind | null {
  if (step.agent !== undefined) {
    return "agent";
  }
  if (step.run !== undefined) {
    return "run";
  }
  if (step.approve !== undefined) {
    return "approve";
  }
  return null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberish(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The pass edge this step names, else the one after it in the file (a fall-through). */
function passTargetOf(draft: WorkflowDraft, id: string): string | undefined {
  const steps = stepsOf(draft);
  const at = steps.findIndex((step) => step.id === id);
  if (at === -1) {
    return undefined;
  }
  const next = steps[at]?.next;
  if (typeof next === "string") {
    return next;
  }
  const following = steps[at + 1]?.id;
  return typeof following === "string" ? following : undefined;
}

/** One line for a step in a picker: what it does, in the file's own words. */
function stepSub(step: Mapping): string {
  const kind = kindOf(step);
  if (kind === "run") {
    return text(step.run);
  }
  if (kind === "agent") {
    const agent = (step.agent ?? {}) as Mapping;
    const model = text(agent.model);
    return model === "" ? "a model step" : `a model step · ${model}`;
  }
  if (kind === "approve") {
    return text((step.approve as Mapping | undefined)?.title);
  }
  return "no step body yet";
}

/** `steps[2]` — the YAML path of the step, for a sheet's footnote. */
function pathOf(draft: WorkflowDraft, id: string): string {
  const at = stepsOf(draft).findIndex((step) => step.id === id);
  return at === -1 ? "steps" : `steps[${at}]`;
}

/** The on_fail mapping of a step, when it has one. */
function onFailOf(step: Mapping): Mapping | undefined {
  const value = step.on_fail;
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Mapping)
    : undefined;
}

// ---------------------------------------------------------------------------
// Insert / step / picker: which sheet a gesture opens, and what it shows.
// ---------------------------------------------------------------------------

/**
 * The sheet an intent opens. `insert` is the kind picker; a label on the `✗`
 * edge is the loop's COUNTER (the short sheet the mockup shows for "lint fails →
 * exec"), and every other label opens the step itself (its retry stepper, its
 * Next row). Anything else completes with no sheet at all.
 */
export function sheetForIntent(intent: EditIntent): SheetRequest | null {
  switch (intent.kind) {
    case "insert":
      return { kind: "kind", at: intent.at };
    case "open":
      return sheetForLabel(intent.id, intent.which);
    default:
      return null;
  }
}

/** A step, or one of its labels: which sheet that is (see `sheetForIntent`). */
export function sheetForLabel(id: string, which?: EditLabel["which"]): SheetRequest {
  return which === "fail" ? { kind: "max", id } : { kind: "step", id };
}

/** Where a sheet goes when it closes: back to the step it belongs to, or to the graph. */
export function afterSheet(request: SheetRequest): SheetRequest | null {
  if (request.kind === "pick") {
    return { kind: "step", id: request.id };
  }
  return null;
}

/**
 * Where the sheet goes once a control has fired. Three cases, and no fourth:
 * - the control REFUSED (`null`): the sheet stays up, so the refusal's own words
 *   (the controller's `notice`) are read where the field is;
 * - the kind was picked: the step is on the graph, so the picker closes;
 * - anything else fires INSIDE its sheet, so the sheet STAYS UP — the mockup's
 *   `− 2 +` is pressed repeatedly and a model tick is read against the list —
 *   except a picker's target, which hands back the step that opened it.
 */
export function sheetAfterAction(
  request: SheetRequest,
  action: SheetAction | null,
): SheetRequest | null {
  if (action === null) {
    return request;
  }
  if (action.do === "insert") {
    return null;
  }
  return request.kind === "pick" ? afterSheet(request) : request;
}

/** The kind picker (D8, medium detent): three rows, one line each. */
export function kindSheet(draft: WorkflowDraft, at: InsertAt): SheetModel {
  const steps = stepsOf(draft);
  const anchor = "after" in at ? stepOf(draft, at.after) : undefined;
  const pass = "after" in at ? passTargetOf(draft, at.after) : undefined;
  return {
    request: { kind: "kind", at },
    title: "after" in at ? `Add a step after ${at.after}` : "Add a step",
    cancel: "Cancel",
    done: null,
    detent: "medium",
    note: null,
    sections: [
      {
        // The heading is the BAND's, like every other section's (`If it fails`,
        // `When it passes`), so it lands on the same margin (validation N3).
        label: "What it does",
        fields: [
          {
            control: "choice",
            key: "kind",
            label: null,
            options: (["agent", "run", "approve"] as const).map((kind) => ({
              value: kind,
              label: kindTitle(kind),
              sub: kindSub(kind),
              glyph: KIND_GLYPH[kind],
              on: false,
              off: false,
            })),
          },
        ],
        foot:
          anchor === undefined || pass === undefined
            ? "Next you choose where it goes."
            : `It goes between ${text(anchor.id)} and ${pass}.`,
        footBad: steps.length === 0,
      },
    ],
  };
}

function kindTitle(kind: StepKind): string {
  return kind === "agent" ? "Agent" : kind === "run" ? "Run a command" : "Approval";
}

function kindSub(kind: StepKind): string {
  if (kind === "agent") {
    return "A model does the work, then says pass or fail.";
  }
  return kind === "run"
    ? "A shell command. Exit 0 is pass."
    : "Waits for you. Never auto-accepted.";
}

/**
 * A step's own sheet (D8, large detent): its body per kind, the failure block
 * every kind shares, and the pass edge. `null` when there is no such step — a
 * sheet never opens onto nothing.
 */
export function stepSheet(input: {
  readonly draft: WorkflowDraft;
  readonly prompts: DraftPrompts;
  readonly id: string;
  readonly models?: readonly string[];
  readonly agentTypes?: readonly string[];
  readonly notice: string | null;
}): SheetModel | null {
  const { draft, id } = input;
  const step = stepOf(draft, id);
  if (step === undefined) {
    return null;
  }
  const kind = kindOf(step);
  const body = kind === null ? [] : bodyFields(draft, input.prompts, id, step, input);
  const onFail = onFailOf(step);
  const goto = text(onFail?.goto);
  // The SHAPE decides, never the content: `{goto: ""}` is "Go to step" with the
  // step still to pick (the empty string is what the validator then refuses).
  const failing = onFail !== undefined;
  const retry = numberish(step.retry) ?? 0;
  const next = text(step.next);
  const following = passTargetOf(draft, id);
  return {
    request: { kind: "step", id },
    title: id,
    cancel: "‹ Graph",
    done: "Done",
    detent: "large",
    note: input.notice,
    sections: [
      {
        label: null,
        fields: body,
        foot: `${pathOf(draft, id)} · ${kindFoot(kind)}`,
        footBad: false,
      },
      {
        label: "If it fails",
        fields: [
          {
            control: "stepper",
            key: "retry",
            label: "Retry",
            sub: "same step again, 0–5",
            value: retry,
            min: 0,
            max: WORKFLOW_MAX_RETRY,
          },
          {
            control: "segmented",
            key: "then",
            label: "Then",
            options: [
              { label: "Stop", on: !failing },
              { label: "Go to step", on: failing },
            ],
          },
          ...(failing
            ? [
                {
                  control: "pick" as const,
                  key: "goto",
                  label: "Go to",
                  value: goto,
                  // A `pick` row draws its value as plain text: an empty one is a
                  // blank line, so the pending step says so in words.
                  sub: goto === "" ? "not picked yet" : null,
                  opens: { kind: "pick" as const, id, purpose: "fail" as const },
                },
                {
                  control: "stepper" as const,
                  key: "max",
                  label: "At most",
                  sub: "times, 1–10 — then it stops",
                  value: numberish(onFail?.max) ?? 1,
                  min: 1,
                  max: WORKFLOW_MAX_GOTO,
                },
              ]
            : []),
        ],
        foot: goto === "" ? null : `Draws a dashed ✗ link to ${goto}. Each pass through it counts.`,
        footBad: false,
      },
      {
        label: "When it passes",
        fields: [
          {
            control: "pick",
            key: "next",
            label: "Next",
            value: next === "" ? "The step below" : next,
            sub:
              next === "" ? `the default${following === undefined ? "" : ` · ${following}`}` : null,
            opens: { kind: "pick", id, purpose: "next" },
          },
        ],
        foot: null,
        footBad: false,
      },
    ],
  };
}

function kindFoot(kind: StepKind | null): string {
  if (kind === "run") {
    return "exit 0 = pass, anything else = fail";
  }
  return kind === "agent" ? "a model step" : kind === "approve" ? "waits for you" : "no body yet";
}

/** The per-kind rows: what a `run`, an `agent` or an `approve` step owns. */
function bodyFields(
  draft: WorkflowDraft,
  prompts: DraftPrompts,
  id: string,
  step: Mapping,
  input: {
    readonly models?: readonly string[];
    readonly agentTypes?: readonly string[];
  },
): SheetField[] {
  const kind = kindOf(step);
  if (kind === "run") {
    const where = step.where;
    const container =
      typeof where === "object" && where !== null && !Array.isArray(where)
        ? (where as Mapping)
        : undefined;
    // Docker is the SHAPE (`where` is a mapping); the name inside may still be
    // empty, which is a pending container the validator names on Save.
    const docker = text(container?.docker);
    const timeout = text(step.timeout);
    return [
      {
        control: "text",
        key: "run",
        label: "Command",
        sub: null,
        value: text(step.run),
        mono: true,
        multiline: true,
        placeholder: "bun run lint",
      },
      {
        control: "text",
        key: "id",
        label: "Step id",
        sub: "from the command",
        value: id,
        mono: true,
        multiline: false,
        placeholder: "lint",
      },
      {
        control: "segmented",
        key: "where",
        label: "Where",
        options: [
          { label: "Local", on: container === undefined },
          { label: "Docker", on: container !== undefined },
        ],
      },
      ...(container === undefined
        ? []
        : [
            {
              control: "text" as const,
              key: "docker",
              label: "Container",
              sub: null,
              value: docker,
              mono: true,
              multiline: false,
              placeholder: "name",
            },
          ]),
      {
        control: "text",
        key: "timeout",
        label: "Timeout",
        sub: timeout === "" ? "default · 20m" : null,
        value: timeout,
        mono: true,
        multiline: false,
        placeholder: "5m",
      },
    ];
  }
  if (kind === "agent") {
    const agent = (step.agent ?? {}) as Mapping;
    const path = text(agent.prompt);
    const inline = text(agent.prompt_text);
    // The KEY decides the mode, as it does for `where`/`on_fail`: a hand-written
    // `prompt: ""` is a File step that names no file, not an Inline one.
    const isFile = agent.prompt !== undefined;
    const file = path === "" ? (prompts[defaultPromptPath(id)] ?? "") : (prompts[path] ?? "");
    return [
      {
        control: "segmented",
        key: "promptMode",
        label: "Prompt",
        options: [
          { label: "File", on: isFile },
          { label: "Inline", on: !isFile },
        ],
      },
      ...(!isFile
        ? [
            {
              control: "text" as const,
              key: "promptText",
              label: "Prompt",
              sub: null,
              value: inline,
              mono: false,
              multiline: true,
              placeholder: "What the model should do",
            },
          ]
        : [
            {
              control: "text" as const,
              key: "promptPath",
              label: "File",
              sub: file === "" ? "not in this draft — it is written on save" : firstLine(file),
              value: path,
              mono: true,
              multiline: false,
              placeholder: defaultPromptPath(id),
            },
          ]),
      {
        control: "choice",
        key: "model",
        label: "Model",
        options: [
          ...(input.models ?? []).map((model) => ({
            value: model,
            label: model,
            sub: null,
            glyph: null,
            on: text(agent.model) === model,
            off: false,
          })),
          {
            value: "",
            label: "Session default",
            sub: "the session's own model",
            glyph: null,
            on: text(agent.model) === "",
            off: false,
          },
        ],
      },
      {
        control: "choice",
        key: "agentType",
        label: "Agent type",
        options: [
          ...(input.agentTypes ?? []).map((type) => ({
            value: type,
            label: type,
            sub: null,
            glyph: null,
            on: text(agent.type) === type,
            off: false,
          })),
          {
            value: "",
            label: "Default",
            sub: "the session's own type",
            glyph: null,
            on: text(agent.type) === "",
            off: false,
          },
        ],
      },
      {
        control: "text",
        key: "tokens",
        label: "Token cap",
        sub: "else the run's budget",
        value: numberish(agent.tokens) === null ? "" : String(agent.tokens),
        mono: true,
        multiline: false,
        placeholder: "none",
      },
    ];
  }
  const approve = (step.approve ?? {}) as Mapping;
  return [
    {
      control: "text",
      key: "title",
      label: "Title",
      sub: null,
      value: text(approve.title),
      mono: false,
      multiline: false,
      placeholder: "Merge {{inputs.slug}} into main",
    },
    {
      control: "text",
      key: "detail",
      label: "Detail",
      sub: "what you are asked, before you answer",
      value: text(approve.detail),
      mono: false,
      multiline: true,
      placeholder: "optional",
    },
  ];
}

/** A prompt file's first non-empty line: the one-line preview a field shows. */
function firstLine(source: string): string {
  const line = source.split("\n").find((candidate) => candidate.trim() !== "");
  return line === undefined ? "" : line.trim().slice(0, 80);
}

/**
 * The goto picker (D8, large detent): the draft's steps in file order with their
 * kind, the step itself dim and saying why. `purpose` "next" also offers the
 * default (no `next:` key at all).
 */
export function pickSheet(input: {
  readonly draft: WorkflowDraft;
  readonly id: string;
  readonly purpose: PickPurpose;
}): SheetModel | null {
  const { draft, id, purpose } = input;
  if (stepOf(draft, id) === undefined) {
    return null;
  }
  const steps = stepsOf(draft);
  const options: SheetChoice[] = [
    ...(purpose === "next"
      ? [
          {
            value: "",
            label: "The step below",
            sub: "the default — no next: key",
            glyph: null,
            on: text(stepOf(draft, id)?.next) === "",
            off: false,
          },
        ]
      : []),
    ...steps
      .filter((step) => text(step.id) !== id)
      .map((step) => ({
        value: text(step.id),
        label: text(step.id),
        sub: stepSub(step),
        glyph: kindOf(step) === null ? null : KIND_GLYPH[kindOf(step) as StepKind],
        on: false,
        off: false,
      })),
    // The step itself LAST and dim: it is on the list (a person may look for it)
    // but a `✗` pointed at its own step is what `retry:` is for.
    ...(purpose === "fail"
      ? [
          {
            value: "",
            label: id,
            sub: "itself — use Retry instead",
            glyph: null,
            on: false,
            off: true,
          },
        ]
      : []),
  ];
  return {
    request: { kind: "pick", id, purpose },
    title: purpose === "fail" ? `If ${id} fails, go to` : `When ${id} passes, go to`,
    cancel: "Cancel",
    done: null,
    detent: "large",
    note: null,
    sections: [
      {
        label: null,
        fields: [{ control: "choice", key: "target", label: null, options }],
        foot:
          purpose === "fail"
            ? "A step above makes a loop: it is allowed because the link is counted (at most n times). A step below skips ahead."
            : "A step above makes a loop: it is allowed because the link is counted (at most n times).",
        footBad: false,
      },
    ],
  };
}

/** The `✗ ×n` counter (D8, short detent). `null` when the step has no fail target. */
export function maxSheet(draft: WorkflowDraft, id: string): SheetModel | null {
  const step = stepOf(draft, id);
  const onFail = step === undefined ? undefined : onFailOf(step);
  const goto = text(onFail?.goto);
  if (step === undefined || goto === "") {
    return null;
  }
  return {
    request: { kind: "max", id },
    title: `${id} fails → ${goto}`,
    cancel: "Cancel",
    done: "Done",
    detent: "short",
    note: null,
    sections: [
      {
        label: null,
        fields: [
          {
            control: "stepper",
            key: "max",
            label: "At most",
            sub: "times, then the run stops",
            value: numberish(onFail?.max) ?? 1,
            min: 1,
            max: WORKFLOW_MAX_GOTO,
          },
        ],
        foot: "Every cycle needs a counted link: this is it.",
        footBad: false,
      },
    ],
  };
}

/**
 * Workflow Settings (D8): the file's description, its inputs and its budget.
 * The budget is CLOSED and shows the defaults — a default is never written, so
 * the file stays short and a diff says only what a person chose.
 */
export function settingsSheet(draft: WorkflowDraft): SheetModel {
  const inputs = (draft.inputs ?? {}) as Record<string, Mapping>;
  const budget = (draft.budget ?? {}) as Mapping;
  const names = Object.keys(inputs);
  return {
    request: { kind: "settings" },
    title: "Settings",
    cancel: "‹ Graph",
    done: "Done",
    detent: "large",
    note: null,
    sections: [
      {
        label: null,
        fields: [
          {
            control: "value",
            key: "name",
            label: "Name",
            value: text(draft.name),
            sub: null,
          },
          {
            control: "value",
            key: "version",
            label: "Version",
            value: String(numberish(draft.version) ?? 1),
            sub: "goes up by itself when you save",
          },
          {
            control: "text",
            key: "description",
            label: "Description",
            sub: null,
            value: text(draft.description),
            mono: false,
            multiline: true,
            placeholder: "what this workflow does",
          },
        ],
        foot: null,
        footBad: false,
      },
      {
        label: "Inputs",
        fields: [
          ...names.flatMap((name): SheetField[] => {
            const input = inputs[name] as Mapping;
            const fallback = text(input.default);
            const required = input.required === true;
            return [
              {
                control: "segmented",
                key: `input-required:${name}`,
                label: name,
                options: [
                  { label: "Required", on: required },
                  { label: "Has a default", on: !required },
                ],
              },
              ...(required
                ? []
                : [
                    {
                      control: "text" as const,
                      key: `input-default:${name}`,
                      label: `${name} default`,
                      sub: null,
                      value: fallback,
                      mono: false,
                      multiline: false,
                      placeholder: '""',
                    },
                  ]),
            ];
          }),
          {
            control: "text",
            key: "input-add",
            label: "Add input",
            sub: "strings only",
            value: "",
            mono: true,
            multiline: false,
            placeholder: "name",
          },
        ],
        foot: "Use them as {{inputs.name}} in prompts and approvals.",
        footBad: false,
      },
      {
        label: "Budget",
        fields: [
          {
            control: "value",
            key: "budget-tokens",
            label: "Tokens",
            value: numberish(budget.tokens) === null ? "default" : String(budget.tokens),
            sub: null,
          },
          {
            control: "value",
            key: "budget-wait",
            label: "Wait for you",
            value: text(budget.wait) === "" ? "default · 12h" : text(budget.wait),
            sub: "then the run stops",
          },
          {
            control: "value",
            key: "budget-step-runs",
            label: "Step runs",
            value:
              numberish(budget.max_step_runs) === null
                ? "default · 50"
                : String(budget.max_step_runs),
            sub: "the belt against loops",
          },
        ],
        foot: "Defaults are not written to the file.",
        footBad: false,
      },
    ],
  };
}

/** The model of ONE sheet, from the draft on screen (the route's only entry). */
export function sheetModel(input: {
  readonly request: SheetRequest;
  readonly draft: WorkflowDraft;
  readonly prompts: DraftPrompts;
  readonly models?: readonly string[];
  readonly agentTypes?: readonly string[];
  readonly notice: string | null;
}): SheetModel | null {
  const { request } = input;
  switch (request.kind) {
    case "kind":
      return kindSheet(input.draft, request.at);
    case "step":
      return stepSheet({ ...input, id: request.id });
    case "pick":
      return pickSheet({ draft: input.draft, id: request.id, purpose: request.purpose });
    case "max":
      return maxSheet(input.draft, request.id);
    case "settings":
      return settingsSheet(input.draft);
  }
}

// ---------------------------------------------------------------------------
// A control, applied: one controller call per action, or nothing.
// ---------------------------------------------------------------------------

/** A stepper's own clamp: the − and + ends stop at the validator's range. */
export function stepped(value: number, min: number, max: number, delta: number): number {
  return Math.min(max, Math.max(min, value + delta));
}

/** The field with this key, from any section of the model (the ONE lookup). */
function fieldOf(model: SheetModel, key: string): SheetField | undefined {
  for (const section of model.sections) {
    for (const field of section.fields) {
      if (field.key === key) {
        return field;
      }
    }
  }
  return undefined;
}

/**
 * The control a key names, when the sheet really draws it. A key the model does
 * not hold can only come from a stale render or a screen bug, so it does
 * nothing at all here: a stepper that is not on screen (the `max` of a step that
 * stops) must never be able to change the file anyway.
 */
function controlOf<C extends SheetField["control"]>(
  model: SheetModel,
  key: string,
  control: C,
): Extract<SheetField, { control: C }> | null {
  const field = fieldOf(model, key);
  return field !== undefined && field.control === control
    ? (field as Extract<SheetField, { control: C }>)
    : null;
}

/**
 * A TEXT field committed. Every key below names one field of one sheet; a value
 * the file cannot hold (an empty docker name, a timeout that is not a duration)
 * reaches the validator instead of being guessed at here — except a blank
 * optional field, which simply drops the key.
 */
export function textAction(model: SheetModel, key: string, raw: string): SheetAction | null {
  // `description` and the input fields are Settings' own (no step involved).
  if (key === "description" || key.startsWith("input-")) {
    return settingsTextAction(model, key, raw);
  }
  if (controlOf(model, key, "text") === null) {
    return null;
  }
  const value = raw.trim();
  const id = "id" in model.request ? model.request.id : "";
  switch (key) {
    case "run":
      return { do: "patch", id, patch: { kind: "run", run: raw } };
    case "id":
      return value === "" || value === id ? null : { do: "rename", id, to: value };
    case "docker":
      // A blank name is SENT: the draft keeps `{docker: ""}` and Save names it,
      // instead of a field that shows empty while the file keeps the old name.
      return { do: "patch", id, patch: { kind: "run", where: { docker: value } } };
    case "timeout":
      if (value === "") {
        return { do: "patch", id, patch: { kind: "run", timeout: null } };
      }
      return parseWorkflowDuration(value) === null
        ? null
        : { do: "patch", id, patch: { kind: "run", timeout: value } };
    case "promptPath":
      return value === "" ? null : { do: "prompt", id, prompt: { path: value } };
    case "promptText":
      return { do: "prompt", id, prompt: { text: raw } };
    case "tokens": {
      if (value === "") {
        return { do: "patch", id, patch: { kind: "agent", tokens: null } };
      }
      const tokens = Number(value);
      return Number.isInteger(tokens) && tokens > 0
        ? { do: "patch", id, patch: { kind: "agent", tokens } }
        : null;
    }
    case "title":
      return { do: "patch", id, patch: { kind: "approve", title: raw } };
    case "detail":
      return { do: "patch", id, patch: { kind: "approve", detail: value === "" ? null : raw } };
    default:
      return null;
  }
}

/** Settings' own text fields: the description and an input's default. */
function settingsTextAction(model: SheetModel, key: string, raw: string): SheetAction | null {
  const field = fieldOf(model, key);
  if (field === undefined) {
    return null;
  }
  const value = raw.trim();
  if (key === "description") {
    return { do: "description", text: raw };
  }
  if (key.startsWith("input-default:")) {
    const name = key.slice("input-default:".length);
    return { do: "input", name, input: { default: raw } };
  }
  if (key === "input-add") {
    return value === "" ? null : { do: "input", name: value, input: { required: true } };
  }
  return null;
}

/** A stepper's − / + pressed. */
export function stepperAction(model: SheetModel, key: string, delta: number): SheetAction | null {
  const control = controlOf(model, key, "stepper");
  if (control === null) {
    return null;
  }
  const id = "id" in model.request ? model.request.id : "";
  if (key === "retry") {
    return { do: "retry", id, retry: stepped(control.value, control.min, control.max, delta) };
  }
  if (key === "max") {
    return { do: "gotoMax", id, max: stepped(control.value, control.min, control.max, delta) };
  }
  return null;
}

/** A segmented control's option chosen. */
export function segmentAction(model: SheetModel, key: string, option: string): SheetAction | null {
  if (controlOf(model, key, "segmented") === null) {
    return null;
  }
  const id = "id" in model.request ? model.request.id : "";
  if (key === "then") {
    return option === "Stop"
      ? { do: "then", id, target: "stop" }
      : { do: "then", id, target: gotoOf(model) ?? "" };
  }
  if (key === "where") {
    return option === "Docker"
      ? { do: "patch", id, patch: { kind: "run", where: { docker: "" } } }
      : { do: "patch", id, patch: { kind: "run", where: "local" } };
  }
  if (key === "promptMode") {
    return option === "Inline"
      ? { do: "prompt", id, prompt: { text: "" } }
      : { do: "prompt", id, prompt: { path: defaultPromptPath(id) } };
  }
  if (key.startsWith("input-required:")) {
    const name = key.slice("input-required:".length);
    return {
      do: "input",
      name,
      input: option === "Required" ? { required: true } : { default: "" },
    };
  }
  return null;
}

/** The fail target the step sheet currently shows (a `Go to step` re-segmentation). */
function gotoOf(model: SheetModel): string | null {
  const control = controlOf(model, "goto", "pick");
  return control === null ? null : control.value;
}

/** An inline list's row picked (a model, an agent type, a kind, a goto target). */
export function choiceAction(model: SheetModel, key: string, value: string): SheetAction | null {
  const control = controlOf(model, key, "choice");
  if (control === null) {
    return null;
  }
  // Only an option the sheet actually offers: a value from a stale render (or a
  // step that has left the draft) can never write itself into the file.
  const chosen = control.options.find((option) => option.value === value);
  if (chosen === undefined || chosen.off) {
    return null;
  }
  const id = "id" in model.request ? model.request.id : "";
  if (key === "kind" && model.request.kind === "kind") {
    return value === "agent" || value === "run" || value === "approve"
      ? { do: "insert", at: model.request.at, stepKind: value }
      : null;
  }
  if (key === "model") {
    return { do: "patch", id, patch: { kind: "agent", model: value === "" ? null : value } };
  }
  if (key === "agentType") {
    return { do: "patch", id, patch: { kind: "agent", type: value === "" ? null : value } };
  }
  if (key === "target" && model.request.kind === "pick") {
    if (model.request.purpose === "next") {
      return { do: "next", id, target: value === "" ? undefined : value };
    }
    return value === "" ? null : { do: "then", id, target: value };
  }
  return null;
}

/** A `pick` row tapped: the picker it opens (never a controller call). */
export function pickOpens(model: SheetModel, key: string): SheetRequest | null {
  const control = controlOf(model, key, "pick");
  return control === null ? null : control.opens;
}

/** Carry an action out: exactly one controller call, or nothing at all. */
export function applySheetAction(actions: SheetActions, action: SheetAction | null): void {
  if (action === null) {
    return;
  }
  switch (action.do) {
    case "insert":
      actions.insert(action.at, action.stepKind);
      return;
    case "patch":
      actions.patch(action.id, action.patch);
      return;
    case "rename":
      actions.rename(action.id, action.to);
      return;
    case "prompt":
      actions.prompt(action.id, action.prompt);
      return;
    case "retry":
      actions.setRetry(action.id, action.retry);
      return;
    case "then":
      // `""` is the pending target: it is WRITTEN, so the sheet can draw the
      // choice it is being asked for (Save then refuses it until it is picked).
      actions.setFail(action.id, action.target);
      return;
    case "gotoMax":
      actions.setGotoMax(action.id, action.max);
      return;
    case "next":
      actions.setNext(action.id, action.target);
      return;
    case "description":
      actions.edit((draft) => withDescription(draft, action.text));
      return;
    case "input":
      actions.edit((draft) => withInput(draft, action.name, action.input));
  }
}

// ---------------------------------------------------------------------------
// The root-level edits a sheet reaches (description, inputs). Pure, immutable,
// and REFUSING rather than guessing: a bad input name is the controller's notice,
// never a key the validator then fails on a line nobody sees.
// ---------------------------------------------------------------------------

/** An input is either required or has a default, never both (the validator's rule). */
export function withInput(
  draft: WorkflowDraft,
  name: string,
  input: { readonly required: true } | { readonly default: string } | null,
): DraftEdit {
  const key = name.trim();
  if (!/^[A-Za-z0-9_-]+$/.test(key)) {
    return { draft, refused: `"${key}" is not an input name — use letters, digits, - or _` };
  }
  const inputs: Record<string, WorkflowInput> = {
    ...((draft.inputs ?? {}) as Record<string, WorkflowInput>),
  };
  if (input === null) {
    if (!Object.hasOwn(inputs, key)) {
      return { draft, refused: `no input "${key}"` };
    }
    const rest = Object.fromEntries(Object.entries(inputs).filter(([each]) => each !== key));
    const next: Record<string, unknown> = { ...draft };
    if (Object.keys(rest).length === 0) {
      // The key must be GONE, not `undefined` (which is still a key on the draft):
      // a computed delete, so the draft keeps its shape and noDelete is clean.
      const drop = "inputs";
      delete next[drop];
    } else {
      next.inputs = rest;
    }
    return { draft: next };
  }
  inputs[key] =
    "required" in input ? { required: true } : { required: false, default: input.default };
  return { draft: { ...draft, inputs } };
}

/** The file's description; blank drops the key rather than writing `description: ""`. */
export function withDescription(draft: WorkflowDraft, raw: string): DraftEdit {
  const value = raw.trim();
  const next: Record<string, unknown> = { ...draft };
  if (value === "") {
    const drop = "description";
    delete next[drop];
    return { draft: next };
  }
  next.description = raw;
  return { draft: next };
}
