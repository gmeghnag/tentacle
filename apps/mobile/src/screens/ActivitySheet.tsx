/**
 * The Activity sheet (docs/feat/mobile-chrome.md Design 5, slice S8): everything
 * that runs beside the conversation, one band per group, running first —
 * Sub-agents, Shell jobs, Finished, Scheduled (the wakes' count + the soonest;
 * a tap opens Session info's SCHEDULED WAKES, `onScheduled`).
 * Every row opens its detail (S9): a child's (`SubagentDetail` — live steps,
 * message, Stop; or a Finished child's report) or a shell job's (`JobDetail`).
 *
 * Render only (AGENTS §7): the groups, rows and labels are `activity.ts`'s, the
 * detail is `subagent-detail.ts`'s `sheetDetail`; WHICH one is open is the
 * screen's.
 */
import type { JSX } from "react";
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ActivityGroup, ActivityView } from "../activity.ts";
import type { ChildAction, JobAction } from "../session-screen-controller.ts";
import type { ActivityFocus, SheetDetail } from "../subagent-detail.ts";
import { DENSE_FONT_SCALE, type Palette, space, typography } from "../theme.ts";
import { BandSection } from "../ui/BandSection.tsx";
import { Row } from "../ui/Row.tsx";
import { Sheet } from "../ui/Sheet.tsx";
import { JobDetail } from "./JobDetail.tsx";
import { SubagentDetail } from "./SubagentDetail.tsx";

export interface ActivitySheetProps {
  readonly palette: Palette;
  readonly visible: boolean;
  readonly view: ActivityView;
  /** The open detail (`sheetDetail`); `null`: the list. */
  readonly detail: SheetDetail;
  readonly child: ChildAction | null;
  readonly job: JobAction | null;
  /** Open a row's detail, or go back to the list (`null`). */
  readonly onFocus: (focus: ActivityFocus) => void;
  readonly onDraft: (text: string) => void;
  readonly onSend: () => void;
  /** Stop the open child or job — the screen confirms first (F17). */
  readonly onStop: () => void;
  readonly onRefreshJob: () => void;
  /** The Scheduled row: close this sheet, open Session info at SCHEDULED WAKES. */
  readonly onScheduled: () => void;
  /** Absent: the open report's row is not in the transcript. */
  readonly onShow?: () => void;
  readonly onLink: (href: string) => void;
  readonly onClose: () => void;
}

function Group({
  palette,
  group,
  onOpen,
  onScheduled,
}: {
  readonly palette: Palette;
  readonly group: ActivityGroup;
  readonly onOpen: (focus: ActivityFocus) => void;
  readonly onScheduled: () => void;
}): JSX.Element {
  if (group.rows.length === 0 && group.empty !== null) {
    return (
      <BandSection palette={palette} title={group.title} onSheet testID={`activity-${group.kind}`}>
        <Row palette={palette} title={group.empty} dimmed first onSheet />
      </BandSection>
    );
  }
  return (
    <BandSection palette={palette} title={group.title} onSheet testID={`activity-${group.kind}`}>
      {group.rows.map((row, i) => (
        <Row
          key={row.key}
          testID={`activity-row-${row.id}`}
          palette={palette}
          title={row.title}
          subtitle={row.meta}
          first={i === 0}
          onSheet
          leading={
            row.running ? <ActivityIndicator size="small" color={palette.accent} /> : undefined
          }
          chevron
          onPress={() =>
            row.kind === "scheduled"
              ? onScheduled()
              : onOpen({ kind: row.kind === "job" ? "job" : "child", id: row.id })
          }
          {...(row.kind === "finished"
            ? { value: row.unread ? "Report · new" : row.hasReport ? "Report" : "" }
            : {})}
        >
          {row.step === undefined ? null : (
            <Text
              numberOfLines={1}
              maxFontSizeMultiplier={DENSE_FONT_SCALE}
              style={[typography.mono, { color: palette.sec }]}
            >
              {row.step}
            </Text>
          )}
        </Row>
      ))}
    </BandSection>
  );
}

export function ActivitySheet({
  palette,
  visible,
  view,
  detail,
  child,
  job,
  onFocus,
  onDraft,
  onSend,
  onStop,
  onRefreshJob,
  onScheduled,
  onShow,
  onLink,
  onClose,
}: ActivitySheetProps): JSX.Element {
  const insets = useSafeAreaInsets();
  const close = onClose;
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={close}
    >
      <View style={[styles.root, { backgroundColor: palette.bg }]}>
        <Sheet
          palette={palette}
          title="Activity"
          testID="activity-sheet"
          insetBottom={false}
          scroll
          onClose={close}
        >
          {detail === null ? (
            <ScrollView testID="activity-scroll" showsVerticalScrollIndicator>
              {view.groups.map((group) => (
                <Group
                  key={group.kind}
                  palette={palette}
                  group={group}
                  onOpen={onFocus}
                  onScheduled={onScheduled}
                />
              ))}
              <View style={{ height: insets.bottom + 20 }} />
            </ScrollView>
          ) : detail.kind === "job" ? (
            <JobDetail
              palette={palette}
              view={detail.view}
              action={job}
              onRefresh={onRefreshJob}
              onStop={onStop}
              onBack={() => onFocus(null)}
            />
          ) : (
            <SubagentDetail
              palette={palette}
              view={detail.view}
              report={detail.report}
              action={child}
              onDraft={onDraft}
              onSend={onSend}
              onStop={onStop}
              {...(onShow === undefined ? {} : { onShow })}
              onLink={onLink}
              onBack={() => onFocus(null)}
            />
          )}
        </Sheet>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingBottom: space.inset },
});
