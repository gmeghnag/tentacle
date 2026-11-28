/**
 * The session screen's sheets (docs/feat/mobile-ui-fluidity-s3.md): what the
 * native sheet ROUTES draw (published on `SHEET_HOSTS`) and the sheets drawn in
 * place. It follows the `sheets` slice and republishes only when something a
 * sheet reads changed — never per streamed delta. A dumb renderer (AGENTS §7):
 * which sheet is up is the shell's reconciler; what one does is its `actions`.
 */
import { type JSX, memo, useLayoutEffect } from "react";
import type { StopArm } from "../../activity-panel.ts";
import type { ActivityView } from "../../activity.ts";
import { browserPageOf } from "../../browser-view.ts";
import { playHaptic } from "../../haptics.ts";
import type { HubActionId, HubItem } from "../../hub-actions.ts";
import { PERF } from "../../perf-probe.ts";
import type { SessionMenuAction } from "../../session-menu.ts";
import type { SessionStore } from "../../session-store.ts";
import { SHEET_HOSTS } from "../../sheet-host.ts";
import type { ActivityFocus, sheetDetail } from "../../subagent-detail.ts";
import type { Palette } from "../../theme.ts";
import { type ToolsSegmentId, toolsView } from "../../tools-view.ts";
import { ActionSheet } from "../../ui/ActionSheet.tsx";
import { useSlice } from "../../use-slice.ts";
import { ActivitySheet } from "../ActivitySheet.tsx";
import { BrowserPage } from "../BrowserPage.tsx";
import { CommandsSheet } from "../CommandsSheet.tsx";
import { PermissionSheetView } from "../PermissionSheet.tsx";
import { RenameSheet } from "../RenameSheet.tsx";
import { SelectTextSheet } from "../SelectTextSheet.tsx";
import { SessionInfoSheet } from "../SessionInfoSheet.tsx";
import { ToolsSheet } from "../ToolsSheet.tsx";
import { OutboxDecisionSheet } from "../compose/OutboxDecisionSheet.tsx";
import type { PaneActionsRef } from "./actions.ts";

interface SheetsPaneProps {
  readonly store: SessionStore;
  readonly palette: Palette;
  readonly actions: PaneActionsRef;
  /** Whose sheet routes these are (memoized by the shell); null: no routes. */
  readonly owner: { readonly computerId: string; readonly sessionId: string } | null;
  readonly deciding: string | null;
  readonly infoPage: "info" | "browser";
  readonly expanded: string | null;
  readonly toolsSegment: ToolsSegmentId;
  readonly toolsQuery: string;
  readonly toolsExpanded: ReadonlySet<string>;
  readonly askDetent: number;
  /** An RN `Modal` must not be drawn while a native sheet is up or coming (F6). */
  readonly yields: boolean;
  readonly hubMenuOpen: boolean;
  readonly hubMenuItems: readonly HubItem[];
  readonly menuOpen: boolean;
  readonly menu: readonly SessionMenuAction[];
  readonly selectText: string | null;
  readonly activityOpen: boolean;
  readonly activityVm: ActivityView;
  readonly activityDetail: ReturnType<typeof sheetDetail>;
  readonly activityFocus: ActivityFocus;
  readonly activityNow: number;
  readonly arm: StopArm;
  /** "Show in chat" has a row to go to. */
  readonly canShow: boolean;
  readonly reduceMotion: boolean;
}

