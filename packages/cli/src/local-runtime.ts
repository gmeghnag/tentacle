import { createHash } from "node:crypto";
/**
 * The local session runtime built on the RPC stack — the same `RemoteClient` ↔
 * `Connection` path used for remote daemons, but with the daemon in-process
 * (over a worker port, or an in-memory pipe in tests). This is the "TUI always
 * over RPC" lever: the agent loop + tool execution run on the daemon side, so
 * the render thread never janks, and the main thread owns persistence.
 *
 * The daemon owns the live conversation but NOT the on-disk store: at each
 * committed round, turn end and compaction we read its log back
 * (`session/log`) and write the entries to the session's `<uid>.jsonl` here
 * (docs/feat/session-log-laptop-store.md). The main also owns the session uid
 * (passed into `session/open`), so a resumed session keeps its file.
 *
 * Sessions outlive connections daemon-side, so this runtime closes what it
 * opened: the previous session on `/clear` (`SessionController.close`), every
 * session still open on `dispose` — the same on every runtime (AGENTS §7).
 */
import { type SessionRecord, type TitleState, recordTitleState } from "@tentacle/agent";
import {
  AttachTimeoutError,
  type Clock,
  type DaemonKind,
  type LinkStatus,
  type NamedModels,
  type ReadBack,
  RemoteClient,
  type RemoteSession,
  type SessionEvent,
} from "@tentacle/client";
import type { TentacleConfig } from "@tentacle/config";
import type {
  ChatMessage,
  JobController,
  JobStatus,
  ModelProvider,
  PermissionBroker,
} from "@tentacle/core";
import { forkWrite, forkableMessages } from "@tentacle/daemon";
import { applyGroupMessage } from "@tentacle/exec";
import {
  DomainErrorCode,
  type McpServerStatus,
  type SessionSettings,
  type SessionTitle,
} from "@tentacle/protocol";
import { type DuplexChannel, type MessageEndpoint, messagePortChannel } from "@tentacle/transport";
import type { SessionController } from "@tentacle/tui";
import { createSettingsNotifier } from "./carried-settings.ts";
import { logDaemonError } from "./daemon-log.ts";
import { type HooksTrustStore, createHooksTrustResolver, fileTrustStore } from "./hooks-trust.ts";
import { type ResidentUse, residentUseOf } from "./relay-state.ts";
import type { SessionSaver } from "./session-saver.ts";
import {
  type SettingsLine,
  changedNotice,
  settingsCommandLines,
  syncedLines,
  updateFailureLine,
} from "./settings-view.ts";
import { APP_VERSION, CLIENT_INFO } from "./version.ts";
import type { WorkerBootstrap } from "./worker-bootstrap.ts";

export interface LocalRuntime {
  readonly createSession: () => PersistingController;
  /**
   * A read-only `JobController` view: only `onExit` is live (backed by the
   * daemon's background-exit stream), so the TUI surfaces job exits in the
   * worker path exactly as it does in-process. The mutating methods are never
   * called by the frontend (jobs are started/read/killed daemon-side).
   */
  readonly jobs: JobController;
  /** The link's status, for the TUI's StatusBar ("reconnecting…", "disconnected: …"). */
  readonly link: { onLinkStatus(listener: (status: LinkStatus) => void): () => void };
  /** The daemon's MCP servers, probed live (`mcp/status`, the TUI's `/mcp`). */
  readonly mcpStatus: () => Promise<readonly McpServerStatus[]>;
  /**
   * Wait (bounded) for the pending post-turn saves, close the open sessions
   * daemon-side, then the transport. Await it before exiting.
   */
  dispose(): Promise<void>;
  /**
   * `dispose` for a client that leaves a session for a later one (the relay,
   * docs/feat/detached-relay.md): the same saves and teardown, but the open
   * sessions are DETACHED, never closed — alone on a session, `dispose` ends it.
   */
  release(): Promise<void>;
  /**
   * Attach to the LIVE session `id` (`session/open` with no `create`, no
   * messages: docs/feat/detached-handover.md) and make it the next
   * `createSession`'s. `record` (its laptop copy, if any) gives only the saved
   * `createdAt` and title. Resolves false when the daemon does not know `id`
   * (`UnknownSession`): nothing was created and the runtime's seed is intact,
   * so the next `createSession` takes the seeded path. Any other error rejects.
   * `adoptTurn`: the run's turn id (its relay minted it, owner.json carries it):
   * that controller owns it too, so auto-accept may answer its asks
   * (docs/fix/detach-live.md B2); no other session does.
   */
  attachTo(
    id: string,
    record: SessionRecord | null,
    opts?: { readonly adoptTurn?: string },
  ): Promise<boolean>;
  /**
   * After `attachTo` resolved false: open the seeded session NOW
   * (`openSeeded`: create-or-attach, atomic daemon-side) and make it the next
   * `createSession`'s, so every TUI of a run reopened after a close is on ONE
   * live session from the start (docs/fix/detach-live.md KO 4). Rejects as
   * the open does; then nothing is kept and the next `createSession` is lazy.
   * `record` (given, `null` included) replaces the runtime's startup seed: the
   * laptop copy as read NOW, never one from before a slow dial (R8).
   */
  openSeeded(record?: SessionRecord | null): Promise<void>;
  /**
   * The quit of a client of a shared session: one last read-back of every open
   * session (a foreign turn is saved only at its end), the pending saves, then
   * the saves are sealed (a read in flight or a turn's end after this reports
   * nothing: the close ends it, docs/fix/detach-live.md A3), then
   * `session/close` — `ifLast` unless `closeForAll` (a confirmed `/quit`: it
   * ends the session for every client) — a drain of the model calls this
   * client serves (bounded: another client's turn would fail with them; a
   * close aborts them at once), then the transport.
   * `saved`: that read-back answered and its write reached the laptop copy (a
   * session that already ended, closed by another client, is not a failed
   * save: the closer saved it); false: the sessions are DETACHED instead, a
   * close would end what may be their only copy. `sessionsKept`: the sessions
   * the daemon did not confirm it closed.
   */
  quit(opts?: {
    readonly closeForAll?: boolean;
    /**
     * This quit is the last client of its sessions (a lone `/quit`): the
     * `ifLast` close ends them, so the saved history is closed like a
     * `closeForAll`'s (docs/fix/detach-live.md Q2).
     */
    readonly ending?: boolean;
  }): Promise<{ readonly sessionsKept: number; readonly saved: boolean }>;
  /**
   * The relay handing its session over (docs/feat/detached-handover.md): from
   * now on nothing is saved (the TUIs save it), so its last write precedes the
   * ack and none follows it.
   */
  stopSaving(): void;
  /** Every pending post-turn save done (bounded, never rejects). */
  flushed(): Promise<void>;
  /**
   * Synchronous, for an exit net (docs/fix/detach-live.md R6): every session's
   * `saveConfirmed` and the saver `clean`, i.e. the laptop holds the latest
   * state. False once saving stopped (a hand-over: the TUIs save it).
   */
  saveConfirmed(): boolean;
  /** `RemoteClient.modelIdle`: the model calls this runtime serves are over, or `ms` passed. */
  modelIdle(ms: number): Promise<void>;
  /**
   * Job exits no turn has flushed, as the open sessions' opens reported them
   * (`RemoteClient.unflushedExits`): above 0 the TUI starts a wake turn
   * (docs/fix/attach-unflushed-exits.md). 0 before `attachTo`.
   */
  unflushedExits(): number;
  /** `id`'s running background jobs, `null` if they cannot be read. */
  sessionJobs(id: string): Promise<number | null>;
  /**
   * Who uses the daemon besides `id`, and how `id` stands, `null` if it cannot
   * be told; `ownMayBeAbsent`: `residentUseOf`'s (a TUI's quit).
   */
  residentUse(
    id: string,
    opts?: { readonly ownMayBeAbsent?: boolean },
  ): Promise<ResidentUse | null>;
}

