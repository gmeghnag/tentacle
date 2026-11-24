/**
 * docs/feat/workflow-editor.md D2: the draft edit operations. Each one is pure
 * and immutable, refuses what the plan names, and NEVER rewrites a reference the
 * user did not ask it to rewrite (delete leaves a target dangling and says so;
 * rename is the one op that follows the references, because the user named the
 * step). `draftProblems` is the daemon's own text, so the phone's bar and the
 * daemon's refusal cannot drift.
 */
import { describe, expect, test } from "bun:test";
import {
  EDIT_HISTORY_LIMIT,
  EditHistory,
  WORKFLOW_MAX_GOTO,
  WORKFLOW_MAX_RETRY,
  defaultPromptPath,
  deleteStep,
  draftProblems,
  duplicateStep,
  insertStep,
  moveStep,
  nextVersion,
  patchStep,
  renameStep,
  setFailTarget,
  setGotoMax,
  setNext,
  setPrompt,
  setRetry,
  stepIdFor,
  validateWorkflow,
  workflowYaml,
} from "../src/index.ts";

type Draft = Record<string, unknown>;

const stepsOf = (draft: Draft): Draft[] => (draft.steps as Draft[] | undefined) ?? [];
const idsOf = (draft: Draft): string[] => stepsOf(draft).map((step) => String(step.id));
const stepOf = (draft: Draft, id: string): Draft => {
  const found = stepsOf(draft).find((step) => step.id === id);
  if (found === undefined) {
    throw new Error(`no step ${id} in ${idsOf(draft).join(", ")}`);
  }
  return found;
};
const agentOf = (draft: Draft, id: string): Draft => stepOf(draft, id).agent as Draft;

/** Two steps, reached by fall-through: the shape `＋` on an edge inserts into. */
const plain = (): Draft => ({
  schemaVersion: 1,
  name: "task",
  version: 1,
  steps: [
    { id: "plan", agent: { prompt_text: "plan" } },
    { id: "gate", run: "bun run check" },
  ],
});

/** review ⇄ fix: an explicit `next` and a counted goto (the real loop shape). */
const loop = (): Draft => ({
  schemaVersion: 1,
  name: "task",
  version: 1,
  steps: [
    { id: "plan", agent: { prompt_text: "plan" } },
    {
      id: "review",
      agent: { prompt_text: "review" },
      next: "gate",
      on_fail: { goto: "fix", max: 2 },
    },
    { id: "fix", agent: { prompt_text: "fix" }, next: "review" },
    { id: "gate", run: "bun run check" },
  ],
});

/** A draft nobody can mutate: any write inside an op throws under strict mode. */
function deepFrozen(value: unknown): Draft {
  const walk = (item: unknown): unknown => {
    if (Array.isArray(item)) {
      return Object.freeze(item.map(walk));
    }
    if (item !== null && typeof item === "object") {
      return Object.freeze(
        Object.fromEntries(Object.entries(item).map(([key, inner]) => [key, walk(inner)])),
      );
    }
    return item;
  };
  return walk(value) as Draft;
}

