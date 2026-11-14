/**
 * What the key router decides the App must DO (docs/feat/app-decomposition.md
 * S3): the effects are DATA, never closures, so every layer stays a pure
 * function of `KeySnapshot` and the whole precedence order is unit-testable
 * without React or Ink. `execute.ts` is the only place that touches the App.
 *
 * A pure module may read the SAME source it always read (Fable H3): a ref
 * getter stays a live read, a render closure value stays a render value. The
 * effects below therefore carry *decided* values (a new `DockState`, an answer)
 * or a *decision* another pure module still applies (`applyPanel`), never the
 * state that decided them.
 */
import type { PermissionResponse } from "@tentacle/core";
import type { DockState } from "../background-focus.ts";
import type { ChordState } from "../chord.ts";
import type { QuitConfirmFacts } from "../commands.ts";
import type { ReplyMode } from "../permission-reply.ts";
import type { SessionsState } from "../sessions-panel.ts";
import type { TreeAction } from "../tree-panel.ts";

/** The permission answer's "stop everything" (`App` aborts, no deny goes out). */
export type KeyEffect =
  /** Shift+Tab: auto-accept on/off (granting the ask already on screen). */
  | { readonly kind: "toggleAutoAccept" }
  /** Raise or drop the `/quit` confirmation dialog. */
  | { readonly kind: "setQuitConfirm"; readonly facts: QuitConfirmFacts | null }
  /** Close for good (`closeForAll` skips attach-run's re-check). */
  | { readonly kind: "quit"; readonly closeForAll: boolean }
  /** Write the send-now chord's carry-over state. */
  | { readonly kind: "setChord"; readonly state: ChordState }
  /** The chord completed: send the queued messages now. */
  | { readonly kind: "sendNow" }
  /** The bracketed-paste carry-over buffer (null when not inside a paste). */
  | { readonly kind: "setPasteBuffer"; readonly buffer: string | null }
  | { readonly kind: "armPasteTimeout" }
  | { readonly kind: "clearPasteTimeout" }
  /** Insert text into the OPEN REPLY field, never the hidden main one. */
  | { readonly kind: "insertReply"; readonly text: string }
  | { readonly kind: "setReplyMode"; readonly mode: ReplyMode }
  | { readonly kind: "permissionSelect"; readonly index: number }
  | { readonly kind: "permissionAnswer"; readonly response: PermissionResponse }
  /** Ctrl+C on the dialog: dismiss + abort the shown turn (no deny goes out). */
  | { readonly kind: "permissionStop" }
  /** Ctrl+V in the reply field: read the clipboard into it. */
  | { readonly kind: "pasteReply" }
  /** Leave the TUI (Ink unmounts). */
  | { readonly kind: "exit" }
  /** Abort the running turn, marking it stopped here (`stoppedHereRef`). */
  | { readonly kind: "abortTurn" }
  /** Route text through `routeAttach` (prose → insert, image paths → chips). */
  | { readonly kind: "routeAttach"; readonly text: string }
  | { readonly kind: "closePanel" }
  /** Apply a panel action to the LIVE panel (`applyPanel`, functional read). */
  | { readonly kind: "applyPanel"; readonly action: TreeAction }
  /** Write the sessions panel's state (`sessionsDelete`'s arm/answer). */
  | { readonly kind: "setSessionsState"; readonly state: SessionsState }
  /** Switch to another session (the panel already closed). */
  | { readonly kind: "switchTo"; readonly id: string; readonly reopen: boolean }
  /** Delete a session, then refresh the panel if it is still the same one. */
  | {
      readonly kind: "sessionsDelete";
      readonly id: string;
      /** The panel generation when the key landed: a newer one means "closed". */
      readonly startedGen: number;
    }
  | { readonly kind: "killJob"; readonly id: string }
  | { readonly kind: "killChild"; readonly id: string }
  | { readonly kind: "setDock"; readonly state: DockState }
  | { readonly kind: "fieldSet"; readonly text: string }
  | { readonly kind: "fieldReset" }
  /** Ctrl+T from the input: the same toggle `/agents` runs. */
  | { readonly kind: "toggleAgents" }
  /** Esc with an upload in flight: abort it, the chips stay. */
  | { readonly kind: "cancelUpload" }
  | { readonly kind: "toggleExpandAll" }
  /** Palette Up/Down: move the highlight by `step` rows (wrapping). */
  | { readonly kind: "moveCommandSel"; readonly step: -1 | 1 }
  /** Run the highlighted palette command by NAME (the App resolves it). */
  | { readonly kind: "runCommand"; readonly name: string }
  | { readonly kind: "pushNotice"; readonly text: string };
