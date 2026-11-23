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
import type { ArtifactMeta } from "@tentacle/protocol";
import type { ApprovalScroll } from "../approval-scroll.ts";
import type { ArtifactIntent } from "../artifact-open.ts";
import type { DockState } from "../background-focus.ts";
import type { ChordState } from "../chord.ts";
import type { QuitConfirmFacts } from "../commands.ts";
import type { OpenPanel } from "../panel.ts";
import { applyPanel } from "../panel.ts";
import type { ReplyMode } from "../permission-reply.ts";
import type { SchedulesState } from "../schedule-view.ts";
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
  /** Write the `workflow_approve` dialog's detail scroll. */
  approvalScroll(scroll: ApprovalScroll): void;
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

  // --- voice dictation (docs/feat/voice-dictation.md): the hook's three intents
  voiceToggle(): void;
  voiceFinish(): void;
  voiceCancel(): void;

  // --- panels, sessions, dock
  closePanel(): void;
  panelApply(action: TreeAction): void;
  /** Flip the open panel's selected switch (`panelSwitchOp` on the live state). */
  switchCapability(): void;
  setSessionsState(state: SessionsState): void;
  /** Open the artifact a `/artifacts` row asks for (docs/feat/model-artifacts.md D8). */
  openArtifact(artifact: ArtifactMeta, intent?: ArtifactIntent): void;
  /** `Ctrl+X Ctrl+O`: the newest artifact in the transcript. */
  openNewestArtifact(): void;
  /**
   * Preview a chart artifact inside `/artifacts` (docs/feat/model-charts.md C8),
   * or (`null`) return to the tree its `esc`/`q` asked for.
   */
  previewArtifact(artifact: ArtifactMeta | null): void;
  /** The artifact open confirm's answer (`y` opens; anything else drops it). */
  answerArtifactConfirm(yes: boolean): void;
  switchTo(id: string, reopen: boolean): void;
  sessionsDelete(id: string, startedGen: number): void;
  killJob(id: string): void;
  killChild(id: string): void;
  /** Delete one scheduled wake (`session/schedule_delete`, cron-tool S5). */
  deleteSchedule(id: string): void;
  /** Write the `/schedule` panel's own state (its arm/answer). */
  setSchedulesState(state: SchedulesState): void;
  /** `o` in `/workflow`: read one step's prompt/report (`session/workflow_step`). */
  workflowDetail(runId: string, stepId: string, startedGen: number): void;
  /** `r` in `/workflow`: re-run the selected step (`rerun_step`). */
  workflowRerun(runId: string, stepId: string, startedGen: number): void;
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
  pullBackQueued(id: string, text: string): void;
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
    case "approvalScroll":
      host.approvalScroll(effect.scroll);
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
    case "switchCapability":
      host.switchCapability();
      return;
    case "setSessionsState":
      host.setSessionsState(effect.state);
      return;
    case "openArtifact":
      host.openArtifact(effect.artifact, effect.intent);
      return;
    case "openNewestArtifact":
      host.openNewestArtifact();
      return;
    case "previewArtifact":
      host.previewArtifact(effect.artifact);
      return;
    case "answerArtifactConfirm":
      host.answerArtifactConfirm(effect.yes);
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
    case "deleteSchedule":
      host.deleteSchedule(effect.id);
      return;
    case "setSchedulesState":
      host.setSchedulesState(effect.state);
      return;
    case "workflowDetail":
      host.workflowDetail(effect.runId, effect.stepId, effect.startedGen);
      return;
    case "workflowRerun":
      host.workflowRerun(effect.runId, effect.stepId, effect.startedGen);
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
    case "voiceToggle":
      host.voiceToggle();
      return;
    case "voiceFinish":
      host.voiceFinish();
      return;
    case "voiceCancel":
      host.voiceCancel();
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
    case "pullBackQueued":
      host.pullBackQueued(effect.id, effect.text);
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
