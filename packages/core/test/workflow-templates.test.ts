/**
 * docs/feat/workflow-editor.md D2: the templates. The property that matters is
 * the owner's decision (22/11 ~23:00) — a template creates the YAML AND its
 * prompt files, and every prompt it carries is referenced by a step, so the
 * whole thing sits inside the ONE approved hash. A template that validates is
 * not enough: an unreferenced prompt file would be written outside the hash.
 *
 * One reading of the plan, stated here because it contradicts itself: D2 says
 * "every template passes `draftProblems` with 0 errors", and D2 also says the
 * kind's empty bodies "fail validation until filled in: they are visible
 * problems, never a silent placeholder". `blank` IS one of those empty bodies
 * (one empty `run` step), so the 0-errors property holds for every template that
 * carries a real graph, and `blank`'s one problem is asserted instead.
 *
 * A template also carries the `inputs:` its prompts interpolate, so
 * `draft(name, description, template.inputs)` is the state the New sheet opens in.
 */
import { describe, expect, test } from "bun:test";
import { WORKFLOW_TEMPLATES, draftProblems, workflowYaml } from "../src/index.ts";
import type { WorkflowDraft } from "../src/index.ts";

type Step = Record<string, unknown>;

const named = (id: string) => {
  const template = WORKFLOW_TEMPLATES.find((candidate) => candidate.id === id);
  if (template === undefined) {
    throw new Error(`no template ${id}`);
  }
  return template;
};
/** A freshly-built draft, with its steps in a typed shape the assertions can read. */
const fresh = (id: string, name = "task", description = "") => {
  const template = named(id);
  const draft = template.draft(name, description, template.inputs);
  return { template, draft, steps: draft.steps as unknown as Step[] };
};
const step = (steps: readonly Step[], id: string): Step => {
  const found = steps.find((candidate) => candidate.id === id);
  if (found === undefined) {
    throw new Error(`no step ${id}`);
  }
  return found;
};

describe("WORKFLOW_TEMPLATES", () => {
  test("offers blank and the mockup's six-step plan·build·review·merge", () => {
    expect(WORKFLOW_TEMPLATES.map((template) => template.id)).toEqual([
      "blank",
      "plan-build-review-merge",
    ]);
    for (const template of WORKFLOW_TEMPLATES) {
      expect(template.label.trim()).not.toBe("");
      expect(template.sub.trim()).not.toBe("");
    }
    expect(fresh("plan-build-review-merge").steps.map((s) => s.id)).toEqual([
      "plan",
      "exec",
      "review",
      "fix",
      "gate",
      "merge",
    ]);
  });

  test("a template with prompts validates with 0 problems, and writes no default", () => {
    const { template, draft } = fresh("plan-build-review-merge");
    expect(draftProblems(draft, template.prompts, { name: "task" })).toEqual([]);
    // "defaults never land in the file": a fresh template emits no budget.
    expect(workflowYaml(draft)).not.toContain("budget:");
  });

  test("blank is one empty step: it does NOT validate until the user fills it in", () => {
    const { template, draft, steps } = fresh("blank");
    expect(steps).toHaveLength(1);
    expect(draftProblems(draft, template.prompts, { name: "task" })).toEqual([
      "steps[0].run: should not be empty",
    ]);
    expect(template.prompts).toEqual({});
    expect(template.inputs).toEqual({});
  });

  test("every prompt file a template carries is referenced by a step (inside the hash)", () => {
    for (const template of WORKFLOW_TEMPLATES) {
      const { steps } = fresh(template.id);
      const referenced = steps.flatMap((s) => {
        const agent = s.agent as { prompt?: string } | undefined;
        return agent?.prompt === undefined ? [] : [agent.prompt];
      });
      expect({ id: template.id, paths: Object.keys(template.prompts).sort() }).toEqual({
        id: template.id,
        paths: [...referenced].sort(),
      });
    }
  });

  test("the name, description and inputs the sheet collected are the ones written", () => {
    for (const template of WORKFLOW_TEMPLATES) {
      const { draft } = fresh(template.id, "ship-it", "ship the thing");
      expect(draft.name).toBe("ship-it");
      expect(draft.version).toBe(1);
      expect(draft.description).toBe("ship the thing");
      expect(draft.inputs).toEqual(
        Object.keys(template.inputs).length === 0 ? undefined : template.inputs,
      );
    }
  });

  test("an empty description, and a template with no inputs, write no key at all", () => {
    for (const template of WORKFLOW_TEMPLATES) {
      const { draft } = fresh(template.id);
      expect({ id: template.id, has: "description" in draft }).toEqual({
        id: template.id,
        has: false,
      });
    }
    expect("inputs" in fresh("blank").draft).toBe(false);
  });

  test("the plan·build·review·merge template is the loop the mockup drew", () => {
    const { draft, steps } = fresh("plan-build-review-merge");
    // review ⇄ fix: an explicit next back to review, and a COUNTED goto to fix
    // (a pass loop with no counter is refused by the validator).
    expect(step(steps, "review").next).toBe("gate");
    expect(step(steps, "review").on_fail).toEqual({ goto: "fix", max: 3 });
    expect(step(steps, "fix").next).toBe("review");
    expect(step(steps, "exec").retry).toBe(1);
    expect(step(steps, "gate").run).toBe("bun run check");
    expect(step(steps, "merge").approve).toEqual({ title: "Merge {{inputs.slug}} into main" });
    // The model/type pickers are left to the session: a template naming "opus"
    // would be a validator error wherever that session does not offer it.
    for (const candidate of steps) {
      expect((candidate.agent as { model?: string } | undefined)?.model).toBeUndefined();
    }
    // The `slug` the merge step interpolates is declared, so the sheet asks for it.
    expect((draft as WorkflowDraft).inputs).toEqual({
      slug: { required: true },
      doc: { required: false, default: "" },
    });
  });

  test("a template's prompts interpolate only inputs the workflow declares", () => {
    for (const template of WORKFLOW_TEMPLATES) {
      for (const ref of Object.values(template.prompts)
        .join("\n")
        .matchAll(/\{\{inputs\.([A-Za-z0-9_-]+)\}\}/g)) {
        expect({ id: template.id, key: ref[1] }).toEqual({
          id: template.id,
          key: expect.any(String),
        });
        expect(Object.hasOwn(template.inputs, ref[1] as string)).toBe(true);
      }
    }
    expect(Object.values(named("plan-build-review-merge").prompts).join("\n")).toContain(
      "{{steps.review.reason}}",
    );
  });

  test("the template's prompt paths live under prompts/ and end in .md", () => {
    for (const template of WORKFLOW_TEMPLATES) {
      for (const path of Object.keys(template.prompts)) {
        expect(path).toMatch(/^prompts\/[a-z0-9-]+\.md$/);
      }
    }
  });
});
