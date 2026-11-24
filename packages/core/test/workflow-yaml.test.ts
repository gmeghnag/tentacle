/**
 * docs/feat/workflow-editor.md D1: the canonical emitter round-trips, the
 * validator split changes no behaviour, and `isCanonical` answers honestly.
 */
import { describe, expect, test } from "bun:test";
import {
  asDraft,
  isCanonical,
  validateWorkflow,
  validateWorkflowValue,
  workflowYaml,
} from "../src/index.ts";

/** Parse a YAML text the way the validator's caller does (Bun's runtime). */
function parse(text: string): unknown {
  const yaml = (globalThis as { Bun?: { YAML?: { parse(t: string): unknown } } }).Bun?.YAML;
  if (yaml === undefined) {
    throw new Error("this test needs Bun.YAML");
  }
  return yaml.parse(text);
}

/** Hold a string through the emitter, then parse it back. */
function roundTrip(draft: Record<string, unknown>): unknown {
  return parse(workflowYaml(draft));
}

const BASE = {
  schemaVersion: 1,
  name: "task",
  version: 3,
  steps: [{ id: "run", run: "bun run check" }],
} satisfies Record<string, unknown>;

describe("workflowYaml", () => {
  test("round-trips a plain workflow", () => {
    expect(roundTrip(BASE)).toEqual(BASE);
  });

  test("round-trips the full shape: description, inputs, budget, every step kind", () => {
    const draft = {
      schemaVersion: 1,
      name: "task",
      version: 2,
      description: "plan → exec → review",
      inputs: { slug: { required: true }, doc: { default: "" } },
      budget: { tokens: 3_000_000, wait: "4h", max_step_runs: 10 },
      steps: [
        {
          id: "plan",
          agent: {
            prompt_text: "plan {{inputs.slug}}",
            model: "opus",
            type: "general",
            tokens: 400_000,
          },
          retry: 1,
          on_fail: { goto: "fix", max: 3 },
          next: "gate",
        },
        {
          id: "exec",
          agent: { prompt: "prompts/exec.md", model: "deepseek" },
        },
        {
          id: "gate",
          run: "bun run check",
          where: { docker: "tentacle-ci" },
          timeout: "20m",
          retry: 0,
        },
        {
          id: "merge",
          approve: { title: "Merge {{inputs.slug}}", detail: "{{steps.plan.reason}}" },
        },
        { id: "local", run: "ls", where: "local" },
      ],
    };
    expect(roundTrip(draft)).toEqual(draft);
  });

  test("round-trips hostile strings", () => {
    // Every one of these is a string the emitter must quote, or YAML reads it as
    // a mapping, a comment, a tag, a boolean, a number or a folded block.
    const hostile = [
      "a: b",
      "trailing # comment",
      " # leading space then hash",
      "- dash start",
      "? question",
      "*anchor",
      "&alias",
      "!tag",
      "yes",
      "no",
      "null",
      "~",
      "1.0",
      "0x1f",
      "1e3",
      "true",
      "{{inputs.slug}}",
      '"already quoted"',
      "'single quoted'",
      "tab\there",
      "line with trailing spaces   ",
      "windows\r\nnewline",
      "😀 emoji",
      "",
      "  ",
      "multi\nline",
      "multi\nline\n",
      "a\n\nb",
      "a\n b",
      "a\nb ",
      "\na",
      "a\n\tb",
      "caf\u00e9\nna\u00efve",
      "{not: a flow mapping}",
      "[not: a flow list]",
      "% directive",
      "@reserved",
      "back\\slash",
      "col:on",
    ];
    for (const text of hostile) {
      const draft = { ...BASE, description: text };
      expect({ text, parsed: roundTrip(draft) }).toEqual({ text, parsed: draft });
    }
  });

  test("round-trips every control character, on one line and in a block (review r1 #2)", () => {
    const controls = [
      ...Array.from({ length: 0x20 }, (_v, i) => String.fromCharCode(i)),
      "\u007f",
      "\u0080",
      "\u0085",
      "\u009f",
      " ",
      " ",
      "﻿",
    ];
    for (const c of controls) {
      for (const text of [`a${c}b`, `l1\nb${c}`, `l1\n${c}b`, `${c}\nx`]) {
        const draft = { ...BASE, description: text, inputs: { [`k${c}`]: { default: text } } };
        const code = c.charCodeAt(0).toString(16);
        expect({ code, text, parsed: roundTrip(draft) }).toEqual({ code, text, parsed: draft });
      }
    }
  });

  test("refuses a lone surrogate loudly — YAML cannot hold one (review r1 #2)", () => {
    for (const bad of ["a\ud800b", "x\udc00", "l1\nb\ud83d"]) {
      expect(() => workflowYaml({ ...BASE, description: bad })).toThrow(
        "root.description: a lone UTF-16 surrogate cannot be written as YAML",
      );
      expect(() => workflowYaml({ ...BASE, inputs: { [bad]: { required: true } } })).toThrow(
        "a lone UTF-16 surrogate cannot be written as YAML",
      );
    }
    // A well-formed pair is a character like any other.
    const draft = { ...BASE, description: "l1\n😀" };
    expect(roundTrip(draft)).toEqual(draft);
  });

  test("omits the budget defaults, so a default typed in is the same file", () => {
    const withDefaults = { ...BASE, budget: { wait: "12h", max_step_runs: 50 } };
    expect(workflowYaml(withDefaults)).toBe(workflowYaml(BASE));
    expect(workflowYaml(withDefaults)).not.toContain("wait");
    expect(workflowYaml({ ...BASE, budget: { tokens: 5 } })).toContain("budget:");
  });

  test("writes keys in the schema's order, not the draft's", () => {
    const draft = {
      steps: [{ run: "bun run check", id: "gate", retry: 0, on_fail: { max: 2, goto: "fix" } }],
      version: 1,
      name: "task",
      schemaVersion: 1,
    };
    const lines = workflowYaml(draft).split("\n");
    expect(lines.slice(0, 3)).toEqual(["schemaVersion: 1", "name: task", "version: 1"]);
    const step = lines.findIndex((l) => l.startsWith("  - "));
    expect(lines.slice(step, step + 4)).toEqual([
      "  - id: gate",
      "    run: bun run check",
      "    retry: 0",
      "    on_fail:",
    ]);
    expect(lines[step + 4]).toBe("      goto: fix");
    expect(lines[step + 5]).toBe("      max: 2");
  });

  test("a safe multi-line prompt is a |- block; an unsafe one is quoted", () => {
    const safe = { ...BASE, description: "line one\nline two" };
    expect(workflowYaml(safe)).toContain("description: |-\n  line one\n  line two\n");
    const unsafe = { ...BASE, description: "line one\n\nline two" };
    expect(workflowYaml(unsafe)).not.toContain("|-");
    expect(roundTrip(unsafe)).toEqual(unsafe);
  });

  test("is deterministic and ends with one newline", () => {
    const once = workflowYaml(BASE);
    expect(workflowYaml(BASE)).toBe(once);
    expect(once.endsWith("\n")).toBe(true);
    expect(once.endsWith("\n\n")).toBe(false);
  });

  test("a workflow the validator accepts survives the round trip its spec equals", () => {
    const text = workflowYaml(BASE);
    expect(validateWorkflow(text).ok).toBe(true);
  });
});

