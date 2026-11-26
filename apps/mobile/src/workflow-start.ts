/**
 * The phone's "Start a workflow" (docs/feat/workflows-ui.md D6, slice 5b). Pure
 * and React-free (AGENTS §7): the catalogue projection, the inputs form, the
 * start's params and the refusal branches live here, and `screens/WorkflowStart.tsx`
 * only draws them.
 *
 * The rules:
 * - **The catalogue is three different answers**, kept apart on purpose: an older
 *   daemon (`{unsupported:true}`), a session that cannot run workflows at all
 *   (`unavailable`), and a folder with no workflow in it (`empty`). None of them
 *   may look like the others — "no workflows" over a pod's session would send a
 *   person hunting for a file that was always there.
 * - **Valid rows first, by name; then the broken ones**, each with EVERY error the
 *   daemon sent, verbatim (they name their YAML path), and no way to start them.
 * - **Approval is a WORD and a glyph**, never hue alone (the owner is colour-blind).
 * - **A start is pinned to the hash on screen** (`startParams` returns null without
 *   one): the daemon refuses `changed` otherwise, so a file edited in between is
 *   never run as something the person did not review.
 * - **An empty optional input is OMITTED, never `""`** — the daemon applies the
 *   file's own `default` only when the input is absent (`resolveInputs`,
 *   `core/src/workflow-machine.ts:144-152`); sending `""` would override it. Only
 *   declared names are ever sent, and `inputs` is absent when nothing is left.
 * - **`formProblems` is a HINT, never the authority**: it catches a required field
 *   left empty, a value past the wire's own bound, control characters and an
 *   over-4-KiB list; the daemon still decides (`inputsProblem`).
 * - **Wire text off a row is flattened to one line** (`oneLine`, the `activity.ts`
 *   seam — a serve host's repo, but still a wire row); a `run` step's `command` is
 *   kept VERBATIM, because it is what an approval shows.
 */
import {
  WORKFLOW_INPUTS_MAX_CHARS,
  type WorkflowCatalogueResult,
  type WorkflowDefInput,
  type WorkflowDefRow,
  type WorkflowDefStep,
  type WorkflowInputValue,
} from "@tentacle/protocol";
import { oneLine } from "./activity.ts";

/** A row as the screen draws it: the wire fields plus the two decisions this app owns. */
export interface CatalogueEntry {
  /** Stable identity for a list key: the row's path (a name is not unique across folders). */
  readonly key: string;
  readonly name: string;
  readonly path: string;
  readonly ok: boolean;
  /** The hash `start{hash}` pins; `null` on a broken row (it cannot be started). */
  readonly hash: string | null;
  /** `approved` as the daemon answered it; `null` = it did not say (an older daemon). */
  readonly approved: boolean | null;
  /** The word AND the glyph ("Approved" ✓ / "Needs approval" ?); `null` = nothing to claim. */
  readonly approval: { readonly glyph: string; readonly word: string } | null;
  readonly description: string | null;
  readonly inputs: readonly WorkflowDefInput[];
  readonly steps: readonly WorkflowDefStep[];
  /** Every validation error, verbatim (each names its YAML path). */
  readonly errors: readonly string[];
}

/**
 * The catalogue as the screen shows it. `kind` is the whole decision, so the
 * screen never has to re-derive "is this empty, unavailable, or too old".
 */
export interface CatalogueView {
  readonly kind: "loading" | "unsupported" | "unavailable" | "empty" | "ready";
  /** The absolute folder that was read (a person in the wrong folder sees where tentacle looks). */
  readonly dir: string | null;
  readonly valid: readonly CatalogueEntry[];
  readonly invalid: readonly CatalogueEntry[];
  /** More YAML files than the daemon lists: what is shown is not all of it. */
  readonly truncated: boolean;
  /** Git ignores the folder: the "not versioned" note. */
  readonly gitIgnored: boolean;
  /** `unavailable`'s own reason, else null. */
  readonly reason: string | null;
}

/** One thing the form can see is wrong. `field: null` = the list as a whole. */
export interface FormProblem {
  readonly field: string | null;
  readonly text: string;
}

/** The catalogue has not answered yet (the screen's first frame). */
export const LOADING_CATALOGUE: CatalogueView = {
  kind: "loading",
  dir: null,
  valid: [],
  invalid: [],
  truncated: false,
  gitIgnored: false,
  reason: null,
};

