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
 *
 * The landing's actions (docs/feat/mobile-workflows-landing.md D7):
 * - **Every action asks `blockedWhy` first** (`workflow-landing.ts`, the gate the
 *   screen draws from): a dimmed action sends nothing.
 * - **Approve only RAISES the daemon's ask.** This controller never answers it:
 *   it watches the Session screen's sheet, and when that file's approval ask
 *   leaves it (answered, denied, withdrawn) «Asking…» ends and the catalogue is
 *   re-read — the read is the truth. An approved read, a pull or a reconnect end
 *   it too (an answer given elsewhere; tapping again raises no second ask). A
 *   Start or Delete of the same file meanwhile only covers «Asking…».
 * - **The ask is a banner here** (docs/fix/mobile-workflows-landing-v2.md D1):
 *   `ask` is what the sheet is not showing, and `reviewAsk` brings it up.
 * - **Delete is two steps**, and sends the hash seen when it was ASKED.
 */
import type { WorkflowAction } from "@tentacle/client";
import type {
  WorkflowApproveResult,
  WorkflowCatalogueResult,
  WorkflowDeleteResult,
  WorkflowResult,
} from "@tentacle/protocol";
import type { AskBannerView } from "./ask-park.ts";
import type { SessionOpenFailure } from "./session-controller.ts";
import {
  type LandingAct,
  type LandingBusy,
  blockedWhy,
  schedulesNotice,
} from "./workflow-landing.ts";
import { type AskSource, SESSION_ENDED } from "./workflow-run-controller.ts";
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
  needsValues,
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
  /** `RemoteSession.workflowApprove()`: raise one file's hash approval. */
  workflowApprove(
    name: string,
    hash: string,
  ): Promise<WorkflowApproveResult | { unsupported: true }>;
  /** `RemoteSession.workflowDelete()`: remove one file, pinned to what was seen. */
  workflowDelete(
    name: string,
    hash?: string,
  ): Promise<WorkflowDeleteResult | { unsupported: true }>;
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
  /** Actions in flight, by row key (`asking` lasts until the ask leaves the sheet). */
  readonly busy: Readonly<Record<string, LandingBusy>>;
  /** The banner of the session's pending ask that is not up here, or null. */
  readonly ask: AskBannerView | null;
  /** The row whose delete is being asked, or null. */
  readonly confirm: string | null;
  /** The daemon answered `unsupported` to an approve or a delete. */
  readonly actUnsupported: boolean;
  /** The link to the computer is down (`setOffline`). */
  readonly offline: boolean;
  /** A Session screen's sheet exists to answer an approval on. */
  readonly canAnswer: boolean;
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
  /**
   * This session's permission sheet, WATCHED and brought up, never answered: its
   * edge says an approval ask left the screen, `banner` is the ask not up here,
   * `unpark` brings its sheet. Absent/null = no Session screen, so Approve is off.
   */
  readonly asks?: Pick<AskSource, "current" | "subscribe" | "unpark" | "banner"> | null;
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
  /** An item's Start: at once when no input needs a value, else its form. */
  startNow(key: string): void;
  /** An item's Approve: raise the approval ask for the hash on screen. */
  approve(key: string): void;
  /** An item's Delete: ask first, nothing sent. */
  askDelete(key: string): void;
  cancelDelete(): void;
  /** The second step: send the delete that was asked about. */
  confirmDelete(key: string): void;
  /** The banner was tapped: bring the ask's sheet up. Sends the session nothing. */
  reviewAsk(): void;
  /** The link went down / came back; coming back re-reads. */
  setOffline(offline: boolean): void;
  dispose(): void;
}

const ENDED: readonly SessionOpenFailure[] = ["archived", "deleted", "gone"];

