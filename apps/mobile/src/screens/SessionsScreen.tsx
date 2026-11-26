/**
 * `Sessions` — one computer's sessions (mockup `Sessions`, restyled to E2 bands by
 * S4 of docs/feat/mobile-chrome.md): a large title with a thin back button, a
 * search field, then Running / Idle / Archived — one full-width `BandSection` per
 * section. A dumb renderer over `viewModel` and `session-groups.ts` (the logic
 * lives in `session-list.ts` / `session-list-controller.ts` / `session-groups.ts`,
 * AGENTS §7): it maps a precomputed view-model to elements and owns only the look.
 * Under the list, pinned, a bar with the drawer's New session pill
 * (docs/feat/mobile-project-new-session.md); what it shows and what a tap does are
 * decided in `project-new-session.ts`.
 *
 * Every daemon string (`title`) is rendered as plain `Text` — never a link, never
 * markdown — because the daemon may be a pod, which is not trusted.
 *
 * testIDs (the flows' contract): `sessions-list`, `section-active` (wraps Running
 * and Idle), `section-archived`, `session-<id>`, `sessions-loading`,
 * `sessions-error`, `sessions-retry`, `sessions-empty`, `sessions-stale`,
 * `sessions-more`, `sessions-search`, `sessions-back`, `sessions-new-bar`,
 * `sessions-new`, `sessions-new-reason`, `sessions-new-error`.
 */
import { type JSX, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ProjectNewSessionView } from "../project-new-session.ts";
import { groupSessions, sessionLine, sessionMeta } from "../session-groups.ts";
import type { viewModel } from "../session-list-controller.ts";
import type { SessionRow } from "../session-list.ts";
import { DENSE_FONT_SCALE, type Palette, radius, size, space, typography } from "../theme.ts";
import { BandSection } from "../ui/BandSection.tsx";
import { Banner } from "../ui/Banner.tsx";
import { CompactBar, useCompactTitle } from "../ui/CompactBar.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { HeaderIcon } from "../ui/HeaderIcon.tsx";
import { Icon } from "../ui/Icon.tsx";
import { PillButton } from "../ui/PillButton.tsx";
import { Row } from "../ui/Row.tsx";
import { ScreenHeader } from "../ui/ScreenHeader.tsx";
import { StatusDot } from "../ui/StatusDot.tsx";
import { Text, TextInput } from "../ui/Text.tsx";

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
  /** Opened from the drawer's magnifier: the search field takes focus when it appears. */
  readonly focusSearch?: boolean;
  /** The New session bar (`projectNewSessionView`). */
  readonly newSession: ProjectNewSessionView;
  /** Every tap on the pill, dimmed or not: the caller decides what it does. */
  readonly onNewSession: () => void;
  readonly onNewSessionDismiss: () => void;
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
      <BandSection palette={palette} title={title}>
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
      </BandSection>
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
  focusSearch,
  newSession,
  onNewSession,
  onNewSessionDismiss,
}: SessionsScreenProps): JSX.Element {
  const insets = useSafeAreaInsets();
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
              <HeaderIcon
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
                autoFocus={focusSearch === true}
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
              body="Start one with New session."
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
          {groups.running.length + groups.idle.length > 0 || groups.pinned.length > 0 ? (
            <View testID="section-active" style={styles.sections}>
              <Section
                testID="section-pinned"
                title="Pinned"
                rows={groups.pinned}
                palette={palette}
                onOpen={onOpen}
              />
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
            <BandSection palette={palette}>
              <Row
                testID="sessions-more"
                palette={palette}
                first
                minHeight={size.rowAction}
                tone="accent"
                title="Load more"
                onPress={onLoadMore}
              />
            </BandSection>
          ) : null}
        </View>
      </ScrollView>
      {newSession.error === null ? null : (
        <Pressable
          testID="sessions-new-error"
          accessibilityRole="button"
          accessibilityHint="Dismisses this message"
          onPress={onNewSessionDismiss}
          style={styles.newError}
        >
          <Text style={[typography.footnote, { color: palette.red }]}>{newSession.error}</Text>
        </Pressable>
      )}
      {/* The drawer's footer, same metrics (D1). */}
      <View
        testID="sessions-new-bar"
        style={[
          styles.newBar,
          { borderTopColor: palette.sepChat, paddingBottom: Math.max(insets.bottom, 10) },
        ]}
      >
        {newSession.reason === null ? null : (
          <Text
            testID="sessions-new-reason"
            maxFontSizeMultiplier={DENSE_FONT_SCALE}
            style={[typography.footnote, styles.newReason, { color: palette.sec }]}
          >
            {newSession.reason}
          </Text>
        )}
        <View style={styles.newGap} />
        <PillButton
          palette={palette}
          testID="sessions-new"
          label="New session"
          icon="plus"
          height={40}
          disabled={!newSession.enabled}
          busy={newSession.busy}
          accessibilityLabel={newSession.accessibilityLabel}
          onPress={onNewSession}
        />
      </View>
      <CompactBar palette={palette} title={title} shown={compact.shown} />
    </View>
  );
}

// ONE left edge (visual review V3): each band is full-width with its own 20 pt
// gutter, so the body adds none; the distance between two sections is the band's
// own `space.sectionTop` (Design 4), not a wrapper gap on top of it.
const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingBottom: 40 },
  body: { paddingTop: 8 },
  sections: { gap: 0 },
  // BandSection owns the section rhythm; the only thing this wrapper adds is the
  // id a flow asserts.
  section: { gap: 0 },
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
  newError: { paddingHorizontal: space.rowX, paddingVertical: 8 },
  newBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingTop: 6,
    paddingHorizontal: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  // The reason starts on the page margin and wraps rather than push the pill out.
  newReason: { flexShrink: 1, paddingHorizontal: 10 },
  newGap: { flex: 1 },
});