/** A client-side `JobController` whose only live capability is `onExit`. */
function remoteJobsView(client: RemoteClient): JobController {
  return {
    start() {
      throw new Error("jobs are managed daemon-side; the client cannot start one");
    },
    read: () => undefined,
    kill: () => false,
    list: () => [],
    dispose: () => {},
    onExit: (listener) =>
      client.onBackgroundExit((n) =>
        listener({
          id: n.jobId,
          command: n.command,
          status: n.status as JobStatus,
          exitCode: n.exitCode,
          startedAt: Date.now(),
          ...(n.agent ? { agent: n.agent } : {}),
        }),
      ),
  };
}

/** How long `dispose` waits for the pending post-turn saves before closing the sessions. */
export const FLUSH_ON_EXIT_TIMEOUT_MS = 3000;
/** How long `quit` lets a model call it serves finish for the clients that stay (probe I). */
export const QUIT_MODEL_DRAIN_MS = 10_000;

/** A `SessionController` whose post-turn saves can be awaited. */
export interface PersistingController extends SessionController {
  /** `RemoteSession.send`: `opts.turnId` mints the turn's id (a relay's run, B2). */
  send(
    prompt: string,
    signal?: AbortSignal,
    opts?: { readonly skill?: string; readonly turnId?: string },
  ): AsyncIterable<SessionEvent>;
  /** `RemoteSession.enqueue`: `id` is the caller's key for the text (a `sendNow` cites it). */
  enqueue(text: string, id?: string): Promise<void>;
  /** `RemoteSession.sendNow`; the new turn is saved once it settles, like `send`'s. */
  sendNow(...args: Parameters<RemoteSession["sendNow"]>): Promise<AsyncIterable<SessionEvent>>;
  /** `RemoteSession.rename`: the daemon's stored text; its `session_title` triggers a save. */
  rename(title: string): Promise<string>;
  /** Resolves once no save is pending (never rejects). */
  flushed(): Promise<void>;
  /** Read the history back and save it now (a no-op once closed); resolves as `flushed`. */
  saveNow(): Promise<void>;
  /**
   * Synchronous, for an exit net (docs/fix/detach-live.md R6): no turn in flight,
   * no read-back pending, and the last one answered since the last change. An
   * attached session starts unconfirmed (its laptop copy may be older than the
   * daemon's). Whether the write reached disk is the saver's (`clean`).
   */
  saveConfirmed(): boolean;
  /**
   * No save after this: a later `flush` does nothing, a read in flight that
   * fails reports nothing (the quit took the last save; the close ends it).
   */
  seal(): void;
  /** `RemoteSession.sessionId`. */
  readonly sessionId: string | null;
  /** `RemoteSession.watch`; a foreign turn is saved at its end, a `history` at once. */
  watch: RemoteSession["watch"];
  /** `RemoteSession.open` (the eager attach of an `attach` session; else a no-op). */
  open: RemoteSession["open"];
  /** `RemoteSession.openSeeded` (the eager create-or-attach of a seeded session). */
  openSeeded: RemoteSession["openSeeded"];
  /** `RemoteSession.openForReset`: the open a reset needs (else a no-op). */
  openForReset: RemoteSession["openForReset"];
  ownsTurn: RemoteSession["ownsTurn"];
  onQueued: RemoteSession["onQueued"];
  /** `RemoteSession.onSubagents`: the live list of this session's background sub-agents. */
  onSubagents?: RemoteSession["onSubagents"];
  /** `RemoteSession.onSubagentNotify`: a running child's message to this session's agent. */
  onSubagentNotify?: RemoteSession["onSubagentNotify"];
  /** `/settings` (present only where this laptop carries settings: `run`/`attach`). */
  settings?(): readonly SettingsLine[];
  /** `/settings sync`: the outcome as lines, never a rejection; a success is saved at once. */
  updateSettings?(): Promise<readonly SettingsLine[]>;
}

