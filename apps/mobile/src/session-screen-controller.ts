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
import type { AttachmentRef, SessionContextResult, SessionSkillsResult } from "@tentacle/protocol";
import { DomainErrorCode } from "@tentacle/transport";
import { RpcError } from "@tentacle/transport";
import type { Compose, ComposeHandle, PhotoPort } from "./compose-controller.ts";
import { createCompose } from "./compose-controller.ts";
import {
  type ComposerAction,
  FAILED_NOTICE,
  REFUSED_NOTICE,
  restoreAfterFailure,
  returnKeyAction,
} from "./composer.ts";
import type { OutboxDriver } from "./outbox-driver.ts";
import type { OutboxStore } from "./outbox-store.ts";
import type { OutboxItem } from "./outbox.ts";
import {
  type PermissionSheet,
  type SheetState,
  createPermissionSheet,
} from "./permission-sheet.ts";
import type { SessionController, SessionHandle, SessionOpenFailure } from "./session-controller.ts";
import { type ForeignTurn, createSessionFeed } from "./session-feed.ts";
import {
  type InfoPort,
  type SessionInfoState,
  createSessionInfo,
} from "./session-info-controller.ts";
import {
  type RenameState,
  renameErrorText,
  renamePlan,
  titleAfterRename,
} from "./session-rename.ts";

export type { RenameState };
import type { ComposeBarView, OutboxRowView, SessionViewInput } from "./session-view.ts";

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
    opts?: { readonly turnId?: string; readonly attachments?: readonly AttachmentRef[] },
  ): AsyncIterable<SessionEvent>;
  /**
   * The session's own-vs-foreign turn test (`RemoteSession.autoAcceptsTurn`, the
   * WIDEST the session offers — own turns, and on a trusted `serve` its own wake
   * turns). Absent on a handle that decides nothing: see `autoAcceptsTurnOf`.
   */
  readonly autoAcceptsTurn?: (turnId: string) => boolean;
  /**
   * The session's title changes (`RemoteSession.onTitle`, the daemon's
   * `session_title`): a rename on ANY device reaches the header.
   */
  onTitle?(listener: (notice: { readonly title: string }) => void): () => void;
  /**
   * The skills this session has (`RemoteSession.skills()`, `session/skills`): what
   * Session info lists. Optional because a fake handle need not answer, and an
   * older daemon rejects it — the caller's section then says so (F2/F4).
   */
  skills?(): Promise<SessionSkillsResult>;
  /** The context this session would send now (`session/context`). */
  context?(): Promise<SessionContextResult>;
  /** Rename it (`session/rename`, the TUI's `/rename` path). */
  rename?(title: string): Promise<string>;
}

/**
 * A handle's own-turn test, when it has one. The screen hands it to the sheet
 * LIVE (the handle only exists after the attach), so a handle without one keeps
 * the sheet's stricter rule: a NAMED turn is the app's, an ask with no turn id
 * never is (`permission-sheet.ts`; docs/feat/session-auto-accept.md D4).
 */
export function autoAcceptsTurnOf(
  handle: SendableHandle | null,
): ((turnId: string) => boolean) | undefined {
  const test = handle?.autoAcceptsTurn;
  return typeof test === "function" ? (turnId: string) => test.call(handle, turnId) : undefined;
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
  /** The compose half (13d): the queue, the chips, the outbox. */
  readonly compose: ComposeBarView;
  /**
   * Session info (docs/feat/mobile-session-info.md): the sheet's value, `null`
   * while it is closed. The header's model and context bar live in `view`.
   */
  readonly info: SessionInfoState | null;
  /** Whether the rename field is open (Owner decision 5: tap the title). */
  readonly renaming: RenameState | null;
}

/**
 * What the compose half needs from the screen (13d). Everything the screen
owns
 * is passed in; everything else is the app's (`compose-controller.ts`).
 */
