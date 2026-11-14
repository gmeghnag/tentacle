/**
 * The session screen's wiring (docs/feat/mobile-session-view.md 12c): open/
 * attach, the transcript feed, the composer's taps, the permission sheet, and
 * the thumbnails window — pure and injected, so `SessionScreen.tsx` maps a state
 * to elements and owns nothing but looks (AGENTS §7).
 *
 * The invariants it keeps, all of them the plan's:
 * - **ONE broker.** The sheet's requester is set on the client's own broker on
 *   open and `reset()` on leave — never a second `PermissionBroker` (AGENTS §7
 *   "single broker"): with no requester set, a daemon-side ask WAITS.
 * - **Leaving detaches.** `leave` is `RemoteSession.detach` (via the controller),
 *   never `close()`: the session keeps running for every device (decision 4).
 * - **Nothing is lost.** A send the daemon refused before the ack puts its text
 *   back (F13); a link that drops keeps the rows and the draft (F8, F12).
 */
import type { SessionEvent } from "@tentacle/client";
import type { PermissionBroker, PermissionRequester } from "@tentacle/core";
import { DomainErrorCode } from "@tentacle/transport";
import { RpcError } from "@tentacle/transport";
import {
  type ComposerAction,
  FAILED_NOTICE,
  REFUSED_NOTICE,
  restoreAfterFailure,
} from "./composer.ts";
import {
  type PermissionSheet,
  type SheetState,
  createPermissionSheet,
} from "./permission-sheet.ts";
import type { SessionController, SessionHandle, SessionOpenFailure } from "./session-controller.ts";
import { type ForeignTurn, createSessionFeed } from "./session-feed.ts";
import { type SessionStatus, type SessionView, sessionView } from "./session-view.ts";
import {
  type ThumbnailDriver,
  type ThumbnailSource,
  type ThumbnailState,
  createThumbnailDriver,
  initialThumbnails,
} from "./thumbnails.ts";
import { type State, initialState } from "./transcript.ts";

/** A handle this screen can also prompt (what the composer's Send needs). */
export interface SendableHandle extends SessionHandle {
  send(
    prompt: string,
    signal?: AbortSignal,
    opts?: { readonly turnId?: string },
  ): AsyncIterable<SessionEvent>;
}

export interface SessionScreenState {
  readonly status: SessionStatus;
  readonly transcript: State;
  readonly draft: string;
  /** A refused/failed send's notice, shown above the composer until the next one. */
  readonly notice: string | null;
  readonly view: SessionView;
  readonly sheet: SheetState;
  readonly thumbnails: ThumbnailState;
}

export interface SessionScreenDeps {
  readonly sessionId: string;
  /** The route said it was in the Archived section (Opened with Reopen, Owner Q4). */
  readonly archived: boolean;
  readonly title: string;
  readonly project: string;
  readonly controller: SessionController<SendableHandle>;
  /**
   * The client's ONE broker: the sheet's requester is set on it on open and
   * withdrawn on leave. `reset(requester)` withdraws ONLY the requester named,
   * so a release that arrives after a newer screen mounted its own leaves that
   * one in place (AGENTS §7 "single broker": a cleared requester holds asks
   * silently).
   */
  readonly broker: Pick<PermissionBroker, "setRequester" | "reset">;
  readonly now: () => number;
  /** Injectable for tests: the sheet's clock/arm window and the thumbnail port. */
  readonly sheet?: (deps: { readonly now: () => number }) => PermissionSheet;
  readonly thumbnails?: ThumbnailSource;
  /** Told whenever the state changes (a React setState in the screen). */
  readonly onChange?: (state: SessionScreenState) => void;
}