describe("insertStep", () => {
  test("inserts on a fall-through edge without writing a next anywhere", () => {
    const before = plain();
    const out = insertStep(before, { after: "plan" }, "run");
    expect(idsOf(out.draft)).toEqual(["plan", "run", "gate"]);
    expect(stepOf(out.draft, "plan").next).toBeUndefined();
    expect(stepOf(out.draft, "run").next).toBeUndefined();
    expect(out.id).toBe("run");
    expect(out.refused).toBeUndefined();
    expect(idsOf(before)).toEqual(["plan", "gate"]);
  });

  test("splits an explicit next edge: A.next = S and S.next = the old target", () => {
    const out = insertStep(loop(), { after: "review" }, "agent");
    expect(idsOf(out.draft)).toEqual(["plan", "review", "agent", "fix", "gate"]);
    expect(stepOf(out.draft, "review").next).toBe("agent");
    expect(stepOf(out.draft, "agent").next).toBe("gate");
  });

  test("splits a redundant next edge (A.next = the step right after it)", () => {
    const draft = plain();
    const withNext = {
      ...draft,
      steps: [
        { id: "plan", agent: { prompt_text: "plan" }, next: "gate" },
        { id: "gate", run: "bun run check" },
      ],
    };
    const out = insertStep(withNext, { after: "plan" }, "run");
    expect(idsOf(out.draft)).toEqual(["plan", "run", "gate"]);
    expect(stepOf(out.draft, "plan").next).toBe("run");
    expect(stepOf(out.draft, "run").next).toBe("gate");
  });

  test("{end: true} appends a step with no next", () => {
    const out = insertStep(plain(), { end: true }, "approve");
    expect(idsOf(out.draft)).toEqual(["plan", "gate", "approve"]);
    expect(stepOf(out.draft, "approve").next).toBeUndefined();
  });

  test("each kind starts from its own empty body — a visible problem, not a placeholder", () => {
    const run = insertStep(plain(), { end: true }, "run").draft;
    expect(stepOf(run, "run")).toEqual({ id: "run", run: "" });
    const agent = insertStep(plain(), { end: true }, "agent").draft;
    expect(stepOf(agent, "agent")).toEqual({ id: "agent", agent: { prompt_text: "" } });
    const approve = insertStep(plain(), { end: true }, "approve").draft;
    expect(stepOf(approve, "approve")).toEqual({ id: "approve", approve: { title: "" } });
  });

  test("an empty run body IS a problem; an empty approve title too", () => {
    const runDraft = insertStep(plain(), { end: true }, "run").draft;
    expect(draftProblems(runDraft, {}, { name: "task" })).toEqual([
      "steps[2].run: should not be empty",
    ]);
    const approveDraft = insertStep(plain(), { end: true }, "approve").draft;
    expect(draftProblems(approveDraft, {}, { name: "task" })).toEqual([
      "steps[2].approve.title: should not be empty",
    ]);
  });

  test("the new id never collides", () => {
    const draft = plain();
    const once = insertStep(draft, { end: true }, "run").draft;
    expect(idsOf(once)).toEqual(["plan", "gate", "run"]);
    const twice = insertStep(
      { ...once, steps: [...stepsOf(once), { id: "run-2", run: "x" }] },
      { end: true },
      "run",
    ).draft;
    expect(idsOf(twice)).toEqual(["plan", "gate", "run", "run-2", "run-3"]);
  });

  test("refuses an anchor that is not a step", () => {
    const out = insertStep(plain(), { after: "nope" }, "run");
    expect(out.refused).toBe('no step "nope"');
    expect(idsOf(out.draft)).toEqual(["plan", "gate"]);
  });
});

