/**
 * The phone's "Start a workflow" screen, as a controller
 * (docs/feat/workflows-ui.md D6, slice 5b). Pure and injected (AGENTS §7): the
 * screen draws `state()` and forwards taps, so every rule below is tested with
 * fakes — the shape mirrors `workflow-run-controller.ts`.
 *
 * - **The attach** is the SAME session runtime as every other screen
 *   (`session-runtimes.ts`): `open(sessionId)`, never with `reopen` (only an
 *   explicit Reopen revives an archived session, §7), and a session another
 *   screen already follows is BORROWED — leaving never detaches it from under
 *   that screen. A session that ended says "This session has ended".
 * - **The catalogue** is read once the session is open, and again on a pull or
 *   after a `changed` refusal. ONE read in flight; a pull during a read is ONE
 *   more read after it. A failed read keeps the last catalogue and says so —
 *   never a spinner that never ends.
 * - **Start** is gated on the form alone (`canStart`): a ready session, a valid
 *   row, a hash to pin, no problems and no start already in flight. The daemon
 *   still decides (its `inputsProblem` is the authority).
 * - **A refusal branches on its WORD** (`afterRefusal`): `changed` re-reads the
 *   catalogue and KEEPS the values of the inputs that still exist (dropping the
 *   rest) with "This workflow changed — review it again"; `running` shows
 *   "Workflow X is already running" AND opens that run; anything else is the
 *   daemon's own reason. Nothing is re-sent automatically.
 * - Nothing lands after `dispose`, and `leave` runs only when this screen was the
 *   one that opened the session.
 */
import type { WorkflowAction } from "@tentacle/client";
import type { WorkflowCatalogueResult, WorkflowResult } from "@tentacle/protocol";
import type { SessionOpenFailure } from "./session-controller.ts";
import { SESSION_ENDED } from "./workflow-run-controller.ts";
import {
  type CatalogueEntry,
  type CatalogueView,
  type FormProblem,
  LOADING_CATALOGUE,
  type StartParams,
  afterRefusal,
  catalogueRows,
  formFor,
  formProblems,
  openEntry,
  runningNotice,
  startBannerChanged,
  startParams,
} from "./workflow-start.ts";

/**
 * The subset of `RemoteSession` this screen drives (a seam: tests use a fake).
 * Both methods are the session's own, so no screen ever dials a second path.
 */
export interface StartSessionHandle {
  /** `RemoteSession.workflowCatalogue()` (`packages/client/src/remote-session.ts:1333`). */
  workflowCatalogue(): Promise<WorkflowCatalogueResult | { unsupported: true }>;
  /** `RemoteSession.workflow()`, the SAME action `session/workflow` takes. */
  workflow(action: WorkflowAction): Promise<WorkflowResult | { ok: false; reason: string }>;
}

export interface StartState {
  /**
   * `opening` before the session is attached, `loading` while the first catalogue
   * read is in flight, `ready` once it answered (even with no rows), and then the
   * four states that keep a person from hunting for a row that cannot exist:
   * `unsupported` (an older daemon), `unavailable` (a pod's session), `ended`
   * (the session went away) and `failed` (the link).
   */
  readonly kind:
    | "opening"
    | "loading"
    | "ready"
    | "unsupported"
    | "unavailable"
    | "ended"
    | "failed";
  /** The catalogue, or null until it answered (`LOADING_CATALOGUE` while it does). */
  readonly catalogue: CatalogueView | null;
  /** The ended/failed reason, else null. */
  readonly error: string | null;
  /** The row whose form is open (its `key`), or null (the list). */
  readonly openKey: string | null;
  /** What has been typed, by input name. */
  readonly values: Readonly<Record<string, string>>;
  /** What the form can see is wrong (`formProblems`), a hint only. */
  readonly problems: readonly FormProblem[];
  /** "This workflow changed — review it again", after a `changed` refusal. */
  readonly banner: string | null;
  /** A refusal's reason (or an already-running notice), else null. */
  readonly notice: string | null;
  /** A start is in flight: Start is off until it answers. */
  readonly starting: boolean;
}

export interface WorkflowStartDeps {
  readonly sessionId: string;
  /** The session runtime's `open` — never `reopen`. */
  readonly open: (
    sessionId: string,
  ) => Promise<
    | { readonly ok: true; readonly session: StartSessionHandle }
    | { readonly ok: false; readonly reason: SessionOpenFailure }
  >;
  readonly leave: () => void;
  /** Another screen already follows this session: never `leave` it. */
  readonly borrowed: boolean;
  /** A start (or a `running` refusal) opened a run: navigate to it. */
  readonly onOpenRun: (runId: string, name: string) => void;
  readonly onChange?: () => void;
}

export interface WorkflowStartController {
  state(): StartState;
  /** The screen is shown: attach and read the catalogue once. */
  start(): void;
  /** Pull to refresh / re-read after a `changed` refusal. */
  pull(): void;
  /** Open a VALID row's form (a broken one has no form to open). */
  openRow(key: string): void;
  /** Back to the list (the form's values are kept for the same row). */
  closeRow(): void;
  setValue(name: string, value: string): void;
  canStart(): boolean;
  beginStart(): void;
  dispose(): void;
}

const ENDED: readonly SessionOpenFailure[] = ["archived", "deleted", "gone"];

