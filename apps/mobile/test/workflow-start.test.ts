/**
 * `workflow-start.ts` (docs/feat/workflows-ui.md D6, slice 5b): the catalogue as
 * rows, the inputs form, the start params and the refusal branches — the pure
 * rules behind the phone's "Start a workflow". The daemon decides the inputs
 * (`resolveInputs`, `inputsProblem`); this module only pre-fills and blocks what
 * is obviously wrong, and it must never send `""` for an empty optional field
 * (an explicit empty value OVERRIDES the file's `default`).
 */
import { describe, expect, test } from "bun:test";
import type { WorkflowCatalogueResult, WorkflowDefRow } from "@tentacle/protocol";
import { WORKFLOW_INPUTS_MAX_CHARS } from "@tentacle/protocol";
import {
  LOADING_CATALOGUE,
  afterRefusal,
  catalogueRows,
  formFor,
  formProblems,
  openEntry,
  runningNotice,
  startBannerChanged,
  startParams,
} from "../src/workflow-start.ts";

const HASH = "a".repeat(64);

const row = (over: Partial<WorkflowDefRow> = {}): WorkflowDefRow => ({
  name: "demo",
  path: ".tentacle/workflows/demo.yaml",
  ok: true,
  version: 1,
  hash: HASH,
  approved: false,
  description: "A demo",
  inputs: [
    { name: "slug", required: true },
    { name: "note", required: false, default: "hello" },
  ],
  steps: [
    { id: "build", kind: "agent", model: "fast", where: "local" },
    { id: "ship", kind: "run", where: "local", command: "echo hi\n\necho bye" },
  ],
  ...over,
});

const catalogue = (over: Partial<WorkflowCatalogueResult> = {}): WorkflowCatalogueResult => ({
  workflows: [row()],
  dir: "/work/proj/.tentacle/workflows",
  ...over,
});

const broken = (name: string, errors: string[]): WorkflowDefRow => ({
  name,
  path: `.tentacle/workflows/${name}.yaml`,
  ok: false,
  errors,
});