export interface ComposeWiring {
  readonly computerId: string;
  readonly store: OutboxStore;
  /**
   * 13b's driver for this screen, built with the prompt the COMPOSE acts carry: the
   * turn it starts folds into THIS transcript (a drained stream would show no turn
   * and no answer — 13d's flow 07/18). The app owns the store; the driver is per
   * screen, because the fold is.
   */
  readonly driver: (prompt: {
    readonly prompt: (
      text: string,
      turnId: string,
      refs: readonly AttachmentRef[],
    ) => Promise<void>;
    /** 13b's hand-back: an item whose text belongs in the field (F7/F20). */
    readonly onDraft: (item: OutboxItem, why: "archived" | "deleted" | "gone" | "busy") => void;
  }) => OutboxDriver;
  readonly photos: PhotoPort;
  /**
   * The chat handle's compose side, once the attach answered — built over THIS
   * screen's own attach handle (owner B4: a port without it could not read the
   * session's facts, so every send died silently after clearing the field).
   */
  readonly handle: (session: SendableHandle) => ComposeHandle | null;
  /** Write the draft (13b's store: the text and the chip copies that outlive the screen). */
  readonly draft: (text: string, photos: readonly string[]) => void;
  readonly mint: () => string;
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
  /**
   * This phone's own device name (the one it paired under), for ask's "also
   * asked on" note never naming the device it is shown on
   * (docs/feat/session-auto-accept.md D7). Absent → nothing is dropped.
   */
  readonly phoneName?: () => string | undefined;
  /** Told whenever the state changes (a React setState in the screen). */
  readonly onChange?: (state: SessionScreenState) => void;
  /** The compose half (13d). Absent: a screen with no queue and no photos (12c's tests). */
  readonly compose?: ComposeWiring;
  /**
   * Session info (docs/feat/mobile-session-info.md): the port the sheet pulls
   * through, built over the ONE client stack. It takes an accessor because the
   * session's handle only exists AFTER the attach (`skills`/`context`/`autoAccept`
   * are the handle's), and the screen is built first.
   */
  readonly info?: (handle: () => SendableHandle | null) => InfoPort;
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
  /**
   * The keyboard's Return (B2): `press` only when `returnKeyAction` allows it on
   * the CURRENT action — never a Stop, never a no-op clear.
   */
  pressReturn(): void;
  /** Up/Down (the client's `onLinkStatus`): the banner's `reconnecting`. */
  link(up: boolean): void;
  /** Session info opened: start every pull (F1–F5 live in the controller). */
  openInfo(): Promise<void>;
  /** The sheet closed: drop in-flight answers and stop following the link (F5). */
  closeInfo(): void;
  /** Pull-to-refresh, and a `Retry` row (and the port's link `up`, its own). */
  refreshInfo(): Promise<void>;
  /** The auto-accept switch (Owner Q3, F11). */
  setAutoAccept(on: boolean): Promise<void>;
  /** The switch's value NOW (the session's shared link: a flip elsewhere is here). */
  autoAcceptOn(): boolean;
  /** Tapping the title: the rename field opens on the CURRENT title (Owner 5). */
  beginRename(): void;
  /** What is typed into it. */
  setRenameText(text: string): void;
  /** Save it: a no-op when empty/unchanged, else `session/rename`. */
  submitRename(): Promise<void>;
  /** Dismiss it without saving. */
  cancelRename(): void;
  /** The person's tap on a link: the sheet's confirmation is the screen's job. */
  onLink(href: string): void;
  /** The FlatList's visible window: which images want bytes (12b's driver). */
  window(first: number, last: number, rows: readonly { readonly kind: string }[]): void;
  /** A permission tap, from the sheet's own UI. */
  sheet(): PermissionSheet;
  /** The photo button's answer: the Library picker or the Camera (13d, D5). */
  pickPhoto(source: "library" | "camera"): Promise<void>;
  /** A chip's × : forget that photo (13d). */
  removeChip(key: string): Promise<void>;
  /** **Send now**, beside the queue (13d, D1). */
  sendNow(): Promise<void>;
  /** A tap on another device's returned row (13d, D3: an explicit act). */
  take(id: string): Promise<void>;
  /** The outbox's four answers, for one item (13d, D4). */
  outbox(
    what: "send" | "steer" | "discard" | "edit" | "open" | "close",
    itemId?: string,
  ): Promise<void>;
  /** The screen unmounted: detach, withdraw the sheet, release the requester. */
  leave(): Promise<void>;
  /** Unsubscribe everything (the screen's cleanup, after `leave`). */
  dispose(): void;
}

