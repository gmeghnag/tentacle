/**
 * The Activity sheet (docs/feat/mobile-chrome.md Design 5, slice S8): everything
 * that runs beside the conversation, one band per group, running first —
 * Sub-agents, Shell jobs, Finished, Scheduled (a ghost: cron has no protocol yet).
 * A Finished row with a report opens it (`SubagentDetail`). Read-only in S8: the
 * running rows' detail, message and Stop, and a job's output, are S9.
 *
 * Render only (AGENTS §7): the groups, rows and labels are `activity.ts`'s; the
 * one piece of state here is WHICH report is open (presentation).
 */
import type { JSX } from "react";
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ChildReport } from "../activity-memory.ts";
import { type ActivityGroup, type ActivityView, reportRow } from "../activity.ts";
import { DENSE_FONT_SCALE, type Palette, space, typography } from "../theme.ts";
import { BandSection } from "../ui/BandSection.tsx";
import { Row } from "../ui/Row.tsx";
import { Sheet } from "../ui/Sheet.tsx";
import { SubagentDetail } from "./SubagentDetail.tsx";

export interface ActivitySheetProps {
  readonly palette: Palette;
  readonly visible: boolean;
  readonly view: ActivityView;
  readonly reports: ReadonlyMap<string, ChildReport>;
  /** The child whose report is open (a row's or the transcript card's tap); `null`: the list. */
  readonly focus: string | null;
  /** Open a child's report (`id`) or go back to the list (`null`). */
  readonly onFocus: (agentId: string | null) => void;
  readonly onLink: (href: string) => void;
  readonly onClose: () => void;
}

function Group({
  palette,
  group,
  onOpen,
}: {
  readonly palette: Palette;
  readonly group: ActivityGroup;
  readonly onOpen: (id: string) => void;
}): JSX.Element {
  if (group.ghost) {
    return (
      <BandSection palette={palette} title={group.title} onSheet testID={`activity-${group.kind}`}>
        <Row palette={palette} title={group.title} value="soon" dimmed first onSheet />
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
          {...(row.kind === "finished"
            ? {
                value: row.unread ? "Report · new" : row.hasReport ? "Report" : "",
                chevron: true,
                onPress: () => onOpen(row.id),
              }
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
  reports,
  focus,
  onFocus,
  onLink,
  onClose,
}: ActivitySheetProps): JSX.Element {
  const insets = useSafeAreaInsets();
  const row = reportRow(view, focus);
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
          {row === null ? (
            <ScrollView testID="activity-scroll" showsVerticalScrollIndicator>
              {view.groups.map((group) => (
                <Group key={group.kind} palette={palette} group={group} onOpen={onFocus} />
              ))}
              <View style={{ height: insets.bottom + 20 }} />
            </ScrollView>
          ) : (
            <SubagentDetail
              palette={palette}
              row={row}
              report={reports.get(row.id) ?? null}
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