describe("the catalogue as rows", () => {
  test("valid rows come FIRST, sorted by name; then the broken ones, sorted, with EVERY error", () => {
    const view = catalogueRows(
      catalogue({
        workflows: [
          broken("zeta", ["steps[1].on_fail.goto: no such step", "version: unsupported (9)"]),
          row({ name: "second", path: ".tentacle/workflows/second.yaml" }),
          broken("alpha", ["inputs.slug: bad name"]),
          row({ name: "aye", path: ".tentacle/workflows/aye.yaml" }),
        ],
      }),
    );
    expect(view.kind).toBe("ready");
    expect(view.valid.map((e) => e.name)).toEqual(["aye", "second"]);
    expect(view.invalid.map((e) => e.name)).toEqual(["alpha", "zeta"]);
    // Verbatim: every error, in the daemon's order, each still naming its YAML path.
    expect(view.invalid[1]?.errors).toEqual([
      "steps[1].on_fail.goto: no such step",
      "version: unsupported (9)",
    ]);
    // A broken row can never be started, so it carries no hash and no approval.
    expect(view.invalid[0]?.hash).toBeNull();
    expect(view.invalid[0]?.approval).toBeNull();
    expect(view.invalid[0]?.ok).toBe(false);
  });

  test("approval is a word AND a glyph — never hue alone (the owner is colour-blind)", () => {
    const view = catalogueRows(
      catalogue({
        workflows: [
          row({ name: "no", approved: false }),
          row({ name: "yes", approved: true }),
          row({ name: "unknown", approved: undefined }),
        ],
      }),
    );
    const byName = new Map(view.valid.map((e) => [e.name, e.approval]));
    expect(byName.get("yes")).toEqual({ glyph: "✓", word: "Approved" });
    expect(byName.get("no")).toEqual({ glyph: "?", word: "Needs approval" });
    // An older daemon that omits the field: no claim either way.
    expect(byName.get("unknown")).toBeNull();
  });

  test("the folder, `gitIgnored`, `truncated` and the `elsewhere` hint survive the projection", () => {
    const view = catalogueRows(
      catalogue({ truncated: true, gitIgnored: true, workflows: [row()] }),
    );
    expect(view.dir).toBe("/work/proj/.tentacle/workflows");
    expect(view.truncated).toBe(true);
    expect(view.gitIgnored).toBe(true);
    expect(view.elsewhere).toBeNull();

    const hint = { dir: "/work/proj", count: 2 };
    expect(catalogueRows(catalogue({ elsewhere: hint })).elsewhere).toEqual(hint);
  });

  test("unsupported, unavailable and an empty folder are THREE different things", () => {
    expect(catalogueRows({ unsupported: true })).toMatchObject({
      kind: "unsupported",
      dir: null,
      reason: null,
    });
    const unavailable = catalogueRows(
      catalogue({ workflows: [], unavailable: "this session cannot run workflows" }),
    );
    expect(unavailable.kind).toBe("unavailable");
    expect(unavailable.reason).toBe("this session cannot run workflows");
    // …never an empty list that looks like an empty folder.
    expect(unavailable.kind).not.toBe("empty");

    const empty = catalogueRows(
      catalogue({ workflows: [], elsewhere: { dir: "/work/proj", count: 2 } }),
    );
    expect(empty.kind).toBe("empty");
    expect(empty.dir).toBe("/work/proj/.tentacle/workflows");
    expect(empty.elsewhere).toEqual({ dir: "/work/proj", count: 2 });
  });

  test("the loading view claims nothing", () => {
    expect(LOADING_CATALOGUE).toMatchObject({ kind: "loading", valid: [], invalid: [] });
  });

  test("wire text is flattened to ONE line, but a `run` command is kept verbatim", () => {
    const view = catalogueRows(
      catalogue({
        workflows: [
          row({
            name: "demo",
            description: "spans\n\ntwo lines",
            inputs: [{ name: "slug", required: true }],
          }),
          broken("bad", ["steps[0].run:\nmissing command"]),
        ],
      }),
    );
    expect(view.valid[0]?.description).toBe("spans two lines");
    expect(view.invalid[0]?.errors[0]).toBe("steps[0].run: missing command");
    // The command is what an approval shows: never rewritten, never truncated.
    expect(view.valid[0]?.steps[1]?.command).toBe("echo hi\n\necho bye");
  });

  test("`openEntry` finds the row under the key, and nothing else", () => {
    const view = catalogueRows(catalogue());
    const entry = view.valid[0];
    expect(entry).toBeDefined();
    if (entry === undefined) {
      return;
    }
    expect(openEntry(view, entry.key)?.name).toBe("demo");
    expect(openEntry(view, "nope")).toBeNull();
    expect(openEntry(null, entry.key)).toBeNull();
  });
});

describe("the inputs form", () => {
  test("one field per declared input, prefilled with the file's default", () => {
    const form = formFor(row());
    expect(form.fields).toEqual([
      { name: "slug", required: true, value: "", defaultValue: null },
      { name: "note", required: false, value: "hello", defaultValue: "hello" },
    ]);
  });

  test("a value already typed wins over the default (a reload keeps what was typed)", () => {
    const form = formFor(row(), { slug: "s1", note: "" });
    expect(form.fields.map((f) => f.value)).toEqual(["s1", ""]);
  });
});

