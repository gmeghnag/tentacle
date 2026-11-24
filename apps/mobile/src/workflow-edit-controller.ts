/**
 * The phone's workflow EDITOR, as a controller (docs/feat/workflow-editor.md D7,
 * slice 6). Pure and injected (AGENTS §7): the screen draws `state()` and
 * forwards taps, so every rule below is tested with a fake session — the shape
 * mirrors `workflow-start-controller.ts`.
 *
 * - **States:** `loading → editing(draft, history, problems, dirty) →
 *   reviewing(preview) → saving → saved(hash, version)`, plus the four screens
 *   that keep a person from hunting for an editor that cannot work: `broken`
 *   (the file on disk does not validate), `unreadable`, `unsupported` (an older
 *   daemon) and `unavailable` (a pod's session), and the two the attach can end
 *   in (`ended`, `failed`).
 * - **Save → review → write.** Save runs `workflowSave{dryRun:true}`: it returns
 *   every file, patch, hash, version and note and writes NOTHING, and its answer
 *   is what Review draws. Confirm then sends `dryRun:false` with `baseHash` —
 *   the hash the file had when it was opened.
 * - **Save is off** when the link is down, when the draft has a problem (the bar
 *   shows the first, verbatim, with its YAML path), or when nothing changed.
 *   The reason is always a string (`saveOff`), never an empty modal.
 * - **A refusal branches on its WORD**, never on its sentence: `changed` keeps
 *   the draft and offers Reload / Keep editing; `exists` names the file to
 *   rename; `invalid` puts the validator's errors back on the bar. Nothing is
 *   re-sent automatically.
 * - **Disconnect mid-save is decided by the hash on reconnect** (`reconnectOutcome`),
 *   which is exact because the emitter is deterministic: the preview's hash IS
 *   the hash of the bytes a write produces. If it landed, the baseline is the
 *   snapshot that was SENT (edits made since stay dirty); Save is off until it
 *   is decided, and it is checked at once when the link is (still) up.
 * - Nothing lands after `dispose`, and `leave` runs only when this screen was the
 *   one that opened the session.
 */
import type { WorkflowSaveRequest } from "@tentacle/client";
import {
  type DraftEdit,
  type DraftPrompts,
  EditHistory,
  type InsertAt,
  type StepKind,
  type StepPatch,
  WORKFLOW_TEMPLATES,
  type WorkflowDraft,
  type WorkflowInput,
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
} from "@tentacle/core";
import {
  WORKFLOW_PROMPTS_MAX,
  WorkflowNameSchema,
  type WorkflowSaveResult,
  type WorkflowSourceResult,
} from "@tentacle/protocol";
import type { SessionOpenFailure } from "./session-controller.ts";
import { SESSION_ENDED } from "./workflow-run-controller.ts";

/** What an older daemon (no `workflow_source` / `workflow_save`) gets. */
export const EDIT_UPDATE_TENTACLE = "Update tentacle on this computer";
/** The `unreadable` / `broken` screen's one line of advice, after the errors verbatim. */
export const EDIT_FIX_ELSEWHERE = "Fix it on the computer or ask the model";
/** Save off while the link is down: the draft is on this phone and stays there. */
export const EDIT_OFFLINE = "Offline — your draft stays on this phone";
/** The banner a `changed` refusal raises; the draft is kept, never overwritten. */
export const EDIT_CHANGED = "Changed on the computer";
/** A save whose answer never arrived: the reconnect checks, it is never re-sent. */
export const EDIT_SAVE_INTERRUPTED = "The save was interrupted — reconnecting will check";
/** Save off while a lost save is undecided: a second write would race the first. */
export const EDIT_SAVE_PENDING = "Checking whether the last save landed";
/** Save off with nothing to save. */
export const EDIT_NOTHING_TO_SAVE = "Nothing to save yet";
/** The New sheet never chose a starting point (the editor's own first frame). */
export const EDIT_NO_TEMPLATE = "No template was chosen";

const ENDED: readonly SessionOpenFailure[] = ["archived", "deleted", "gone"];

