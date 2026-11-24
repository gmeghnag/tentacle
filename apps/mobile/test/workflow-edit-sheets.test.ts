/**
 * The editor's sheets as data (docs/feat/workflow-editor.md D8, slice 7b). Each
 * test names the property it kills, and every one of them is a rule a renderer
 * cannot see: which sheet a gesture opens, what a control ends in, and what the
 * sheet REFUSES to guess.
 */
import { describe, expect, test } from "bun:test";
import type { WorkflowDraft } from "@tentacle/core";
import { draftProblems } from "@tentacle/core";
import {
  type SheetAction,
  type SheetActions,
  type SheetModel,
  type SheetRequest,
  afterSheet,
  applySheetAction,
  choiceAction,
  kindSheet,
  maxSheet,
  pickOpens,
  pickSheet,
  segmentAction,
  settingsSheet,
  sheetAfterAction,
  sheetForIntent,
  sheetForLabel,
  sheetModel,
  stepped,
  stepperAction,
  textAction,
  withDescription,
  withInput,
} from "../src/workflow-edit-sheets.ts";

const DRAFT: WorkflowDraft = {
  schemaVersion: 1,
  name: "task",
  version: 1,
  description: "plan → exec → gate",
  inputs: { slug: { required: true }, doc: { required: false, default: "" } },
  steps: [
    { id: "plan", agent: { prompt: "prompts/plan.md", model: "opus" } },
    {
      id: "exec",
      run: "bun run lint",
      where: { docker: "node" },
      timeout: "5m",
      retry: 1,
      on_fail: { goto: "plan", max: 2 },
      next: "gate",
    },
    { id: "gate", approve: { title: "Merge {{inputs.slug}}" } },
  ],
};

const PROMPTS = { "prompts/plan.md": "Read the task and write the plan." };

/** Every controller call a sheet makes, recorded in order. */
function spy(): { readonly actions: SheetActions; readonly calls: readonly string[] } {
  const calls: string[] = [];
  const actions: SheetActions = {
    insert: (at, kind) => calls.push(`insert ${JSON.stringify(at)} ${kind}`),
    patch: (id, patch) => calls.push(`patch ${id} ${JSON.stringify(patch)}`),
    rename: (id, to) => calls.push(`rename ${id} ${to}`),
    prompt: (id, prompt) => calls.push(`prompt ${id} ${JSON.stringify(prompt)}`),
    setRetry: (id, retry) => calls.push(`retry ${id} ${retry}`),
    setFail: (id, target, max) => calls.push(`setFail ${id} ${target} ${max ?? ""}`),
    setGotoMax: (id, max) => calls.push(`gotoMax ${id} ${max}`),
    setNext: (id, target) => calls.push(`setNext ${id} ${target ?? ""}`),
    edit: (change) => {
      const result = change(DRAFT, {});
      calls.push(`edit ${JSON.stringify(result.draft.description ?? result.draft.inputs)}`);
    },
  };
  return { actions, calls };
}

/** The field with this key, from any section. */
function field(model: SheetModel, key: string) {
  for (const section of model.sections) {
    for (const candidate of section.fields) {
      if (candidate.key === key) {
        return candidate;
      }
    }
  }
  return undefined;
}