describe("what the form can catch before the daemon does", () => {
  const def = row();

  test("a required input left empty BLOCKS, and names its field", () => {
    const problems = formProblems(def, { slug: "", note: "" });
    expect(problems.map((p) => p.field)).toEqual(["slug"]);
    expect(problems[0]?.text).toContain("slug");
    // Whitespace is empty.
    expect(formProblems(def, { slug: "   " }).map((p) => p.field)).toEqual(["slug"]);
    expect(formProblems(def, { slug: "s1" })).toEqual([]);
  });

  test("an optional input left empty is fine (the file's default applies)", () => {
    expect(formProblems(def, { slug: "s1", note: "" })).toEqual([]);
  });

  test("a value over the wire's bound, and control characters, are caught", () => {
    const long = formProblems(def, { slug: "x".repeat(WORKFLOW_INPUTS_MAX_CHARS + 1) });
    expect(long.map((p) => p.field)).toEqual(["slug"]);
    const ctl = formProblems(def, { slug: "a\nb" });
    expect(ctl.map((p) => p.field)).toEqual(["slug"]);
  });

  test("the WHOLE JSON of the values is bounded too (field null: no one field is at fault)", () => {
    // Two values, each under the per-field cap, over the 4 KiB list bound together.
    const big = "y".repeat(WORKFLOW_INPUTS_MAX_CHARS - 100);
    const problems = formProblems(def, { slug: big, note: big });
    expect(problems.map((p) => p.field)).toEqual([null]);
  });

  test("an undeclared name is not a problem — it is simply never sent", () => {
    expect(formProblems(def, { slug: "s1", junk: "x" })).toEqual([]);
  });
});

describe("what a start sends", () => {
  test("only declared names, pinned to the hash that was on screen", () => {
    const params = startParams(row(), { slug: "s1", note: "n", junk: "ignored" });
    expect(params).toEqual({
      name: "demo",
      hash: HASH,
      inputs: [
        { name: "slug", value: "s1" },
        { name: "note", value: "n" },
      ],
    });
  });

  test('an empty or whitespace-only OPTIONAL input is OMITTED — `""` would override the default', () => {
    expect(startParams(row(), { slug: "s1", note: "" })?.inputs).toEqual([
      { name: "slug", value: "s1" },
    ]);
    expect(startParams(row(), { slug: "s1", note: "  " })?.inputs).toEqual([
      { name: "slug", value: "s1" },
    ]);
  });

  test("nothing left to send → no `inputs` key at all", () => {
    const params = startParams(
      row({ inputs: [{ name: "note", required: false, default: "hello" }] }),
      { note: "" },
    );
    expect(params).toEqual({ name: "demo", hash: HASH });
    expect(params !== null && "inputs" in params).toBe(false);
  });

  test("a row with no hash cannot be started safely → null (never an unpinned start)", () => {
    expect(startParams(row({ hash: undefined }), { slug: "s1" })).toBeNull();
    expect(startParams({ name: "demo", hash: undefined }, {})).toBeNull();
  });
});

describe("a refusal branches on its word, never on its text", () => {
  test("`changed` → reload the catalogue and review again", () => {
    expect(afterRefusal({ refusal: "changed", reason: "workflows/demo.yaml changed" })).toEqual({
      kind: "reload",
    });
  });

  test("`running` → open the run that already holds the slot", () => {
    expect(afterRefusal({ refusal: "running", runId: "wf-7", reason: "already running" })).toEqual({
      kind: "openRun",
      runId: "wf-7",
    });
  });

  test("a `running` word with no run id says so instead of navigating nowhere", () => {
    expect(afterRefusal({ refusal: "running", reason: "already running" })).toEqual({
      kind: "showReason",
      reason: "already running",
    });
  });

  test("any other word (or none) → the daemon's reason, as text", () => {
    expect(afterRefusal({ refusal: "inputs", reason: "missing required input(s): slug" })).toEqual({
      kind: "showReason",
      reason: "missing required input(s): slug",
    });
    expect(afterRefusal({ reason: "something else" })).toEqual({
      kind: "showReason",
      reason: "something else",
    });
    // Nothing at all: still a word a person can read.
    expect(afterRefusal({}).kind).toBe("showReason");
  });
});

describe("the screen's own lines", () => {
  test("the stale-file banner and the already-running notice", () => {
    expect(startBannerChanged).toBe("This workflow changed — review it again");
    expect(runningNotice("demo")).toBe("Workflow demo is already running");
  });
});