export interface SessionScreenController {
  state(): SessionScreenState;
  /** The screen's subscription: every state change, plus an unsubscribe. */
  subscribe(listener: (state: SessionScreenState) => void): () => void;
  /** Attach (and re-attach on a Retry). `reopen`: the person's Reopen button. */
  open(reopen?: boolean): Promise<void>;
  /** The Retry button. */
  retry(): void;
  /** The Reopen button (only an archived failure offers it). */
  reopen(): void;
  setDraft(text: string): void;
  /** A tap on the composer's one button. */
  press(): void;
  /** The link went up/down (the client's `onLinkStatus`): the banner's `reconnecting`. */
  link(up: boolean): void;
  /** The person's tap on a link: the sheet's confirmation is the screen's job. */
  onLink(href: string): void;
  /** The FlatList's visible window: which images want bytes (12b's driver). */
  window(first: number, last: number, rows: readonly { readonly kind: string }[]): void;
  /** A permission tap, from the sheet's own UI. */
  sheet(): PermissionSheet;
  /** The screen unmounted: detach, withdraw the sheet, release the requester. */
  leave(): Promise<void>;
  /** Unsubscribe everything (the screen's cleanup, after `leave`). */
  dispose(): void;
}

/** A send refused before the ack is given back, not failed (F13). */
function refusedBeforeStart(error: unknown, streamed: boolean): boolean {
  if (streamed) {
    return false;
  }
  return error instanceof RpcError && error.code === DomainErrorCode.TurnInProgress;
}

