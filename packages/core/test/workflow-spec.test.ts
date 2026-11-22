import { describe, expect, test } from "bun:test";
import {
  WORKFLOW_DEFAULT_MAX_STEP_RUNS,
  WORKFLOW_DEFAULT_WAIT_MS,
  WORKFLOW_SCHEMA_VERSION,
  type WorkflowSpec,
  parseWorkflowDuration,
  promptPathProblem,
  renderTemplate,
  runtimeHasher,
  shortHash,
  validateWorkflow,
  workflowHash,
} from "../src/index.ts";

/** The D1 example of docs/feat/agent-workflows.md, prompts inline. */
const EXAMPLE = `schemaVersion: 1
name: task
version: 3
description: plan → exec → review loop → gate → merge
inputs:
  slug: { required: true }
  doc: { default: "" }
budget: { tokens: 3000000, wait: 12h, max_step_runs: 50 }
steps:
  - id: plan
    agent: { prompt_text: "plan {{inputs.slug}}", model: opus, type: general, tokens: 400000 }
  - id: exec
    agent: { prompt_text: "do {{inputs.slug}}: {{steps.plan.reason}}", model: deepseek }
    retry: 1
  - id: review
    agent: { prompt_text: "review {{steps.exec.report}}" }
    on_fail: { goto: fix, max: 3 }
    next: gate
  - id: fix
    agent: { prompt_text: "fix it" }
    next: review
  - id: gate
    run: bun run check
    where: { docker: tentacle-ci }
    timeout: 20m
  - id: merge
    approve: { title: "Merge {{inputs.slug}} into main", detail: "{{steps.review.reason}}" }
  - id: ios
    run: bun run e2e
`;

/** The example, with one replacement — the shortest way to build a fixture. */
function variant(from: string, to: string): string {
  expect(EXAMPLE.includes(from)).toBe(true);
  return EXAMPLE.replace(from, to);
}

/** The errors of a refused file (fails loudly when the fixture is accepted). */
function errorsOf(text: string, ctx: Parameters<typeof validateWorkflow>[1] = {}): string[] {
  const result = validateWorkflow(text, ctx);
  if (result.ok) {
    throw new Error("expected the workflow to be refused");
  }
  return [...result.errors];
}

function accept(text: string, ctx: Parameters<typeof validateWorkflow>[1] = {}): WorkflowSpec {
  const result = validateWorkflow(text, ctx);
  if (!result.ok) {
    throw new Error(`expected the workflow to load, got: ${result.errors.join(" | ")}`);
  }
  return result.spec;
}