describe("which sheet a gesture opens", () => {
  test("`＋` opens the kind picker, at the edge it was tapped on", () => {
    const at = { after: "exec" } as const;
    expect(sheetForIntent({ kind: "insert", at })).toEqual({ kind: "kind", at });
    expect(sheetForIntent({ kind: "insert", at: { end: true } })).toEqual({
      kind: "kind",
      at: { end: true },
    });
  });

  test("a step opens its own sheet; its `✗` label opens the COUNTER", () => {
    // The mockup: tapping the dashed `✗ ×2` link asks "at most how many times",
    // not "what runs here" — a step's body is not what the label is about.
    expect(sheetForIntent({ kind: "open", id: "exec" })).toEqual({ kind: "step", id: "exec" });
    expect(sheetForIntent({ kind: "open", id: "exec", which: "fail" })).toEqual({
      kind: "max",
      id: "exec",
    });
    // `next` / `retry` labels belong to the step's own sheet (its Next row and
    // its retry stepper), never to a second copy of those controls.
    expect(sheetForLabel("exec", "next")).toEqual({ kind: "step", id: "exec" });
    expect(sheetForLabel("exec", "retry")).toEqual({ kind: "step", id: "exec" });
  });

  test("a gesture that completes on the canvas opens nothing", () => {
    // A drop, a menu row, a delete: none of them is a sheet. A stray sheet here
    // would cover the graph exactly when the person is manipulating it.
    for (const intent of [
      { kind: "none" },
      { kind: "duplicate", id: "exec" },
      { kind: "move", id: "exec", by: 1 },
      { kind: "remove", id: "exec" },
      { kind: "saveFail", id: "exec", target: "plan" },
    ] as const) {
      expect(sheetForIntent(intent)).toBeNull();
    }
  });
});

describe("the kind picker", () => {
  test("three kinds, one line each, and it says where the step goes", () => {
    const model = kindSheet(DRAFT, { after: "exec" });
    const kinds = field(model, "kind");
    expect(kinds?.control).toBe("choice");
    if (kinds?.control !== "choice") {
      throw new Error("expected a choice field");
    }
    expect(kinds.options.map((o) => o.value)).toEqual(["agent", "run", "approve"]);
    expect(kinds.options.every((o) => o.sub !== null)).toBe(true);
    // The footnote names the edge the step lands on (exec → gate).
    expect(model.sections[0]?.foot).toBe("It goes between exec and gate.");
    expect(model.detent).toBe("medium");
  });

  test("picking a kind inserts THAT kind at that edge, and nothing else", () => {
    const model = kindSheet(DRAFT, { after: "exec" });
    const { actions, calls } = spy();
    applySheetAction(actions, choiceAction(model, "kind", "run"));
    expect(calls).toEqual(['insert {"after":"exec"} run']);
  });

  test("a kind the sheet does not offer inserts nothing (never a guessed body)", () => {
    const model = kindSheet(DRAFT, { end: true });
    expect(choiceAction(model, "kind", "http")).toBeNull();
  });
});