export const SheetsPane = memo(function SheetsPane(props: SheetsPaneProps): JSX.Element {
  PERF.pane("sheets");
  const {
    store,
    palette,
    actions,
    owner,
    deciding,
    infoPage,
    expanded,
    toolsSegment,
    toolsQuery,
    toolsExpanded,
    askDetent,
    yields,
  } = props;
  const slice = useSlice(store, "sheets");
  const compose = slice.compose;
  const decision =
    deciding === null ? null : (compose.outbox.find((r) => r.itemId === deciding) ?? null);
  // Publish what the routes draw (D2). A layout effect, so the element is in the
  // host before the shell's reconciler (a passive effect) can push the route that
  // reads it. Keyed on its inputs: a streamed delta republishes nothing.
  useLayoutEffect(() => {
    if (owner === null) {
      return;
    }
    const { controller } = actions.current;
    const sheet = controller.sheet();
    const info = slice.info;
    const host = SHEET_HOSTS.host(owner.computerId, owner.sessionId);
    host.publish(
      "commands",
      <CommandsSheet
        palette={palette}
        rows={slice.commands}
        onCompact={() => void controller.compact()}
        onStopCompact={() => controller.cancelCompaction()}
        onArmClear={() => controller.armClear()}
        onCancelClear={() => controller.cancelClear()}
        onClear={() => void controller.clear()}
        onRename={() => actions.current.renameFromCommands()}
        onRetry={() => controller.retryLast()}
        onAutoAccept={(on) => void controller.setAutoAccept(on)}
        onClose={() => actions.current.closeCommands()}
      />,
    );
    host.publish(
      "outbox",
      <OutboxDecisionSheet
        item={decision === null ? null : { text: decision.text }}
        palette={palette}
        why="something changed since you wrote this — your message is still here"
        steerable={slice.view.composer.running}
        onSend={() => void controller.outbox("send", deciding ?? "")}
        onSteer={() => void controller.outbox("steer", deciding ?? "")}
        onDiscard={() => void controller.outbox("discard", deciding ?? "")}
        onEdit={() => void controller.outbox("edit", deciding ?? "")}
        onClose={() => actions.current.decide(null)}
      />,
    );
    // Session info and Tools (S4) are routes too: their content is the same
    // element it was inside a `<Modal>`, with no `visible` — the route exists only
    // while the sheet is up, and the sheet's own list is `Sheet native`'s one
    // scroller (F8).
    if (info !== null) {
      host.publish(
        "info",
        infoPage === "browser" ? (
          <BrowserPage
            palette={palette}
            view={browserPageOf(info)}
            {...(info.view.banner === undefined ? {} : { banner: info.view.banner.text })}
            onBack={() => actions.current.showInfoPage("info")}
            onClose={() => actions.current.closeInfo()}
            onSwitch={(kind, name, enabled) => void controller.setCapability(kind, name, enabled)}
            onLockedTap={() => playHaptic("light")}
          />
        ) : (
          <SessionInfoSheet
            palette={palette}
            view={info.view}
            autoAcceptOn={controller.autoAcceptOn()}
            autoAcceptError={info.autoAcceptError}
            onAutoAccept={(on) => void controller.setAutoAccept(on)}
            onSwitch={(kind, name, enabled) => void controller.setCapability(kind, name, enabled)}
            onDeleteSchedule={(scheduleId) => void controller.deleteSchedule(scheduleId)}
            onCopyApp={(url) => actions.current.copyText(url, "sheet")}
            onStopApp={(app) => void controller.stopApp(app)}
            scrollRef={(node) => actions.current.scrollRef(node)}
            onSectionLayout={(id, y) => actions.current.sectionLayout(id, y)}
            onRefresh={() => void controller.refreshInfo()}
            onRetry={() => void controller.refreshInfo()}
            expanded={expanded}
            onExpand={(key) => actions.current.expandInfo(key)}
            onOpenArtifacts={() => actions.current.openArtifactsFromInfo()}
            onOpenBrowser={() => actions.current.showInfoPage("browser")}
            onClose={() => actions.current.closeInfo()}
          />
        ),
      );
      host.publish(
        "tools",
        <ToolsSheet
          palette={palette}
          view={toolsView(info.tools, {
            segment: toolsSegment,
            query: toolsQuery,
            open: toolsExpanded,
          })}
          onSwitch={(kind, name, enabled) => void controller.setCapability(kind, name, enabled)}
          onSegment={(segment) => actions.current.toolsSegment(segment)}
          onQuery={(query) => actions.current.toolsQuery(query)}
          onToggle={(key, open) => actions.current.toolsToggle(key, open)}
          onRefresh={() => actions.current.refreshTools()}
          onClose={() => actions.current.closeTools()}
        />,
      );
    }
    // The ask (S5) is a route too. Published even when `idle` → `undefined`, so a
    // route pushed for the PREVIOUS ask can never draw a stale one: the host's
    // orphan/wait rule keeps that honest (`sheetRouteView`).
    host.publish(
      "permission",
      slice.sheet.kind === "idle" ? undefined : (
        <PermissionSheetView
          sheet={sheet}
          state={slice.sheet}
          palette={palette}
          detent={askDetent}
        />
      ),
    );
    // `decision` is `slice` + `deciding`; `actions` is the stable ref.
  }, [
    owner,
    palette,
    slice,
    decision,
    deciding,
    infoPage,
    expanded,
    toolsSegment,
    toolsQuery,
    toolsExpanded,
    askDetent,
    actions,
  ]);

  const { controller } = actions.current;
  const activity = slice.activity;
  return (
    <>
      {/* The ask, Outbox's decision, Commands, Session info and Tools are native
        sheet ROUTES (docs/feat/mobile-native-sheets.md S3–S5): this pane
        PUBLISHES their elements on `SHEET_HOSTS` (above) and the routes draw
        them, so they are not mounted here — no RN `Modal` over a `formSheet` (F6). */}
      {/* The hub's plain menu (Design 5/7): "More" (the overflow), no fan fits,
        or VoiceOver's long-press / Show all (everything). */}
      <ActionSheet
        palette={palette}
        visible={props.hubMenuOpen && !yields}
        testID="hub-menu-sheet"
        cancelTestID="hub-menu-cancel"
        actions={props.hubMenuItems.map((item) => ({
          label: item.label,
          testID: `hub-menu-${item.id}`,
          ...(item.danger ? { destructive: true } : {}),
          onPress: () => actions.current.hubMenuPick(item.id as HubActionId),
        }))}
        onCancel={() => actions.current.closeHubMenu()}
      />
      <SelectTextSheet
        palette={palette}
        text={yields ? null : props.selectText}
        onClose={() => actions.current.closeSelectText()}
        onCopyAll={(text) => actions.current.copyText(text, "sheet")}
      />
      <ActionSheet
        palette={palette}
        visible={props.menuOpen && !yields}
        testID="session-menu-sheet"
        cancelTestID="session-menu-cancel"
        message={
          props.menu.every((action) => action.text === "") ? "Nothing to copy yet" : undefined
        }
        actions={props.menu.map((action) => ({
          label: action.label,
          testID: `session-menu-${action.id}`,
          onPress: () => actions.current.menuPick(action.id, action.text),
        }))}
        onCancel={() => actions.current.closeMenu()}
      />
      <ActivitySheet
        palette={palette}
        visible={props.activityOpen && !yields}
        view={props.activityVm}
        detail={props.activityDetail}
        focus={props.activityFocus}
        now={props.activityNow}
        child={activity.child}
        job={activity.job}
        onFocus={(next) => actions.current.focusActivity(next)}
        onDraft={(text) => controller.setChildDraft(text)}
        onSend={() => void controller.messageChild()}
        onStop={() => actions.current.confirmStop()}
        onStopRow={(kind, id) => actions.current.stopRow(kind, id)}
        arm={props.arm}
        stopNotices={activity.stopNotices}
        onRefreshJob={() => void controller.refreshJob()}
        onScheduled={() => actions.current.activityScheduled()}
        {...(props.canShow ? { onShow: () => actions.current.showInChat() } : {})}
        onLink={(url) => actions.current.link(url)}
        onClose={() => actions.current.closeActivity()}
        reduceMotion={props.reduceMotion}
      />
      <RenameSheet
        palette={palette}
        state={yields ? null : slice.renaming}
        onChange={(text) => controller.setRenameText(text)}
        onSave={() => void controller.submitRename()}
        onCancel={() => controller.cancelRename()}
      />
    </>
  );
});
