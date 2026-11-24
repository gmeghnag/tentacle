/**
 * The New sheet and Review as values (docs/feat/workflow-editor.md D8, slice 7c).
 *
 * I know X for sure: the controller (D7) owns create, the preview and the write;
 * the `dryRun:true` answer is the ONLY truth Review may draw. My current
 * hypothesis is Y: `workflow-edit-review.ts` maps that answer and the New sheet's
 * fields to what is drawn without recounting or inventing anything. My next
 * cheapest test is Z: feed it answers and fields, assert the drawn values.
 */
import { describe, expect, test } from "bun:test";
import { WORKFLOW_TEMPLATES } from "@tentacle/core";
import type { WorkflowSaveResult } from "@tentacle/protocol";
import {
  EDIT_NAME_RULE,
  EDIT_OFFLINE,
  type EditState,
  existsNotice,
} from "../src/workflow-edit-controller.ts";
import {
  NEW_DEFAULT_TEMPLATE,
  REVIEW_HASH_APPROVED,
  REVIEW_HASH_FOOT,
  REVIEW_REWRITES,
  headerAction,
  newSheetCreate,
  newSheetModel,
  newSheetUp,
  renameOffered,
  reviewModel,
  savedLine,
  showsReview,
} from "../src/workflow-edit-review.ts";

const HASH = "7b04d2aa".padEnd(64, "0");

function preview(over: Partial<WorkflowSaveResult> = {}): WorkflowSaveResult {
  return {
    ok: true,
    hash: HASH,
    version: 1,
    path: ".tentacle/workflows/task.yaml",
    files: [
      {
        path: ".tentacle/workflows/task.yaml",
        status: "new",
        added: 38,
        removed: 0,
        patch: "@@ -0,0 +1,2 @@\n+a\n+b",
      },
      {
        path: ".tentacle/workflows/prompts/plan.md",
        status: "new",
        added: 1,
        removed: 0,
        patch: "+x",
      },
      { path: ".tentacle/workflows/prompts/exec.md", status: "unchanged", added: 0, removed: 0 },
      {
        path: ".tentacle/workflows/prompts/fix.md",
        status: "changed",
        added: 5,
        removed: 1,
        patch: "@@ -1 +1,5 @@\n-a\n+b",
      },
    ],
    ...over,
  };
}

function state(over: Partial<EditState> = {}): EditState {
  return {
    kind: "editing",
    name: "task",
    mode: "replace",
    draft: { name: "task", steps: [] },
    prompts: {},
    problems: [],
    dirty: true,
    saveOff: null,
    preview: null,
    saved: null,
    changed: false,
    notice: null,
    errors: [],
    reason: null,
    canonical: true,
    offline: false,
    canUndo: false,
    canRedo: false,
    context: null,
    ...over,
  };
}