describe("the step sheet, per kind", () => {
  const sheet = (id: string, extra: Record<string, unknown> = {}) =>
    sheetModel({
      request: { kind: "step", id },
      draft: DRAFT,
      prompts: PROMPTS,
      models: ["opus", "sonnet"],
      agentTypes: ["general"],
      notice: null,
      ...extra,
    });

  test("a run step shows its command, id, where, timeout — read from the file", () => {
    const model = sheet("exec");
    expect(model).not.toBeNull();
    const run = field(model as SheetModel, "run");
    expect(run?.control === "text" && run.value).toBe("bun run lint");
    const where = field(model as SheetModel, "where");
    expect(where?.control === "segmented" && where.options[1]?.on).toBe(true);
    expect(field(model as SheetModel, "docker")?.control).toBe("text");
    expect(
      field(model as SheetModel, "timeout")?.control === "text" &&
        field(model as SheetModel, "timeout"),
    ).toMatchObject({ value: "5m" });
  });

  test("an agent step offers the session's models ONLY, plus the default", () => {
    const model = sheet("plan") as SheetModel;
    const picker = field(model, "model");
    if (picker?.control !== "choice") {
      throw new Error("expected the model choice");
    }
    // The last option is the session's default: an agent step may name no model.
    expect(picker.options.map((o) => o.value)).toEqual(["opus", "sonnet", ""]);
    expect(picker.options[0]?.on).toBe(true);
    // The prompt is shown as the FILE it is, with its first line as the preview.
    const path = field(model, "promptPath");
    expect(path?.control === "text" && path.value).toBe("prompts/plan.md");
    expect(path?.control === "text" && path.sub).toBe("Read the task and write the plan.");
  });

  test("an approve step shows its title and detail", () => {
    const model = sheet("gate") as SheetModel;
    expect(field(model, "title")?.control).toBe("text");
    expect(field(model, "detail")?.control).toBe("text");
  });

  test("no such step: no sheet at all (never an empty one)", () => {
    expect(sheet("gone")).toBeNull();
  });

  test("the failure block: Stop hides the target rows, Go to step shows them", () => {
    const withGoto = sheet("exec") as SheetModel;
    expect(field(withGoto, "retry")).toMatchObject({ value: 1, min: 0, max: 5 });
    expect(field(withGoto, "goto")).toMatchObject({ value: "plan" });
    expect(field(withGoto, "max")).toMatchObject({ value: 2, min: 1, max: 10 });
    const stopping = sheetModel({
      request: { kind: "step", id: "plan" },
      draft: DRAFT,
      prompts: PROMPTS,
      notice: null,
    }) as SheetModel;
    expect(field(stopping, "goto")).toBeUndefined();
    expect(field(stopping, "max")).toBeUndefined();
    const then = field(stopping, "then");
    expect(then?.control === "segmented" && then.options[0]?.on).toBe(true);
  });

  test("every control ends in exactly ONE controller call, and the right one", () => {
    const run = sheet("exec") as SheetModel;
    const agentStep = sheet("plan") as SheetModel;
    const { actions, calls } = spy();
    applySheetAction(actions, textAction(run, "run", "bun run build"));
    applySheetAction(actions, textAction(run, "timeout", "10m"));
    applySheetAction(actions, stepperAction(run, "retry", 1));
    applySheetAction(actions, stepperAction(run, "max", -1));
    applySheetAction(actions, segmentAction(run, "then", "Stop"));
    applySheetAction(actions, choiceAction(agentStep, "model", "sonnet"));
    expect(calls).toEqual([
      'patch exec {"kind":"run","run":"bun run build"}',
      'patch exec {"kind":"run","timeout":"10m"}',
      "retry exec 2",
      "gotoMax exec 1",
      "setFail exec stop ",
      'patch plan {"kind":"agent","model":"sonnet"}',
    ]);
  });

  test("a control the sheet does not have does nothing at all", () => {
    // The `max` stepper is absent while the step stops: a stepper that is not
    // drawn must not be able to change the file anyway.
    const stopping = sheetModel({
      request: { kind: "step", id: "plan" },
      draft: DRAFT,
      prompts: PROMPTS,
      notice: null,
    }) as SheetModel;
    const { actions, calls } = spy();
    applySheetAction(actions, stepperAction(stopping, "max", 1));
    applySheetAction(actions, textAction(stopping, "docker", "node"));
    applySheetAction(actions, choiceAction(stopping, "target", "exec"));
    expect(calls).toEqual([]);
  });

  test("the steppers stop at the validator's own range", () => {
    expect(stepped(0, 0, 5, -1)).toBe(0);
    expect(stepped(5, 0, 5, 1)).toBe(5);
    const model = sheet("exec") as SheetModel;
    const { actions, calls } = spy();
    // max is 2 in the file: +1 then the clamp at 10 is the module's, not the UI's.
    for (let i = 0; i < 12; i += 1) {
      const current = maxSheet(DRAFT, "exec") as SheetModel;
      applySheetAction(actions, stepperAction(current, "max", 1));
      void model;
    }
    expect(calls).toContain("gotoMax exec 3");
  });
});

