/**
 * The editor's New sheet and Review screen, as values (docs/feat/workflow-editor.md
 * D8, slice 7c). Pure and React-free (AGENTS §7): `WorkflowNew.tsx` and
 * `WorkflowEditReview.tsx` draw these and decide nothing.
 *
 * - **New** — the name is checked live by the wire's own schema (the controller's
 *   `nameProblem`, one sentence), and Create sends exactly what the sheet shows:
 *   the chosen template, the name, the description and the template's inputs.
 * - **Review** — every row, patch, hash, version and note is the daemon's
 *   `dryRun:true` answer, verbatim; nothing is recounted here. The notes are the
 *   plan's failure modes said in words: a hand-written layout (Q3), a run in
 *   flight, schedules pinned to the old hash, other workflows a shared prompt
 *   changes.
 * - **Header / toast** — Save becomes Run once a write landed (`canRun`), and the
 *   saved toast is `savedToast` of what landed.
 */
import { WORKFLOW_TEMPLATES, type WorkflowInput } from "@tentacle/core";
import type { WorkflowSaveResult, WorkflowWriteFile } from "@tentacle/protocol";
import { type DiffView, diffView } from "./diff-view.ts";
import {
  EDIT_OFFLINE,
  type EditState,
  existsNotice,
  nameProblem,
  savedToast,
} from "./workflow-edit-controller.ts";

/** The template the New sheet starts on (the mockup's preselected row). */
export const NEW_DEFAULT_TEMPLATE = "plan-build-review-merge";

/** What the New sheet holds while it is up. */
export interface NewSheetInput {
  readonly name: string;
  readonly description: string;
  readonly template: string;
}

export interface NewSheetModel {
  /** "Saved as workflows/demo.yaml · lowercase, digits and -". */
  readonly savedAs: string;
  /** The name's problem, live; `null` while it is empty (nothing typed is not an error). */
  readonly nameProblem: string | null;
  readonly templates: readonly {
    readonly id: string;
    readonly label: string;
    readonly sub: string;
    readonly on: boolean;
  }[];
  /** The chosen template's inputs: "required" or `default "x"`. */
  readonly inputs: readonly { readonly name: string; readonly sub: string }[];
  /** Create is on: a valid name and a known template. */
  readonly canCreate: boolean;
}

/** What Create hands `controller.create`, or `null` when Create is off. */
export interface NewSheetCreate {
  readonly templateId: string;
  readonly name: string;
  readonly description: string;
  readonly inputs: Readonly<Record<string, WorkflowInput>>;
}

function inputSub(input: WorkflowInput): string {
  if (input.required) {
    return "required";
  }
  return `default "${input.default ?? ""}"`;
}

export function newSheetModel(input: NewSheetInput): NewSheetModel {
  const name = input.name.trim();
  const problem = name === "" ? null : nameProblem(name);
  const chosen = WORKFLOW_TEMPLATES.find((entry) => entry.id === input.template);
  return {
    savedAs: `Saved as workflows/${name === "" ? "<name>" : name}.yaml · lowercase, digits and -`,
    nameProblem: problem,
    templates: WORKFLOW_TEMPLATES.map((entry) => ({
      id: entry.id,
      label: entry.label,
      sub: entry.sub,
      on: entry.id === input.template,
    })),
    inputs: Object.entries(chosen?.inputs ?? {}).map(([key, value]) => ({
      name: key,
      sub: inputSub(value),
    })),
    canCreate: name !== "" && problem === null && chosen !== undefined,
  };
}

export function newSheetCreate(input: NewSheetInput): NewSheetCreate | null {
  const chosen = WORKFLOW_TEMPLATES.find((entry) => entry.id === input.template);
  if (!newSheetModel(input).canCreate || chosen === undefined) {
    return null;
  }
  return {
    templateId: chosen.id,
    name: input.name.trim(),
    description: input.description.trim(),
    inputs: chosen.inputs,
  };
}

/**
 * The New sheet is up: a CREATE route (no name in the params) whose controller
 * has no draft yet and has not been started (the sheet's Create starts it).
 */
export function newSheetUp(input: {
  readonly routeName: string | undefined;
  readonly state: EditState;
}): boolean {
  return (
    input.routeName === undefined && input.state.draft === null && input.state.kind === "opening"
  );
}

/** Q3's warning: a hand-written file loses its comments and layout. */
export const REVIEW_REWRITES =
  "This file has comments or its own layout; saving rewrites it (the full patch is below)";
/** The hash's foot when it is not approved yet. */
export const REVIEW_HASH_FOOT =
  "The hash covers the file and its prompts. The first Run asks you to approve it; any later edit makes a new hash, and asks again.";
/** The hash's foot when that exact hash is approved already (display only). */
export const REVIEW_HASH_APPROVED = "This exact hash is approved already.";