/** Shown above the form after a `changed` refusal: the file is not the one on screen. */
export const startBannerChanged = "This workflow changed — review it again";
/** Shown when a start was refused `running`: that run holds the slot, so open it. */
export function runningNotice(name: string): string {
  return `Workflow ${oneLine(name)} is already running`;
}
/** What a session that cannot run workflows at all says (a pod's daemon). */
export const START_UNAVAILABLE = "Workflows run only on a laptop or serve session";
/** What an older daemon (no `workflow_catalogue`) says. */
export const START_UPDATE_TENTACLE = "Update tentacle on this computer";

const APPROVED = { glyph: "✓", word: "Approved" } as const;
const NEEDS_APPROVAL = { glyph: "?", word: "Needs approval" } as const;

function entry(row: WorkflowDefRow): CatalogueEntry {
  const errors = (row.errors ?? []).map(oneLine);
  return {
    key: row.path,
    name: row.name,
    path: row.path,
    ok: row.ok,
    // A broken file has no start to pin, so it carries no hash even if one came.
    hash: row.ok ? (row.hash ?? null) : null,
    approved: row.ok ? (row.approved ?? null) : null,
    approval: row.ok
      ? row.approved === true
        ? APPROVED
        : row.approved === false
          ? NEEDS_APPROVAL
          : null
      : null,
    description: row.description === undefined ? null : oneLine(row.description),
    inputs: row.inputs ?? [],
    // A `run` step's command is what an approval shows: never rewritten here.
    steps: row.steps ?? [],
    errors,
  };
}

const byName = (a: CatalogueEntry, b: CatalogueEntry): number =>
  a.name === b.name ? a.key.localeCompare(b.key) : a.name.localeCompare(b.name);

/**
 * The wire answer, as the screen's view. A `loading` view is `LOADING_CATALOGUE`;
 * everything else comes from an answer. An `unavailable` answer is NOT an empty
 * folder: the reason is carried and its own kind keeps the two apart.
 */
export function catalogueRows(
  result: WorkflowCatalogueResult | { unsupported: true },
): CatalogueView {
  if ("unsupported" in result) {
    return { ...LOADING_CATALOGUE, kind: "unsupported" };
  }
  const rows = result.workflows.map(entry);
  const valid = rows.filter((e) => e.ok).sort(byName);
  const invalid = rows.filter((e) => !e.ok).sort(byName);
  const kind: CatalogueView["kind"] =
    result.unavailable !== undefined
      ? "unavailable"
      : valid.length + invalid.length === 0
        ? "empty"
        : "ready";
  return {
    kind,
    dir: result.dir === "" ? null : result.dir,
    valid,
    invalid,
    truncated: result.truncated === true,
    gitIgnored: result.gitIgnored === true,
    reason: result.unavailable === undefined ? null : oneLine(result.unavailable),
  };
}

/** The row under `key` (a valid one — the screen only opens those), or null. */
export function openEntry(view: CatalogueView | null, key: string): CatalogueEntry | null {
  return view?.valid.find((e) => e.key === key) ?? null;
}

/** The hash a start must pin, or null when this row cannot be started safely. */
export function startHash(entryLike: {
  readonly hash?: string | null;
}): string | null {
  return entryLike.hash === undefined ? null : entryLike.hash;
}

/** One form field: its declared name, whether it must be filled, its value now. */
export interface FormField {
  readonly name: string;
  readonly required: boolean;
  readonly value: string;
  /** The file's own default (the placeholder), `null` when it declares none. */
  readonly defaultValue: string | null;
}

/**
 * The form for one row: one field per DECLARED input, prefilled with the file's
 * default. A value already typed (`values`) wins — that is what a `changed`
 * refusal's reload keeps.
 */