/** The subset of `RemoteSession` this screen drives (a seam: tests use a fake). */
export interface EditSessionHandle {
  /** `RemoteSession.workflowSource()` (`packages/client/src/remote-session.ts:1388`). */
  workflowSource(name: string): Promise<WorkflowSourceResult | { unsupported: true }>;
  /** `RemoteSession.workflowSave()` (`packages/client/src/remote-session.ts:1411`). */
  workflowSave(request: WorkflowSaveRequest): Promise<WorkflowSaveResult | { unsupported: true }>;
}

/** What a save landed, once it did. */
export interface EditSaved {
  readonly hash: string;
  readonly version: number;
  readonly path: string;
}

/** The editor's state, as the screen draws it. */
export interface EditState {
  /**
   * `opening` before the session is attached, `loading` while the first read is
   * in flight, then the editing cycle, then the states that say why there is no
   * editor at all.
   */
  readonly kind:
    | "opening"
    | "loading"
    | "editing"
    | "reviewing"
    | "saving"
    | "saved"
    | "broken"
    | "unreadable"
    | "unsupported"
    | "unavailable"
    | "ended"
    | "failed";
  /** The file stem this editor writes (`null` until the New sheet named one). */
  readonly name: string | null;
  /** `create` refuses an existing file; `replace` requires `baseHash` to still be the file's. */
  readonly mode: "create" | "replace";
  readonly draft: WorkflowDraft | null;
  /** The prompt files the editor holds, by path. */
  readonly prompts: DraftPrompts;
  /** The validator's sentences (`draftProblems`), the daemon's own words. */
  readonly problems: readonly string[];
  /** Changed since it was opened (a created draft starts dirty: it is not on disk). */
  readonly dirty: boolean;
  /** Why Save is off right now (`null` = it is on). Always a string on the bar. */
  readonly saveOff: string | null;
  /** The `dryRun:true` answer: exactly what Review draws. */
  readonly preview: WorkflowSaveResult | null;
  /** What the write landed (the Run button pins this hash). */
  readonly saved: EditSaved | null;
  /** "Changed on the computer": the draft is KEPT and Reload / Keep editing is offered. */
  readonly changed: boolean;
  /** A refusal's sentence, or a notice: one line, never a modal. */
  readonly notice: string | null;
  /** The `broken` / `unreadable` screen's lines, verbatim from the daemon. */
  readonly errors: readonly string[];
  /** Why the file cannot be edited at all (`unreadable` / `broken`). */
  readonly reason: string | null;
  /** The file already holds the emitter's bytes: false = a save rewrites its layout. */
  readonly canonical: boolean | null;
  /** The link is down: editing continues, Save does not. */
  readonly offline: boolean;
  /** Undo / redo are offered (`EditHistory`). */
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** The session's pickers (model and agent-type NAMES only, AGENTS §7). */
  readonly context: {
    readonly models?: readonly string[];
    readonly agentTypes?: readonly string[];
  } | null;
}

export interface WorkflowEditDeps {
  readonly sessionId: string;
  /** The session runtime's `open` — never `reopen`. */
  readonly open: (
    sessionId: string,
  ) => Promise<
    | { readonly ok: true; readonly session: EditSessionHandle }
    | { readonly ok: false; readonly reason: SessionOpenFailure }
  >;
  readonly leave: () => void;
  /** Another screen already follows this session: never `leave` it. */
  readonly borrowed: boolean;
  /** The name to edit; ABSENT opens the create flow (the New sheet names the file). */
  readonly name?: string;
  readonly onChange?: () => void;
}