export function createSessionScreen(deps: SessionScreenDeps): SessionScreenController {
  /** `Loading…` from the first render: the screen mounts already attaching. */
  let status: SessionStatus = { phase: "opening" };
  /** One attach at a time (a `Retry`/`Reopen` during one is a no-op tap). */
  let attaching = false;
  let transcript: State = initialState;
  let draft = "";
  let notice: string | null = null;
  let thumbnails: ThumbnailState = initialThumbnails;
  let handle: SendableHandle | null = null;
  let foreign: ForeignTurn | null = null;
  /** This phone's own turn's abort (Stop, for `own: true`). */
  let ownControl: AbortController | null = null;
  let disposed = false;
  const unmount = new AbortController();
  /** THIS screen's requester: the identity `releaseRequester` withdraws by. */
  const mounted: PermissionRequester = (req, options) => sheet.requester(req, options);

  const sheet =
    deps.sheet === undefined
      ? createPermissionSheet({
          now: deps.now,
          onChange: () => emit(),
          // The age guard's release is a clock event: it re-renders through the
          // same `onChange` every other change uses (never a screen-side timer).
          schedule: (fn, ms) => {
            const timer = setTimeout(fn, ms);
            return { cancel: () => clearTimeout(timer) };
          },
        })
      : deps.sheet({ now: deps.now });

  const driver: ThumbnailDriver = createThumbnailDriver(
    deps.thumbnails ?? { fetch: async () => null },
    (next) => {
      thumbnails = next;
      emit();
    },
    unmount.signal,
    initialThumbnails,
  );

  const feed = createSessionFeed({
    state: () => transcript,
    put: (next) => {
      transcript = next;
      emit();
    },
    setForeign: (turn) => {
      foreign = turn;
      emit();
    },
  });

  function view(): SessionView {
    return sessionView({
      title: deps.title,
      project: deps.project,
      status,
      rows: transcript.rows,
      turn: transcript.turn,
      link: transcript.link,
      ended: transcript.closed,
      draft,
      archived: deps.archived,
    });
  }

  function state(): SessionScreenState {
    return {
      status,
      transcript,
      draft,
      notice,
      view: view(),
      sheet: sheet.view(),
      thumbnails,
    };
  }

  const listeners = new Set<(state: SessionScreenState) => void>();

  function emit(): void {
    if (disposed) {
      return;
    }
    const next = state();
    deps.onChange?.(next);
    for (const listener of listeners) {
      listener(next);
    }
  }

  /**
   * Take the sheet's requester on the client's ONE broker (never a second one).
   * The requester itself is the identity the release compares against: it is
   * created once, with this screen, so no other screen's can equal it.
   */
  function mountRequester(): void {
    deps.broker.setRequester(mounted);
  }

  /** Withdraw the requester IF it is still this screen's (a newer screen keeps its own). */
  function releaseRequester(): void {
    deps.broker.reset(mounted);
  }

  /**
   * An archived row shows its banner and Reopen from the first render, so a tap
   * can arrive while the FIRST attach is still in flight: remember it and run
   * it when that attach settles, instead of swallowing the tap.
   */
  let queuedReopen = false;

  /**
   * Attach. `reopen` is the person's explicit Reopen button (Owner Q4) — the
   * FIRST attach of an archived session never passes it, so merely opening the
   * screen cannot revive a session or count against the daemon's cap.
   */
  async function attach(reopen: boolean): Promise<void> {
    if (attaching) {
      if (reopen) {
        queuedReopen = true;
      }
      return;
    }
    attaching = true;
    status = { phase: "opening", ...(reopen ? { reopenRequested: true as const } : {}) };
    emit();
    const result = await deps.controller.open(deps.sessionId, {
      ...(reopen ? { reopen: true } : {}),
      watch: (activity) => feed.activity(activity),
    });
    attaching = false;
    if (disposed) {
      return;
    }
    if (!result.ok) {
      status = {
        phase: "failed",
        failure: result.reason,
        ...(reopen ? { reopenRequested: true as const } : {}),
      };
      emit();
      if (queuedReopen) {
        // The person tapped Reopen while this attach was still running: honour
        // it now rather than making them tap the same button twice.
        queuedReopen = false;
        void attach(true);
      }
      return;
    }
    queuedReopen = false;
    handle = result.session;
    status = { phase: "open" };
    // Asks reach the person from now on. Set AFTER the attach, so a replayed ask
    // is queued by the broker until the sheet is up and then delivered in order
    // (F1) — never to a half-built screen.
    mountRequester();
    emit();
  }

  async function send(action: Extract<ComposerAction, { kind: "send" }>): Promise<void> {
    const session = handle;
    if (session === null) {
      return;
    }
    const text = action.text;
    const turnId = crypto.randomUUID();
    const control = new AbortController();
    ownControl = control;
    draft = "";
    notice = null;
    emit();
    let streamed = false;
    let failure: unknown;
    const events = (async function* guarded(): AsyncIterable<SessionEvent> {
      try {
        for await (const event of session.send(text, control.signal, { turnId })) {
          streamed = true;
          yield event;
        }
      } catch (error) {
        failure = error;
        throw error;
      }
    })();
    await feed.ownTurn(turnId, events);
    ownControl = null;
    if (failure === undefined) {
      emit();
      return;
    }
    // Nothing streamed and the daemon refused it before the ack: the person's
    // words come BACK (F13). Anything else is a loss the transcript says itself.
    if (refusedBeforeStart(failure, streamed)) {
      draft = restoreAfterFailure(draft, text);
      notice = REFUSED_NOTICE;
      emit();
      return;
    }
    if (!streamed) {
      draft = restoreAfterFailure(draft, text);
      notice = FAILED_NOTICE;
      emit();
    }
  }

  function press(): void {
    const action = view().composer.action;
    if (action.kind === "send") {
      void send(action);
      return;
    }
    if (action.kind !== "stop") {
      return;
    }
    if (action.own) {
      // This phone's own turn: the same call its `send` gave a signal for.
      ownControl?.abort();
      return;
    }
    foreign?.cancel();
  }

  return {
    state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open: () => attach(false),
    retry() {
      void attach(status.phase === "failed" && status.reopenRequested === true);
    },
    reopen() {
      void attach(true);
    },
    setDraft(text) {
      draft = text;
      emit();
    },
    press,
    link(up) {
      feed.link(up);
    },
    onLink(href) {
      // The screen shows the confirmation (`links.ts`); nothing is opened here.
      void href;
    },
    window(first, last, rows) {
      driver.view(rows, first, last);
    },
    sheet: () => sheet,
    async leave() {
      sheet.dismiss();
      // Withdraw only THIS screen's requester (never a newer screen's: the app
      // has one link, hence one broker, shared by every screen on it).
      releaseRequester();
      await deps.controller.leave(deps.sessionId);
      emit();
    },
    dispose() {
      disposed = true;
      listeners.clear();
      unmount.abort();
      // Idempotent and identity-scoped: a dispose that lands AFTER the next
      // screen mounted its requester withdraws nothing.
      releaseRequester();
    },
  };
}