/** What a `run`/`attach` controller needs for `/settings` (docs/feat/session-settings-apply.md). */
export interface ControllerSettings {
  /** This terminal's carried settings (the runtime's, from its start). */
  readonly mine: SessionSettings;
  /** An own sync landed on `sessionId`: a later drift is news again. */
  readonly applied?: (sessionId: string) => void;
  /** Its eager attach timed out: until it opens, it may be live with other values (F3). */
  readonly unconfirmed?: boolean;
}

/** A read that failed because the session no longer exists daemon-side (by code). */
const ended = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === DomainErrorCode.UnknownSession;

/** The daemon ANSWERED with a refusal (by code): nothing changed. */
const clearRefused = (error: unknown): boolean =>
  Object.values(DomainErrorCode).includes((error as { code?: unknown } | null)?.code as never);

/** The daemon's wire title as the store's `TitleState`. */
function titleState(title: SessionTitle): TitleState {
  return title.source === "auto" ? { source: "auto" } : { source: title.source, text: title.text };
}

/**
 * Wrap a remote session so its history is persisted after each committed
 * round, turn end and compaction. Reads the authoritative log back from the
 * daemon (`session/log`) rather than reconstructing it from the update stream.
 *
 * The save is DETACHED from the turn (docs/feat/client-reattach-frontends.md
 * §6): with a reconnecting client the read waits out a dropped link, and the
 * turn must not look busy for the whole outage. Saves are serialized (one read
 * at a time, so disk order is history order) and coalesced (at most one more
 * waits; it reads the newest history when it runs). A failed read goes to
 * `onFlushError`, never thrown. `close` follows the pending save, so a `/clear`
 * right after a turn does not close the session under its own save.
 *
 * The title saved is the DAEMON's (docs/feat/session-titles.md): the one the
 * read-back carries; a read-back without one (an older daemon) keeps the last
 * known — `initialTitle`, the resumed record's — never re-derived over it. A
 * title change while idle (`session_title`: generated, or renamed by any
 * client) triggers a save too: pod and worker daemons keep nothing on disk.
 */