export interface WorkflowEditController {
  state(): EditState;
  /** The screen is shown: attach and read (a create reads only the picker vocabulary). */
  start(): void;
  /** A create: build the draft and its prompts from a template, before or after `start`. */
  create(
    templateId: string,
    name: string,
    description?: string,
    inputs?: Readonly<Record<string, WorkflowInput>>,
  ): void;
  /** Rename the FILE (the `exists` refusal's repair). Create mode only. */
  renameFile(name: string): void;
  /**
   * Apply one of `@tentacle/core`'s edit operations; its refusal lands on the
   * bar. The `DraftEdit` comes back so the menu can read `dangling` ("N links
   * point here") without computing it twice.
   */
  edit(change: (draft: WorkflowDraft, prompts: DraftPrompts) => DraftEdit): DraftEdit | null;
  insert(at: InsertAt, kind: StepKind, seed?: string): void;
  rename(id: string, newId: string): void;
  remove(id: string): void;
  duplicate(id: string): void;
  move(id: string, by: number): void;
  setNext(id: string, target: string | undefined): void;
  setFail(id: string, target: string | "stop", max?: number): void;
  setRetry(id: string, retry: number): void;
  setGotoMax(id: string, max: number): void;
  patch(id: string, patch: StepPatch): void;
  prompt(id: string, prompt: { readonly path: string } | { readonly text: string }): void;
  undo(): void;
  redo(): void;
  /** Save → the `dryRun:true` preview (nothing is written). No-op while Save is off. */
  beginReview(): void;
  /** Back from Review to the draft, with nothing sent. */
  cancelReview(): void;
  /** Review's confirm: the `dryRun:false` write, with `baseHash`. */
  confirmSave(): void;
  /** `changed` → Reload: discard the draft and read the file again (the caller confirms first). */
  reload(): void;
  /** `changed` → Keep editing: the banner goes, the draft stays (the next save is `changed` again). */
  keepEditing(): void;
  /** "Discard N changes?" — null when there is nothing to discard. */
  discardPrompt(): string | null;
  /** The Cancel tap confirmed: the draft is dropped (a started run is never touched). */
  discard(): void;
  /** The link went up or down (`ComputerLink.onStatus`); coming back re-checks a lost save. */
  setLink(up: boolean): void;
  canSave(): boolean;
  canConfirm(): boolean;
  canRun(): boolean;
  dispose(): void;
}

/** A whole editor state, the unit `EditHistory` undoes (they are immutable ops). */
interface Snapshot {
  readonly draft: WorkflowDraft;
  readonly prompts: DraftPrompts;
}

/** "Discard 3 changes?" — one edit is still one change (mockup wording). */
export function discardText(changes: number): string {
  return `Discard ${changes} ${changes === 1 ? "change" : "changes"}?`;
}

/** "Saved .tentacle/workflows/demo.yaml · v2 · 1a2b3c4d", the toast a landed save raises. */
export function savedToast(saved: EditSaved): string {
  return `Saved ${saved.path} · v${saved.version} · ${saved.hash.slice(0, 8)}`;
}

/** "A workflow (or prompt file) named demo exists" — the `exists` refusal, by name. */
export function existsNotice(name: string): string {
  return `A workflow (or prompt file) named ${name} exists`;
}

/**
 * What a reconnect means, from the file's hash alone (D7's "exact" rule): the
 * preview hash IS the bytes' hash (a deterministic emitter), so
 * - it landed (`hash === preview`);
 * - it did not (`hash` is still the base, or — a create — nothing is there);
 * - or someone else wrote in the meantime (`changed`).
 */
export function reconnectOutcome(input: {
  readonly baseHash: string | null;
  readonly previewHash: string;
  /** The hash the re-read reported; absent when the file does not validate or is gone. */
  readonly hash: string | undefined;
  /** Whether the re-read found any file at all (`text` present). */
  readonly exists: boolean;
}): "saved" | "editing" | "changed" {
  if (input.hash === input.previewHash) {
    return "saved";
  }
  if (input.baseHash !== null) {
    return input.hash === input.baseHash ? "editing" : "changed";
  }
  // A create: the file is there only if the write landed, which the first
  // branch already answered — so nothing on disk means it did not.
  return input.exists ? "changed" : "editing";
}

/**
 * Why Save is off, in the bar's order: the link first (nothing travels), then a
 * problem (the first one, verbatim, with its YAML path), then nothing to save.
 */
export function saveOffReason(input: {
  readonly offline: boolean;
  readonly problems: readonly string[];
  readonly dirty: boolean;
  /** A lost save is still undecided (the hash has not been read yet). */
  readonly pending?: boolean;
}): string | null {
  if (input.offline) {
    return EDIT_OFFLINE;
  }
  if (input.pending === true) {
    return EDIT_SAVE_PENDING;
  }
  const first = input.problems[0];
  if (first !== undefined) {
    return first;
  }
  return input.dirty ? null : EDIT_NOTHING_TO_SAVE;
}