describe("refusals: the sheet never guesses", () => {
  const model = sheetModel({
    request: { kind: "step", id: "exec" },
    draft: DRAFT,
    prompts: PROMPTS,
    notice: null,
  }) as SheetModel;
  // A field belongs to the sheet of the kind that owns it: `tokens` is an agent
  // step's, `detail` an approve step's. Asking a RUN step's sheet for them sends
  // nothing at all — the same guard that stops a stale control.
  const agentStep = sheetModel({
    request: { kind: "step", id: "plan" },
    draft: DRAFT,
    prompts: PROMPTS,
    notice: null,
  }) as SheetModel;
  const approveStep = sheetModel({
    request: { kind: "step", id: "gate" },
    draft: DRAFT,
    prompts: PROMPTS,
    notice: null,
  }) as SheetModel;

  test("a timeout that is not a duration sends nothing (the validator's own range)", () => {
    // Guessing "5" as 5 minutes would write a number the file cannot hold; the
    // field stays as the file has it until a person types a duration.
    expect(textAction(model, "timeout", "5")).toBeNull();
    expect(textAction(model, "timeout", "5x")).toBeNull();
  });

  test("an empty optional field DROPS the key, never writes it empty", () => {
    expect(textAction(model, "timeout", "")).toEqual({
      do: "patch",
      id: "exec",
      patch: { kind: "run", timeout: null },
    });
    expect(textAction(agentStep, "tokens", "")).toEqual({
      do: "patch",
      id: "plan",
      patch: { kind: "agent", tokens: null },
    });
    expect(textAction(approveStep, "detail", "")).toEqual({
      do: "patch",
      id: "gate",
      patch: { kind: "approve", detail: null },
    });
  });

  test("an unchanged id renames nothing (a rename rewrites every reference)", () => {
    expect(textAction(model, "id", "exec")).toBeNull();
    expect(textAction(model, "id", "  ")).toBeNull();
    expect(textAction(model, "id", "lint")).toEqual({ do: "rename", id: "exec", to: "lint" });
  });

  test("`Go to step` with no target picked yet sets no fail target", () => {
    // The step stops today: re-segmenting must not write `on_fail` naming the
    // empty string, which the validator would refuse on a line nobody sees.
    const stopping = sheetModel({
      request: { kind: "step", id: "plan" },
      draft: DRAFT,
      prompts: PROMPTS,
      notice: null,
    }) as SheetModel;
    const { actions, calls } = spy();
    applySheetAction(actions, segmentAction(stopping, "then", "Go to step"));
    expect(calls).toEqual([]);
  });

  test("a token cap that is not a positive whole number sends nothing", () => {
    expect(textAction(agentStep, "tokens", "0")).toBeNull();
    expect(textAction(agentStep, "tokens", "1.5")).toBeNull();
    expect(textAction(agentStep, "tokens", "12000")).toEqual({
      do: "patch",
      id: "plan",
      patch: { kind: "agent", tokens: 12000 },
    });
  });

  test("an input name the file cannot reference is refused by the CORE, not renamed", () => {
    const result = withInput(DRAFT, "my slug", { required: true });
    expect(result.draft).toBe(DRAFT);
    expect(result.refused).toContain("is not an input name");
  });
});