export function persistingController(
  inner: RemoteSession,
  /** Every non-empty read (raw, mid-turn too), its title, and the read itself (for the log store). */
  persist: (messages: readonly ChatMessage[], title: TitleState, back: ReadBack) => void,
  onFlushError: (error: Error) => void = () => {},
  initialTitle: TitleState = { source: "auto" },
  /** A turn this client did not mint but owns: a detached run's (B2). */
  adoptedTurn?: string,
  /** Present → `/settings` and `/settings sync` (docs/feat/session-settings-apply.md). */
  carried?: ControllerSettings,
  /**
   * Keep the copy this client held when the daemon's history FORKED from it
   * (docs/feat/session-log.md F1: a restarted daemon reseeded from another
   * copy). Awaited BEFORE the session file is replaced; a rejection leaves the
   * file as it is and is retried at the next save.
   */
  setAside?: (messages: readonly ChatMessage[], title: TitleState) => Promise<void>,
  /** `/clear`: keep the chat it drops (docs/feat/clear-fork-history.md). Absent: `connect`, unit fakes. */
  keepFork?: (messages: readonly ChatMessage[], title: TitleState) => void,
): PersistingController {
  /** The newest read held (what `/clear` forks) and the read head already forked. */
  let lastRead: {
    messages: readonly ChatMessage[];
    title: TitleState;
    head: string;
  } | null = null;
  let forkedHead: string | null = null;
  let running: Promise<void> | null = null;
  let again = false;
  let closed = false;
  let sealed = false;
  let lastTitle = initialTitle;
  /** `saveConfirmed`'s two facts: turns in flight, and the last read-back answered since the last change. */
  let turns = 0;
  let confirmed = true;
  /** A forked-from copy not yet durable aside (F1): kept until it is, before any later write. */
  let pendingAside: readonly ChatMessage[] | null = null;
  /**
   * A `/clear` is on the wire: a read STARTED after it describes the NEW
   * history, so it must never become `/clear`'s copy (M1).
   */
  let clearSent = false;
  const run = async (): Promise<void> => {
    do {
      again = false;
      confirmed = false;
      try {
        const pre = !clearSent;
        const back = await inner.readBack();
        if (back?.aside && setAside) {
          pendingAside = back.aside;
        }
        if (pendingAside && setAside) {
          // Aside FIRST: the file still holds that copy until this lands.
          await setAside(pendingAside, lastTitle);
          pendingAside = null;
        }
        if (back) {
          if (back.title) {
            lastTitle = titleState(back.title);
          }
          // The copy `/clear` forks: only a read started BEFORE the clear was
          // sent (the channel is ordered, so its reply precedes the clear's).
          if (pre) {
            lastRead = {
              messages: back.messages,
              title: lastTitle,
              head: back.read?.head?.id ?? "",
            };
          }
          // The start record is read AFTER the read-back resolved: every frame
          // that preceded its reply on the ordered channel is recorded (P14).
          // EVERY read is handed on — mid-turn ones, RAW, and empty ones too
          // (the log store's segment must follow every read; it writes no file
          // for an empty history). A turn still open at the file's end (no
          // `turn_end`) is closed when the file is LOADED
          // (docs/feat/session-log-laptop-store.md Q11).
          persist(back.messages, lastTitle, back);
        }
        confirmed = !again;
      } catch (error) {
        // Sealed: the quit's last save is taken, the close ends what follows.
        // A session that ENDED daemon-side (closed by any client, by the code,
        // never the text) is no failed save: nothing is left to read.
        if (!sealed && !ended(error)) {
          onFlushError(error instanceof Error ? error : new Error(String(error)));
        }
      }
    } while (again);
  };
  const flush = (): void => {
    confirmed = false; // a change to save; sealed, it never will be
    if (sealed) {
      return;
    }
    if (running) {
      again = true;
      return;
    }
    running = run().finally(() => {
      running = null;
    });
  };
  const flushed = (): Promise<void> => running ?? Promise.resolve();
  /**
   * Q4: an opened session's state goes to the laptop now and the read-back is
   * waited for (bounded), so a TUI with no turn since counts as saved. A read
   * or write that fails (or is slow) leaves it unconfirmed, as before; the open
   * itself never fails on it.
   */
  const saveOnOpen = async (): Promise<void> => {
    flush();
    await bounded(flushed(), FLUSH_ON_EXIT_TIMEOUT_MS);
  };
  const unsubscribeTitle = inner.onTitle(() => flush());
  // A background sub-agent's report can land while nobody streams (the session
  // is idle): only this save puts its `end` on the laptop's log (M5,
  // docs/feat/subagent-background.md). `?.`: unit-test fakes of a session.
  const unsubscribeAgentExit = inner.onAgentExit?.(() => flush());
  // A turn that ends while nobody iterates it (an attach mid-turn, R9) still
  // gets its end saved: only that save makes the session confirmed again.
  // (A turn somebody iterates saves itself when its stream ends: `saved`.)
  // LOAD-BEARING: `onIdle` fires synchronously in `RemoteSession`'s `streaming`
  // setter, so `flush` (which clears `confirmed`) runs before any read of
  // `saveConfirmed`. Keep it synchronous. Pinned by the test "R9 synchrony" in
  // test/local-runtime.test.ts (this call) and by client/test/idle-sync.test.ts
  // (the setter's); the R9 mid-turn test alone does NOT catch a deferred call.
  const unsubscribeIdle = inner.onIdle?.(() => {
    // `?.`: unit-test fakes of a session
    if (turns === 0) {
      flush();
    }
  });
  // A turn that failed before its first event (the link is gone for good, the
  // session closed, a send-now cancelled before it started) changed nothing:
  // reading the history back would only fail and report a save failure for a
  // complete file.
  async function* saved(events: AsyncIterable<SessionEvent>): AsyncGenerator<SessionEvent> {
    let changed = false;
    turns += 1;
    try {
      for await (const event of events) {
        changed = true;
        confirmed = false;
        // A call's result is a committed round (the daemon commits it at its
        // `history_commit`): save it now, not at the turn's end. In a pod `run`
        // the laptop holds the only copy, and a pod lost mid-turn would take a
        // never-saved conversation with it. Coalesced by `flush` (one read in
        // flight, the rest collapse into one more); no timer.
        if (event.type === "tool_result") {
          flush();
        }
        yield event;
      }
      changed = true;
    } finally {
      turns -= 1;
      if (changed) {
        flush();
      }
    }
  }
  const armFork = (copy: typeof lastRead): void => {
    if (!keepFork || copy === null || copy.head === forkedHead) {
      return;
    }
    const kept = forkableMessages(copy.messages);
    if (kept === null) {
      return;
    }
    forkedHead = copy.head;
    try {
      keepFork(kept, copy.title);
    } catch (error) {
      onFlushError(error instanceof Error ? error : new Error(String(error)));
    }
  };
  return {
    send(prompt, signal, opts) {
      return saved(inner.send(prompt, signal, opts));
    },
    // A refusal rejects untouched (the caller falls back); the old turn is
    // saved by its own `send`.
    async sendNow(messages, target, signal) {
      return saved(await inner.sendNow(messages, target, signal));
    },
    async compact() {
      const result = await inner.compact();
      flush();
      return result;
    },
    // `/clear` (docs/feat/clear-keeps-jobs.md): the daemon reset the history in
    // place; save the new segment the way a compaction's is.
    // The old chat is kept as its own session first (clear-fork-history).
    async clear() {
      // A resumed session nothing has opened yet holds its chat only as this
      // client's seed, with nothing daemon-side under its id
      // (docs/fix/clear-silent-noop.md): the first prompt's own open is done
      // FIRST (a no-op for every other session), so the read below finds the
      // pre-clear history to fork and the daemon has a conversation to reset.
      // `?.`: unit-test fakes of a session, and a caller that opened already
      // (`App.runClear` awaits the same open before it counts the clear as its
      // own — review M1).
      await inner.openForReset?.();
      // Read the pre-clear history back first (bounded: a slow link must not hold /clear).
      flush();
      await bounded(flushed(), FLUSH_ON_EXIT_TIMEOUT_MS);
      // The copy is taken AFTER the clear settles, so a pre-clear read slower
      // than the bound above still lands in it (M1); a read started after the
      // clear never does (`clearSent`, checked where the read starts).
      clearSent = true;
      let result: Awaited<ReturnType<typeof inner.clear>>;
      try {
        result = await inner.clear();
      } catch (error) {
        const copy = lastRead;
        if (!clearRefused(error)) {
          // The link dropped: it may have landed. A spare row beats a lost chat.
          armFork(copy);
          flush();
        }
        throw error;
      } finally {
        clearSent = false;
      }
      armFork(lastRead); // queued in the store BEFORE the save below can drop the old chat
      flush();
      return result;
    },
    // Propagate the inner Promise (don't swallow it) so the TUI can reconcile
    // its optimistic entry on a delivery failure.
    enqueue(text, id) {
      return inner.enqueue(text, id);
    },
    skills() {
      return inner.skills();
    },
    context() {
      return inner.context();
    },
    rename(title) {
      return inner.rename(title);
    },
    onReturned(listener) {
      return inner.onReturned(listener);
    },
    // The record is a copy of the SESSION, not of my turns (AGENTS §7
    // Persistence): a foreign turn is saved at its end like an own one, and a
    // history the daemon replaced the screen with is saved at once.
    watch(listener) {
      return inner.watch((activity) => {
        if (activity.kind === "turn") {
          listener({ ...activity, events: saved(activity.events) });
          return;
        }
        if (activity.kind === "history") {
          flush();
        }
        listener(activity);
      });
    },
    async open() {
      confirmed = false; // live: the daemon's history, not yet on the laptop
      await inner.open();
      await saveOnOpen();
    },
    async openSeeded() {
      confirmed = false; // it may attach a live one: the daemon's history, not yet on the laptop
      await inner.openSeeded();
      await saveOnOpen();
    },
    // The open `/clear` and `/compact` need, exposed so the TUI can await it
    // BEFORE it arms its own bookkeeping (review M1/M2). The controller's own
    // `clear` awaits it too (memoized: the same open, so the pre-clear read
    // below still finds the history that open applies).
    openForReset() {
      return inner.openForReset();
    },
    ownsTurn(turnId) {
      return turnId === adoptedTurn || inner.ownsTurn(turnId);
    },
    onQueued(listener) {
      return inner.onQueued(listener);
    },
    onSubagents(listener) {
      return inner.onSubagents(listener);
    },
    onSubagentNotify(listener) {
      return inner.onSubagentNotify(listener);
    },
    close() {
      closed = true;
      unsubscribeTitle();
      unsubscribeAgentExit?.();
      unsubscribeIdle?.();
      void flushed().then(() => inner.close());
    },
    flushed,
    saveNow() {
      if (!closed) {
        flush();
      }
      return flushed();
    },
    // A turn running on the daemon is never saved (R9), whoever iterates it.
    saveConfirmed: () => turns === 0 && running === null && confirmed && !inner.busy,
    seal() {
      sealed = true;
    },
    get sessionId() {
      return inner.sessionId;
    },
    ...(carried
      ? {
          settings: () =>
            settingsCommandLines(carried.mine, {
              ...inner.settingsState(),
              ...(carried.unconfirmed === true ? { unconfirmed: true } : {}),
            }),
          // The sync recomposes the system head: saved at once, like a compaction.
          async updateSettings(): Promise<readonly SettingsLine[]> {
            try {
              const result = await inner.applySettings();
              if (result === null) {
                return settingsCommandLines(carried.mine, {
                  open: false,
                  ...(carried.unconfirmed === true ? { unconfirmed: true } : {}),
                });
              }
              if (result.applied) {
                const id = inner.sessionId;
                if (id !== null) {
                  carried.applied?.(id);
                }
                flush();
              }
              return syncedLines(carried.mine, result);
            } catch (error) {
              return [updateFailureLine(error)];
            }
          },
        }
      : {}),
  };
}