export function createWorkflowStartController(deps: WorkflowStartDeps): WorkflowStartController {
  let phase: StartState["kind"] = "opening";
  let catalogue: CatalogueView | null = null;
  let error: string | null = null;
  let openKey: string | null = null;
  let values: Record<string, string> = {};
  let problems: readonly FormProblem[] = [];
  let banner: string | null = null;
  let notice: string | null = null;
  let starting = false;
  let session: StartSessionHandle | null = null;
  let opened = false;
  let disposed = false;
  /** One read in flight; a trigger during it is ONE more read after it. */
  let reading = false;
  let again = false;

  const changed = () => deps.onChange?.();

  /** The open row's entry, from the CURRENT catalogue (null when it left it). */
  function entry(): CatalogueEntry | null {
    return openKey === null ? null : openEntry(catalogue, openKey);
  }

  function state(): StartState {
    return {
      kind: phase,
      catalogue,
      error,
      openKey,
      values,
      problems,
      banner,
      notice,
      starting,
    };
  }

  /** Recompute the form's hint for whatever row is open (a closed form has none). */
  function refreshProblems(): void {
    const def = entry();
    problems = def === null ? [] : formProblems(def, values);
  }

  /**
   * A `changed` refusal's re-read: the NEW row's declared inputs are the values
   * that survive; anything the file no longer declares is dropped, so a stale
   * name is never sent. A row that vanished closes the form.
   */
  function keepSurvivingValues(): void {
    const def = entry();
    if (def === null) {
      openKey = null;
      values = {};
      problems = [];
      return;
    }
    const next: Record<string, string> = {};
    for (const field of formFor(def, values).fields) {
      next[field.name] = field.value;
    }
    values = next;
    refreshProblems();
  }

  function read(): void {
    if (session === null) {
      return;
    }
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    if (catalogue === null) {
      phase = "loading";
    }
    changed();
    void session
      .workflowCatalogue()
      .then((result) => {
        if (disposed) {
          return;
        }
        catalogue = catalogueRows(result);
        error = null;
        if (catalogue.kind === "unsupported") {
          phase = "unsupported";
        } else if (catalogue.kind === "unavailable") {
          phase = "unavailable";
        } else {
          phase = "ready";
        }
        // The form follows the new catalogue (a reload keeps what still exists).
        keepSurvivingValues();
        changed();
      })
      .catch((err: unknown) => {
        if (disposed) {
          return;
        }
        // A failed read KEEPS the last catalogue and says so: never a spinner.
        const text = err instanceof Error ? err.message : "could not read the workflows";
        notice = `Could not read the workflows (${text})`;
        if (catalogue === null) {
          phase = "failed";
          error = text;
        }
        changed();
      })
      .finally(() => {
        reading = false;
        if (again && !disposed) {
          again = false;
          read();
        }
      });
  }

  function reload(): void {
    // A `changed` refusal: re-read keeping the typed values, and say why.
    banner = startBannerChanged;
    notice = null;
    read();
  }

  function beginStart(): void {
    const def = entry();
    if (session === null || starting || def === null || !canStart()) {
      return;
    }
    const params: StartParams | null = startParams(def, values);
    if (params === null) {
      // No hash to pin: the daemon would re-read the file, so nothing is sent.
      notice = "This workflow cannot be started (it has no hash)";
      changed();
      return;
    }
    starting = true;
    banner = null;
    notice = null;
    changed();
    void session
      .workflow({ action: "start", ...params })
      .then((result) => {
        if (disposed) {
          return;
        }
        starting = false;
        if (result.ok) {
          if (result.runId === undefined) {
            notice = "The workflow was started, but the run's id did not arrive";
            changed();
            return;
          }
          deps.onOpenRun(result.runId, def.name);
          changed();
          return;
        }
        const next = afterRefusal(result);
        if (next.kind === "reload") {
          reload();
          return;
        }
        if (next.kind === "openRun") {
          notice = runningNotice(def.name);
          changed();
          deps.onOpenRun(next.runId, def.name);
          return;
        }
        notice = next.reason;
        changed();
      })
      .catch((err: unknown) => {
        if (disposed) {
          return;
        }
        starting = false;
        notice = `The start failed (${err instanceof Error ? err.message : String(err)})`;
        changed();
      });
  }

  function canStart(): boolean {
    const def = entry();
    return (
      phase === "ready" &&
      def !== null &&
      def.ok &&
      def.hash !== null &&
      !starting &&
      problems.length === 0
    );
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
          error = ended ? SESSION_ENDED : `Could not open the session (${result.reason})`;
          changed();
          return;
        }
        opened = true;
        session = result.session;
        read();
      });
    },
    pull() {
      read();
    },
    openRow(key) {
      // Only a VALID row has a form: a broken file is its errors and no Start.
      const def = openEntry(catalogue, key);
      if (def === null) {
        return;
      }
      openKey = key;
      banner = null;
      notice = null;
      values = Object.fromEntries(formFor(def, values).fields.map((f) => [f.name, f.value]));
      refreshProblems();
      changed();
    },
    closeRow() {
      openKey = null;
      problems = [];
      banner = null;
      changed();
    },
    setValue(name, value) {
      values = { ...values, [name]: value };
      refreshProblems();
      changed();
    },
    canStart,
    beginStart,
    dispose() {
      disposed = true;
      if (opened && !deps.borrowed) {
        deps.leave();
      }
      opened = false;
      session = null;
    },
  };
}

/** The view a screen shows before anything answered (its first frame). */
export const INITIAL_START_CATALOGUE: CatalogueView = LOADING_CATALOGUE;
