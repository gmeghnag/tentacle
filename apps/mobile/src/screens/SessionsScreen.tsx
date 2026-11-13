/**
 * `Sessions` — one computer's sessions, Active and Archived (docs/feat/
 * mobile-app-shell.md). A dumb renderer over `viewModel` (the logic lives in
 * `session-list.ts` / `session-list-controller.ts`, AGENTS §7): it maps a
 * precomputed view-model to elements and owns only spacing and colour.
 *
 * Every daemon string (`title`, badge text) is rendered as plain `Text` — never
 * a link, never markdown — because the daemon may be a pod, which is not trusted.
 */
import type { JSX } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { viewModel } from "../session-list-controller.ts";
import type { SessionRow } from "../session-list.ts";
import type { Palette } from "../theme.ts";

export interface SessionsScreenProps {
  readonly palette: Palette;
  readonly view: ReturnType<typeof viewModel>;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
  readonly onLoadMore: () => void;
  readonly onRetry: () => void;
  readonly onOpen: (row: SessionRow) => void;
}

function Row({
  row,
  palette,
  onOpen,
}: {
  readonly row: SessionRow;
  readonly palette: Palette;
  readonly onOpen: (row: SessionRow) => void;
}): JSX.Element {
  return (
    <Pressable
      testID={`session-${row.sessionId}`}
      accessibilityRole="button"
      onPress={() => onOpen(row)}
      style={styles.row}
    >
      <View style={styles.rowText}>
        <Text style={[styles.title, { color: palette.label }]} numberOfLines={1}>
          {row.title}
        </Text>
        <Text style={[styles.subtitle, { color: palette.secondaryLabel }]}>{row.subtitle}</Text>
      </View>
      {row.badges.map((badge) => (
        <Text
          key={badge}
          testID={`badge-${row.sessionId}-${badge}`}
          style={[styles.badge, { backgroundColor: palette.running, color: palette.badgeText }]}
        >
          {badge}
        </Text>
      ))}
    </Pressable>
  );
}

function Section({
  title,
  rows,
  palette,
  onOpen,
}: {
  readonly title: string;
  readonly rows: readonly SessionRow[];
  readonly palette: Palette;
  readonly onOpen: (row: SessionRow) => void;
}): JSX.Element | null {
  if (rows.length === 0) {
    return null;
  }
  return (
    <View testID={`section-${title.toLowerCase()}`} style={styles.section}>
      <Text style={[styles.sectionTitle, { color: palette.secondaryLabel }]}>{title}</Text>
      <View style={[styles.card, { backgroundColor: palette.card }]}>
        {rows.map((row, index) => (
          <View
            key={row.sessionId}
            style={
              index === 0 ? undefined : [styles.separator, { borderTopColor: palette.separator }]
            }
          >
            <Row row={row} palette={palette} onOpen={onOpen} />
          </View>
        ))}
      </View>
    </View>
  );
}

export function SessionsScreen({
  palette,
  view,
  refreshing,
  onRefresh,
  onLoadMore,
  onRetry,
  onOpen,
}: SessionsScreenProps): JSX.Element {
  const nothingYet = view.status === "loading" && view.sections.active.length === 0;
  return (
    <ScrollView
      testID="sessions-list"
      style={{ backgroundColor: palette.groupedBackground }}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.accent} />
      }
    >
      {view.stale ? (
        <Text testID="sessions-stale" style={[styles.notice, { color: palette.secondaryLabel }]}>
          {view.error ?? "Reconnecting…"}
        </Text>
      ) : null}
      {nothingYet ? <ActivityIndicator testID="sessions-loading" color={palette.accent} /> : null}
      {view.status === "failed" ? (
        <View style={[styles.card, { backgroundColor: palette.card }]}>
          <Text testID="sessions-error" style={[styles.subtitle, { color: palette.danger }]}>
            {view.error ?? "Something went wrong"}
          </Text>
          <Pressable testID="sessions-retry" accessibilityRole="button" onPress={onRetry}>
            <Text style={[styles.retry, { color: palette.accent }]}>Retry</Text>
          </Pressable>
        </View>
      ) : null}
      {view.empty ? (
        <Text testID="sessions-empty" style={[styles.notice, { color: palette.secondaryLabel }]}>
          No sessions yet — run `tentacle` in this project
        </Text>
      ) : null}
      <Section title="Active" rows={view.sections.active} palette={palette} onOpen={onOpen} />
      <Section title="Archived" rows={view.sections.archived} palette={palette} onOpen={onOpen} />
      {view.canLoadMore ? (
        <Pressable testID="sessions-more" accessibilityRole="button" onPress={onLoadMore}>
          <Text style={[styles.retry, { color: palette.accent }]}>Load more</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 12 },
  section: { gap: 6 },
  sectionTitle: { fontSize: 13, textTransform: "uppercase", paddingHorizontal: 4 },
  card: { borderRadius: 12, paddingHorizontal: 16 },
  separator: { borderTopWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 12 },
  rowText: { flex: 1, gap: 2 },
  title: { fontSize: 17 },
  subtitle: { fontSize: 13 },
  badge: {
    fontSize: 11,
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
    overflow: "hidden",
  },
  notice: { fontSize: 14, paddingHorizontal: 4 },
  retry: { fontSize: 15, paddingVertical: 12 },
});