export interface LocalRuntimeDeps {
  readonly channel: DuplexChannel;
  /**
   * Opens a fresh channel to the same daemon after a drop (a pod's new exec, a
   * WebSocket redial): present → the client reconnects and resumes; absent
   * (the worker) → a drop is terminal.
   */
  readonly channelFactory?: () => Promise<DuplexChannel>;
  /** The client's clock (tests); default the system's. */
  readonly clock?: Clock;
  /** Called to tear down the daemon side (terminate the worker / close the pipe). */
  readonly disposeTransport: () => void;
  readonly permissions: PermissionBroker;
  /**
   * An in-TUI notice (the session's `NoticeHub`): e.g. a reconnect that could
   * not restore the latest turn. Absent → dropped (tests, no TUI).
   */
  readonly notify?: (text: string, hint?: string) => void;
  /** Where each turn's history goes; its failures are reported, never thrown. */
  readonly saver: SessionSaver;
  readonly cwd: string;
  readonly model: string;
  /** A session to resume (its uid + history are reused), or null for a fresh one. */
  readonly resume: SessionRecord | null;
  /** Local model the daemon can tunnel calls back to (pod reverse-tunnel, F4.d). */
  readonly modelProvider?: ModelProvider;
  /** Serves the pod's TITLE calls; absent → refused (the laptop's `model.autoTitle` is off). */
  readonly titleModelProvider?: ModelProvider;
  /** The entries this laptop published to a pod; absent → every name is refused. */
  readonly namedModels?: NamedModels;
  /**
   * What this laptop carries into a pod (`run`/`attach`, docs/feat/config-carry.md).
   * Absent → nothing is sent: the local worker gets the config at bootstrap.
   */
  readonly sessionSettings?: SessionSettings;
  /** `container` for `run`/`attach`: picks the advice for a daemon too old to give its own. */
  readonly daemonKind?: DaemonKind;
  /**
   * Where the laptop stores project-hooks trust decisions — the local worker
   * ONLY (docs/feat/hooks-project-trust.md, D4). Ignored when the daemon
   * proxies the model through us (a pod, D5: asked every session, never stored).
   */
  readonly hooksTrustStore?: HooksTrustStore;
  /**
   * Non-fatal errors of the laptop-side peer (a stray/malformed daemon frame, a
   * local model failure the daemon only sees as opaque). Route to a buffered
   * sink — never a raw terminal write while Ink owns it (AGENTS §7).
   */
  readonly onPeerError?: (error: Error) => void;
  /**
   * Is someone there to answer the broker? Default true (a TUI). False (the
   * relay): a project-hooks trust ask is declined with a notice, never asked.
   */
  readonly interactive?: boolean;
  /** The first session's uid (a detached run's, minted by its launcher); else a fresh one. */
  readonly sessionId?: string;
  /**
   * The sessions may be shared with other laptop clients (a TUI of a detached
   * run, docs/feat/detached-handover.md): every close of them, `/clear`
   * included, is `session/close{ifLast}`, so it never ends one under the others.
   */
  readonly shared?: true;
}