describe("validateWorkflow — the happy path", () => {
  test("the D1 example loads, defaults resolved", () => {
    const spec = accept(EXAMPLE, { name: "task" });
    expect(spec.name).toBe("task");
    expect(spec.version).toBe(3);
    expect(spec.steps.map((s) => s.kind)).toEqual([
      "agent",
      "agent",
      "agent",
      "agent",
      "run",
      "approve",
      "run",
    ]);
    expect(spec.budget.maxStepRuns).toBe(50);
    expect(spec.inputs.slug).toEqual({ required: true });
    expect(spec.inputs.doc).toEqual({ required: false, default: "" });
    const gate = spec.steps[4];
    expect(gate?.kind === "run" && gate.where).toEqual({ engine: "docker", name: "tentacle-ci" });
    expect(gate?.kind === "run" && gate.timeoutMs).toBe(20 * 60_000);
    expect(spec.steps[1]?.retry).toBe(1);
    expect(spec.steps[2]?.onFail).toEqual({ kind: "goto", id: "fix", max: 3 });
    expect(spec.steps[2]?.next).toBe("gate");
  });

  test("budget and step defaults are applied when omitted", () => {
    const spec = accept(
      `schemaVersion: 1
name: mini
version: 1
steps:
  - id: only
    run: echo hi
`,
    );
    expect(spec.budget).toEqual({
      waitMs: WORKFLOW_DEFAULT_WAIT_MS,
      maxStepRuns: WORKFLOW_DEFAULT_MAX_STEP_RUNS,
    });
    expect(spec.inputs).toEqual({});
    expect(spec.prompts).toEqual([]);
  });

  test("a retry/goto loop terminates — the example's review→fix→review is ACCEPTED", () => {
    // The property that matters: a counted `on_fail.goto` edge may form a cycle.
    const spec = accept(EXAMPLE);
    const review = spec.steps.find((s) => s.id === "review");
    expect(review?.onFail).toEqual({ kind: "goto", id: "fix", max: 3 });
  });

  test("prompt files are read through the seam, deduped and sorted", () => {
    const files: Record<string, string> = {
      "prompts/b.md": "b {{inputs.slug}}",
      "prompts/a.md": "a",
    };
    const spec = accept(
      `schemaVersion: 1
name: two
version: 1
inputs: { slug: { required: true } }
steps:
  - id: one
    agent: { prompt: prompts/b.md }
  - id: two
    agent: { prompt: prompts/a.md }
  - id: three
    agent: { prompt: prompts/b.md }
`,
      { readPrompt: (path) => files[path] },
    );
    expect(spec.prompts.map((p) => p.path)).toEqual(["prompts/a.md", "prompts/b.md"]);
    expect(spec.steps[0]?.kind === "agent" && spec.steps[0].promptPath).toBe("prompts/b.md");
  });
});

