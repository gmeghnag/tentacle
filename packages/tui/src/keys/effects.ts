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
import type { ArtifactMeta } from "@tentacle/protocol";
import type { ArtifactIntent } from "../artifact-open.ts";
import type { DockState } from "../background-focus.ts";
import type { ChordState } from "../chord.ts";
import type { QuitConfirmFacts } from "../commands.ts";
import type { ReplyMode } from "../permission-reply.ts";
import type { SchedulesState } from "../schedule-view.ts";
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
  /**
   * Space in `/mcp` / `/skills`: flip the selected row's on/off switch
   * (docs/feat/session-capabilities.md S4). What it flips is decided on the
   * LIVE panel and switches (`panelSwitchOp`), like `applyPanel`.
   */
  | { readonly kind: "switchCapability" }
  /** Write the sessions panel's state (`sessionsDelete`'s arm/answer). */
  | { readonly kind: "setSessionsState"; readonly state: SessionsState }
  /**
   * Enter in `/artifacts`: open the version the panel's cursor is on
   * (docs/feat/model-artifacts.md D8). The META is the panel's own decision
   * (`artifactAt`), never an index the App resolves again.
   */
  | {
      readonly kind: "openArtifact";
      readonly artifact: ArtifactMeta;
      /** `n` (with the network) or `s` (save a copy); absent: a plain open. */
      readonly intent?: ArtifactIntent;
    }
  /** `Ctrl+X Ctrl+O`: open the newest artifact in the transcript (D8). */
  | { readonly kind: "openNewestArtifact" }
  /** The artifact open confirm (a pod's bytes, or the network) was answered. */
  | { readonly kind: "answerArtifactConfirm"; readonly yes: boolean }
  /** Write the `/schedule` panel's own state (its arm/answer, cron-tool S5). */
  | { readonly kind: "setSchedulesState"; readonly state: SchedulesState }
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
  /** Drop one scheduled wake (`session/schedule_delete`, cron-tool S5): the dock's `x`. */
  | { readonly kind: "deleteSchedule"; readonly id: string }
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
  | { readonly kind: "pushNotice"; readonly text: string }
  // --- the line-editing tail (S12, `line-layer.ts`): what a chunk every layer
  // above passed does to the input line. Each is one call on the line editor
  // or one App setter; the decision (which one, with what) is already taken.
  | { readonly kind: "fieldInsert"; readonly text: string }
  | { readonly kind: "fieldDeleteBack" }
  | { readonly kind: "fieldDeleteWord"; readonly dir: -1 | 1 }
  | { readonly kind: "fieldMoveCursor"; readonly delta: -1 | 1; readonly extend: boolean }
  | { readonly kind: "fieldMoveWord"; readonly dir: -1 | 1; readonly extend: boolean }
  | { readonly kind: "fieldMoveLine"; readonly edge: "start" | "end"; readonly extend: boolean }
  | { readonly kind: "fieldMoveVertical"; readonly dir: -1 | 1; readonly extend: boolean }
  /** Write the history walk's position and saved draft (the App's refs). */
  | { readonly kind: "setHistoryCursor"; readonly index: number; readonly draft: string }
  /** DOWN at the draft slot: onto the pill / back into the list (`downToDock`). */
  | { readonly kind: "dockDown" }
  /** PgUp / PgDn: scroll the transcript (`applyScroll` on the live offset). */
  | { readonly kind: "scroll"; readonly dir: "pageUp" | "pageDown" }
  /** Ctrl+V in the main input: read the clipboard, route it as an attachment. */
  | { readonly kind: "pasteClipboard" }
  | { readonly kind: "submit"; readonly text: string }
  /** Backspace on an empty input with chips: drop the last chip. */
  | { readonly kind: "removeLastChip" }
  // --- voice dictation (docs/feat/voice-dictation.md). The key layer only
  // DECIDES; `useVoice` owns the child and the reducer does the rest.
  /** Start a dictation, or finish the running one (one key, two meanings). */
  | { readonly kind: "voiceToggle" }
  /** Enter while dictating: transcribe and insert. Never sends. */
  | { readonly kind: "voiceFinish" }
  /** Esc while dictating: discard it and leave the agent's turn alone. */
  | { readonly kind: "voiceCancel" };