describe("the goto picker", () => {
  test("the draft's own order, and the step itself is drawn DIM with its reason", () => {
    const model = pickSheet({ draft: DRAFT, id: "exec", purpose: "fail" }) as SheetModel;
    const target = field(model, "target");
    if (target?.control !== "choice") {
      throw new Error("expected the target choice");
    }
    // plan (above), gate (below), then exec itself: never hidden, always off.
    expect(target.options.map((o) => o.label)).toEqual(["plan", "gate", "exec"]);
    expect(target.options.map((o) => o.off)).toEqual([false, false, true]);
    expect(target.options[2]?.sub).toBe("itself — use Retry instead");
    expect(model.title).toBe("If exec fails, go to");
  });

  test("picking one sets the fail target (the core still owns the self-refusal)", () => {
    const model = pickSheet({ draft: DRAFT, id: "exec", purpose: "fail" }) as SheetModel;
    const { actions, calls } = spy();
    applySheetAction(actions, choiceAction(model, "target", "gate"));
    expect(calls).toEqual(["setFail exec gate "]);
    expect(choiceAction(model, "target", "")).toBeNull();
  });

  test("the `next` picker also offers the default, which DROPS the key", () => {
    const model = pickSheet({ draft: DRAFT, id: "exec", purpose: "next" }) as SheetModel;
    const target = field(model, "target");
    if (target?.control !== "choice") {
      throw new Error("expected the target choice");
    }
    expect(target.options.map((o) => o.label)).toEqual(["The step below", "plan", "gate"]);
    const { actions, calls } = spy();
    applySheetAction(actions, choiceAction(model, "target", ""));
    applySheetAction(actions, choiceAction(model, "target", "gate"));
    expect(calls).toEqual(["setNext exec ", "setNext exec gate"]);
  });

  test("the step itself cannot be picked: the DIM row writes nothing (the guard is here, not the render)", () => {
    // Drawn dim is an affordance; `choiceAction` is what keeps the file honest. A
    // stale render (or a screen that forgot `disabled`) must still not write `exec`.
    const model = pickSheet({ draft: DRAFT, id: "exec", purpose: "fail" }) as SheetModel;
    const { actions, calls } = spy();
    applySheetAction(actions, choiceAction(model, "target", "exec"));
    expect(calls).toEqual([]);
  });

  test("a step that is gone opens no picker", () => {
    expect(pickSheet({ draft: DRAFT, id: "gone", purpose: "fail" })).toBeNull();
  });
});

describe("the max sheet", () => {
  test("it counts the loop of a step that HAS a fail target", () => {
    const model = maxSheet(DRAFT, "exec") as SheetModel;
    expect(model.title).toBe("exec fails → plan");
    expect(model.detent).toBe("short");
    expect(field(model, "max")).toMatchObject({ value: 2, min: 1, max: 10 });
  });

  test("a step with no `✗` link has no counter to show", () => {
    expect(maxSheet(DRAFT, "plan")).toBeNull();
    expect(maxSheet(DRAFT, "gone")).toBeNull();
  });
});

describe("workflow Settings", () => {
  test("name, version, description, the inputs and a CLOSED budget", () => {
    const model = settingsSheet(DRAFT);
    expect(field(model, "name")?.control).toBe("value");
    expect(field(model, "version")?.control).toBe("value");
    expect(field(model, "description")?.control).toBe("text");
    // An input renders as its kind switch, and a defaulted one shows its value.
    expect(field(model, "input-required:slug")?.control).toBe("segmented");
    expect(field(model, "input-default:doc")?.control).toBe("text");
    expect(field(model, "input-default:slug")).toBeUndefined();
    // The budget is read-only and says "default": a default is never written.
    const tokens = field(model, "budget-tokens");
    expect(tokens?.control === "value" && tokens.value).toBe("default");
  });

  test("a description edit reaches the draft, and blank DROPS the key", () => {
    expect(withDescription(DRAFT, "  ").draft.description).toBeUndefined();
    expect(withDescription(DRAFT, "new words").draft.description).toBe("new words");
    const model = settingsSheet(DRAFT);
    const { actions, calls } = spy();
    applySheetAction(actions, textAction(model, "description", "new words"));
    expect(calls).toEqual(['edit "new words"']);
  });

  test("an input is required OR has a default, never both (the validator's rule)", () => {
    // The one property that would otherwise only fail on the daemon.
    const asDefault = withInput(DRAFT, "slug", { default: "x" }).draft;
    expect(asDefault.inputs).toEqual({
      slug: { required: false, default: "x" },
      doc: { required: false, default: "" },
    });
    const problems = draftProblems(asDefault, PROMPTS);
    expect(problems.filter((line) => line.startsWith("inputs.slug"))).toEqual([]);
    // A new input starts required, which is what the sheet's `Add input` sends.
    const added = withInput(DRAFT, "branch", { required: true }).draft;
    expect(added.inputs).toEqual({
      slug: { required: true },
      doc: { required: false, default: "" },
      branch: { required: true },
    });
  });

  test("removing the last input drops `inputs:` rather than writing an empty map", () => {
    const one = { ...DRAFT, inputs: { slug: { required: true } } };
    const result = withInput(one, "slug", null);
    expect(result.draft.inputs).toBeUndefined();
    expect(withInput(DRAFT, "nope", null).refused).toBe('no input "nope"');
  });
});

