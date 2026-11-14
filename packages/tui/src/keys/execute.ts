/**
 * The key router's EXECUTOR (docs/feat/app-decomposition.md S3): the one place a
 * routing decision becomes a call into the App. `keys/route.ts` decides; this
 * file acts; `App.tsx` supplies the port and keeps the ONE `useInput`.
 *
 * The port is narrow on purpose (AGENTS §7): a field is either a setter the App
 * already had (stable identity, so `useCallback` deps do not churn) or a decision
 * another pure module still owns (`applyPanel`, `sessionsDelete`'s refresh). The
 * executor adds no branching that the router could have decided — anything that
 * looks like a decision below (a kind check on an effect) IS a decision already
 * taken upstream, in the effect's own `kind`.
 */
import type { PermissionResponse } from "@tentacle/core";
import type { DockState } from "../background-focus.ts";
import type { ChordState } from "../chord.ts";
import type { QuitConfirmFacts } from "../commands.ts";
import type { OpenPanel } from "../panel.ts";
import { applyPanel } from "../panel.ts";
import type { ReplyMode } from "../permission-reply.ts";
import type { SessionsState, SessionsView } from "../sessions-panel.ts";
import {
  deleteFailedNotice,
  refreshedSessions,
  sessionsListError,
  sessionsRefreshApplies,
} from "../sessions-panel.ts";
import type { TreeAction } from "../tree-panel.ts";
import type { KeyEffect } from "./effects.ts";

/**
 * What the executor may call. Every field keeps the identity it has in `App`
 * today (Fable H2): setters are the App's own stable callbacks, the refs are
 * the refs, and nothing here is rebuilt per render except the two view-model
 * reads the palette needs (`paletteNames`, read at the event).
 */
export interface KeyHost {
  // --- input / dialogs
  toggleAutoApprove(): void;
  setQuitConfirm(facts: QuitConfirmFacts | null): void;
  requestQuit(confirmed: boolean): void;
  closeForAll(): void;
  setChord(state: ChordState): void;
  sendNow(): void;
  setPasteBuffer(buffer: string | null): void;
  armPasteTimeout(): void;
  clearPasteTimeout(): void;
  insertReply(text: string): boolean;
  setReplyMode(mode: ReplyMode): void;
  permissionSelect(index: number): void;
  permissionAnswer(response: PermissionResponse): void;
  /** Ctrl+C on the dialog: dismiss it and abort the turn shown here, if any. */
  permissionStop(): void;
  pasteReply(): void;
  exit(): void;
  stopTurn(): void;

  // --- input text and attachments
  routeAttach(text: string): void;
  fieldSet(text: string): void;
  fieldReset(): void;
  cancelUpload(): void;

  // --- panels, sessions, dock
  closePanel(): void;
  panelApply(action: TreeAction): void;
  setSessionsState(state: SessionsState): void;
  switchTo(id: string, reopen: boolean): void;
  sessionsDelete(id: string, startedGen: number): void;
  killJob(id: string): void;
  killChild(id: string): void;
  setDock(state: DockState): void;
  toggleAgents(): void;
  toggleExpandAll(): void;

  // --- the palette
  moveCommandSel(step: -1 | 1): void;
  runCommand(name: string): void;
  pushNotice(text: string): void;

  // --- the line-editing tail (S12, `line-layer.ts`)
  fieldInsert(text: string): void;
  fieldDeleteBack(): void;
  fieldDeleteWord(dir: -1 | 1): void;
  fieldMoveCursor(delta: -1 | 1, extend: boolean): void;
  fieldMoveWord(dir: -1 | 1, extend: boolean): void;
  fieldMoveLine(edge: "start" | "end", extend: boolean): void;
  fieldMoveVertical(dir: -1 | 1, extend: boolean): void;
  setHistoryCursor(index: number, draft: string): void;
  dockDown(): void;
  scroll(dir: "pageUp" | "pageDown"): void;
  pasteClipboard(): void;
  submit(text: string): void;
  removeLastChip(): void;
}