/** The prompt files the draft's agent steps read, in draft order, deduplicated. */
function referencedPrompts(draft: WorkflowDraft): string[] {
  const steps = Array.isArray(draft.steps) ? draft.steps : [];
  const paths: string[] = [];
  for (const step of steps) {
    const agent = (step as { agent?: unknown } | null)?.agent;
    const prompt = (agent as { prompt?: unknown } | null | undefined)?.prompt;
    if (typeof prompt === "string" && !paths.includes(prompt)) {
      paths.push(prompt);
    }
  }
  return paths;
}

/** Why a file name is refused: the ONE sentence the New sheet and a rename both show. */
export const EDIT_NAME_RULE = "Use lowercase letters, digits and single hyphens (at most 64)";

/** A name the wire accepts (`WorkflowNameSchema`), checked here so Save can say why. */
export function nameProblem(name: string): string | null {
  return WorkflowNameSchema.safeParse(name).success ? null : EDIT_NAME_RULE;
}

export function createWorkflowEditController(deps: WorkflowEditDeps): WorkflowEditController {
  const creating = deps.name === undefined;
  let phase: EditState["kind"] = "opening";
  let name: string | null = deps.name ?? null;
  let mode: "create" | "replace" = creating ? "create" : "replace";
  let history: EditHistory<Snapshot> | null = null;
  let baseline: Snapshot | null = null;
  let problems: readonly string[] = [];
  let saveOff: string | null = null;
  let preview: WorkflowSaveResult | null = null;
  let saved: EditSaved | null = null;
  let changedOnDisk = false;
  let notice: string | null = null;
  let errors: readonly string[] = [];
  let reason: string | null = null;
  let canonical: boolean | null = null;
  let offline = false;
  let context: EditState["context"] = null;
  /** The hash the file had when it was opened (`null` on a create): the wire's `baseHash`. */
  let baseHash: string | null = null;
  /** Edits applied since it was opened / last saved (the "N changes" count). */
  let changes = 0;
  /**
   * A save whose answer never arrived: the hash decides, nothing is re-sent.
   * `sent` is the snapshot that write carried — the baseline if it landed — and
   * `changesAtSend` the count then, so edits made since stay counted.
   */
  let interrupted: {
    readonly previewHash: string;
    readonly sent: Snapshot;
    readonly changesAtSend: number;
  } | null = null;
  /** A `checkInterrupted` read is in flight (one at a time). */
  let checking = false;
  /** A link-up arrived while `checking`: if that read fails, check again. */
  let recheck = false;
  let created = false;
  let session: EditSessionHandle | null = null;
  let opened = false;
  let disposed = false;
  let reading = false;
  let writing = false;

  const changed = () => deps.onChange?.();

  function draft(): WorkflowDraft | null {
    return history?.current.draft ?? null;
  }

  function prompts(): DraftPrompts {
    return history?.current.prompts ?? {};
  }

  function dirty(): boolean {
    const current = history?.current;
    if (current === undefined) {
      return false;
    }
    // A create is never on disk, so it is changed by definition (`asDraft` drops
    // the defaults, so a loaded file compares equal to itself).
    if (baseline === null) {
      return true;
    }
    return JSON.stringify(current.draft) !== JSON.stringify(baseline.draft);
  }

  function state(): EditState {
    const current = history;
    const isDirty = dirty();
    return {
      kind: phase,
      name,
      mode,
      draft: current?.current.draft ?? null,
      prompts: current?.current.prompts ?? {},
      problems,
      dirty: isDirty,
      saveOff,
      preview,
      saved,
      changed: changedOnDisk,
      notice,
      errors,
      reason,
      canonical,
      offline,
      canUndo: current?.canUndo ?? false,
      canRedo: current?.canRedo ?? false,
      context,
    };
  }

  /** Recompute the bar and Save's gate for whatever the draft is now. */
  function refresh(): void {
    const current = history?.current;
    if (current === undefined) {
      problems = [];
      saveOff = null;
      return;
    }
    problems = draftProblems(current.draft, current.prompts, {
      ...(name !== null ? { name } : {}),
      ...(context?.models !== undefined ? { models: context.models } : {}),
      ...(context?.agentTypes !== undefined ? { agentTypes: context.agentTypes } : {}),
    });
    saveOff = saveOffReason({ offline, problems, dirty: dirty(), pending: interrupted !== null });
  }

  function commit(next: Snapshot): void {
    if (history === null) {
      history = new EditHistory<Snapshot>(next);
    } else {
      history.push(next);
    }
  }

  /**
   * The one door every edit goes through: record it, bump the version on the
   * FIRST edit of a loaded file (the mockup's "the version goes up by itself"),
   * recompute the bar. A refusal leaves the draft untouched and says why.
   */
  function apply(
    change: (draft: WorkflowDraft, prompts: DraftPrompts) => DraftEdit,
  ): DraftEdit | null {
    const current = history?.current;
    if (current === undefined || phase !== "editing") {
      return null;
    }
    const result = change(current.draft, current.prompts);
    const nextPrompts = result.prompts ?? current.prompts;
    if (result.refused !== undefined) {
      notice = result.refused;
      refresh();
      changed();
      return result;
    }
    const bumped =
      mode !== "create" && changes === 0
        ? { ...result.draft, version: nextVersion(versionOf(current.draft)) }
        : result.draft;
    commit({ draft: bumped, prompts: nextPrompts });
    changes += 1;
    changedOnDisk = false;
    notice = null;
    refresh();
    changed();
    return result;
  }

  function versionOf(value: WorkflowDraft): number {
    const version = value.version;
    return typeof version === "number" ? version : 0;
  }

  /** Land a fresh read: the draft, its prompts, the base hash, the bar. */
  function land(result: WorkflowSourceResult): void {
    context = result.context ?? null;
    if (result.unavailable !== undefined) {
      phase = "unavailable";
      reason = result.unavailable;
      changed();
      return;
    }
    if (creating) {
      // The probe only ever lends its picker vocabulary: the draft is the
      // template's, even when the name already exists (the save says `exists`).
      phase = history === null ? "loading" : "editing";
      refresh();
      changed();
      return;
    }
    if (result.unreadable !== undefined) {
      phase = "unreadable";
      reason = result.unreadable;
      errors = [];
      changed();
      return;
    }
    const raw = result.draft;
    if (raw === undefined) {
      // Structurally not a workflow: the daemon said why in `unreadable`.
      phase = "unreadable";
      reason = result.unreadable ?? "This file is not a workflow";
      changed();
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      phase = "unreadable";
      reason = "The draft arrived unreadable";
      changed();
      return;
    }
    const draft = parsed as WorkflowDraft;
    const held: Record<string, string> = {};
    for (const file of result.prompts ?? []) {
      held[file.path] = file.text;
    }
    history = new EditHistory<Snapshot>({ draft, prompts: held });
    baseline = { draft, prompts: held };
    changes = 0;
    canonical = result.canonical ?? null;
    errors = [];
    reason = null;
    baseHash = result.hash ?? null;
    mode = "replace";
    // A file that does not VALIDATE has no hash, and a `replace` save cannot
    // repair it: the writer's base check needs the file on disk to hash to
    // something (`.tentacle/tmp/workflow-editor/s6/broken-base.ts` — it answers
    // `changed` forever). So the editor says so instead of offering an edit that
    // can never be saved; the fix belongs on the computer (or to the model).
    if (baseHash === null) {
      phase = "broken";
      errors = result.errors ?? [];
      reason = result.errors?.[0] ?? "This file does not validate";
      refresh();
      changed();
      return;
    }
    phase = "editing";
    refresh();
    changed();
  }

  /** Both modes: read the picker vocabulary; a `replace` also reads the file. */
  function read(target: string): void {
    if (session === null || reading) {
      return;
    }
    reading = true;
    if (history === null) {
      phase = "loading";
    }
    changed();
    void session
      .workflowSource(target)
      .then((result) => {
        if (disposed) {
          return;
        }
        if ("unsupported" in result) {
          phase = "unsupported";
          changed();
          return;
        }
        land(result);
      })
      .catch((err: unknown) => {
        if (disposed) {
          return;
        }
        const text = err instanceof Error ? err.message : String(err);
        if (history === null) {
          phase = "failed";
          reason = `Could not read the workflow (${text})`;
        } else {
          notice = `Could not read the workflow (${text})`;
        }
        changed();
      })
      .finally(() => {
        reading = false;
      });
  }

  /** The write, `dryRun` true or false: one path, one set of refusal branches. */
  function canConfirmNow(): boolean {
    return (
      phase === "reviewing" &&
      preview !== null &&
      preview.ok &&
      preview.hash !== undefined &&
      !writing
    );
  }

  function send(dryRun: boolean): void {
    const current = history?.current;
    if (session === null || current === undefined || name === null || writing) {
      return;
    }
    const promptPaths = referencedPrompts(current.draft);
    if (promptPaths.length > WORKFLOW_PROMPTS_MAX) {
      notice = `Too many prompt files (${promptPaths.length}, at most ${WORKFLOW_PROMPTS_MAX})`;
      changed();
      return;
    }
    const request: WorkflowSaveRequest = {
      name,
      mode,
      draft: JSON.stringify(current.draft),
      prompts: promptPaths
        .filter((path) => Object.hasOwn(current.prompts, path))
        .map((path) => ({ path, text: current.prompts[path] as string })),
      ...(baseHash !== null ? { baseHash } : {}),
      dryRun,
    };
    const changesAtSend = changes;
    writing = true;
    notice = null;
    if (!dryRun) {
      phase = "saving";
    }
    changed();
    void session
      .workflowSave(request)
      .then((result) => {
        if (disposed) {
          return;
        }
        writing = false;
        if ("unsupported" in result) {
          phase = "unsupported";
          changed();
          return;
        }
        if (dryRun) {
          takePreview(result);
          return;
        }
        takeWrite(result);
      })
      .catch((err: unknown) => {
        if (disposed) {
          return;
        }
        writing = false;
        if (dryRun) {
          // A lost PREVIEW (`dryRun`) wrote nothing: back to editing, Review again.
          phase = "editing";
          notice = `The review did not answer (${err instanceof Error ? err.message : String(err)})`;
          refresh();
          changed();
          return;
        }
        // A save whose answer never arrived is NEVER re-sent: the file is read
        // and the hash decides which of the three it was — at once when the
        // link is (still) up, else when it comes back. Save is off till then.
        interrupted = { previewHash: preview?.hash ?? "", sent: current, changesAtSend };
        phase = "editing";
        notice = `${EDIT_SAVE_INTERRUPTED} (${err instanceof Error ? err.message : String(err)})`;
        refresh();
        changed();
        if (!offline) {
          checkInterrupted();
        }
      });
  }

  /** Review's answer: a preview, or the refusal that stops it before the write. */
  function takePreview(result: WorkflowSaveResult): void {
    if (result.ok && result.hash !== undefined) {
      preview = result;
      phase = "reviewing";
      errors = [];
      notice = null;
      changed();
      return;
    }
    preview = null;
    afterRefusal(result);
  }

  function takeWrite(result: WorkflowSaveResult): void {
    if (result.ok) {
      const current = history?.current;
      const hash = result.hash;
      if (current !== undefined && hash !== undefined) {
        // The file on disk is now these bytes: the next save replaces them, and
        // the base hash is the one just written.
        baseline = current;
        baseHash = hash;
        mode = "replace";
        changes = 0;
        canonical = true;
      }
      preview = null;
      interrupted = null;
      phase = "saved";
      saved =
        hash === undefined
          ? null
          : {
              hash,
              version: result.version ?? versionOf(current?.draft ?? {}),
              path: result.path ?? `${name ?? ""}.yaml`,
            };
      errors = [];
      notice = null;
      refresh();
      changed();
      return;
    }
    afterRefusal(result);
  }

  /**
   * A refusal, by its WORD (D7's outcomes): `changed` keeps the draft and offers
   * Reload / Keep editing, `exists` names the file to rename, `invalid` puts the
   * errors back on the bar, `unavailable` is its own screen.
   */
  function afterRefusal(result: WorkflowSaveResult): void {
    const refusal = result.refusal;
    if (refusal === "changed") {
      phase = "editing";
      changedOnDisk = true;
      notice = null;
      refresh();
      changed();
      return;
    }
    if (refusal === "unavailable") {
      phase = "unavailable";
      reason = result.reason ?? null;
      changed();
      return;
    }
    phase = "editing";
    if (refusal === "exists") {
      errors = [];
      notice = existsNotice(name ?? result.path ?? "this file");
    } else {
      errors = result.errors ?? [];
      notice = result.reason ?? result.errors?.[0] ?? "This draft cannot be saved";
    }
    refresh();
    changed();
  }

  /** A rename of the FILE (create mode's `exists` repair): the draft's name follows. */
  function renameFile(next: string): void {
    if (mode !== "create") {
      return;
    }
    const why = nameProblem(next);
    if (why !== null) {
      notice = why;
      changed();
      return;
    }
    name = next;
    const current = history?.current;
    if (current !== undefined) {
      const draft = { ...current.draft, name: next };
      history = new EditHistory<Snapshot>({ draft, prompts: current.prompts });
    }
    notice = null;
    refresh();
    changed();
  }

  return {
    state,
    start() {
      void deps.open(deps.sessionId).then((result) => {
        if (disposed) {
          if (result.ok && !deps.borrowed) {
            deps.leave();
          }
          return;
        }
        if (!result.ok) {
          const ended = ENDED.includes(result.reason);
          phase = ended ? "ended" : "failed";
          reason = ended ? SESSION_ENDED : `Could not open the session (${result.reason})`;
          changed();
          return;
        }
        opened = true;
        session = result.session;
        if (name === null) {
          phase = "failed";
          reason = EDIT_NO_TEMPLATE;
          changed();
          return;
        }
        read(name);
      });
    },
    create(templateId, nextName, description = "", inputs = {}) {
      const template = WORKFLOW_TEMPLATES.find((entry) => entry.id === templateId);
      const why = nameProblem(nextName);
      if (template === undefined || why !== null) {
        notice = template === undefined ? `No template "${templateId}"` : why;
        changed();
        return;
      }
      name = nextName;
      mode = "create";
      baseHash = null;
      created = true;
      const held: Record<string, string> = {};
      for (const path of referencedPrompts(template.draft(nextName, description, inputs))) {
        if (Object.hasOwn(template.prompts, path)) {
          held[path] = template.prompts[path] as string;
        }
      }
      history = new EditHistory<Snapshot>({
        draft: template.draft(nextName, description, inputs),
        prompts: held,
      });
      baseline = null;
      changes = 0;
      canonical = null;
      if (phase === "loading" || phase === "failed") {
        phase = "editing";
      }
      refresh();
      changed();
    },
    renameFile,
    edit(change) {
      return apply(change);
    },
    insert(at, kind, seed = "") {
      apply((draft) => insertStep(draft, at, kind, seed));
    },
    rename(id, newId) {
      apply((draft, prompts) => renameStep(draft, id, newId, prompts));
    },
    remove(id) {
      apply((draft, prompts) => deleteStep(draft, id, prompts));
    },
    duplicate(id) {
      apply((draft) => duplicateStep(draft, id));
    },
    move(id, by) {
      apply((draft) => moveStep(draft, id, by));
    },
    setNext(id, target) {
      apply((draft) => setNext(draft, id, target));
    },
    setFail(id, target, max) {
      apply((draft) => setFailTarget(draft, id, target, max));
    },
    setRetry(id, retry) {
      apply((draft) => setRetry(draft, id, retry));
    },
    setGotoMax(id, max) {
      apply((draft) => setGotoMax(draft, id, max));
    },
    patch(id, stepPatch) {
      apply((draft) => patchStep(draft, id, stepPatch));
    },
    prompt(id, promptChange) {
      apply((draft) => setPrompt(draft, id, promptChange));
    },
    undo() {
      if (history === null || phase !== "editing") {
        return;
      }
      history.undo();
      notice = null;
      refresh();
      changed();
    },
    redo() {
      if (history === null || phase !== "editing") {
        return;
      }
      history.redo();
      notice = null;
      refresh();
      changed();
    },
    beginReview() {
      if (phase !== "editing" || saveOff !== null || writing || interrupted !== null) {
        return;
      }
      send(true);
    },
    cancelReview() {
      if (phase !== "reviewing") {
        return;
      }
      preview = null;
      phase = "editing";
      changed();
    },
    confirmSave() {
      if (!canConfirmNow()) {
        return;
      }
      send(false);
    },
    reload() {
      if (name === null) {
        return;
      }
      changedOnDisk = false;
      history = null;
      baseline = null;
      // A fresh read supersedes a lost save's question (its hash is the new base).
      interrupted = null;
      preview = null;
      saved = null;
      changes = 0;
      notice = null;
      phase = "loading";
      read(name);
    },
    keepEditing() {
      changedOnDisk = false;
      changed();
    },
    discardPrompt() {
      const isDirty = dirty();
      if (!isDirty || phase === "saved" || phase === "saving") {
        return null;
      }
      return discardText(Math.max(1, changes));
    },
    discard() {
      if (baseline === null) {
        // A create: there is no file to go back to, so the draft goes with it.
        history = null;
        changes = 0;
        problems = [];
        saveOff = null;
        preview = null;
        changed();
        return;
      }
      history = new EditHistory<Snapshot>(baseline);
      changes = 0;
      preview = null;
      changedOnDisk = false;
      notice = null;
      refresh();
      changed();
    },
    setLink(up) {
      offline = !up;
      // Any "up" re-checks a lost save still undecided — after a down, or a
      // relay reconnect this screen never saw as down. An ordinary one re-reads
      // nothing (`checkInterrupted` returns at once with no lost save).
      if (up) {
        checkInterrupted();
        return;
      }
      refresh();
      changed();
    },
    canSave() {
      return phase === "editing" && saveOff === null;
    },
    canConfirm: canConfirmNow,
    canRun() {
      return phase === "saved" && saved !== null;
    },
    dispose() {
      disposed = true;
      if (opened && !deps.borrowed) {
        deps.leave();
      }
      opened = false;
      session = null;
    },
  };

  /**
   * The link came back: a save whose answer was lost is decided by the file's
   * hash (`reconnectOutcome`) — landed, still dirty, or changed. Nothing else
   * re-reads (an ordinary reconnect leaves the draft alone).
   */
  function checkInterrupted(): void {
    const lost = interrupted;
    if (lost !== null && checking) {
      // The read in flight may be on the link that just died: remember this
      // up, so a failure of that read checks again instead of waiting for
      // another link flap.
      recheck = true;
    }
    if (lost === null || checking || session === null || name === null) {
      refresh();
      changed();
      return;
    }
    // `interrupted` stays set (Save stays off) until the hash has decided.
    checking = true;
    recheck = false;
    void session
      .workflowSource(name)
      .then((result) => {
        checking = false;
        // Disposed, or a Reload superseded the question while this was in flight.
        if (disposed || interrupted !== lost) {
          return;
        }
        interrupted = null;
        if ("unsupported" in result) {
          phase = "unsupported";
          changed();
          return;
        }
        if (result.unavailable !== undefined) {
          phase = "unavailable";
          reason = result.unavailable;
          changed();
          return;
        }
        const outcome = reconnectOutcome({
          baseHash,
          previewHash: lost.previewHash,
          hash: result.hash,
          exists: result.text !== undefined,
        });
        if (outcome === "saved") {
          const hash = result.hash ?? lost.previewHash;
          saved = {
            hash,
            version: result.version ?? versionOf(draft() ?? {}),
            path: result.path ?? `${name ?? ""}.yaml`,
          };
          // The disk holds what was SENT — not edits made since (offline
          // editing continues): those stay dirty against it.
          baseline = lost.sent;
          baseHash = hash;
          mode = "replace";
          canonical = true;
          if (dirty()) {
            changes = Math.max(1, changes - lost.changesAtSend);
            phase = "editing";
            notice = "The save landed — your later edits are not saved yet";
          } else {
            changes = 0;
            phase = "saved";
            notice = null;
          }
        } else if (outcome === "editing") {
          phase = "editing";
          notice = "It did not land — your draft is still here";
        } else {
          phase = "editing";
          changedOnDisk = true;
        }
        refresh();
        changed();
      })
      .catch((err: unknown) => {
        checking = false;
        if (disposed || interrupted !== lost) {
          return;
        }
        // The link is still not good enough: the decision stays pending (Save
        // off) and the next link-up checks again — at once if one already
        // arrived while this read was in flight (never a retry loop otherwise).
        notice = `Could not check the save (${err instanceof Error ? err.message : String(err)})`;
        if (recheck && !offline) {
          recheck = false;
          checkInterrupted();
          return;
        }
        refresh();
        changed();
      });
  }
}

/** The prompt paths a draft's agent steps read (`referencedPrompts` in the send path). */
export { referencedPrompts };
