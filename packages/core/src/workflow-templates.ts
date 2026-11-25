/**
 * docs/feat/workflow-editor.md D2 — the workflow templates.
 *
 * The owner's decision (22/11 ~23:00): a template creates the YAML **and** its
 * prompt files (`workflows/prompts/*.md`), all under the ONE approved hash. That
 * is why `prompts` sits on the template: every path here is referenced by a step
 * of the draft it builds, so nothing it writes lives outside the hash
 * (`core/test/workflow-templates.test.ts` pins it).
 *
 * Two shapes, both the mockup's:
 *  - `blank` — one empty `run` step, which deliberately does NOT validate: the
 *    user fills it in, and the bar says so (never a silent placeholder).
 *  - `plan-build-review-merge` — the mockup's `TEMPLATE` verbatim, minus the
 *    model names. A template naming `opus` would be a validator error on a
 *    session that does not offer it, so the model/type pickers are left for the
 *    step sheet, which offers only `context.models`.
 *
 * Pure: no I/O, no clock, no React.
 */
import { WORKFLOW_SCHEMA_VERSION } from "./workflow-spec.ts";
import type { WorkflowInput } from "./workflow-spec.ts";
import type { WorkflowDraft } from "./workflow-yaml.ts";

type DraftStep = Record<string, unknown>;

/** One starting point the New-workflow sheet offers. */
export interface WorkflowTemplate {
  /** Stable id (`blank`); what a route or a test names. */
  readonly id: string;
  /** The row's title. */
  readonly label: string;
  /** The row's one-line description. */
  readonly sub: string;
  /** The `inputs:` the sheet opens with (its prompts interpolate exactly these). */
  readonly inputs: Readonly<Record<string, WorkflowInput>>;
  /** The prompt files the workflow writes beside its YAML, by relative path. */
  readonly prompts: Readonly<Record<string, string>>;
  /** The draft, once the sheet knows the name, description and inputs. */
  readonly draft: (
    name: string,
    description: string,
    inputs: Readonly<Record<string, WorkflowInput>>,
  ) => WorkflowDraft;
}

/** `version: 1`, the id/kind body order the emitter writes, `undefined` dropped. */
function draftOf(
  name: string,
  description: string,
  inputs: Readonly<Record<string, WorkflowInput>>,
  steps: readonly DraftStep[],
): WorkflowDraft {
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    name,
    version: 1,
    ...(description.trim() === "" ? {} : { description: description.trim() }),
    ...(Object.keys(inputs).length === 0 ? {} : { inputs }),
    steps: steps.map((step) => ({ ...step })),
  };
}

/** The mockup's plan → exec → review ⇄ fix → gate → merge. */
const LOOP_STEPS: readonly DraftStep[] = [
  {
    id: "plan",
    agent: { prompt: "prompts/plan.md", tokens: 400_000 },
  },
  {
    id: "exec",
    agent: { prompt: "prompts/exec.md" },
    retry: 1,
  },
  {
    id: "review",
    agent: { prompt: "prompts/review.md" },
    // A COUNTED goto: the review ⇄ fix pass loop has no counter of its own, which
    // the validator refuses (`cycleProblem`). review.next: gate leaves the loop.
    on_fail: { goto: "fix", max: 3 },
    next: "gate",
  },
  {
    id: "fix",
    agent: { prompt: "prompts/fix.md" },
    next: "review",
  },
  {
    id: "gate",
    run: "bun run check",
    timeout: "20m",
  },
  {
    id: "merge",
    approve: { title: "Merge {{inputs.slug}} into main" },
  },
];

/** The four prompt files the loop's agent steps read (`{{steps.<id>.report}}`). */
const LOOP_PROMPTS: Readonly<Record<string, string>> = {
  "prompts/plan.md": [
    "Read the task and write the plan for {{inputs.slug}}.",
    "",
    "Name every file you will touch, in order, and the check that proves each one.",
  ].join("\n"),
  "prompts/exec.md": [
    "Execute the plan and stop at the first surprise.",
    "",
    "The plan was:",
    "",
    "{{steps.plan.report}}",
  ].join("\n"),
  "prompts/review.md": [
    "Review the change against the plan. Answer pass or fail, with the one reason that decides it.",
    "",
    "The plan was:",
    "",
    "{{steps.plan.report}}",
  ].join("\n"),
  "prompts/fix.md": [
    "Fix exactly what the review found, and nothing else.",
    "",
    "The review said: {{steps.review.reason}}",
  ].join("\n"),
};

/** One empty command step: the user fills it in, and the bar says it is empty. */
const BLANK_STEPS: readonly DraftStep[] = [{ id: "step", run: "" }];

/**
 * Every starting point, in the sheet's order: Blank, then the loop (the mockup's
 * `newSheet`).
 */
export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = [
  {
    id: "blank",
    label: "Blank",
    sub: "one empty step — you add the rest",
    inputs: {},
    prompts: {},
    draft: (name, description, inputs) => draftOf(name, description, inputs, BLANK_STEPS),
  },
  {
    id: "plan-build-review-merge",
    label: "Plan · build · review · merge",
    sub: "6 steps: a review ⇄ fix loop (≤3), a gate your gate command runs, your approval to merge",
    // `slug` is required by the merge step's title, so the sheet ASKS for it.
    inputs: { slug: { required: true }, doc: { required: false, default: "" } },
    prompts: LOOP_PROMPTS,
    draft: (name, description, inputs) => draftOf(name, description, inputs, LOOP_STEPS),
  },
];