export function formFor(
  def: { readonly inputs?: readonly WorkflowDefInput[] },
  values: Readonly<Record<string, string>> = {},
): { readonly fields: readonly FormField[] } {
  return {
    fields: (def.inputs ?? []).map((input) => {
      const given = values[input.name];
      return {
        name: input.name,
        required: input.required,
        value: given ?? input.default ?? "",
        defaultValue: input.default ?? null,
      };
    }),
  };
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: a control character in an input value
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * What the form can see is wrong — a HINT (the daemon still decides): a required
 * input left empty, a value past the wire's bound, a control character, and the
 * whole list past its 4-KiB JSON bound. An undeclared name is nobody's problem
 * here; `startParams` simply never sends it.
 */
export function formProblems(
  def: { readonly inputs?: readonly WorkflowDefInput[] },
  values: Readonly<Record<string, string>>,
): readonly FormProblem[] {
  const problems: FormProblem[] = [];
  const sent = sentInputs(def, values);
  for (const input of def.inputs ?? []) {
    const value = sent.get(input.name) ?? "";
    if (input.required && value.trim() === "") {
      problems.push({ field: input.name, text: `${input.name} is required` });
      continue;
    }
    if (value.length > WORKFLOW_INPUTS_MAX_CHARS) {
      problems.push({
        field: input.name,
        text: `${input.name} is longer than ${WORKFLOW_INPUTS_MAX_CHARS} characters`,
      });
      continue;
    }
    if (CONTROL.test(value)) {
      problems.push({ field: input.name, text: `${input.name} contains a control character` });
    }
  }
  // The list's own bound (the same JSON the log emits): no single field is at fault.
  if (
    problems.length === 0 &&
    JSON.stringify(inputsJson(sent)).length > WORKFLOW_INPUTS_MAX_CHARS
  ) {
    problems.push({
      field: null,
      text: `the inputs together are longer than ${WORKFLOW_INPUTS_MAX_CHARS} characters`,
    });
  }
  return problems;
}

/** What would actually be sent for `values`: declared names only, empty optionals left out. */
function sentInputs(
  def: { readonly inputs?: readonly WorkflowDefInput[] },
  values: Readonly<Record<string, string>>,
): Map<string, string> {
  const sent = new Map<string, string>();
  for (const input of def.inputs ?? []) {
    const value = values[input.name];
    if (value === undefined) {
      continue;
    }
    // A blank OPTIONAL value is OMITTED so the file's `default` applies (a `""`
    // would override it); a blank REQUIRED one is sent as typed and refused by the
    // daemon — `formProblems` already blocks it here.
    if (!input.required && value.trim() === "") {
      continue;
    }
    sent.set(input.name, value);
  }
  return sent;
}

function inputsJson(sent: Map<string, string>): WorkflowInputValue[] {
  return [...sent].map(([name, value]) => ({ name, value }));
}

/**
 * Whether a start needs the person to type something first
 * (docs/feat/mobile-workflows-landing.md D7.4): an input that is required and has
 * no default. Otherwise the list's Start starts at once.
 */
export function needsValues(def: { readonly inputs?: readonly WorkflowDefInput[] }): boolean {
  return (def.inputs ?? []).some((input) => input.required && input.default === undefined);
}

/** A start's params, as `session/workflow{action:"start"}` takes them. */
export interface StartParams {
  readonly name: string;
  readonly hash?: string;
  readonly inputs?: WorkflowInputValue[];
}

/**
 * The start to send, or `null` when this row cannot be started safely (no hash:
 * the daemon would re-read the file and run an edit nobody reviewed). Only
 * declared names; a blank optional input is left OUT entirely, and `inputs` is
 * absent when nothing is left to say.
 */
export function startParams(
  def: {
    readonly name: string;
    readonly hash?: string | null;
    readonly inputs?: readonly WorkflowDefInput[];
  },
  values: Readonly<Record<string, string>>,
): StartParams | null {
  const hash = startHash(def);
  if (hash === null) {
    return null;
  }
  const inputs = inputsJson(sentInputs(def, values));
  return { name: def.name, hash, ...(inputs.length === 0 ? {} : { inputs }) };
}

/** What a refusal asks the screen to do next. */
export type AfterRefusal =
  | { readonly kind: "reload" }
  | { readonly kind: "openRun"; readonly runId: string }
  | { readonly kind: "showReason"; readonly reason: string };

/** A refusal's fallback text when the daemon sent none. */
const REFUSED = "the start was refused";

/**
 * Branch on the refusal WORD, never on its text (a newer daemon's word is
 * carried as is → `showReason`): `changed` reloads the catalogue, `running`
 * opens the run that holds the slot, anything else is the daemon's reason.
 */
export function afterRefusal(result: {
  readonly refusal?: string;
  readonly runId?: string;
  readonly reason?: string;
}): AfterRefusal {
  const reason = result.reason === undefined ? REFUSED : oneLine(result.reason);
  if (result.refusal === "changed") {
    return { kind: "reload" };
  }
  if (result.refusal === "running") {
    // No run id: there is nothing to open, so say it instead of navigating nowhere.
    return result.runId === undefined
      ? { kind: "showReason", reason }
      : {
          kind: "openRun",
          runId: result.runId,
        };
  }
  return { kind: "showReason", reason };
}