describe("isCanonical", () => {
  test("is true on the emitter's own output", () => {
    expect(isCanonical(workflowYaml(BASE), BASE)).toBe(true);
  });

  test("ignores a BOM but not a comment", () => {
    expect(isCanonical(`\ufeff${workflowYaml(BASE)}`, BASE)).toBe(true);
    expect(isCanonical(`# mine\n${workflowYaml(BASE)}`, BASE)).toBe(false);
    expect(isCanonical(workflowYaml(BASE).replace(/\n/g, "\r\n"), BASE)).toBe(false);
  });
});

describe("asDraft", () => {
  test("accepts a structurally sound mapping", () => {
    expect(asDraft(BASE)).toEqual({ draft: BASE });
  });

  test("accepts a mapping with a dangling next — opening is not validating", () => {
    const draft = { ...BASE, steps: [{ id: "run", run: "ls", next: "gone" }] };
    expect(asDraft(draft)).toEqual({ draft });
  });

  test("refuses a non-mapping and a wrong-typed field", () => {
    for (const raw of [null, [], "text", 3]) {
      expect("unreadable" in asDraft(raw)).toBe(true);
    }
    expect("unreadable" in asDraft({ schemaVersion: 1, name: "task" })).toBe(true);
    expect("unreadable" in asDraft({ ...BASE, steps: [{ id: "run", run: 3 }] })).toBe(true);
    expect("unreadable" in asDraft({ ...BASE, surprise: 1 })).toBe(true);
  });

  test("opens a step with no kind: an empty kind is a problem to SEE, not a refusal", () => {
    const draft = { ...BASE, steps: [{ id: "s" }] };
    expect(asDraft(draft)).toEqual({ draft });
    expect(validateWorkflowValue(draft).ok).toBe(false);
  });

  test("drops a budget that was all defaults, so opening and saving is a no-op", () => {
    const raw = { ...BASE, budget: { wait: "12h", max_step_runs: 50 } };
    const result = asDraft(raw);
    if (!("draft" in result)) {
      throw new Error("expected a draft");
    }
    expect(result.draft.budget).toBeUndefined();
    expect(workflowYaml(result.draft)).toBe(workflowYaml(BASE));
    const partial = asDraft({ ...BASE, budget: { wait: "1h", max_step_runs: 50 } });
    if (!("draft" in partial)) {
      throw new Error("expected a draft");
    }
    expect(partial.draft.budget).toEqual({ wait: "1h" });
  });

  test("its refusal names what is wrong", () => {
    const result = asDraft({ ...BASE, steps: [{ id: 3 }] });
    if (!("unreadable" in result)) {
      throw new Error("expected a refusal");
    }
    expect(result.unreadable).toContain("steps[0].id");
  });
});

describe("validateWorkflowValue (the split)", () => {
  test("gives the same verdict as validateWorkflow on the emitted text", () => {
    const text = workflowYaml({
      ...BASE,
      steps: [{ id: "run", run: "" }],
    });
    const viaText = validateWorkflow(text);
    const viaValue = validateWorkflowValue(parse(text));
    expect(viaValue).toEqual(viaText);
    expect(viaText.ok).toBe(false);
  });

  test("refuses a non-mapping the way the text form does", () => {
    const result = validateWorkflowValue([]);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected a refusal");
    }
    expect(result.errors[0]).toContain("YAML mapping");
  });

  test("checks the file stem against ctx.name, exactly as before", () => {
    const result = validateWorkflowValue(BASE, { name: "other" });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected a refusal");
    }
    expect(result.errors[0]).toContain('should be "other"');
  });
});