describe("validateWorkflow — every refusal names its YAML path", () => {
  test("unparseable YAML", () => {
    const [first] = errorsOf("schemaVersion: [\n");
    expect(first).toStartWith("not valid YAML:");
  });

  test("a YAML list is not a workflow", () => {
    expect(errorsOf("- 1\n- 2\n")[0]).toContain("must be a YAML mapping");
  });

  test("unknown schemaVersion is refused before anything else", () => {
    const errors = errorsOf(variant("schemaVersion: 1", "schemaVersion: 2"));
    expect(errors).toEqual([
      `schemaVersion: 2 is not supported — this tentacle reads schemaVersion ${WORKFLOW_SCHEMA_VERSION}`,
    ]);
  });

  test("a missing schemaVersion is refused", () => {
    expect(errorsOf(EXAMPLE.replace("schemaVersion: 1\n", ""))[0]).toContain(
      "schemaVersion: is missing",
    );
  });

  test("name must be the file stem and a slug", () => {
    expect(errorsOf(variant("name: task", "name: Task"), { name: "Task" })).toContain(
      "name: should be lowercase letters, digits and single hyphens",
    );
    expect(errorsOf(variant("name: task", "name: other"), { name: "task" })).toContain(
      'name: should be "task" — the file stem is the workflow\'s name',
    );
  });

  test("a step with two kinds, or none, is refused by its index", () => {
    expect(
      errorsOf(
        variant("    run: bun run e2e", '    run: bun run e2e\n    approve: { title: "x" }'),
      ),
    ).toContain("steps[6]: needs exactly ONE of agent:, run: or approve: — found run and approve");
    expect(errorsOf(variant("    run: bun run e2e", "    retry: 2"))).toContain(
      "steps[6]: needs exactly ONE of agent:, run: or approve: — found none",
    );
  });

  test("duplicate ids are refused", () => {
    expect(errorsOf(variant("  - id: ios", "  - id: gate"))).toContain(
      'steps[6].id: "gate" is used twice — step ids are unique',
    );
  });

  test("a mistyped goto names the closest step", () => {
    expect(errorsOf(variant("goto: fix, max: 3", "goto: fx, max: 3"))).toContain(
      'steps[2].on_fail.goto: no step "fx" (did you mean "fix"?)',
    );
  });

  test("a mistyped next names the closest step", () => {
    expect(errorsOf(variant("next: gate", "next: gatee"))).toContain(
      'steps[2].next: no step "gatee" (did you mean "gate"?)',
    );
  });

  test("retry out of range is refused", () => {
    expect(errorsOf(variant("retry: 1", "retry: 6"))[0]).toContain(
      "steps[1].retry: Number must be less than or equal to 5",
    );
  });

  test("an uncounted pass-edge cycle is refused, naming the cycle", () => {
    // Drop review's `next: gate`: `pass` now falls through into fix, whose
    // `next: review` closes a loop that no counter bounds.
    const errors = errorsOf(EXAMPLE.replace("    next: gate\n", ""));
    const cycle = errors.find((e) => e.startsWith("steps: "));
    expect(cycle).toBeDefined();
    expect(cycle).toContain("pass loop with no counter");
    expect(cycle).toContain("review → fix → review");
  });

  test("a step where: is refused on an agent step", () => {
    // `local` is the one value an agent step may carry (the daemon's own shell).
    const local = accept(
      variant(
        '    agent: { prompt_text: "fix it" }',
        '    agent: { prompt_text: "fix it" }\n    where: local',
      ),
    );
    expect(local.steps[3]?.kind).toBe("agent");
    // A container target is a `run` step's only.
    expect(
      errorsOf(
        variant(
          '    agent: { prompt_text: "fix it" }',
          '    agent: { prompt_text: "fix it" }\n    where: { docker: box }',
        ),
      ),
    ).toContain(
      "steps[3].where: an agent step runs on the laptop only — remove where: (a run step may use docker)",
    );
  });

  test("an unknown where: key is refused with its fix", () => {
    expect(
      errorsOf(variant("where: { docker: tentacle-ci }", "where: { podman: tentacle-ci }")),
    ).toContain('steps[4].where: does not know "podman" — use local, or {docker: <container>}');
  });

  test("an on_fail with no goto id is refused", () => {
    expect(errorsOf(variant("on_fail: { goto: fix, max: 3 }", "on_fail: { max: 3 }"))).toContain(
      "steps[2].on_fail: needs a step id — {goto: <step>, max: 1..10}",
    );
  });

  test("on_fail.max out of range is refused", () => {
    expect(errorsOf(variant("goto: fix, max: 3", "goto: fix, max: 11"))).toContain(
      "steps[2].on_fail: max should be a whole number 1..10",
    );
  });

  test("an agent step needs exactly one of prompt:/prompt_text:", () => {
    expect(
      errorsOf(variant('    agent: { prompt_text: "fix it" }', "    agent: { model: opus }")),
    ).toContain("steps[3].agent: needs exactly ONE of prompt: (a file) or prompt_text: (inline)");
    expect(
      errorsOf(
        variant(
          '    agent: { prompt_text: "fix it" }',
          '    agent: { prompt_text: "x", prompt: prompts/fix.md }',
        ),
      ),
    ).toContain("steps[3].agent: needs exactly ONE of prompt: (a file) or prompt_text: (inline)");
  });

  test("a prompt path that leaves workflows/ is refused", () => {
    expect(
      errorsOf(
        variant('    agent: { prompt_text: "fix it" }', "    agent: { prompt: ../secrets/fix.md }"),
      ),
    ).toContain("steps[3].agent.prompt: should stay inside workflows/ — remove the ..");
  });

  test("a prompt file that does not exist is refused", () => {
    expect(
      errorsOf(
        variant('    agent: { prompt_text: "fix it" }', "    agent: { prompt: prompts/fix.md }"),
        {
          readPrompt: () => undefined,
        },
      ),
    ).toContain('steps[3].agent.prompt: no file "prompts/fix.md" under workflows/');
  });

  test("an unknown model names the session's models", () => {
    expect(errorsOf(EXAMPLE, { models: ["opus", "haiku"] })).toContain(
      'steps[1].agent.model: "deepseek" is not a model of this session — one of opus, haiku',
    );
  });

  test("an unknown agent type names the session's types", () => {
    expect(errorsOf(EXAMPLE, { agentTypes: ["explore"] })).toContain(
      'steps[0].agent.type: "general" is not an agent type — one of explore',
    );
  });

  test("an unknown template reference is refused, with the accepted forms", () => {
    expect(errorsOf(variant("plan {{inputs.slug}}", "plan {{inputs.slugg}}"))).toContain(
      'steps[0].agent.prompt_text: no input "slugg" (did you mean "slug"?) — declare it under inputs:',
    );
    // Inner spaces are tolerated: the model writes them either way.
    expect(accept(variant("plan {{inputs.slug}}", "plan {{ inputs.slug }}")).steps[0]?.kind).toBe(
      "agent",
    );
    expect(errorsOf(variant("plan {{inputs.slug}}", "plan {{inputs.slug + 1}}"))).toContain(
      'steps[0].agent.prompt_text: "{{inputs.slug + 1}}" is not a reference — use {{inputs.<name>}}, {{steps.<id>.reason}} or {{steps.<id>.report}}',
    );
    expect(
      errorsOf(variant("review {{steps.exec.report}}", "review {{steps.nope.report}}")),
    ).toContain(
      'steps[2].agent.prompt_text: no step "nope" — {{steps.<id>.…}} must name a step that runs before it',
    );
  });

  test("an approve step's title is templated and checked", () => {
    expect(errorsOf(variant("Merge {{inputs.slug}}", "Merge {{inputs.slugs}}"))).toContain(
      'steps[5].approve.title: no input "slugs" (did you mean "slug"?) — declare it under inputs:',
    );
  });

  test("an input that is both required and defaulted is refused", () => {
    expect(
      errorsOf(variant("slug: { required: true }", 'slug: { required: true, default: "x" }')),
    ).toContain('inputs.slug.required: an input is either required or has a "default", never both');
  });

  test("a bad duration is refused at its path", () => {
    expect(errorsOf(variant("timeout: 20m", "timeout: 20 minutes")).join(" | ")).toContain(
      "steps[4].timeout: should be a duration like 30s, 20m or 12h",
    );
  });

  test("every error is reported at once, not one per round", () => {
    const broken = EXAMPLE.replace("goto: fix, max: 3", "goto: fx, max: 3")
      .replace("next: gate", "next: gatee")
      .replace("plan {{inputs.slug}}", "plan {{inputs.slugg}}");
    expect(errorsOf(broken).length).toBe(3);
  });

  test("an empty run: command is refused", () => {
    expect(errorsOf(variant("    run: bun run e2e", '    run: "  "'))).toContain(
      "steps[6].run: should not be empty",
    );
  });

  test("a workflow with no steps is refused", () => {
    expect(errorsOf("schemaVersion: 1\nname: x\nversion: 1\nsteps: []\n")[0]).toContain(
      "steps: Array must contain at least 1 element(s)",
    );
  });
});