export interface ReviewModel {
  /** "Will be written": one row per file, `new · 38 lines` / `+5 −1` / `unchanged`. */
  readonly rows: readonly { readonly path: string; readonly value: string }[];
  /**
   * The patches, in the daemon's file order (an `unchanged` file has none),
   * parsed by the transcript's own `diffView` so Review draws the permission
   * sheet's diff renderer; `patch` is kept verbatim.
   */
  readonly patches: readonly {
    readonly key: string;
    readonly path: string;
    readonly patch: string;
    readonly view: DiffView;
  }[];
  /** The first 8 hex of the hash the write produces. */
  readonly hash: string;
  readonly version: string;
  readonly hashFoot: string;
  /** The notes, each a full sentence. */
  readonly notes: readonly string[];
  /** "Save 5 files" — the files that actually change. */
  readonly button: string;
}

function fileValue(file: WorkflowWriteFile): string {
  if (file.status === "new") {
    return `new · ${file.added} ${file.added === 1 ? "line" : "lines"}`;
  }
  if (file.status === "changed") {
    return `+${file.added} −${file.removed}`;
  }
  return "unchanged";
}

const list = (names: readonly string[]): string => names.join(", ");

/** Review's whole content, or `null` when there is no accepted preview to show. */
export function reviewModel(input: {
  readonly preview: WorkflowSaveResult | null;
  readonly canonical: boolean | null;
  /** The link is down: confirm is off (the controller's `canConfirm`), and Review says why. */
  readonly offline?: boolean;
}): ReviewModel | null {
  const preview = input.preview;
  if (preview === null || !preview.ok || preview.hash === undefined) {
    return null;
  }
  const files = preview.files ?? [];
  const notes: string[] = [];
  if (input.offline === true) {
    notes.push(EDIT_OFFLINE);
  }
  if (input.canonical === false) {
    notes.push(REVIEW_REWRITES);
  }
  if (preview.running !== undefined) {
    notes.push(
      `Run ${preview.running} continues with the version it started with; resuming it will be refused after this save`,
    );
  }
  const schedules = preview.schedules ?? [];
  if (schedules.length > 0) {
    notes.push(
      `${schedules.length === 1 ? "Schedule" : "Schedules"} ${list(schedules)} ${
        schedules.length === 1 ? "is" : "are"
      } pinned to the old hash: skipped until re-created`,
    );
  }
  const also = preview.alsoChanges ?? [];
  if (also.length > 0) {
    notes.push(`Also changes ${list(also)}: a shared prompt file, so their next start asks`);
  }
  const written = files.filter((file) => file.status !== "unchanged").length;
  return {
    rows: files.map((file) => ({ path: file.path, value: fileValue(file) })),
    patches: files.flatMap((file, index) =>
      file.patch === undefined || file.status === "unchanged"
        ? []
        : [
            {
              key: `review-${index}`,
              path: file.path,
              patch: file.patch,
              view: diffView({
                kind: "diff",
                path: file.path,
                patch: file.patch,
                added: file.added,
                removed: file.removed,
              }),
            },
          ],
    ),
    hash: preview.hash.slice(0, 8),
    version: preview.version === undefined ? "—" : String(preview.version),
    hashFoot: preview.approved === true ? REVIEW_HASH_APPROVED : REVIEW_HASH_FOOT,
    notes,
    button: written === 0 ? "Save" : `Save ${written} ${written === 1 ? "file" : "files"}`,
  };
}

/** The editor shows Review (instead of the graph) while an accepted preview is up. */
export function showsReview(state: EditState): boolean {
  return (
    (state.kind === "reviewing" || state.kind === "saving") &&
    reviewModel({ preview: state.preview, canonical: state.canonical }) !== null
  );
}

/**
 * How the graph is drawn: `edit` while the draft can change, `view` once a
 * write landed (the mockup's saved screen keeps the graph under Run, but the
 * controller edits nothing in `saved`, so a tap must not open a sheet whose
 * controls would silently do nothing), `null` when there is no editor at all.
 */
export function canvasMode(kind: EditState["kind"]): "edit" | "view" | null {
  if (kind === "editing" || kind === "reviewing" || kind === "saving") {
    return "edit";
  }
  return kind === "saved" ? "view" : null;
}

/** The header's right button: Save, or Run once a write landed (D7 `saved`). */
export function headerAction(input: {
  readonly canSave: boolean;
  readonly canRun: boolean;
}): { readonly label: "Save" | "Run"; readonly on: boolean } {
  return input.canRun ? { label: "Run", on: true } : { label: "Save", on: input.canSave };
}

/** "Saved workflows/demo.yaml · v2 · 1a2b3c4d" while the save that landed is on screen. */
export function savedLine(state: EditState): string | null {
  return state.kind === "saved" && state.saved !== null ? savedToast(state.saved) : null;
}

/** A create refused `exists`: the file is renamed from here (the controller's `renameFile`). */
export function renameOffered(state: EditState): boolean {
  return (
    state.mode === "create" && state.name !== null && state.notice === existsNotice(state.name)
  );
}