/** Handshake the daemon and return a session factory that persists each turn. */
export async function createLocalRuntime(deps: LocalRuntimeDeps): Promise<LocalRuntime> {
  // The laptop decides `hooks/trust`, through THE single broker (AGENTS §7).
  // A pod (it tunnels the model through us) never gets the store, whatever
  // the caller passed: a pod-originated prompt never creates a lasting approval.
  const hooksTrust = createHooksTrustResolver({
    broker: deps.permissions,
    // A TUI's prompt answers the broker; a relay has no one to ask.
    interactive: deps.interactive ?? true,
    ...(deps.hooksTrustStore && !deps.modelProvider ? { store: deps.hooksTrustStore } : {}),
    ...(deps.notify ? { notify: deps.notify } : {}),
  });
  const client = new RemoteClient(deps.channel, deps.permissions, deps.modelProvider, {
    ...(deps.onPeerError ? { onError: deps.onPeerError } : {}),
    ...(deps.channelFactory ? { channelFactory: deps.channelFactory } : {}),
    ...(deps.clock ? { clock: deps.clock } : {}),
    hooksTrust,
    clientInfo: CLIENT_INFO,
    ...(deps.daemonKind ? { daemonKind: deps.daemonKind } : {}),
    ...(deps.titleModelProvider ? { titleModelProvider: deps.titleModelProvider } : {}),
    ...(deps.namedModels ? { namedModels: deps.namedModels } : {}),
    ...(deps.sessionSettings ? { sessionSettings: deps.sessionSettings } : {}),
    // `session/log` checkpoints (docs/feat/session-log.md): the daemon hashes the same way.
    sha256: (text) => createHash("sha256").update(text).digest("hex"),
  });
  await client.initialize();
  // A pod's report of what it did with them: through `notify`, never a raw write.
  // Another terminal's sync is told the same way (docs/feat/session-settings-apply.md).
  let forgetDrift: ((sessionId: string) => void) | undefined;
  if (deps.sessionSettings && deps.notify) {
    const mine = deps.sessionSettings;
    const notify = deps.notify;
    const notifier = createSettingsNotifier(mine, notify);
    forgetDrift = notifier.forget;
    client.onSessionSettings(notifier);
    client.onSessionSettingsChanged(({ sessionId, previous, report }) => {
      notifier.forget(sessionId);
      const text = changedNotice(mine, previous, report);
      if (text !== null) {
        notify(text);
      }
    });
  }
  const carried: ControllerSettings | undefined = deps.sessionSettings
    ? { mine: deps.sessionSettings, ...(forgetDrift ? { applied: forgetDrift } : {}) }
    : undefined;
  client.onHistoryLost(({ turns }) => {
    deps.notify?.(
      `⚠ The daemon lost the session while the link was down; it was restored without your last ${
        turns === 1 ? "turn" : `${turns} turns`
      } (no longer in the model's context, and not saved).`,
    );
  });
  // The daemon says (by code) the session was deleted elsewhere: it is not
  // recreated, so our copy goes too — through the saver, never a raw write.
  client.onSessionDeleted(({ sessionId }) => {
    deps.saver.remove(sessionId);
    deps.notify?.(
      "⚠ This session was deleted from another device: it was not restored, and its local copy was removed.",
    );
  });

  let seed = deps.resume;
  let firstId = deps.sessionId;
  /** The session `attachTo` opened: the next `createSession` hands it out. */
  let attached: PersistingController | null = null;
  const closeIfLast = deps.shared === true;
  let saving = true;
  /** Ids whose eager attach timed out: they may be live, with values nobody here has read. */
  const attachTimedOut = new Set<string>();
  const build = (
    uid: string,
    record: SessionRecord | null,
    attach: boolean,
    adoptTurn?: string,
  ): PersistingController => {
    // The first save's stamp, kept by every later one (a fresh session has no
    // record: recordFromSnapshot stamps "now", and that value is then reused).
    let createdAt = record?.createdAt;
    // A resumed record's chosen title seeds the open that recreates it (pod,
    // worker: they keep nothing), so it is never regenerated over a rename.
    const title = record ? recordTitleState(record) : ({ source: "auto" } as const);
    // An attach seeds nothing: the session is live, its history the daemon's.
    const session = attach
      ? client.newSession(undefined, uid, undefined, { attach: {}, closeIfLast })
      : client.newSession(
          record?.messages,
          uid,
          title.source === "auto" ? undefined : { text: title.text, source: title.source },
          { closeIfLast },
        );
    const controller = persistingController(
      session,
      (_messages, _latest, back) => {
        if (!saving) {
          return; // handed over: the TUIs save it now
        }
        // The read's validated entries go to the log as they are (F4); the
        // title is in them (`title` entries).
        createdAt ??= Date.now();
        deps.saver.write({
          id: uid,
          meta: { cwd: deps.cwd, model: deps.model, createdAt },
          entries: back.entries,
          messages: back.messages,
          read: back.read,
        });
      },
      (error) => deps.saver.failed(uid, `could not read the history back: ${error.message}`),
      title,
      adoptTurn,
      carried && attachTimedOut.has(uid) ? { ...carried, unconfirmed: true } : carried,
      // F1: the copy the daemon forked from goes aside (a log file too).
      (messages, latest) => {
        createdAt ??= Date.now();
        return deps.saver.saveAside(
          uid,
          { cwd: deps.cwd, model: deps.model, createdAt },
          messages,
          latest,
        );
      },
      (messages, latest) => {
        createdAt ??= Date.now();
        deps.saver.keepFork(
          uid,
          forkWrite({
            id: crypto.randomUUID(),
            meta: { cwd: deps.cwd, model: deps.model, createdAt },
            messages,
            title: latest,
            ts: Date.now(),
          }),
        );
      },
    );
    controllers.add(controller);
    return controller;
  };
  const createSession = (): PersistingController => {
    if (attached) {
      const controller = attached;
      attached = null;
      return controller;
    }
    const record = seed;
    seed = null; // only the first session resumes; /clear starts fresh
    const uid = record?.id ?? firstId ?? crypto.randomUUID();
    firstId = undefined;
    return build(uid, record, false);
  };
  const controllers = new Set<PersistingController>();
  const allFlushed = (): Promise<void> =>
    bounded(
      Promise.all([...controllers].map((c) => c.flushed())).then(() => undefined),
      FLUSH_ON_EXIT_TIMEOUT_MS,
    );
  /**
   * Q4: the open's own save has reached the laptop file (bounded), not just
   * been read back: only then does `saveConfirmed` mean the file is current.
   */
  const written = async (): Promise<void> => {
    await deps.saver.drain({ timeoutMs: FLUSH_ON_EXIT_TIMEOUT_MS });
  };
  /** Leave every open session to the daemon (bounded). */
  const detachAll = (): Promise<void> =>
    bounded(
      Promise.all(
        client.liveSessionIds().map((id) =>
          client.detachSession(id).catch((error: unknown) => {
            deps.onPeerError?.(error instanceof Error ? error : new Error(String(error)));
          }),
        ),
      ).then(() => undefined),
      FLUSH_ON_EXIT_TIMEOUT_MS,
    );

  return {
    createSession,
    jobs: remoteJobsView(client),
    link: { onLinkStatus: (listener) => client.onLinkStatus(listener) },
    mcpStatus: () => client.mcpStatus(),
    dispose: async () => {
      // A quit right after a turn must not close the session under its save.
      await allFlushed();
      await client.closeSessions();
      client.close();
      deps.disposeTransport();
    },
    release: async () => {
      await allFlushed();
      // This client leaves: a turn ending later cannot be read back, and that
      // is no failed save (the session is the daemon's, or its closer saved it).
      for (const controller of controllers) {
        controller.seal();
      }
      await detachAll();
      client.close();
      deps.disposeTransport();
    },
    attachTo: async (id, record, opts = {}) => {
      const controller = build(id, record, true, opts.adoptTurn);
      try {
        await controller.open();
      } catch (error) {
        controllers.delete(controller);
        controller.close?.();
        // By the CODE, never the text.
        if ((error as { code?: unknown } | null)?.code === DomainErrorCode.UnknownSession) {
          return false;
        }
        if (error instanceof AttachTimeoutError) {
          attachTimedOut.add(id);
        }
        throw error;
      }
      // The run's session is this one: the seed and the first uid are spent.
      seed = null;
      firstId = undefined;
      attached = controller;
      await written();
      return true;
    },
    openSeeded: async (record) => {
      if (record !== undefined) {
        seed = record;
      }
      const controller = createSession();
      try {
        await controller.openSeeded();
      } catch (error) {
        controllers.delete(controller);
        controller.close?.();
        throw error;
      }
      attached = controller;
      await written();
    },
    quit: async (opts = {}) => {
      // A close that ends a running turn needs nothing more here: that turn has
      // no `turn_end` in the saved log, so it is closed when the file is loaded
      // (docs/feat/session-log-laptop-store.md Q11; was the save-time cut, Q2).
      // A foreign turn is saved only at its end: the last read-back is what
      // puts a running first turn's transcript on the laptop.
      const answered = await withTimeout(
        Promise.all([...controllers].map((c) => c.saveNow())),
        FLUSH_ON_EXIT_TIMEOUT_MS,
        "the last read-back",
      ).then(
        () => true,
        () => false,
      );
      // On disk, before a close ends the daemon's copy (a pod keeps none). The
      // drain lists a read-back that failed too (`saver.failed`).
      const saved = answered && (await deps.saver.drain()).length === 0;
      // The last save is taken: a turn ending under the close, or a read
      // still in flight, must not report a false "not saved" (FAIL 39).
      for (const controller of controllers) {
        controller.seal();
      }
      let sessionsKept: number;
      if (saved) {
        sessionsKept = await client.closeSessions(undefined, {
          ifLast: opts.closeForAll !== true,
        });
      } else {
        sessionsKept = client.liveSessionIds().length;
        await detachAll();
      }
      await client.modelIdle(QUIT_MODEL_DRAIN_MS);
      client.close();
      deps.disposeTransport();
      return { sessionsKept, saved };
    },
    stopSaving: () => {
      saving = false;
    },
    flushed: () => allFlushed(),
    saveConfirmed: () =>
      saving && [...controllers].every((c) => c.saveConfirmed()) && deps.saver.clean(),
    modelIdle: (ms) => client.modelIdle(ms),
    unflushedExits: () => client.unflushedExits(),
    sessionJobs: async (id) => {
      try {
        const { sessions } = await client.sessionList();
        const entry = sessions.find((session) => session.sessionId === id);
        return entry ? (entry.jobs ?? 0) : null;
      } catch {
        return null;
      }
    },
    residentUse: async (id, opts) => {
      try {
        return residentUseOf(await client.sessionList(), id, opts);
      } catch {
        return null;
      }
    },
  };
}

