/**
 * A drawer row's SET actions — pin/unpin and delete — for
 * docs/feat/mobile-session-actions.md (S2), in the `drawer-rename.ts` shape:
 * one pure controller the drawer draws and `App.tsx` wires, so every branch is
 * tested without React or a daemon.
 *
 * What it owns:
 * - **The row's computer.** The call goes to the computer that LISTED the row
 *   (the drawer may list another computer than the open session's), exactly as
 *   rename does; a link that cannot be dialled is a failure, not a queue.
 * - **Never queued.** `session/pin` and `session/delete` are not in the outbox:
 *   a delete replayed after the person changed their mind is far worse than an
 *   error, so an offline tap fails at once and the row stays as it was.
 * - **One action per row in flight.** A second tap while one is in flight sends
 *   nothing (the path is idempotent, but a double DELETE over a slow link is
 *   still two prompts and two answers).
 * - **A success re-reads that computer's list** and clears the error; the row
 *   converges to the daemon's truth, never to a guess.
 * - **Deleting the OPEN session navigates** (Owner Q2): to the next row the
 *   drawer chose (`DrawerList.nextAfterCurrent`), or to the empty drawer.
 */
import { DomainErrorCode, JsonRpcErrorCode } from "@tentacle/protocol";
import { RpcError } from "@tentacle/transport";

/** What the drawer needs to know to draw the row flow (`SessionsDrawer`). */
export interface DrawerRowActionsState {
  /** A pin/unpin is in flight on this row (its glyph may pulse; taps are ignored). */
  readonly busy: ReadonlySet<string>;
  /** The last failure, shown in the drawer's banner until dismissed or replaced. */
  readonly error: string | null;
}

export interface DrawerRowActionsDeps {
  /** `link.client.pinSession(id, pinned)` on that computer; resolves the state after applying. */
  readonly pin: (computerId: string, sessionId: string, pinned: boolean) => Promise<boolean>;
  /** `link.client.deleteSession(id)` on that computer. */
  readonly remove: (computerId: string, sessionId: string) => Promise<void>;
  /** The daemon applied it: re-read that computer's list (never a local guess). */
  readonly reread: (computerId: string) => void;
  /**
   * The open session was deleted: go after it (the drawer's `nextAfterCurrent`),
   * or null for the empty drawer. Called only for the session that WAS open.
   */
  readonly navigate: (nextRowId: string | null) => void;
  /** `currentId` at call time: only the open session's delete navigates. */
  readonly currentId: () => string | null;
  /** The row after the open one, from the list as it stands now (`DrawerList`). */
  readonly nextAfterCurrent: () => string | null;
}

export interface DrawerRowActionsController {
  state(): DrawerRowActionsState;
  subscribe(listener: () => void): () => void;
  /** Long-press → Pin/Unpin: a SET, sent at once; a second tap on that row sends nothing. */
  pin(computerId: string, row: { readonly id: string; readonly pinned: boolean }): Promise<void>;
  /**
   * The confirmation's Delete: `session/delete` by id. A row already deleted
   * elsewhere (`SessionDeleted`) is a SUCCESS — the list is re-read either way.
   */
  confirmDelete(computerId: string, row: { readonly id: string }): Promise<void>;
  /** The banner's dismiss, and the start of a new action (a stale error never lingers). */
  dismiss(): void;
}

const PIN_TOO_OLD = "Update tentacle on this computer to pin sessions.";
const DELETE_TOO_OLD = "Update tentacle on this computer to delete sessions.";
const NOT_CONNECTED = "Not connected to this computer. Try again when it is back.";

/**
 * What a failed pin or delete says. Decided by error CLASS and CODE only —
 * never by message text, which a pod daemon chooses (AGENTS §7 "a pod is not
 * trusted"). `MethodNotFound` gets its own sentence (an older daemon: Rename and
 * the rest still work), a dead link another, anything else keeps the daemon's
 * own words when it gave usable ones.
 */
export function rowActionErrorText(error: unknown, action: "pin" | "delete"): string {
  if (error instanceof RpcError && error.code === JsonRpcErrorCode.MethodNotFound) {
    return action === "pin" ? PIN_TOO_OLD : DELETE_TOO_OLD;
  }
  const message = error instanceof Error ? error.message : "";
  // The client's own "not connected to the daemon" (RemoteClient rejects with it
  // while the link is down): said in the drawer's words, not the client's.
  if (message.includes("not connected")) {
    return NOT_CONNECTED;
  }
  if (message !== "") {
    return message;
  }
  return action === "pin" ? "Couldn't pin the session." : "Couldn't delete the session.";
}

/** `SessionDeleted` on a delete: the session is already gone — the intended outcome. */
function isAlreadyDeleted(error: unknown): boolean {
  return error instanceof RpcError && error.code === DomainErrorCode.SessionDeleted;
}

export function createDrawerRowActions(deps: DrawerRowActionsDeps): DrawerRowActionsController {
  let state: DrawerRowActionsState = { busy: new Set(), error: null };
  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };
  const setBusy = (sessionId: string, on: boolean): void => {
    const busy = new Set(state.busy);
    if (on) {
      busy.add(sessionId);
    } else {
      busy.delete(sessionId);
    }
    state = { ...state, busy };
  };

  /** Shared tail of both actions: the error, or the re-read (+ navigate). */
  async function run(
    sessionId: string,
    computerId: string,
    action: "pin" | "delete",
    call: () => Promise<void>,
    afterSuccess: () => void,
  ): Promise<void> {
    if (state.busy.has(sessionId)) {
      return;
    }
    setBusy(sessionId, true);
    state = { ...state, error: null };
    emit();
    try {
      await call();
    } catch (error) {
      if (action === "delete" && isAlreadyDeleted(error)) {
        // Deleted elsewhere: the intended state, so it is a success.
        setBusy(sessionId, false);
        emit();
        afterSuccess();
        deps.reread(computerId);
        return;
      }
      setBusy(sessionId, false);
      state = { ...state, error: rowActionErrorText(error, action) };
      emit();
      return;
    }
    setBusy(sessionId, false);
    emit();
    afterSuccess();
    deps.reread(computerId);
  }

  return {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async pin(computerId, row) {
      const wanted = !row.pinned;
      await run(
        row.id,
        computerId,
        "pin",
        async () => {
          await deps.pin(computerId, row.id, wanted);
        },
        () => undefined,
      );
    },
    async confirmDelete(computerId, row) {
      // Read BEFORE the await: after it, the row may no longer be the open one.
      const wasOpen = deps.currentId() === row.id;
      await run(
        row.id,
        computerId,
        "delete",
        async () => {
          await deps.remove(computerId, row.id);
        },
        () => {
          if (wasOpen) {
            deps.navigate(deps.nextAfterCurrent());
          }
        },
      );
    },
    dismiss() {
      if (state.error === null) {
        return;
      }
      state = { ...state, error: null };
      emit();
    },
  };
}
