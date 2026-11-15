/**
 * `Sessions` — one computer's sessions (mockup `Sessions`): a large title with a
 * glass back button, a search field, then Running / Idle / Archived in grouped
 * cards. A dumb renderer over `viewModel` and `session-groups.ts` (the logic
 * lives in `session-list.ts` / `session-list-controller.ts` / `session-groups.ts`,
 * AGENTS §7): it maps a precomputed view-model to elements and owns only the look.
 *
 * Every daemon string (`title`) is rendered as plain `Text` — never a link, never
 * markdown — because the daemon may be a pod, which is not trusted.
 *
 * testIDs (the flows' contract): `sessions-list`, `section-active` (wraps Running
 * and Idle), `section-archived`, `session-<id>`, `sessions-loading`,
 * `sessions-error`, `sessions-retry`, `sessions-empty`, `sessions-stale`,
 * `sessions-more`, `sessions-search`, `sessions-back`.
 */
import { type JSX, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { groupSessions, sessionLine, sessionMeta } from "../session-groups.ts";
import type { viewModel } from "../session-list-controller.ts";
import type { SessionRow } from "../session-list.ts";
import { MONO, type Palette, radius, size, space, typography } from "../theme.ts";
import { Banner } from "../ui/Banner.tsx";
import { CompactBar, useCompactTitle } from "../ui/CompactBar.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { GlassButton } from "../ui/GlassButton.tsx";
import { GroupedCard } from "../ui/GroupedCard.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Row } from "../ui/Row.tsx";
import { ScreenHeader } from "../ui/ScreenHeader.tsx";
import { SectionHeader } from "../ui/SectionHeader.tsx";
import { StatusDot } from "../ui/StatusDot.tsx";

export interface SessionsScreenProps {
  readonly palette: Palette;
  readonly view: ReturnType<typeof viewModel>;
  /** The project (computer) name: the large title. */
  readonly title: string;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
  readonly onLoadMore: () => void;
  readonly onRetry: () => void;
  readonly onOpen: (row: SessionRow) => void;
  /** Present only when the stack can go back. */
  readonly onBack?: () => void;
}

function Section({
  title,
  rows,
  palette,
  onOpen,
  testID,
}: {
  readonly title: string;
  readonly rows: readonly SessionRow[];
  readonly palette: Palette;
  readonly onOpen: (row: SessionRow) => void;
  readonly testID?: string;
}): JSX.Element | null {
  if (rows.length === 0) {
    return null;
  }
  return (
    <View testID={testID} style={styles.section}>
      <SectionHeader palette={palette} title={title} />
      <GroupedCard palette={palette}>
        {rows.map((row, index) => (
          <Row
            key={row.sessionId}
            testID={`session-${row.sessionId}`}
            palette={palette}
            first={index === 0}
            minHeight={size.rowSession}
            title={row.title}
            titleWeight="600"
            dimmed={row.archived}
            accessibilityLabel={`${row.title}, ${sessionMeta(row)}`}
            onPress={() => onOpen(row)}
            chevron
          >
            <View style={styles.meta}>
              {row.archived ? null : (
                <StatusDot palette={palette} tone={row.running ? "running" : "offline"} size={7} />
              )}
              {!row.archived && row.attached > 0 ? (
                <Icon name="terminal" color={palette.sec} size={12} />
              ) : null}
              <Text numberOfLines={1} style={[typography.footnote, { color: palette.sec }]}>
                {sessionLine(row)}
              </Text>
            </View>
          </Row>
        ))}
      </GroupedCard>
    </View>
  );
}

export function SessionsScreen({
  palette,
  view,
  title,
  refreshing,
  onRefresh,
  onLoadMore,
  onRetry,
  onOpen,
  onBack,
}: SessionsScreenProps): JSX.Element {
  const [query, setQuery] = useState("");
  const groups = groupSessions(view.sections, query);
  const nothingYet = view.status === "loading" && view.sections.active.length === 0;
  const anyRows = view.sections.active.length + view.sections.archived.length > 0;
  const compact = useCompactTitle();
  return (
    <View style={[styles.root, { backgroundColor: palette.bg }]}>
      <ScrollView
        testID="sessions-list"
        style={{ backgroundColor: palette.bg }}
        contentContainerStyle={styles.content}
        onScroll={compact.onScroll}
        scrollEventThrottle={compact.scrollEventThrottle}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={palette.accent}
          />
        }
      >
        <ScreenHeader
          palette={palette}
          title={title}
          left={
            onBack === undefined ? undefined : (
              <GlassButton
                palette={palette}
                testID="sessions-back"
                icon="chevron.left"
                accessibilityLabel="Back"
                onPress={onBack}
              />
            )
          }
        />
        <View style={styles.body}>
          {anyRows ? (
            <View style={[styles.search, { backgroundColor: palette.fill }]}>
              <Icon name="magnifyingglass" color={palette.sec} size={15} />
              <TextInput
                testID="sessions-search"
                value={query}
                onChangeText={setQuery}
                placeholder="Search sessions"
                placeholderTextColor={palette.sec}
                style={[typography.body, styles.searchInput, { color: palette.label }]}
                autoCorrect={false}
                autoCapitalize="none"
                clearButtonMode="while-editing"
                returnKeyType="search"
                accessibilityLabel="Search sessions"
              />
            </View>
          ) : null}
          {view.stale ? (
            <Banner
              palette={palette}
              testID="sessions-stale"
              tone="warn"
              icon="wifi.slash"
              title="Reconnecting…"
              body={view.error ?? "Showing the last list this phone saw."}
            />
          ) : null}
          {nothingYet ? (
            <EmptyState
              palette={palette}
              loading
              testID="sessions-loading"
              title="Loading sessions…"
            />
          ) : null}
          {view.status === "failed" ? (
            <Banner
              palette={palette}
              tone="error"
              icon="exclamationmark.triangle"
              title="Couldn't load the sessions"
              body={view.error ?? "Something went wrong"}
              bodyTestID="sessions-error"
              action={{ label: "Retry", onPress: onRetry, testID: "sessions-retry" }}
            />
          ) : null}
          {view.empty ? (
            <EmptyState
              palette={palette}
              testID="sessions-empty"
              icon="terminal"
              title="No sessions yet"
              body={
                <Text style={[typography.subhead, { color: palette.sec, textAlign: "center" }]}>
                  {"Run "}
                  <Text style={{ fontFamily: MONO, color: palette.label }}>tentacle</Text>
                  {" in this project on your computer."}
                </Text>
              }
            />
          ) : null}
          {groups.noMatch ? (
            <EmptyState
              palette={palette}
              testID="sessions-no-match"
              icon="magnifyingglass"
              title="No matches"
              body={`Nothing called “${query.trim()}”.`}
            />
          ) : null}
          {groups.running.length + groups.idle.length > 0 ? (
            <View testID="section-active" style={styles.sections}>
              <Section title="Running" rows={groups.running} palette={palette} onOpen={onOpen} />
              <Section title="Idle" rows={groups.idle} palette={palette} onOpen={onOpen} />
            </View>
          ) : null}
          <Section
            testID="section-archived"
            title="Archived"
            rows={groups.archived}
            palette={palette}
            onOpen={onOpen}
          />
          {view.canLoadMore ? (
            <GroupedCard palette={palette}>
              <Row
                testID="sessions-more"
                palette={palette}
                first
                minHeight={size.rowAction}
                tone="accent"
                title="Load more"
                onPress={onLoadMore}
              />
            </GroupedCard>
          ) : null}
        </View>
      </ScrollView>
      <CompactBar palette={palette} title={title} shown={compact.shown} />
    </View>
  );
}

// ONE left edge (visual review V3): title, search field and cards all on the
// page margin — the cards bring their own `marginHorizontal`, so the body adds
// none (it used to, and the cards sat 31 pt in).
const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingBottom: 40 },
  body: { gap: space.sectionSessions, paddingTop: 8 },
  sections: { gap: space.sectionSessions },
  section: { gap: 6 },
  meta: { flexDirection: "row", alignItems: "center", gap: 6 },
  // The 44 pt pill (mockup `Sessions`: radius 22), on the page margin.
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: size.touch,
    borderRadius: size.touch / 2,
    marginHorizontal: space.inset,
    paddingHorizontal: 14,
  },
  searchInput: { flex: 1, paddingVertical: 8 },
});