describe("promptPathProblem", () => {
  test("accepts a plain relative path", () => {
    expect(promptPathProblem("prompts/plan.md")).toBeUndefined();
    expect(promptPathProblem("plan.md")).toBeUndefined();
  });

  test("refuses absolute paths, .. and empty segments", () => {
    expect(promptPathProblem("/etc/passwd")).toContain("absolute");
    expect(promptPathProblem("C:\\x.md")).toContain("absolute");
    expect(promptPathProblem("a/../b.md")).toContain("..");
    expect(promptPathProblem("a//b.md")).toContain("plain relative path");
    expect(promptPathProblem("  ")).toBe("should not be empty");
  });
});

describe("parseWorkflowDuration", () => {
  test("the three units", () => {
    expect(parseWorkflowDuration("30s")).toBe(30_000);
    expect(parseWorkflowDuration("20m")).toBe(1_200_000);
    expect(parseWorkflowDuration("12h")).toBe(43_200_000);
    expect(parseWorkflowDuration(" 5m ")).toBe(300_000);
  });

  test("anything else is null, never 0", () => {
    for (const bad of ["", "20", "20 d", "m", "-5m", "1.5h", "20ms"]) {
      expect(parseWorkflowDuration(bad)).toBeNull();
    }
  });
});

describe("renderTemplate", () => {
  const ctx = {
    inputs: { slug: "agent-workflows" },
    steps: { plan: { reason: "planned", report: "the plan" }, exec: { reason: "no report here" } },
  };

  test("substitutes inputs, reasons and reports", () => {
    expect(
      renderTemplate("{{inputs.slug}} / {{steps.plan.reason}} / {{steps.plan.report}}", ctx),
    ).toBe("agent-workflows / planned / the plan");
  });

  test("an unresolved reference renders empty, never the braces", () => {
    expect(renderTemplate("[{{steps.fix.report}}]", ctx)).toBe("[]");
    expect(renderTemplate("[{{inputs.nope}}]", ctx)).toBe("[]");
    expect(renderTemplate("[{{nonsense}}]", ctx)).toBe("[]");
  });

  test("tolerates inner spaces", () => {
    expect(renderTemplate("{{ inputs.slug }}", ctx)).toBe("agent-workflows");
  });
});

