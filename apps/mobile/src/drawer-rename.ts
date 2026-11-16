/**
 * Rename from the sessions drawer (docs/feat/mobile-chrome.md Design 3 "Row
 * actions", F7): long-press a row → Rename → `session/rename` BY ID, which
 * needs no open (`protocol/src/session.ts` `session/rename`; an archived
 * session is renamed in place). React-free (AGENTS §7): the drawer only draws
 * `state()` with the existing `RenameSheet`.
 *
 * Every decision about the text is `session-rename.ts`'s — `renamePlan`
 * (empty/unchanged = no-op, too long = refused here) and `renameErrorText` —
 * so the drawer and the chat header can never disagree. What this adds is the
 * drawer's own flow: the row's computer is named by the row (the drawer may
 * list another computer than the open session's), a failure keeps the field
 * open with the person's text, a success closes it and asks THAT computer's
 * list to be re-read (the row keeps its old title until the daemon's stored
 * one is read back — F7), and a second Save while one is in flight sends
 * nothing.
 */
import { type RenameState, renameErrorText, renamePlan } from "./session-rename.ts";

export interface DrawerRename {
  /** The computer the row was listed under (the call goes to its link). */
  readonly computerId: string;
  readonly sessionId: string;
  /** The row's title when the field opened: what "unchanged" is measured against. */
  readonly current: string;
  readonly field: RenameState;
}

export interface DrawerRenameDeps {
  /** `link.client.rename(sessionId, title)` on that computer; resolves with the stored title. */
  readonly rename: (computerId: string, sessionId: string, title: string) => Promise<string>;
  /** The daemon renamed it: re-read that computer's list. */
  readonly renamed: (computerId: string) => void;
}

export interface DrawerRenameController {
  /** `null` while the field is closed. */
  state(): DrawerRename | null;
  subscribe(listener: () => void): () => void;
  begin(computerId: string, row: { readonly id: string; readonly title: string }): void;
  setText(text: string): void;
  submit(): Promise<void>;
  cancel(): void;
}

export function createDrawerRename(deps: DrawerRenameDeps): DrawerRenameController {
  let state: DrawerRename | null = null;
  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };
  return {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    begin(computerId, row) {
      state = {
        computerId,
        sessionId: row.id,
        current: row.title,
        field: { text: row.title, saving: false, error: null },
      };
      emit();
    },
    setText(text) {
      if (state === null) {
        return;
      }
      state = { ...state, field: { ...state.field, text, error: null } };
      emit();
    },
    async submit() {
      const open = state;
      if (open === null || open.field.saving) {
        return;
      }
      const plan = renamePlan(open.current, open.field.text);
      if (plan.kind === "noop") {
        state = null;
        emit();
        return;
      }
      if (plan.kind === "invalid") {
        state = { ...open, field: { ...open.field, error: plan.reason } };
        emit();
        return;
      }
      const saving: DrawerRename = { ...open, field: { ...open.field, saving: true, error: null } };
      state = saving;
      emit();
      try {
        await deps.rename(open.computerId, open.sessionId, plan.title);
      } catch (error) {
        // Still this field (not cancelled meanwhile): it stays open with the
        // person's text and the reason — a failed rename never looks done.
        if (state === saving) {
          state = {
            ...open,
            field: { ...open.field, saving: false, error: renameErrorText(error) },
          };
          emit();
        }
        return;
      }
      // The daemon stored it, whether or not the field is still open: the list
      // must be re-read either way, or the row keeps a title that is no longer true.
      deps.renamed(open.computerId);
      if (state === saving) {
        state = null;
        emit();
      }
    },
    cancel() {
      state = null;
      emit();
    },
  };
}