/** Apply ONE effect. Never returns a verdict: the router already decided. */
export function executeEffect(effect: KeyEffect, host: KeyHost): void {
  switch (effect.kind) {
    case "toggleAutoAccept":
      host.toggleAutoApprove();
      return;
    case "setQuitConfirm":
      host.setQuitConfirm(effect.facts);
      return;
    case "quit":
      // `closeForAll` is only for a dialog that SAID "close the session for all".
      if (effect.closeForAll) {
        host.closeForAll();
      }
      host.requestQuit(true);
      return;
    case "setChord":
      host.setChord(effect.state);
      return;
    case "sendNow":
      host.sendNow();
      return;
    case "setPasteBuffer":
      host.setPasteBuffer(effect.buffer);
      return;
    case "armPasteTimeout":
      host.armPasteTimeout();
      return;
    case "clearPasteTimeout":
      host.clearPasteTimeout();
      return;
    case "insertReply":
      host.insertReply(effect.text);
      return;
    case "setReplyMode":
      host.setReplyMode(effect.mode);
      return;
    case "permissionSelect":
      host.permissionSelect(effect.index);
      return;
    case "permissionAnswer":
      host.permissionAnswer(effect.response);
      return;
    case "permissionStop":
      host.permissionStop();
      return;
    case "pasteReply":
      host.pasteReply();
      return;
    case "exit":
      host.exit();
      return;
    case "abortTurn":
      host.stopTurn();
      return;
    case "routeAttach":
      host.routeAttach(effect.text);
      return;
    case "fieldSet":
      host.fieldSet(effect.text);
      return;
    case "fieldReset":
      host.fieldReset();
      return;
    case "cancelUpload":
      host.cancelUpload();
      return;
    case "closePanel":
      host.closePanel();
      return;
    case "applyPanel":
      host.panelApply(effect.action);
      return;
    case "setSessionsState":
      host.setSessionsState(effect.state);
      return;
    case "switchTo":
      host.switchTo(effect.id, effect.reopen);
      return;
    case "sessionsDelete":
      host.sessionsDelete(effect.id, effect.startedGen);
      return;
    case "killJob":
      host.killJob(effect.id);
      return;
    case "killChild":
      host.killChild(effect.id);
      return;
    case "setDock":
      host.setDock(effect.state);
      return;
    case "toggleAgents":
      host.toggleAgents();
      return;
    case "toggleExpandAll":
      host.toggleExpandAll();
      return;
    case "moveCommandSel":
      host.moveCommandSel(effect.step);
      return;
    case "runCommand":
      host.runCommand(effect.name);
      return;
    case "pushNotice":
      host.pushNotice(effect.text);
      return;
    case "fieldInsert":
      host.fieldInsert(effect.text);
      return;
    case "fieldDeleteBack":
      host.fieldDeleteBack();
      return;
    case "fieldDeleteWord":
      host.fieldDeleteWord(effect.dir);
      return;
    case "fieldMoveCursor":
      host.fieldMoveCursor(effect.delta, effect.extend);
      return;
    case "fieldMoveWord":
      host.fieldMoveWord(effect.dir, effect.extend);
      return;
    case "fieldMoveLine":
      host.fieldMoveLine(effect.edge, effect.extend);
      return;
    case "fieldMoveVertical":
      host.fieldMoveVertical(effect.dir, effect.extend);
      return;
    case "setHistoryCursor":
      host.setHistoryCursor(effect.index, effect.draft);
      return;
    case "dockDown":
      host.dockDown();
      return;
    case "scroll":
      host.scroll(effect.dir);
      return;
    case "pasteClipboard":
      host.pasteClipboard();
      return;
    case "submit":
      host.submit(effect.text);
      return;
    case "removeLastChip":
      host.removeLastChip();
      return;
  }
}

/** Apply a route's effects in order (the walk's order IS the execution order). */
export function executeEffects(effects: readonly KeyEffect[], host: KeyHost): void {
  for (const effect of effects) {
    executeEffect(effect, host);
  }
}

// Re-exported so `App.tsx` imports one module for the seam it needs and the
// panel helpers stay owned by the module that decides with them.
export {
  applyPanel,
  sessionsRefreshApplies,
  refreshedSessions,
  sessionsListError,
  deleteFailedNotice,
};
export type { OpenPanel, SessionsView };