/** A refused delete's sentence: the daemon's own reason, on one line. */
function afterDeleteRefusal(reason: string | undefined): string {
  const next = afterRefusal(reason === undefined ? {} : { reason });
  return next.kind === "showReason" ? next.reason : "the delete was refused";
}

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
  /** Rows whose approval is being asked: «Asking…» until that ask leaves the sheet. */
  const asked = new Set<string>();
  /** A start or delete in flight, by row key; it covers «Asking…» while it lasts. */
  let flight: Record<string, "starting" | "deleting"> = {};
  /** The ask the banner shows (`asks.banner`). */
  let askView: AskBannerView | null = null;
  /** The delete being asked: its row, and the hash SEEN when it was asked. */
  let asking: { readonly key: string; readonly name: string; readonly hash?: string } | null = null;
  let actUnsupported = false;
  let offline = false;
  const asks = deps.asks ?? null;
  /** The approval ask on the sheet now: which file's, under which request id. */
  let onSheet: { readonly requestId: string; readonly name: string } | null = null;
  let unwatch: (() => void) | null = null;

  const changed = () => deps.onChange?.();

  function setFlight(key: string, value: "starting" | "deleting" | null): void {
    const next = { ...flight };
    if (value === null) {
      delete next[key];
    } else {
      next[key] = value;
    }
    flight = next;
  }

  function busy(): Record<string, LandingBusy> {
    const asking = [...asked].map((key) => [key, "asking"] as const);
    return { ...Object.fromEntries<LandingBusy>(asking), ...flight };
  }

  /** End every «Asking…» the predicate names. */
  function endAsking(match: (key: string) => boolean): void {
    for (const key of [...asked]) {
      if (match(key)) {
        asked.delete(key);
      }
    }
  }

  /** A row under `key`, valid or broken. */
  function rowAt(key: string): CatalogueEntry | null {
    return openEntry(catalogue, key) ?? catalogue?.invalid.find((e) => e.key === key) ?? null;
  }

  /** The one gate the screen draws from: may this action be sent now? */
  function usable(key: string, act: LandingAct): CatalogueEntry | null {
    const def = rowAt(key);
    if (session === null || def === null) {
      return null;
    }
    const blocked = blockedWhy(def, act, {
      offline,
      ready: phase === "ready",
      canAnswer: asks !== null,
      actUnsupported,
      starting,
      busy: busy(),
    });
    return blocked === null ? def : null;
  }

  /**
   * The sheet changed: the banner follows it, and an approval ask that LEFT it is
   * that file's falling edge. Only a change redraws (a streaming turn calls this
   * for every delta).
   */
  function sheetChanged(): void {
    const next = asks?.banner?.() ?? null;
    const redraw =
      next?.title !== askView?.title ||
      next?.originShort !== askView?.originShort ||
      next?.more !== askView?.more;
    askView = next;
    const ask = asks?.current() ?? null;
    const left = onSheet !== null && ask?.requestId !== onSheet.requestId ? onSheet : null;
    // A file's approval has no run (`approval:<name>`): exactly what Approve raises.
    const agent = ask?.agent?.id;
    onSheet =
      ask !== null &&
      ask.origin?.kind === "workflow" &&
      ask.origin.runId === null &&
      agent?.startsWith("approval:") === true
        ? { requestId: ask.requestId, name: agent.slice("approval:".length) }
        : null;
    if (left !== null) {
      endAsking((key) => rowAt(key)?.name === left.name);
      read();
    }
    if (redraw) {
      changed();
    }
  }

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
      busy: busy(),
      ask: askView,
      confirm: asking?.key ?? null,
      actUnsupported,
      offline,
      canAnswer: asks !== null,
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
        // A row that left takes its question and its «Asking…» with it; an
        // approved one is no longer being asked.
        if (asking !== null && rowAt(asking.key) === null) {
          asking = null;
        }
        endAsking((key) => {
          const row = rowAt(key);
          return row === null || row.approved === true;
        });
        // A row that left takes its action in flight too (a re-created file is clean).
        for (const key of Object.keys(flight)) {
          if (rowAt(key) === null) {
            setFlight(key, null);
          }
        }
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
    send(def, values);
  }

  function startNow(key: string): void {
    const def = usable(key, "start");
    if (def === null) {
      return;
    }
    const defaults = Object.fromEntries(formFor(def).fields.map((f) => [f.name, f.value]));
    if (needsValues(def) || formProblems(def, defaults).length > 0) {
      openRow(key);
      return;
    }
    send(def, defaults);
  }

  /** One start, pinned to the row's hash (the form's, or the list's at once). */
  function send(def: CatalogueEntry, given: Readonly<Record<string, string>>): void {
    if (session === null || starting) {
      return;
    }
    const params: StartParams | null = startParams(def, given);
    if (params === null) {
      // No hash to pin: the daemon would re-read the file, so nothing is sent.
      notice = "This workflow cannot be started (it has no hash)";
      changed();
      return;
    }
    starting = true;
    setFlight(def.key, "starting");
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
        setFlight(def.key, null);
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
        setFlight(def.key, null);
        notice = `The start failed (${err instanceof Error ? err.message : String(err)})`;
        changed();
      });
  }

  function approve(key: string): void {
    const def = usable(key, "approve");
    if (session === null || def === null || def.approved !== false || def.hash === null) {
      return;
    }
    // Marked BEFORE the send: the ask may arrive, and be answered, before the reply.
    asked.add(key);
    asking = null;
    banner = null;
    notice = null;
    changed();
    void session
      .workflowApprove(def.name, def.hash)
      .then((result) => {
        if (disposed) {
          return;
        }
        if ("unsupported" in result) {
          asked.delete(key);
          actUnsupported = true;
          changed();
          return;
        }
        if (result.ok && result.approved !== true) {
          // Asked: the sheet's edge ends it (it may have already).
          return;
        }
        asked.delete(key);
        if (result.ok) {
          read();
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
        read();
      })
      .catch((err: unknown) => {
        if (disposed) {
          return;
        }
        asked.delete(key);
        notice = `The approval failed (${err instanceof Error ? err.message : String(err)})`;
        read();
      });
  }

  function confirmDelete(key: string): void {
    const pinned = asking;
    if (pinned === null || pinned.key !== key) {
      return;
    }
    const def = usable(key, "delete");
    if (session === null || def === null) {
      return;
    }
    asking = null;
    setFlight(key, "deleting");
    banner = null;
    notice = null;
    changed();
    void session
      .workflowDelete(pinned.name, pinned.hash)
      .then((result) => {
        if (disposed) {
          return;
        }
        setFlight(key, null);
        if ("unsupported" in result) {
          actUnsupported = true;
          changed();
          return;
        }
        // Deleted, or refused (`changed`, `gone`, `running`…): say it and re-read.
        notice = result.ok
          ? schedulesNotice(pinned.name, result.schedules ?? [])
          : afterDeleteRefusal(result.reason);
        read();
      })
      .catch((err: unknown) => {
        if (disposed) {
          return;
        }
        setFlight(key, null);
        notice = `The delete failed (${err instanceof Error ? err.message : String(err)})`;
        read();
      });
  }

  function openRow(key: string): void {
    // Only a VALID row has a form: a broken file is its errors and no Start.
    const def = openEntry(catalogue, key);
    if (def === null) {
      return;
    }
    openKey = key;
    asking = null;
    banner = null;
    notice = null;
    values = Object.fromEntries(formFor(def, values).fields.map((f) => [f.name, f.value]));
    refreshProblems();
    changed();
  }

  function canStart(): boolean {
    const def = entry();
    return (
      !offline &&
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
      if (asks !== null && unwatch === null) {
        unwatch = asks.subscribe(() => {
          if (!disposed) {
            sheetChanged();
          }
        });
        // An ask already on the sheet is remembered, so its leaving is an edge.
        sheetChanged();
      }
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
      // A person's refresh also un-sticks «Asking…»: tapping again asks nothing twice.
      endAsking(() => true);
      read();
    },
    openRow,
    startNow,
    approve,
    askDelete(key) {
      const def = usable(key, "delete");
      if (def === null) {
        return;
      }
      asking = { key, name: def.name, ...(def.hash === null ? {} : { hash: def.hash }) };
      changed();
    },
    cancelDelete() {
      asking = null;
      changed();
    },
    confirmDelete,
    reviewAsk() {
      if (!disposed) {
        asks?.unpark?.();
      }
    },
    setOffline(next) {
      if (next === offline) {
        return;
      }
      offline = next;
      if (!next) {
        endAsking(() => true);
        read();
      }
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
      unwatch?.();
      unwatch = null;
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
