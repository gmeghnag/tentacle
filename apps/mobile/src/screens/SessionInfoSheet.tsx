/**
 * Session info — the sheet itself (docs/feat/mobile-session-info.md). RENDER ONLY
 * (AGENTS §7): every row, wording and state it draws comes from
 * `session-info.ts`'s view-model, and every decision (which section is loading,
 * what a cap says, which tone a server gets) was made there.
 *
 * The grammar is the E2 band (docs/feat/mobile-chrome.md Design 4, S4):
 * `BandSection` — one full-width surface per section, square, a small uppercase
 * label above it — of 44 pt `Row`s. Since docs/feat/mobile-native-sheets.md the
 * PRESENTATION is the stack's (`Sheet` route, a native `formSheet`), so there is
 * no `Modal` here and no `visible` prop: this file is drawn only while it is on
 * screen. Every band and every row says `onSheet`, so the ground and the
 * hairlines are the sheet's own tokens (`bandOnSheet`, `sepSheet`).
 *
 * The list is the sheet's OWN scroller (`Sheet native scroll`): a second one
 * inside it would scroll instead of expanding the sheet (F8), and the head stays
 * pinned above it (F0). The reveal's ref and the bands' measurements ride that
 * one scroller, so H4a still lands on its section.
 */
import type { ComponentRef, JSX, ReactNode } from "react";
import { Pressable, type ScrollView, StyleSheet, Switch, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { sectionNotes } from "../band-notes.ts";
import {
  type InfoRow,
  type InfoSection,
  type SectionId,
  type SessionInfoView,
  rowIdentity,
} from "../session-info.ts";
import { DENSE_FONT_SCALE, MONO, type Palette, radius, space, typography } from "../theme.ts";
import { BandNote, BandSection } from "../ui/BandSection.tsx";
import { Banner } from "../ui/Banner.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Row } from "../ui/Row.tsx";
import { Sheet } from "../ui/Sheet.tsx";
import { StatusDot } from "../ui/StatusDot.tsx";
import { Text } from "../ui/Text.tsx";

export interface SessionInfoSheetProps {
  readonly palette: Palette;
  readonly view: SessionInfoView;
  /** The auto-accept switch's value and setter (Owner Q3, F11). */
  readonly autoAcceptOn: boolean;
  readonly autoAcceptError: string | null;
  readonly onAutoAccept: (on: boolean) => void;
  /** A server's/skill's switch (session-capabilities S5): the row's own kind and raw name. */
  readonly onSwitch: (kind: "mcp" | "skill", name: string, enabled: boolean) => void;
  /**
   * Delete one armed scheduled wake (cron-tool S6, M7): the row's RAW id. A
   * trailing control, not a swipe: the app carries no gesture library, and plan
   * P9's rule is a testID-addressable control.
   */
  readonly onDeleteSchedule: (scheduleId: string) => void;
  /** Pull-to-refresh and a Retry row. */
  readonly onRefresh: () => void;
  readonly onRetry: (section: InfoSection["id"]) => void;
  /**
   * The artifacts row (docs/feat/model-artifacts.md D9): it OPENS the gallery,
   * so the sheet is a way in rather than a dead end. The caller routes and
   * closes the sheet.
   */
  readonly onOpenArtifacts: () => void;
  readonly onClose: () => void;
  /** An expanded row (tool names, a full error): its id, or null. */
  readonly expanded: string | null;
  readonly onExpand: (id: string | null) => void;
  /**
   * The scroller, so the caller can reveal a section (docs/feat/mobile-hub.md
   * H4a: the hub's Scheduled item lands on SCHEDULED WAKES). A plain callback ref,
   * not a hook: this component stays hook-free so the element walker can call it.
   */
  readonly scrollRef?: (node: ComponentRef<typeof ScrollView> | null) => void;
  /**
   * A band's y inside the content, as it lays out. The caller decides what (if
   * anything) to scroll to — `revealOffset` is its rule, never this component's.
   */
  readonly onSectionLayout?: (id: SectionId, y: number) => void;
}

/** The shimmer/`Checking…` row of a section still loading. */
function LoadingRow({
  palette,
  first,
}: { readonly palette: Palette; readonly first: boolean }): JSX.Element {
  return (
    <Row
      palette={palette}
      title="Checking…"
      first={first}
      onSheet
      dimmed
      minHeight={44}
      testID="session-info-loading"
    />
  );
}

/** One section's body: its rows, its empty/error state, its cap and footer. */
function SectionBody({
  palette,
  section,
  expanded,
  onExpand,
  onRetry,
  onSwitch,
  onDeleteSchedule,
  onOpenArtifacts,
}: {
  readonly palette: Palette;
  readonly section: InfoSection;
  readonly expanded: string | null;
  readonly onExpand: (id: string | null) => void;
  readonly onRetry: (section: InfoSection["id"]) => void;
  readonly onSwitch: SessionInfoSheetProps["onSwitch"];
  readonly onDeleteSchedule: SessionInfoSheetProps["onDeleteSchedule"];
  readonly onOpenArtifacts: SessionInfoSheetProps["onOpenArtifacts"];
}): JSX.Element {
  if (section.phase === "loading") {
    return <LoadingRow palette={palette} first />;
  }
  if (section.phase !== "ready") {
    const empty = section.empty;
    const text = empty?.title ?? "Nothing here";
    const retryable = section.retry === true;
    return (
      <Row
        palette={palette}
        title={retryable ? `${text} · Retry` : text}
        subtitle={empty?.footnote}
        first
        onSheet
        minHeight={44}
        {...(retryable
          ? { tone: "accent", onPress: () => onRetry(section.id) }
          : { dimmed: section.phase === "offline" })}
        testID={`session-info-empty-${section.id}`}
      />
    );
  }
  return (
    <>
      {section.rows.map((row, index) => (
        <InfoRowView
          key={`${section.id}-${rowIdentity(row)}`}
          palette={palette}
          row={row}
          first={index === 0}
          sectionId={section.id}
          onSwitch={onSwitch}
          onDeleteSchedule={onDeleteSchedule}
          onOpenArtifacts={onOpenArtifacts}
          expanded={expanded === `${section.id}:${rowIdentity(row)}`}
          onExpand={() => {
            if (row.expand === undefined) {
              return;
            }
            onExpand(
              expanded === `${section.id}:${rowIdentity(row)}`
                ? null
                : `${section.id}:${rowIdentity(row)}`,
            );
          }}
        />
      ))}
    </>
  );
}

/** One row: a status dot or a glyph, the title, a subtitle, the trailing value. */
function InfoRowView({
  palette,
  row,
  first,
  sectionId,
  expanded,
  onExpand,
  onSwitch,
  onDeleteSchedule,
  onOpenArtifacts,
}: {
  readonly palette: Palette;
  readonly row: InfoRow;
  readonly first: boolean;
  readonly sectionId: InfoSection["id"];
  readonly expanded: boolean;
  readonly onExpand: () => void;
  readonly onSwitch: SessionInfoSheetProps["onSwitch"];
  readonly onDeleteSchedule: SessionInfoSheetProps["onDeleteSchedule"];
  readonly onOpenArtifacts: SessionInfoSheetProps["onOpenArtifacts"];
}): JSX.Element {
  const toggle = row.switch;
  const remove = row.delete;
  const values =
    row.value === undefined && row.chip === undefined ? undefined : (
      <View style={styles.trailing}>
        {row.value === undefined || row.value === "" ? null : (
          <Text
            maxFontSizeMultiplier={DENSE_FONT_SCALE}
            numberOfLines={1}
            style={[
              row.mono === true ? typography.mono : typography.subhead,
              { color: palette.sec },
              row.mono === true ? { fontFamily: MONO } : null,
            ]}
          >
            {row.value}
          </Text>
        )}
        {row.chip === undefined ? null : (
          <Text
            maxFontSizeMultiplier={DENSE_FONT_SCALE}
            style={[typography.caption, { color: palette.sec }]}
          >
            {row.chip}
          </Text>
        )}
      </View>
    );
  // P1 (owner): a trailing switch on the row, as Auto-accept's; a ghost
  // (disabled) one when the view-model says it cannot send. A scheduled wake's
  // trailing control is its Delete instead (cron-tool S6): a wake has no on/off.
  const trailing =
    remove !== undefined ? (
      <Pressable
        testID={`session-info-${sectionId}-${rowIdentity(row)}-delete`}
        accessibilityRole="button"
        accessibilityLabel={remove.accessibilityLabel}
        onPress={() => onDeleteSchedule(remove.id)}
        style={styles.delete}
      >
        <Text style={[typography.subhead, { color: palette.red }]}>Delete</Text>
      </Pressable>
    ) : toggle === undefined ? (
      values
    ) : (
      <View style={styles.switchTrail}>
        {values}
        <Switch
          testID={`session-info-${sectionId}-${rowIdentity(row)}-switch`}
          accessibilityLabel={toggle.accessibilityLabel}
          value={toggle.on}
          disabled={!toggle.interactive}
          onValueChange={(on) => onSwitch(toggle.kind, toggle.name, on)}
        />
      </View>
    );
  // What that edge IS, for VoiceOver (fix round 1): a control is its own element,
  // a plain `values` read is part of the row. Both of this row's controls live in
  // the first two branches, so the last one is a READ.
  const trailingKind: "value" | "control" =
    remove !== undefined || toggle !== undefined ? "control" : "value";
  return (
    <>
      <Row
        palette={palette}
        title={row.title}
        {...(row.subtitle === undefined ? {} : { subtitle: row.subtitle })}
        first={first}
        onSheet
        minHeight={44}
        dimmed={row.dim === true}
        {...(row.accessibilityLabel === undefined
          ? {}
          : { accessibilityLabel: row.accessibilityLabel })}
        {...(row.expand === undefined ? {} : { onPress: onExpand, chevron: !expanded })}
        {...(row.opens === "artifacts" ? { onPress: onOpenArtifacts, chevron: true as const } : {})}
        trailing={trailing}
        trailingKind={trailingKind}
        testID={`session-info-${sectionId}-${rowIdentity(row)}`}
      >
        {row.tone === undefined ? null : (
          <View style={styles.lead}>
            <StatusDot palette={palette} tone={row.tone} size={8} />
            {row.glyph === undefined ? null : (
              <Icon name={row.glyph} color={palette.orange} size={13} />
            )}
            {row.loading === true ? (
              <Text style={[typography.footnote, { color: palette.sec }]}>Counting…</Text>
            ) : null}
          </View>
        )}
        {row.expand === undefined || !expanded ? null : (
          <Text style={[typography.footnote, { color: palette.sec }]}>{row.expand}</Text>
        )}
      </Row>
    </>
  );
}

/** One section: its note(s) under the band, its rows (and its own last row) in it. */
function Section({
  palette,
  section,
  expanded,
  onExpand,
  onRetry,
  onSwitch,
  onDeleteSchedule,
  onOpenArtifacts,
  lastRow,
}: {
  readonly palette: Palette;
  readonly section: InfoSection;
  readonly expanded: string | null;
  readonly onExpand: (id: string | null) => void;
  readonly onRetry: (section: InfoSection["id"]) => void;
  readonly onSwitch: SessionInfoSheetProps["onSwitch"];
  readonly onDeleteSchedule: SessionInfoSheetProps["onDeleteSchedule"];
  readonly onOpenArtifacts: SessionInfoSheetProps["onOpenArtifacts"];
  /** A row that belongs to THIS section but is not the view-model's (Auto-accept). */
  readonly lastRow?: ReactNode;
}): JSX.Element {
  // The section's notes are the band's footnotes (Design 4), so they sit on the
  // band's own 20 pt gutter instead of 12 pt inside the label they explain. One
  // BLOCK per note — `band-notes.ts` decides how many, and their keys by ROLE
  // (S4 review finding 1: a Fragment of `<Text>`s laid out inline, joining them
  // into one line and hiding the switch note's testID).
  const notes = sectionNotes(section);
  return (
    <View style={styles.section}>
      <BandSection
        palette={palette}
        title={section.title}
        onSheet
        notes={notes.map((note) => (
          <BandNote
            key={note.key}
            palette={palette}
            {...(note.testID === undefined ? {} : { testID: note.testID })}
          >
            {note.text}
          </BandNote>
        ))}
      >
        <SectionBody
          palette={palette}
          section={section}
          expanded={expanded}
          onExpand={onExpand}
          onRetry={onRetry}
          onSwitch={onSwitch}
          onDeleteSchedule={onDeleteSchedule}
          onOpenArtifacts={onOpenArtifacts}
        />
        {lastRow}
      </BandSection>
    </View>
  );
}

export function SessionInfoSheet({
  palette,
  view,
  autoAcceptOn,
  autoAcceptError,
  onAutoAccept,
  onSwitch,
  onDeleteSchedule,
  onRefresh,
  onRetry,
  onOpenArtifacts,
  onClose,
  expanded,
  onExpand,
  scrollRef,
  onSectionLayout,
}: SessionInfoSheetProps): JSX.Element {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.root, { backgroundColor: palette.bg }]}>
      <Sheet
        palette={palette}
        title="Session info"
        subtitle={view.subtitle}
        testID="session-info-sheet"
        insetBottom={false}
        scroll
        native
        onClose={onClose}
        closeTestID="session-info-close"
        scrollTestID="session-info-scroll"
        {...(scrollRef === undefined ? {} : { scrollRef })}
      >
        {view.banner === undefined ? null : (
          <Banner
            palette={palette}
            tone="warn"
            icon="wifi.slash"
            body={view.banner.text}
            testID="session-info-offline"
          />
        )}
        {view.sections.map((section) => (
          <View
            key={section.id}
            style={styles.sectionGroup}
            {...(onSectionLayout === undefined
              ? {}
              : {
                  onLayout: (event: { nativeEvent: { layout: { y: number } } }) =>
                    onSectionLayout(section.id, event.nativeEvent.layout.y),
                })}
          >
            <Section
              palette={palette}
              section={section}
              expanded={expanded}
              onExpand={onExpand}
              onRetry={onRetry}
              onSwitch={onSwitch}
              onDeleteSchedule={onDeleteSchedule}
              onOpenArtifacts={onOpenArtifacts}
              {...(section.id === "session" && view.autoAccept === true
                ? {
                    // Design 4 / the mockup's `infoE2` (`index.html:394-397`):
                    // Auto-accept is the SESSION band's LAST ROW, not a band of
                    // its own — the switch belongs to this session's settings.
                    lastRow: (
                      <Row
                        palette={palette}
                        title="Auto-accept"
                        subtitle={
                          autoAcceptError ?? "Allow every ask in this session, on every device"
                        }
                        onSheet
                        minHeight={44}
                        testID="session-info-autoaccept"
                        trailing={
                          <Switch
                            testID="session-info-autoaccept-switch"
                            accessibilityLabel="Auto-accept for this session, on every device"
                            value={autoAcceptOn}
                            onValueChange={(on) => onAutoAccept(on)}
                          />
                        }
                      />
                    ),
                  }
                : {})}
            />
          </View>
        ))}
        <Text
          maxFontSizeMultiplier={DENSE_FONT_SCALE}
          style={[typography.caption, styles.footer, { color: palette.sec }]}
        >
          {view.footer}
        </Text>
        <Pressable
          testID="session-info-refresh"
          accessibilityRole="button"
          onPress={onRefresh}
          style={styles.refresh}
        >
          <Text style={[typography.footnote, { color: palette.accent }]}>Refresh</Text>
        </Pressable>
        <View style={{ height: insets.bottom + 20 }} />
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  sectionGroup: { gap: 0 },
  section: { gap: 0 },
  footer: { textAlign: "center", paddingHorizontal: space.inset, paddingTop: 4 },
  refresh: { alignSelf: "center", paddingVertical: 8, paddingHorizontal: 16 },
  trailing: { alignItems: "flex-end", gap: 2, maxWidth: "55%" },
  lead: { flexDirection: "row", alignItems: "center", gap: 6 },
  switchTrail: { flexDirection: "row", alignItems: "center", gap: 10 },
  delete: { paddingVertical: 8, paddingLeft: 12 },
});