/** The outbox's rows, from `session-view.ts`'s own projection (never built here). */
function outboxRows(
  items: readonly OutboxItem[],
  base: Omit<SessionViewInput, "outbox">,
): readonly OutboxRowView[] {
  return sessionView({ ...base, outbox: items }).outbox;
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
  /** The session's title as the screen shows it: the route's, then the daemon's (`session_title`/rename). */
  let shownTitle = deps.title;
  /** The last attached handle's title subscription (dropped on a re-attach/leave). */
  let sessionTitleWatch: (() => void) | undefined;
  /** The rename field (Owner decision 5): `null` while it is closed. */
  let renaming: RenameState | null = null;
  /**
   * Session info (docs/feat/mobile-session-info.md). Built over the ONE client
   * stack (`deps.info` hands back the port the app wired), and it reads the
   * handle LIVE: the attach that creates it happens after this.
   */
  const infoPort = deps.info === undefined ? null : deps.info(() => handle);
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
          // The session's shared auto-accept (docs/feat/session-auto-accept.md
          // D6): read through a function, because the handle (and its link) only
          // exists after the attach — the sheet is built first.
          autoAccept: () => handle?.autoAccept,
          // The own-turn test that goes with it (the same one a terminal feeds
          // `autoApproves`), read LIVE: the handle does not exist yet, so this
          // must not be snapshotted here (`undefined` would silently mean "only
          // a named turn"). A handle that offers none keeps that stricter rule.
          autoAcceptsTurn: (turnId: string) => autoAcceptsTurnOf(handle)?.(turnId) === true,
          // This phone's own label, so an ask's "also asked on" never names the
          // device it is shown on (D7). The name the person gave this phone at
          // pairing — the same one the computer lists it under.
          ownHost: () => deps.phoneName?.(),
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

  /**
   * The compose half (13d). Its own state is a pure module's (`compose-state.ts`);
   * it is created ONLY when the app wired it, so a screen without photos and
   * without an outbox (12c's tests) has no queue either.
   */
  const compose: Compose | null =
    deps.compose === undefined
      ? null
      : createCompose({
          computerId: deps.compose.computerId,
          sessionId: deps.sessionId,
          store: deps.compose.store,
          // The driver is built PER SCREEN, over a port whose `prompt` is THIS
          // screen's folding one: 13b's driver keeps the item and the key, but the
          // turn it starts must stream into this transcript (a drained stream shows
          // nothing — 13d's flow 07/18). The app passes a factory, not a driver.
          driver: deps.compose.driver({
            prompt: (text, turnId, refs) => promptWithRefs(text, turnId, refs),
            // 13b's own hand-back (F7/F20): the item is gone and its text is the
            // field's again — APPENDED, never overwriting what the person typed.
            onDraft: (item) => {
              draft = restoreAfterFailure(draft, item.text);
              deps.compose?.draft(draft, []);
              emit();
            },
          }),
          photos: deps.compose.photos,
          // The handle exists only once the attach answered: a compose act on a
          // half-built screen must never build a frame (AGENTS §7).
          handle: () =>
            status.phase === "open" && handle !== null
              ? (deps.compose?.handle(handle) ?? null)
              : null,
          turnId: () => (foreign !== null ? foreign.turnId : (transcript.turn?.turnId ?? null)),
          stopTurn: (turnId, own) => {
            if (own) {
              ownControl?.abort();
              return;
            }
            // A foreign turn is stoppable only through its own activity's
            // `cancel`; a turn id we never saw stream is not ours to cancel.
            if (foreign !== null && foreign.turnId === turnId) {
              foreign.cancel();
            }
          },
          mint: deps.compose.mint,
          prompt: promptWithRefs,
          draft: () => draft,
          setDraft: (text) => {
            draft = text;
            emit();
          },
          // expo-file-system's write (`outbox-fs-expo.ts`) is the store's, and the
          // draft is the same store's data: the app wires the write itself.
          flushDraft: (text, photos) => deps.compose?.draft(text, photos),
          onChange: () => emit(),
          notify: (text) => {
            notice = text;
            emit();
          },
        });

  /**
   * A port or the sheet's controller built over it: `createSessionInfo` is cheap
   * and STATEFUL (its generation counter), so exactly one lives per screen and
   * `open()`/`close()` are what restart it.
   */
  const info = infoPort === null ? null : createSessionInfo(infoPort);

  /** The daemon's model as the header shows it (`undefined`: report nothing). */
  function modelOf(): string | undefined {
    return infoPort?.daemon()?.model;
  }

  /** The context window the bar divides by (`undefined`: no bar, F6). */
  function windowOf(): number | undefined {
    return infoPort?.daemon()?.contextWindow;
  }

  /** The daemon's count at open: the bar's figure until a turn measures one. */
  function measuredContext(): { readonly used: number; readonly exact: boolean } | null {
    return info?.state().openContext ?? null;
  }

  /** The compose view the screen draws (empty when this build has no compose half). */
  function composeView(): { readonly bar: ComposeBarView; readonly items: readonly OutboxItem[] } {
    if (compose === null) {
      return {
        items: [],
        bar: {
          queued: [],
          returnedOthers: [],
          returnedNotice: "",
          outbox: [],
          notSaved: false,
          chips: [],
          ownQueue: 0,
          sendNow: false,
        },
      };
    }
    const value = compose.view();
    return {
      items: value.outbox,
      // The ROWS are the pure view-model's (`sessionView`, from the items).
      bar: {
        queued: value.queued,
        returnedOthers: value.returnedOthers,
        returnedNotice: value.returnedNotice,
        outbox: outboxRows(value.outbox, {
          title: shownTitle,
          project: deps.project,
          status,
          rows: [],
          turn: transcript.turn,
          link: transcript.link,
          ended: transcript.closed,
          draft,
          archived: deps.archived,
        }),
        notSaved: value.notSaved,
        chips: value.chips,
        ownQueue: value.ownQueue,
        sendNow: value.sendNow,
      },
    };
  }

  function view(): SessionView {
    const composeState = composeView().bar;
    return sessionView({
      title: shownTitle,
      project: deps.project,
      status,
      rows: transcript.rows,
      turn: transcript.turn,
      link: transcript.link,
      ended: transcript.closed,
      draft,
      archived: deps.archived,
      // The header's model and context bar (Owner 2/4): the daemon's handshake
      // facts re-read per open (F7), and the fill THIS session measured — never
      // a fabricated 0 (the bar is absent until there is something to fill).
      ...(info === null
        ? {}
        : {
            header: {
              model: modelOf(),
              measured: transcript.lastTurnTokens?.prompt ?? null,
              open: measuredContext(),
              window: windowOf(),
            },
          }),
      queued: composeState.queued,
      returnedOthers: composeState.returnedOthers,
      ...(composeState.returnedNotice === ""
        ? {}
        : { returnedNotice: composeState.returnedNotice }),
      outbox: composeView().items,
      notSaved: composeState.notSaved,
      photos: composeState.chips.map((chip) => ({
        key: chip.key,
        state: chip.state,
        ...(chip.name === undefined ? {} : { name: chip.name }),
        ...(chip.state === "refused" ? { detail: chip.detail } : {}),
      })),
      ownQueue: composeState.ownQueue,
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
      compose: composeView().bar,
      info: info === null ? null : info.state(),
      renaming,
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
    // The daemon's title can move while this screen is open (another device's
    // rename, or this one's): the header follows it, never the route's copy.
    sessionTitleWatch?.();
    sessionTitleWatch = result.session.onTitle?.((notice) => {
      shownTitle = titleAfterRename(notice.title);
      emit();
    });
    // The header's context bar needs a figure NOW: a session attached after its
    // turns has no `agent_usage` to measure from (the TUI asks at attach too).
    if (info !== null) {
      void info.loadContext().catch(() => {});
    }
    // Asks reach the person from now on. Set AFTER the attach, so a replayed ask
    // is queued by the broker until the sheet is up and then delivered in order
    // (F1) — never to a half-built screen.
    mountRequester();
    // The compose half follows the queue from here (13d): its store is loaded
    // once, and a `queued` broadcast is applied by `compose-state.ts`.
    if (compose !== null) {
      const wired = deps.compose?.handle(result.session) ?? null;
      if (wired !== null) {
        void compose.start(wired);
        // The outbox may have items from a killed app: `up` + re-sync is when
        // they get their chance (`decide`, D4), never a blind send.
        void compose.runOutbox();
      }
    }
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
    await feed.ownTurn(turnId, events, { text }).catch(() => {
      // The stream threw: the feed folded it as LOST (F8/F19), and `failure` below
      // is what decides whether the person's words come back (F13).
    });
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

  /**
   * ONE prompt with image refs (13d), folded into this screen's transcript as the
   * phone's OWN turn — 12c's fold, not a drained stream: the compose half hands its
   * turn here (`compose-controller.ts`'s `prompt`), and `turn-running`/the answers
   * appear because this is where the events are applied.
   */
  async function promptWithRefs(
    text: string,
    turnId: string,
    refs: readonly AttachmentRef[],
  ): Promise<void> {
    const session = handle;
    if (session === null) {
      return;
    }
    const control = new AbortController();
    ownControl = control;
    notice = null;
    emit();
    let streamed = false;
    let failure: unknown;
    const events = (async function* guarded(): AsyncIterable<SessionEvent> {
      try {
        for await (const event of session.send(text, control.signal, {
          turnId,
          attachments: refs,
        })) {
          streamed = true;
          yield event;
        }
      } catch (error) {
        failure = error;
        throw error;
      }
    })();
    await feed.ownTurn(turnId, events, { text, attachments: refs }).catch(() => {
      // Folded as LOST by the feed; what the CALLER does about it is decided below.
    });
    ownControl = null;
    emit();
    // Nothing streamed: the daemon refused this prompt before its ack (a foreign
    // turn, a busy door, a dead link), so the caller must give the person's words
    // back — this is the seam 12c's `send` reads and the compose half relies on
    // (F7). Once a turn DID stream, its loss is the transcript's to say: restoring
    // the text would send the same words twice.
    if (failure !== undefined && !streamed) {
      throw failure;
    }
  }

  function press(): void {
    const action = view().composer.action;
    if (action.kind === "send") {
      // With the compose half wired, the ONE tap decides between the wire (no
      // photos) and the outbox (photos, and every offline act) — see
      // `compose-controller.ts`'s `press`, which reads the FIELD itself and clears
      // it in the same step. Clearing it here first would make that read empty and
      // the send would do nothing (the first iOS 26 run's failure of flow 07).
      if (compose !== null) {
        notice = null;
        emit();
        void compose.press(action);
        return;
      }
      void send(action);
      return;
    }
    if (action.kind === "queue" || action.kind === "send-later") {
      // A steer (a turn runs) or an offline item: the compose half's own path.
      if (compose !== null) {
        void compose.press(action);
      }
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
    pressReturn() {
      // The gate reads the action NOW, as `press` does: a second Return before
      // the screen re-rendered must not see a stale `send` and then Stop.
      if (returnKeyAction(view().composer.action) !== null) {
        press();
      }
    },
    link(up) {
      feed.link(up);
    },
    async openInfo() {
      await info?.open();
      emit();
    },
    closeInfo() {
      info?.close();
      emit();
    },
    async refreshInfo() {
      await info?.refresh();
      emit();
    },
    async setAutoAccept(on) {
      await info?.setAutoAccept(on);
      emit();
    },
    autoAcceptOn() {
      return info?.autoAcceptOn() ?? false;
    },
    beginRename() {
      renaming = { text: shownTitle, saving: false, error: null };
      emit();
    },
    setRenameText(text) {
      if (renaming === null) {
        return;
      }
      renaming = { ...renaming, text, error: null };
      emit();
    },
    async submitRename() {
      const field = renaming;
      const session = handle;
      if (field === null) {
        return;
      }
      const plan = renamePlan(shownTitle, field.text);
      if (plan.kind === "noop") {
        // Empty or unchanged is a NO-OP (Owner decision 5): the sheet closes and
        // nothing is sent — the title's source is not needlessly rewritten.
        renaming = null;
        emit();
        return;
      }
      if (plan.kind === "invalid") {
        renaming = { ...field, saving: false, error: plan.reason };
        emit();
        return;
      }
      if (session?.rename === undefined) {
        renaming = {
          ...field,
          saving: false,
          error: "This computer's tentacle is too old to rename sessions.",
        };
        emit();
        return;
      }
      renaming = { ...field, saving: true, error: null };
      emit();
      try {
        const stored = await session.rename(plan.title);
        shownTitle = titleAfterRename(stored);
        renaming = null;
      } catch (error) {
        // The field stays open with the person's text and the reason: a failed
        // rename must never look like it worked.
        renaming = { ...field, saving: false, error: renameErrorText(error) };
      }
      emit();
    },
    cancelRename() {
      renaming = null;
      emit();
    },
    onLink(href) {
      // The screen shows the confirmation (`links.ts`); nothing is opened here.
      void href;
    },
    window(first, last, rows) {
      driver.view(rows, first, last);
    },
    sheet: () => sheet,
    async pickPhoto(source) {
      if (compose === null) {
        return;
      }
      await (source === "library" ? compose.pickLibrary() : compose.pickCamera());
      emit();
    },
    async removeChip(key) {
      await compose?.removeChip(key);
      emit();
    },
    async sendNow() {
      await compose?.sendNow();
      emit();
    },
    async take(id) {
      await compose?.take(id);
      emit();
    },
    async outbox(what, itemId) {
      if (compose === null) {
        return;
      }
      switch (what) {
        case "send":
          await compose.outboxSend(itemId ?? "");
          return;
        case "steer":
          await compose.outboxSteer(itemId ?? "");
          return;
        case "discard":
          await compose.outboxDiscard(itemId ?? "");
          return;
        case "edit":
          await compose.outboxEdit(itemId ?? "");
          return;
        case "open":
          // The sheet is the SCREEN's (`OutboxDecisionSheet.tsx`): its own state.
          return;
        case "close":
          return;
      }
    },
    async leave() {
      sheet.dismiss();
      // Withdraw only THIS screen's requester (never a newer screen's: the app
      // has one link, hence one broker, shared by every screen on it).
      releaseRequester();
      compose?.stop();
      info?.close();
      sessionTitleWatch?.();
      sessionTitleWatch = undefined;
      await deps.controller.leave(deps.sessionId);
      emit();
    },
    dispose() {
      disposed = true;
      listeners.clear();
      unmount.abort();
      compose?.stop();
      info?.close();
      sessionTitleWatch?.();
      sessionTitleWatch = undefined;
      // Idempotent and identity-scoped: a dispose that lands AFTER the next
      // screen mounted its requester withdraws nothing.
      releaseRequester();
    },
  };
}