describe("workflowHash — an approval is bound to the exact bytes", () => {
  const hash = (text: string, prompts: { path: string; text: string }[] = []): string =>
    workflowHash(text, prompts, fakeHasher);

  test("identical bytes give an identical hash", () => {
    expect(hash(EXAMPLE)).toBe(hash(EXAMPLE));
    expect(hash(EXAMPLE)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("one byte of the YAML changes it", () => {
    expect(hash(EXAMPLE)).not.toBe(hash(`${EXAMPLE}\n`));
    expect(hash(EXAMPLE)).not.toBe(hash(EXAMPLE.replace("version: 3", "version: 4")));
  });

  test("one byte of ONE prompt file changes it", () => {
    const prompts = [
      { path: "prompts/a.md", text: "a" },
      { path: "prompts/b.md", text: "b" },
    ];
    expect(hash(EXAMPLE, prompts)).not.toBe(hash(EXAMPLE));
    expect(hash(EXAMPLE, prompts)).not.toBe(
      hash(EXAMPLE, [
        { path: "prompts/a.md", text: "a" },
        { path: "prompts/b.md", text: "b!" },
      ]),
    );
  });

  test("the path is part of the pre-image, and order does not matter", () => {
    const a = [
      { path: "prompts/a.md", text: "same" },
      { path: "prompts/b.md", text: "same" },
    ];
    expect(hash(EXAMPLE, a)).toBe(hash(EXAMPLE, [...a].reverse()));
    expect(hash(EXAMPLE, a)).not.toBe(hash(EXAMPLE, [{ path: "prompts/c.md", text: "same" }]));
  });

  test("a BOM is not part of the hash (the same file, one editor away)", () => {
    expect(hash(`\ufeff${EXAMPLE}`)).toBe(hash(EXAMPLE));
  });

  test("no hasher is a refusal, never a weaker hash", () => {
    // The phone has no `Bun.CryptoHasher` (its global is read-only here, so the
    // absence is passed in): hashing there must fail loudly, not fall back.
    expect(runtimeHasher()).toBeDefined();
    expect(() => workflowHash(EXAMPLE, [], null)).toThrow(/sha-256 hasher/);
  });

  test("shortHash is the first 8 characters", () => {
    expect(shortHash(`${"3f2a1b9c"}${"0".repeat(56)}`)).toBe("3f2a1b9c");
  });
});

/** A deterministic stand-in for sha-256: the tests above are about the PRE-IMAGE. */
function fakeHasher(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (const byte of bytes) {
    h = (h ^ byte) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0").repeat(8);
}
