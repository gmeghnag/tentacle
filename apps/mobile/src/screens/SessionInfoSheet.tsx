/**
 * Session info — the sheet itself (docs/feat/mobile-session-info.md). RENDER ONLY
 * (AGENTS §7): every row, wording and state it draws comes from
 * `session-info.ts`'s view-model, and every decision (which section is loading,
 * what a cap says, which tone a server gets) was made there.
 *
 * The grammar is the Settings screen's (`mobile-ui-polish.md:1288-1291`):
 * `SectionHeader` + a 26 pt `GroupedCard` of 44 pt `Row`s, in a native
 * `pageSheet`.
 */
import type { JSX } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { InfoRow, InfoSection, SessionInfoView } from "../session-info.ts";
import { DENSE_FONT_SCALE, MONO, type Palette, radius, space, typography } from "../theme.ts";
import { Banner } from "../ui/Banner.tsx";
import { GroupedCard } from "../ui/GroupedCard.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Row } from "../ui/Row.tsx";
import { SectionHeader } from "../ui/SectionHeader.tsx";
import { Sheet } from "../ui/Sheet.tsx";
import { StatusDot } from "../ui/StatusDot.tsx";

export interface SessionInfoSheetProps {
  readonly palette: Palette;
  readonly visible: boolean;
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
  readonly onClose: () => void;
  /** An expanded row (tool names, a full error): its id, or null. */
  readonly expanded: string | null;
  readonly onExpand: (id: string | null) => void;
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
}: {
  readonly palette: Palette;
  readonly section: InfoSection;
  readonly expanded: string | null;
  readonly onExpand: (id: string | null) => void;
  readonly onRetry: (section: InfoSection["id"]) => void;
  readonly onSwitch: SessionInfoSheetProps["onSwitch"];
  readonly onDeleteSchedule: SessionInfoSheetProps["onDeleteSchedule"];
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
          key={`${section.id}-${row.title}`}
          palette={palette}
          row={row}
          first={index === 0}
          sectionId={section.id}
          onSwitch={onSwitch}
          onDeleteSchedule={onDeleteSchedule}
          expanded={expanded === `${section.id}:${row.title}`}
          onExpand={() => {
            if (row.expand === undefined) {
              return;
            }
            onExpand(
              expanded === `${section.id}:${row.title}` ? null : `${section.id}:${row.title}`,
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
}: {
  readonly palette: Palette;
  readonly row: InfoRow;
  readonly first: boolean;
  readonly sectionId: InfoSection["id"];
  readonly expanded: boolean;
  readonly onExpand: () => void;
  readonly onSwitch: SessionInfoSheetProps["onSwitch"];
  readonly onDeleteSchedule: SessionInfoSheetProps["onDeleteSchedule"];
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
        testID={`session-info-${sectionId}-${row.title}-delete`}
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
          testID={`session-info-${sectionId}-${row.title}-switch`}
          accessibilityLabel={toggle.accessibilityLabel}
          value={toggle.on}
          disabled={!toggle.interactive}
          onValueChange={(on) => onSwitch(toggle.kind, toggle.name, on)}
        />
      </View>
    );
  return (
    <>
      <Row
        palette={palette}
        title={row.title}
        {...(row.subtitle === undefined ? {} : { subtitle: row.subtitle })}
        first={first}
        minHeight={44}
        dimmed={row.dim === true}
        {...(row.accessibilityLabel === undefined
          ? {}
          : { accessibilityLabel: row.accessibilityLabel })}
        {...(row.expand === undefined ? {} : { onPress: onExpand, chevron: !expanded })}
        trailing={trailing}
        testID={`session-info-${sectionId}-${row.title}`}
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

/** A section header plus its card and footnotes. */
function Section({
  palette,
  section,
  expanded,
  onExpand,
  onRetry,
  onSwitch,
  onDeleteSchedule,
}: {
  readonly palette: Palette;
  readonly section: InfoSection;
  readonly expanded: string | null;
  readonly onExpand: (id: string | null) => void;
  readonly onRetry: (section: InfoSection["id"]) => void;
  readonly onSwitch: SessionInfoSheetProps["onSwitch"];
  readonly onDeleteSchedule: SessionInfoSheetProps["onDeleteSchedule"];
}): JSX.Element {
  return (
    <View style={styles.section}>
      <SectionHeader palette={palette} title={section.title} />
      <GroupedCard palette={palette} surface={palette.fill}>
        <SectionBody
          palette={palette}
          section={section}
          expanded={expanded}
          onExpand={onExpand}
          onRetry={onRetry}
          onSwitch={onSwitch}
          onDeleteSchedule={onDeleteSchedule}
        />
      </GroupedCard>
      {section.rowsNote === undefined ? null : (
        <Text
          maxFontSizeMultiplier={DENSE_FONT_SCALE}
          style={[typography.footnote, styles.footnote, { color: palette.sec }]}
        >
          {section.rowsNote}
        </Text>
      )}
      {section.footer === undefined ? null : (
        <Text
          maxFontSizeMultiplier={DENSE_FONT_SCALE}
          style={[typography.footnote, styles.footnote, { color: palette.sec }]}
        >
          {section.footer}
        </Text>
      )}
      {section.switchNote === undefined ? null : (
        <Text
          maxFontSizeMultiplier={DENSE_FONT_SCALE}
          testID={`session-info-switch-note-${section.id}`}
          style={[typography.footnote, styles.footnote, { color: palette.sec }]}
        >
          {section.switchNote}
        </Text>
      )}
    </View>
  );
}

export function SessionInfoSheet({
  palette,
  visible,
  view,
  autoAcceptOn,
  autoAcceptError,
  onAutoAccept,
  onSwitch,
  onDeleteSchedule,
  onRefresh,
  onRetry,
  onClose,
  expanded,
  onExpand,
}: SessionInfoSheetProps): JSX.Element {
  const insets = useSafeAreaInsets();
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={[styles.root, { backgroundColor: palette.sheet, paddingTop: insets.top }]}>
        <View style={styles.topBar}>
          <View style={styles.spacer} />
          <Pressable
            testID="session-info-close"
            accessibilityRole="button"
            accessibilityLabel="Close"
            onPress={onClose}
            style={styles.close}
          >
            <Icon name="xmark" color={palette.sec} size={17} />
          </Pressable>
        </View>
        <Sheet
          palette={palette}
          title="Session info"
          subtitle={view.subtitle}
          testID="session-info-sheet"
          insetBottom={false}
          scroll
        >
          <ScrollView
            testID="session-info-scroll"
            contentContainerStyle={styles.content}
            showsVerticalScrollIndicator
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
              <View key={section.id} style={styles.sectionGroup}>
                <Section
                  palette={palette}
                  section={section}
                  expanded={expanded}
                  onExpand={onExpand}
                  onRetry={onRetry}
                  onSwitch={onSwitch}
                  onDeleteSchedule={onDeleteSchedule}
                />
                {/* The switch belongs to the SESSION's settings, right under it. */}
                {section.id !== "session" || !view.autoAccept ? null : (
                  <View style={styles.section}>
                    <GroupedCard palette={palette} surface={palette.fill}>
                      <Row
                        palette={palette}
                        title="Auto-accept"
                        subtitle={
                          autoAcceptError ?? "Allow every ask in this session, on every device"
                        }
                        first
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
                    </GroupedCard>
                  </View>
                )}
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
          </ScrollView>
        </Sheet>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topBar: { flexDirection: "row", alignItems: "center", paddingHorizontal: space.inset },
  spacer: { flex: 1 },
  close: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  content: { gap: 22 },
  sectionGroup: { gap: 22 },
  section: { gap: 8 },
  footnote: { paddingHorizontal: space.inset + space.cardInner },
  footer: { textAlign: "center", paddingHorizontal: space.inset, paddingTop: 4 },
  refresh: { alignSelf: "center", paddingVertical: 8, paddingHorizontal: 16 },
  trailing: { alignItems: "flex-end", gap: 2, maxWidth: "55%" },
  lead: { flexDirection: "row", alignItems: "center", gap: 6 },
  switchTrail: { flexDirection: "row", alignItems: "center", gap: 10 },
  delete: { paddingVertical: 8, paddingLeft: 12 },
});