describe("the New sheet", () => {
  const base = { name: "", description: "", template: NEW_DEFAULT_TEMPLATE };

  test("opens on the template the mockup preselects, with its inputs listed", () => {
    const model = newSheetModel(base);
    const on = model.templates.filter((t) => t.on).map((t) => t.id);
    expect(on).toEqual(["plan-build-review-merge"]);
    expect(model.templates.map((t) => t.id)).toEqual(WORKFLOW_TEMPLATES.map((t) => t.id));
    expect(model.inputs).toEqual([
      { name: "slug", sub: "required" },
      { name: "doc", sub: 'default ""' },
    ]);
  });

  test("an empty name is no error, but Create stays off", () => {
    const model = newSheetModel(base);
    expect(model.nameProblem).toBeNull();
    expect(model.canCreate).toBe(false);
    expect(newSheetCreate(base)).toBeNull();
  });

  test("the name is checked live by the wire's rule, and Create follows it", () => {
    for (const bad of ["Task", "a--b", "-a", "a_b", "a b", "x".repeat(65)]) {
      const model = newSheetModel({ ...base, name: bad });
      expect(model.nameProblem).toBe(EDIT_NAME_RULE);
      expect(model.canCreate).toBe(false);
      expect(newSheetCreate({ ...base, name: bad })).toBeNull();
    }
    const good = newSheetModel({ ...base, name: "task-2" });
    expect(good.nameProblem).toBeNull();
    expect(good.canCreate).toBe(true);
    expect(good.savedAs).toContain("workflows/task-2.yaml");
  });

  test("an unknown template is refused (Create off), never sent", () => {
    expect(newSheetModel({ ...base, name: "task", template: "nope" }).canCreate).toBe(false);
    expect(newSheetCreate({ ...base, name: "task", template: "nope" })).toBeNull();
  });

  test("Create sends exactly what the sheet shows: template, name, description, inputs", () => {
    const sent = newSheetCreate({ name: " task ", description: " a loop ", template: "blank" });
    expect(sent).toEqual({ templateId: "blank", name: "task", description: "a loop", inputs: {} });
    const loop = newSheetCreate({ ...base, name: "task" });
    expect(loop?.inputs).toEqual(
      WORKFLOW_TEMPLATES.find((t) => t.id === "plan-build-review-merge")?.inputs ?? {},
    );
  });

  test("it is up only on a create route whose controller has no draft and was not started", () => {
    expect(
      newSheetUp({ routeName: undefined, state: state({ kind: "opening", draft: null }) }),
    ).toBe(true);
    // An edit route never shows it.
    expect(newSheetUp({ routeName: "task", state: state({ kind: "opening", draft: null }) })).toBe(
      false,
    );
    // Created: the template's draft is there.
    expect(newSheetUp({ routeName: undefined, state: state({ kind: "opening" }) })).toBe(false);
    // Started without a template: the controller's own `failed` screen, not the sheet.
    expect(
      newSheetUp({ routeName: undefined, state: state({ kind: "failed", draft: null }) }),
    ).toBe(false);
  });
});

