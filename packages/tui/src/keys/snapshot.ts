import type { PermissionRequest } from "@tentacle/core";
/**
 * The key router's INPUT (docs/feat/app-decomposition.md S3, Fable H3).
 *
 * The single rule this file encodes: **every snapshot field keeps the SOURCE it
 * had inside the old inline handler.** A field that was a ref read at key time is
 * a GETTER (a keypress must see what the previous key in the same tick wrote,
 * before React commits); a field that was a render closure is a VALUE (two keys
 * delivered with no render between them see the same frame, as today).
 * "Cleaning this up to one source" is out of scope: it would change behaviour,
 * and S0b's freshness pins record today's split.
 *
 * The snapshot is built inside the ONE `useInput`, at the event, so a decision
 * reads exactly the values the inline handler read at that instant.
 *
 * Source, per field, verified against `App.tsx` before the move (line numbers are
 * pre-S3 on this branch):
 *
 * | field | old source | here |
 * |---|---|---|
 * | `quitConfirm` | `quitConfirmRef.current` (3814) | getter |
 * | `dock` | `dockRef.current` (3841, 4062) | getter |
 * | `chord` | `chordRef.current` (3842-3860) | getter |
 * | `running` | `stateRef.current.running` (4107) | getter |
 * | `compacting` | `compactingRef.current` (3634) | getter |
 * | `permission.mode` | `permission.readMode()` (3861) | getter |
 * | `uploadInFlight` | `uploadCtrlRef.current !== null` (3900) | getter |
 * | `abortable` | `abortRef.current` truthiness (3907, 3548) | getter |
 * | `exitPending` | `exitPendingRef.current` (3564) | getter |
 * | `subagents` / `jobRows` | `subagentsRef` / `jobRowsRef` (3563, 3565) | getter |
 * | `othersOnSession` | `runQuit?.othersOnSession() ?? 0` (3547, 3562) | getter |
 * | `sessionId` | `sessionRef.current?.sessionId` (3627) | getter |
 * | `switching` | `switchingRef.current` (3708, 3755) | getter |
 * | `panelGen` | `panelGenRef.current` (3700) | getter |
 * | `dockIds` | `dockIds()` (3701) | getter |
 * | `panel` | render `panel` (3612/3682/3698) | value |
 * | `paletteOpen` / `paletteNames` / `commandSel` | render (3757-3791) | value |
 * | `fieldValue` | render `field.value` (3705) | value |
 * | `permission.pending` / `.choices` / `.selected` | render (3870) | value |
 * | `sessions` | render prop (3638) | value |
 * | `detachOnQuit` | prop closure (3565) | value |
 */
import type { Key } from "ink";
import type { SessionDirectory } from "../app-types.ts";
import type { DockState } from "../background-focus.ts";
import type { DockJobRow } from "../background-list.ts";
import type { BackgroundAgentRow } from "../background-view.ts";
import type { ChordState } from "../chord.ts";
import type { QuitConfirmFacts } from "../commands.ts";
import type { OpenPanel } from "../panel.ts";
import type { ReplyMode } from "../permission-reply.ts";
import type { PermissionChoice } from "../permission-ui.ts";

/** The permission dialog, as the router reads it (render values + a live mode). */
export interface KeyPermission {
  readonly pending: PermissionRequest | null;
  readonly choices: readonly PermissionChoice[];
  readonly selected: number;
  /** The mode AS OF NOW (a ref: keys between renders compose, as before). */
  mode(): ReplyMode;
}

/** Everything one chunk's decision may read. See the file header for SOURCES. */
export interface KeySnapshot {
  /** This chunk, exactly as Ink parsed it. */
  readonly char: string;
  readonly key: Key;

  // --- live reads (getters): a key must see what the last key in this tick wrote
  quitConfirm(): QuitConfirmFacts | null;
  dock(): DockState;
  chord(): ChordState;
  running(): boolean;
  compacting(): boolean;
  /** The dock's item ids in paint order (children, then jobs). */
  dockIds(): readonly string[];
  /** Other live TUIs on this session (`runQuit?.othersOnSession() ?? 0`). */
  othersOnSession(): number;
  sessionId(): string | null;
  switching(): boolean;
  panelGen(): number;
  /** An abort handle exists: this TUI can stop the turn shown. */
  abortable(): boolean;
  uploadInFlight(): boolean;
  exitPending(): boolean;
  /** The request's `reply.maxChars` (0 when it takes none), read live. */
  replyMaxChars(): number;
  subagents(): readonly BackgroundAgentRow[];
  jobRows(): readonly DockJobRow[];

  // --- render values: what the frame the chunk landed on showed
  readonly panel: OpenPanel | null;
  readonly paletteOpen: boolean;
  /** The palette's command names, in order (the highlight indexes this). */
  readonly paletteNames: readonly string[];
  readonly commandSel: number;
  /** The LIVE input text as of this render (the dock's `draftIn` decision). */
  readonly fieldValue: string;
  readonly permission: KeyPermission;
  /** The bracketed-paste carry-over buffer, read live (a paste spans chunks). */
  pasteBuffer(): string | null;
  /** Absent when the runtime has no session directory (`/sessions` unavailable). */
  readonly sessions: SessionDirectory | undefined;
  readonly detachOnQuit: boolean;
}