describe("stepIdFor", () => {
  test("slugs the command's first meaningful word", () => {
    expect(stepIdFor("run", "bun run lint", [])).toBe("lint");
    expect(stepIdFor("run", "bun run check", [])).toBe("check");
    expect(stepIdFor("run", "git diff --stat", [])).toBe("git");
  });

  test("slugs a prompt file's stem", () => {
    expect(stepIdFor("agent", "prompts/review.md", [])).toBe("review");
    expect(stepIdFor("agent", "plan.md", [])).toBe("plan");
  });

  test("falls back to the kind, and is unique", () => {
    expect(stepIdFor("run", "", [])).toBe("run");
    expect(stepIdFor("approve", "  ", [])).toBe("approve");
    expect(stepIdFor("run", "bun run lint", ["lint"])).toBe("lint-2");
    expect(stepIdFor("run", "bun run lint", ["lint", "lint-2"])).toBe("lint-3");
  });

  test("always produces something the validator accepts as an id", () => {
    for (const seed of ["", "  ", "bun run lint", "Ünicode ✓", "-c", "123", "prompts/a.md"]) {
      expect(stepIdFor("run", seed, [])).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });
});

describe("setFailTarget", () => {
  test("refuses the step itself, with the mockup's words", () => {
    const out = setFailTarget(loop(), "review", "review");
    expect(out.refused).toBe("itself — use Retry");
    expect(stepOf(out.draft, "review").on_fail).toEqual({ goto: "fix", max: 2 });
  });

  test("keeps the current max, and defaults it to 1", () => {
    expect(stepOf(setFailTarget(loop(), "review", "gate").draft, "review").on_fail).toEqual({
      goto: "gate",
      max: 2,
    });
    expect(stepOf(setFailTarget(loop(), "plan", "fix").draft, "plan").on_fail).toEqual({
      goto: "fix",
      max: 1,
    });
  });

  test("clamps max to the validator's range", () => {
    expect(stepOf(setFailTarget(loop(), "review", "fix", 99).draft, "review").on_fail).toEqual({
      goto: "fix",
      max: WORKFLOW_MAX_GOTO,
    });
    expect(stepOf(setFailTarget(loop(), "review", "fix", 0).draft, "review").on_fail).toEqual({
      goto: "fix",
      max: 1,
    });
  });

  test('"stop" drops the key: the default never lands in the file', () => {
    const out = setFailTarget(loop(), "review", "stop");
    expect(stepOf(out.draft, "review").on_fail).toBeUndefined();
    expect("on_fail" in stepOf(out.draft, "review")).toBe(false);
  });

  test("refuses a target that is not a step", () => {
    expect(setFailTarget(loop(), "review", "nope").refused).toBe('no step "nope"');
    expect(setFailTarget(loop(), "nope", "fix").refused).toBe('no step "nope"');
  });
});

describe("setRetry / setGotoMax", () => {
  test("retry clamps to 0..WORKFLOW_MAX_RETRY, and 0 drops the key", () => {
    expect(stepOf(setRetry(loop(), "gate", 2).draft, "gate").retry).toBe(2);
    expect(stepOf(setRetry(loop(), "gate", 99).draft, "gate").retry).toBe(WORKFLOW_MAX_RETRY);
    expect(stepOf(setRetry(loop(), "gate", -4).draft, "gate").retry).toBeUndefined();
    expect(
      stepOf(setRetry(setRetry(loop(), "gate", 3).draft, "gate", 0).draft, "gate").retry,
    ).toBeUndefined();
  });

  test("goto max clamps to 1..WORKFLOW_MAX_GOTO and needs a goto to be on", () => {
    expect(stepOf(setGotoMax(loop(), "review", 7).draft, "review").on_fail).toEqual({
      goto: "fix",
      max: 7,
    });
    expect(stepOf(setGotoMax(loop(), "review", 99).draft, "review").on_fail).toEqual({
      goto: "fix",
      max: WORKFLOW_MAX_GOTO,
    });
    const none = setGotoMax(loop(), "plan", 3);
    expect(none.refused).toBe("no fail target — drop the ✗ port first");
    expect(stepOf(none.draft, "plan").on_fail).toBeUndefined();
  });
});

describe("setNext", () => {
  test("sets and clears an explicit next", () => {
    const set = setNext(loop(), "fix", "gate").draft;
    expect(stepOf(set, "fix").next).toBe("gate");
    const cleared = setNext(set, "fix", undefined).draft;
    expect("next" in stepOf(cleared, "fix")).toBe(false);
    expect(stepOf(cleared, "review").next).toBe("gate");
  });
});

describe("moveStep", () => {
  test("moves by ±1 and stops at the ends", () => {
    expect(idsOf(moveStep(loop(), "gate", -1).draft)).toEqual(["plan", "review", "gate", "fix"]);
    expect(idsOf(moveStep(loop(), "plan", 1).draft)).toEqual(["review", "plan", "fix", "gate"]);
    expect(idsOf(moveStep(loop(), "plan", -1).draft)).toEqual(["plan", "review", "fix", "gate"]);
    expect(idsOf(moveStep(loop(), "gate", 5).draft)).toEqual(["plan", "review", "fix", "gate"]);
  });

  test("refuses an unknown step", () => {
    expect(moveStep(loop(), "nope", 1).refused).toBe('no step "nope"');
  });
});

describe("duplicateStep", () => {
  test("copies the body right after the original, under a fresh id", () => {
    const out = duplicateStep(loop(), "gate");
    expect(idsOf(out.draft)).toEqual(["plan", "review", "fix", "gate", "gate-2"]);
    expect(stepOf(out.draft, "gate-2").run).toBe("bun run check");
    expect(out.id).toBe("gate-2");
  });
});

describe("renameStep", () => {
  test("rewrites every next / on_fail.goto reference — the user named the step", () => {
    const out = renameStep(loop(), "fix", "repair");
    expect(out.refused).toBeUndefined();
    expect(idsOf(out.draft)).toEqual(["plan", "review", "repair", "gate"]);
    expect(stepOf(out.draft, "review").on_fail).toEqual({ goto: "repair", max: 2 });
    expect(stepOf(out.draft, "repair").next).toBe("review");
  });

  test("refuses an id the validator would reject, a taken id and an unknown step", () => {
    expect(renameStep(loop(), "fix", "Bad Id").refused).toBe(
      '"Bad Id" is not a step id — lowercase letters, digits and single hyphens',
    );
    expect(renameStep(loop(), "fix", "gate").refused).toBe('"gate" is already a step');
    expect(renameStep(loop(), "nope", "x").refused).toBe('no step "nope"');
  });

  test("renaming a step to its own id is a no-op", () => {
    const draft = loop();
    const out = renameStep(draft, "fix", "fix");
    expect(out.refused).toBeUndefined();
    expect(out.draft).toEqual(draft);
  });
});

describe("deleteStep", () => {
  test("leaves the references dangling and reports them — never rewrites them", () => {
    const out = deleteStep(loop(), "fix");
    expect(idsOf(out.draft)).toEqual(["plan", "review", "gate"]);
    expect(stepOf(out.draft, "review").on_fail).toEqual({ goto: "fix", max: 2 });
    expect(out.dangling).toEqual(["review"]);
  });

  test("reports every step that still points at it, in draft order", () => {
    const draft: Draft = {
      schemaVersion: 1,
      name: "task",
      version: 1,
      steps: [
        { id: "a", run: "a", next: "gone" },
        { id: "b", run: "b", on_fail: { goto: "gone", max: 1 } },
        { id: "gone", run: "gone" },
      ],
    };
    expect(deleteStep(draft, "gone").dangling).toEqual(["a", "b"]);
  });

  test("no dangling refs, an empty list; an unknown step is refused", () => {
    expect(deleteStep(loop(), "plan").dangling).toEqual([]);
    // `review.next: gate` names it, so deleting the gate leaves one.
    expect(deleteStep(loop(), "gate").dangling).toEqual(["review"]);
    const missing = deleteStep(loop(), "nope");
    expect(missing.refused).toBe('no step "nope"');
    expect(missing.dangling).toBeUndefined();
  });
});

describe("patchStep", () => {
  test("a run step's command, target and timeout", () => {
    const out = patchStep(loop(), "gate", {
      kind: "run",
      run: "bun test",
      where: { docker: "box" },
      timeout: "30m",
    }).draft;
    expect(stepOf(out, "gate")).toEqual({
      id: "gate",
      run: "bun test",
      where: { docker: "box" },
      timeout: "30m",
    });
  });

  test('where: "local" and a null timeout drop their keys', () => {
    const withBoth = patchStep(loop(), "gate", {
      kind: "run",
      where: { docker: "box" },
      timeout: "30m",
    }).draft;
    const out = patchStep(withBoth, "gate", { kind: "run", where: "local", timeout: null }).draft;
    expect(stepOf(out, "gate")).toEqual({ id: "gate", run: "bun run check" });
  });

  test("an agent step switches between prompt file and inline, never both", () => {
    const inline = patchStep(loop(), "review", { kind: "agent", promptPath: "prompts/r.md" }).draft;
    expect(agentOf(inline, "review")).toEqual({ prompt: "prompts/r.md" });
    const back = patchStep(inline, "review", { kind: "agent", promptText: "inline" }).draft;
    expect(agentOf(back, "review")).toEqual({ prompt_text: "inline" });
  });

  test("agent pickers set and clear model / type / tokens", () => {
    const set = patchStep(loop(), "review", {
      kind: "agent",
      model: "opus",
      type: "general",
      tokens: 400_000,
    }).draft;
    expect(agentOf(set, "review")).toEqual({
      prompt_text: "review",
      model: "opus",
      type: "general",
      tokens: 400_000,
    });
    const cleared = patchStep(set, "review", {
      kind: "agent",
      model: null,
      type: null,
      tokens: null,
    }).draft;
    expect(agentOf(cleared, "review")).toEqual({ prompt_text: "review" });
  });

  test("an approve step's title and detail", () => {
    const draft = insertStep(plain(), { end: true }, "approve").draft;
    const out = patchStep(draft, "approve", {
      kind: "approve",
      title: "Merge?",
      detail: "go",
    }).draft;
    expect(stepOf(out, "approve")).toEqual({
      id: "approve",
      approve: { title: "Merge?", detail: "go" },
    });
    const cleared = patchStep(out, "approve", { kind: "approve", detail: null }).draft;
    expect(stepOf(cleared, "approve")).toEqual({ id: "approve", approve: { title: "Merge?" } });
  });

  test("a kind mismatch is refused, and no other step is touched", () => {
    const before = loop();
    const out = patchStep(before, "gate", { kind: "agent", promptText: "x" });
    expect(out.refused).toBe('"gate" is not an agent step');
    expect(out.draft).toEqual(before);
    expect(patchStep(loop(), "review", { kind: "run", run: "x" }).refused).toBe(
      '"review" is not a run step',
    );
    expect(patchStep(loop(), "nope", { kind: "run", run: "x" }).refused).toBe('no step "nope"');
  });
});

describe("setPrompt", () => {
  test("switches an agent step to a prompt file and back", () => {
    const toFile = setPrompt(loop(), "fix", { path: "prompts/fix.md" }).draft;
    expect(agentOf(toFile, "fix")).toEqual({ prompt: "prompts/fix.md" });
    const toText = setPrompt(toFile, "fix", { text: "fix it" }).draft;
    expect(agentOf(toText, "fix")).toEqual({ prompt_text: "fix it" });
  });

  test("the default path a step's prompt sheet opens with is prompts/<id>.md", () => {
    expect(defaultPromptPath("review")).toBe("prompts/review.md");
    // The rule and the validator agree: the default the sheet shows is accepted.
    expect(setPrompt(loop(), "fix", { path: defaultPromptPath("fix") }).refused).toBeUndefined();
  });

  test("refuses a path that is absolute, has .., or is not markdown", () => {
    expect(setPrompt(loop(), "fix", { path: "/etc/x.md" }).refused).toContain("should be relative");
    expect(setPrompt(loop(), "fix", { path: "../x.md" }).refused).toContain("remove the ..");
    expect(setPrompt(loop(), "fix", { path: "prompts/x.txt" }).refused).toContain(
      "should end with .md",
    );
  });

  test("refuses a run step", () => {
    expect(setPrompt(loop(), "gate", { path: "prompts/x.md" }).refused).toBe(
      '"gate" is not an agent step',
    );
  });
});

describe("draftProblems", () => {
  test("is the daemon's own text, word for word, over the emitted YAML", () => {
    const draft: Draft = {
      schemaVersion: 1,
      name: "task",
      version: 1,
      steps: [
        { id: "plan", agent: { prompt: "prompts/plan.md" }, next: "gone" },
        { id: "gate", run: "" },
      ],
    };
    const prompts = { "prompts/plan.md": "plan {{inputs.nope}}" };
    const direct = draftProblems(draft, prompts, { name: "task" });
    const viaText = validateWorkflow(workflowYaml(draft), {
      name: "task",
      readPrompt: (path) => prompts[path as keyof typeof prompts],
    });
    expect(direct.length).toBeGreaterThan(1);
    expect(direct).toEqual(viaText.ok ? [] : viaText.errors);
  });

  test("a clean draft has no problems", () => {
    expect(draftProblems(loop(), {}, { name: "task" })).toEqual([]);
  });

  test("a deleted step's dangling refs are problems, not refusals — the file still opens", () => {
    const out = deleteStep(loop(), "gate");
    const problems = draftProblems(out.draft, {}, { name: "task" });
    // The step is gone, so the editor keeps going and the bar names the ref.
    expect(problems.some((p) => p.includes('no step "gate"'))).toBe(true);
  });

  test("a referenced prompt file with no text is missing (readPrompt is wired)", () => {
    const draft = setPrompt(loop(), "fix", { path: "prompts/fix.md" }).draft;
    expect(draftProblems(draft, {}, { name: "task" })).toContain(
      'steps[2].agent.prompt: no file "prompts/fix.md" under .tentacle/workflows/',
    );
    expect(draftProblems(draft, { "prompts/fix.md": "fix it" }, { name: "task" })).toEqual([]);
  });
});

describe("EditHistory", () => {
  test("push / undo / redo walk the stack and redo is dropped by a new push", () => {
    const history = new EditHistory("a");
    expect(history.current).toBe("a");
    expect(history.canUndo).toBe(false);
    history.push("b");
    history.push("c");
    expect(history.undo()).toBe("b");
    expect(history.undo()).toBe("a");
    expect(history.undo()).toBeUndefined();
    expect(history.redo()).toBe("b");
    history.push("d");
    expect(history.canRedo).toBe(false);
    expect(history.current).toBe("d");
    // The redo tail was dropped: the state under `d` is `b`, not the `c` undone.
    expect(history.undo()).toBe("b");
  });

  test("is capped at EDIT_HISTORY_LIMIT states, newest kept", () => {
    const history = new EditHistory(0, EDIT_HISTORY_LIMIT);
    for (let i = 1; i <= EDIT_HISTORY_LIMIT + 10; i++) {
      history.push(i);
    }
    expect(history.size).toBe(EDIT_HISTORY_LIMIT);
    expect(history.current).toBe(EDIT_HISTORY_LIMIT + 10);
    for (let i = 0; i < EDIT_HISTORY_LIMIT - 1; i++) {
      history.undo();
    }
    expect(history.current).toBe(11);
    expect(history.undo()).toBeUndefined();
  });
});

describe("nextVersion", () => {
  test("bumps a loaded file's version by one, never below 1", () => {
    expect(nextVersion(1)).toBe(2);
    expect(nextVersion(7)).toBe(8);
    expect(nextVersion(0)).toBe(1);
    expect(nextVersion(1.7)).toBe(2);
    expect(nextVersion(Number.NaN)).toBe(1);
  });
});

describe("purity", () => {
  test("no operation mutates the draft it was handed", () => {
    const draft = deepFrozen(loop());
    const quiet = [
      () => insertStep(draft, { after: "review" }, "agent"),
      () => insertStep(draft, { end: true }, "run"),
      () => duplicateStep(draft, "gate"),
      () => moveStep(draft, "gate", -1),
      () => deleteStep(draft, "fix"),
      () => renameStep(draft, "fix", "repair"),
      () => setFailTarget(draft, "review", "plan"),
      () => setRetry(draft, "gate", 3),
      () => setGotoMax(draft, "review", 4),
      () => setNext(draft, "fix", "gate"),
      () => patchStep(draft, "gate", { kind: "run", run: "x" }),
      () => setPrompt(draft, "fix", { path: "prompts/fix.md" }),
    ];
    for (const op of quiet) {
      expect(() => op()).not.toThrow();
    }
    // The frozen original is still exactly what it was.
    expect(idsOf(draft)).toEqual(["plan", "review", "fix", "gate"]);
    expect(stepOf(draft, "review").on_fail).toEqual({ goto: "fix", max: 2 });
  });
});