/** Resolve when `promise` settles or after `ms`, whichever is first; never rejects. */
function bounded(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.catch(() => {}),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Spawn the worker daemon and build a persisting runtime against it. Returns
 * null (after logging) on any failure — the caller falls back to in-process, so
 * a worker problem never breaks the TUI.
 */
export async function startWorkerRuntime(
  config: TentacleConfig,
  deps: { permissions: PermissionBroker; saver: SessionSaver; resume: SessionRecord | null },
  log: (line: string) => void,
): Promise<LocalRuntime | null> {
  let worker: Worker;
  // A spawn failure (e.g. a worker missing from a compiled binary) would
  // otherwise surface only as the 8s handshake timeout; capture it so the
  // fallback message says what actually happened.
  let workerError: string | null = null;
  try {
    // `new Worker` specifier resolution differs by form AND environment:
    //  - this URL form resolves relative to THIS module from source, and — on
    //    Bun >= 1.4 — against the entrypoints embedded in a compiled binary
    //    (scripts/build.ts lists worker.ts as a second entrypoint).
    //  - on Bun 1.3 the URL form fails in a compiled binary ("ModuleNotFound
    //    resolving /$bunfs/root/worker.ts"); a plain relative string works
    //    there but resolves against the CWD from source (breaking `bun test`).
    // The URL form + Bun >= 1.4 is the only combo that works in both — see the
    // TODO entry "Compiled binary drops the worker daemon".
    worker = new Worker(new URL("./worker.ts", import.meta.url).href, { type: "module" });
    worker.addEventListener("error", (event) => {
      workerError = String((event as ErrorEvent).message);
    });
    // Object bootstrap (structured-cloned); the worker takes its version from it.
    worker.postMessage({ config, version: APP_VERSION } satisfies WorkerBootstrap);
  } catch (error) {
    log(`[worker] could not start (${String(error)}); using in-process\n`);
    return null;
  }
  // Object messages (never string RPC frames) from the worker: forwarded job
  // process groups (the main thread owns the exit net that kills them), and MCP
  // connection errors, surfaced without being fatal.
  worker.addEventListener("message", (event: { data: unknown }) => {
    if (applyGroupMessage(event.data)) {
      return;
    }
    const data = event.data as { type?: string; errors?: Record<string, string> } | null;
    if (data && typeof data === "object" && data.type === "mcp-errors" && data.errors) {
      for (const [name, message] of Object.entries(data.errors)) {
        log(`[mcp] server "${name}" failed to connect: ${message}\n`);
      }
    }
  });
  const channel = messagePortChannel(worker as unknown as MessageEndpoint);
  try {
    return await withTimeout(
      createLocalRuntime({
        channel,
        disposeTransport: () => worker.terminate(),
        permissions: deps.permissions,
        saver: deps.saver,
        cwd: config.cwd,
        model: config.model,
        resume: deps.resume,
        // The local worker is the one runtime whose trust decisions persist (D4).
        hooksTrustStore: fileTrustStore(config.configDir, (message) => {
          logDaemonError(config.configDir, new Error(message));
        }),
        // Laptop-side peer errors (a malformed daemon frame with no turn to
        // fail) go to the same file log as the worker's own errors — never a
        // raw terminal write while Ink owns it (AGENTS §7).
        onPeerError: (error) => {
          logDaemonError(config.configDir, error);
        },
      }),
      8000,
      "worker handshake",
    );
  } catch (error) {
    log(`[worker] handshake failed (${workerError ?? String(error)}); using in-process\n`);
    worker.terminate();
    return null;
  }
}
