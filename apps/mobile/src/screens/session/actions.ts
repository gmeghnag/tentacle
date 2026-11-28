/**
 * What the session screen's panes can ask of the shell (docs/feat/
 * mobile-ui-fluidity-s3.md): ONE stable ref, refreshed every shell render (the
 * `cellActions` pattern), so a memoized pane's props never change because a
 * closure did, and its tap still sees the latest state.
 */
import type { ComponentRef, MutableRefObject } from "react";
import type { ScrollView as RNScrollView } from "react-native";
import type { ActivitySettings } from "../../activity-settings-store.ts";
import type { HubActionId } from "../../hub-actions.ts";
import type { solveHub } from "../../hub-session.ts";
import type { CopySource } from "../../message-copy.ts";
import type { SectionId } from "../../session-info.ts";
import type { SessionScreenController } from "../../session-screen-controller.ts";
import type { ActivityFocus } from "../../subagent-detail.ts";
import type { ToolsSegmentId } from "../../tools-view.ts";

export interface PaneActions {
  /** The screen's controller: its sheet, its commands, its handlers. */
  readonly controller: SessionScreenController;
  // Header.
  readonly openDrawer: () => void;
  readonly openActivity: () => void;
  readonly openInfo: () => void;
  readonly openMenu: () => void;
  readonly unparkAsk: () => void;
  readonly retry: () => void;
  readonly reopen: () => void;
  // Composer.
  readonly selectCopied: () => void;
  readonly decide: (itemId: string | null) => void;
  readonly openBrowser: () => void;
  readonly openAttach: () => void;
  readonly userEdit: (text: string) => void;
  /** Return (`"return"`) or the button: follow again, then send. */
  readonly send: (via: "return" | "press") => void;
  readonly tapMic: () => void;
  // Hub.
  readonly solveHub: () => ReturnType<typeof solveHub>;
  readonly hubFan: (open: boolean) => void;
  readonly hubCommit: (id: HubActionId) => void;
  readonly hubFlash: (id: HubActionId) => void;
  readonly hubShowAll: () => void;
  readonly hubDrop: (position: ActivitySettings["position"]) => void;
  // Sheets.
  readonly renameFromCommands: () => void;
  readonly closeCommands: () => void;
  readonly closeInfo: () => void;
  readonly closeTools: () => void;
  readonly refreshTools: () => void;
  readonly showInfoPage: (page: "info" | "browser") => void;
  readonly copyText: (text: string, source: CopySource) => void;
  readonly scrollRef: (node: ComponentRef<typeof RNScrollView> | null) => void;
  readonly sectionLayout: (id: SectionId, y: number) => void;
  readonly expandInfo: (key: string | null) => void;
  readonly openArtifactsFromInfo: () => void;
  readonly toolsSegment: (segment: ToolsSegmentId) => void;
  readonly toolsQuery: (query: string) => void;
  readonly toolsToggle: (key: string, open: boolean) => void;
  readonly closeHubMenu: () => void;
  readonly hubMenuPick: (id: HubActionId) => void;
  readonly closeSelectText: () => void;
  readonly closeMenu: () => void;
  readonly menuPick: (id: string, text: string) => void;
  readonly focusActivity: (next: ActivityFocus) => void;
  readonly confirmStop: () => void;
  readonly stopRow: (kind: "child" | "job", id: string) => void;
  readonly activityScheduled: () => void;
  readonly showInChat: () => void;
  readonly link: (url: string) => void;
  readonly closeActivity: () => void;
}

export type PaneActionsRef = MutableRefObject<PaneActions>;