describe("the pick row and the sheet gate", () => {
  test("a `pick` row hands back the picker it opens (the route never guesses)", () => {
    const model = sheetModel({
      request: { kind: "step", id: "exec" },
      draft: DRAFT,
      prompts: PROMPTS,
      notice: null,
    }) as SheetModel;
    expect(pickOpens(model, "goto")).toEqual({ kind: "pick", id: "exec", purpose: "fail" });
    expect(pickOpens(model, "next")).toEqual({ kind: "pick", id: "exec", purpose: "next" });
    expect(pickOpens(model, "run")).toBeNull();
  });

  test("the controller's refusal is carried verbatim: the sheet says why it did nothing", () => {
    const model = sheetModel({
      request: { kind: "step", id: "exec" },
      draft: DRAFT,
      prompts: PROMPTS,
      notice: "itself — use Retry",
    }) as SheetModel;
    expect(model.note).toBe("itself — use Retry");
  });

  test("an action is carried out ONCE, and a null one never touches the controller", () => {
    const { actions, calls } = spy();
    const action: SheetAction = { do: "retry", id: "exec", retry: 3 };
    applySheetAction(actions, action);
    applySheetAction(actions, null);
    expect(calls).toEqual(["retry exec 3"]);
  });
});

describe("where a sheet goes after a control fires", () => {
  const step: SheetRequest = { kind: "step", id: "exec" };

  test("a refusal leaves the sheet UP: its words are read where the field is", () => {
    // A timeout that is not a duration, an empty docker name, a duplicate rename:
    // each is `null`, and the controller's `notice` is the sentence on the sheet.
    // Closing on a refusal would take the sentence away with it.
    expect(sheetAfterAction(step, null)).toEqual(step);
  });

  test("a stepper press or a tick stays inside its own sheet", () => {
    // The mockup's `− 2 +` is pressed repeatedly; dismissing after one press would
    // make the second impossible.
    expect(sheetAfterAction(step, { do: "retry", id: "exec", retry: 2 })).toEqual(step);
    expect(sheetAfterAction(step, { do: "gotoMax", id: "exec", max: 3 })).toEqual(step);
    expect(
      sheetAfterAction(step, { do: "patch", id: "exec", patch: { kind: "agent", model: "opus" } }),
    ).toEqual(step);
  });

  test("a picked kind closes the picker: the step is on the graph, not in a sheet", () => {
    const kind: SheetRequest = { kind: "kind", at: { after: "exec" } };
    expect(
      sheetAfterAction(kind, { do: "insert", at: { after: "exec" }, stepKind: "run" }),
    ).toBeNull();
  });

  test("a picked goto TARGET hands back the step that opened the picker", () => {
    // Closing twice (the picker, then the graph) would hide the `Then` row the
    // person just changed — and the `✗ ×n` counter it may still want.
    const pick: SheetRequest = { kind: "pick", id: "exec", purpose: "fail" };
    expect(sheetAfterAction(pick, { do: "then", id: "exec", target: "plan" })).toEqual(step);
    expect(
      sheetAfterAction(
        { kind: "pick", id: "exec", purpose: "next" },
        {
          do: "next",
          id: "exec",
          target: "gate",
        },
      ),
    ).toEqual(step);
  });

  test("the max sheet stays up while its stepper moves: the counter is the whole sheet", () => {
    const max: SheetRequest = { kind: "max", id: "exec" };
    expect(sheetAfterAction(max, { do: "gotoMax", id: "exec", max: 2 })).toEqual(max);
    // Done is the component's `onDone` (`afterSheet`), not a control: the counter
    // closes to the graph, never to a step sheet it never opened from.
    expect(afterSheet(max)).toBeNull();
  });
});