describe("Review", () => {
  test("draws nothing without an ACCEPTED preview (a refusal or no hash)", () => {
    expect(reviewModel({ preview: null, canonical: true })).toBeNull();
    expect(reviewModel({ preview: { ok: false, refusal: "invalid" }, canonical: true })).toBeNull();
    expect(reviewModel({ preview: { ok: true }, canonical: true })).toBeNull();
  });

  test("one row per file, in the daemon's order, with the daemon's own counts", () => {
    const model = reviewModel({ preview: preview(), canonical: true });
    expect(model?.rows).toEqual([
      { path: ".tentacle/workflows/task.yaml", value: "new · 38 lines" },
      { path: ".tentacle/workflows/prompts/plan.md", value: "new · 1 line" },
      { path: ".tentacle/workflows/prompts/exec.md", value: "unchanged" },
      { path: ".tentacle/workflows/prompts/fix.md", value: "+5 −1" },
    ]);
  });

  test("the button counts the files that CHANGE (an unchanged prompt is not written)", () => {
    expect(reviewModel({ preview: preview(), canonical: true })?.button).toBe("Save 3 files");
    const one = preview({ files: [{ path: "a.yaml", status: "changed", added: 1, removed: 1 }] });
    expect(reviewModel({ preview: one, canonical: true })?.button).toBe("Save 1 file");
  });

  test("patches are the daemon's verbatim, and an unchanged file has none", () => {
    const model = reviewModel({ preview: preview(), canonical: true });
    expect(model?.patches.map((p) => p.path)).toEqual([
      ".tentacle/workflows/task.yaml",
      ".tentacle/workflows/prompts/plan.md",
      ".tentacle/workflows/prompts/fix.md",
    ]);
    expect(model?.patches[0]?.patch).toBe("@@ -0,0 +1,2 @@\n+a\n+b");
    // An `unchanged` file draws no patch even if one arrived with it: nothing of
    // it is written, so a diff there would be a lie.
    const stray = preview({
      files: [{ path: "p.md", status: "unchanged", added: 0, removed: 0, patch: "+x" }],
    });
    expect(reviewModel({ preview: stray, canonical: true })?.patches).toEqual([]);
    // Keys are unique (the diff block's testID).
    const keys = new Set(model?.patches.map((p) => p.key));
    expect(keys.size).toBe(3);
  });

  test("hash (first 8) and version are the preview's", () => {
    const model = reviewModel({ preview: preview({ version: 4 }), canonical: true });
    expect(model?.hash).toBe("7b04d2aa");
    expect(model?.version).toBe("4");
    expect(model?.hashFoot).toBe(REVIEW_HASH_FOOT);
    expect(reviewModel({ preview: preview({ approved: true }), canonical: true })?.hashFoot).toBe(
      REVIEW_HASH_APPROVED,
    );
  });

  test("a clean canonical save has no notes", () => {
    expect(reviewModel({ preview: preview(), canonical: true })?.notes).toEqual([]);
    // A create (`canonical` unknown) is not a rewrite either.
    expect(reviewModel({ preview: preview(), canonical: null })?.notes).toEqual([]);
  });

  test("offline: Review says so first, and online it says nothing about the link", () => {
    expect(reviewModel({ preview: preview(), canonical: false, offline: true })?.notes).toEqual([
      EDIT_OFFLINE,
      REVIEW_REWRITES,
    ]);
    expect(reviewModel({ preview: preview(), canonical: true, offline: false })?.notes).toEqual([]);
  });

  test("Q3: a hand-written file warns that saving rewrites its layout", () => {
    expect(reviewModel({ preview: preview(), canonical: false })?.notes).toEqual([REVIEW_REWRITES]);
  });

  test("a run in flight, pinned schedules and other workflows a prompt changes are each said", () => {
    const notes =
      reviewModel({
        preview: preview({ running: "wf-7", schedules: ["sc-1", "sc-2"], alsoChanges: ["other"] }),
        canonical: true,
      })?.notes ?? [];
    expect(notes).toHaveLength(3);
    expect(notes[0]).toContain("wf-7");
    expect(notes[0]).toContain("resuming it will be refused");
    expect(notes[1]).toContain("Schedules sc-1, sc-2 are pinned to the old hash");
    expect(notes[2]).toContain("Also changes other");
    const single =
      reviewModel({ preview: preview({ schedules: ["sc-3"] }), canonical: true })?.notes ?? [];
    expect(single[0]).toContain("Schedule sc-3 is pinned");
  });

  test("Review replaces the graph only while an accepted preview is up", () => {
    expect(showsReview(state({ kind: "reviewing", preview: preview() }))).toBe(true);
    // The write is in flight: the same screen, its button off (canConfirm).
    expect(showsReview(state({ kind: "saving", preview: preview() }))).toBe(true);
    expect(showsReview(state({ kind: "editing", preview: preview() }))).toBe(false);
    expect(showsReview(state({ kind: "reviewing", preview: null }))).toBe(false);
  });
});

describe("after the write", () => {
  test("the header's Save becomes Run only once a write landed", () => {
    expect(headerAction({ canSave: true, canRun: false })).toEqual({ label: "Save", on: true });
    expect(headerAction({ canSave: false, canRun: false })).toEqual({ label: "Save", on: false });
    expect(headerAction({ canSave: false, canRun: true })).toEqual({ label: "Run", on: true });
  });

  test("the saved toast is the controller's own sentence, only in `saved`", () => {
    const saved = { hash: HASH, version: 1, path: ".tentacle/workflows/task.yaml" };
    expect(savedLine(state({ kind: "saved", saved }))).toBe(
      "Saved .tentacle/workflows/task.yaml · v1 · 7b04d2aa",
    );
    expect(savedLine(state({ kind: "editing", saved }))).toBeNull();
    expect(savedLine(state({ kind: "saved", saved: null }))).toBeNull();
  });

  test("Rename is offered only for a CREATE refused `exists`", () => {
    const refused = state({ mode: "create", name: "demo", notice: existsNotice("demo") });
    expect(renameOffered(refused)).toBe(true);
    expect(renameOffered({ ...refused, mode: "replace" })).toBe(false);
    expect(renameOffered({ ...refused, notice: "something else" })).toBe(false);
    expect(renameOffered({ ...refused, notice: null })).toBe(false);
  });
});
