/**
 * Tools — the sheet the hub's Tools item opens (docs/feat/mobile-hub-tools.md
 * D5). RENDER ONLY (AGENTS §7): every band, every word, every switch and the
 * search's result come from `tools-view.ts`'s view-model, which reuses Session
 * info's own builders — so this file decides nothing but placement.
 *
 * The grammar is Session info's (docs/feat/mobile-chrome.md Design 4): the E2
 * band of 44 pt `Row`s inside a native `pageSheet`, everything `onSheet`.
 */
import type { JSX } from "react";
import {
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DENSE_FONT_SCALE, type Palette, radius, size, space, typography } from "../theme.ts";
import type { ToolsBand, ToolsSegmentId, ToolsView } from "../tools-view.ts";
import { BandSection } from "../ui/BandSection.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Row } from "../ui/Row.tsx";
import { Sheet } from "../ui/Sheet.tsx";
import { Text, TextInput } from "../ui/Text.tsx";

export interface ToolsSheetProps {
  readonly palette: Palette;
  readonly visible: boolean;
  readonly view: ToolsView;
  /** The "show or hide it from the model in this session" write (the one source's own). */
  readonly onSwitch: (kind: "mcp" | "skill", name: string, enabled: boolean) => void;
  /** The segmented control's pick. */
  readonly onSegment: (segment: ToolsSegmentId) => void;
  /** The search field's text. */
  readonly onQuery: (query: string) => void;
  /** A band's chevron: its own `capabilityKey`, or null to collapse it. */
  readonly onToggle: (key: string, open: boolean) => void;
  /** Pull-to-refresh, and the Retry row: both re-run the pulls. */
  readonly onRefresh: () => void;
  readonly refreshing: boolean;
  readonly onClose: () => void;
}

/** One band: the row (switch, chevron) and, when expanded, its read-only tools. */
function Band({
  palette,
  band,
  first,
  onSwitch,
  onToggle,
}: {
  readonly palette: Palette;
  readonly band: ToolsBand;
  readonly first: boolean;
  readonly onSwitch: ToolsSheetProps["onSwitch"];
  readonly onToggle: ToolsSheetProps["onToggle"];
}): JSX.Element {
  const toggle = band.switch;
  const tools = band.tools;
  return (
    <>
      <Row
        palette={palette}
        title={band.title}
        subtitle={band.subtitle}
        first={first}
        onSheet
        minHeight={44}
        dimmed={band.dim}
        {...(tools === null
          ? {}
          : { onPress: () => onToggle(band.key, !band.expanded), chevron: !band.expanded })}
        trailing={
          toggle === undefined ? null : (
            <Switch
              testID={`tools-${band.key}-switch`}
              accessibilityLabel={toggle.accessibilityLabel}
              value={toggle.on}
              disabled={!toggle.interactive}
              onValueChange={(on) => onSwitch(toggle.kind, toggle.name, on)}
            />
          )
        }
        testID={`tools-${band.key}`}
      />
      {tools === null || !band.expanded ? null : (
        <View
          testID={`tools-${band.key}-tools`}
          style={[styles.tools, { borderTopColor: palette.sepSheet }]}
        >
          <Text
            maxFontSizeMultiplier={DENSE_FONT_SCALE}
            style={[
              typography.mono,
              band.toolsDim ? { color: palette.sec } : { color: palette.label },
            ]}
          >
            {tools.names.join(", ")}
            {tools.more > 0 ? `, +${tools.more} more` : ""}
          </Text>
        </View>
      )}
    </>
  );
}

export function ToolsSheet({
  palette,
  visible,
  view,
  onSwitch,
  onSegment,
  onQuery,
  onToggle,
  onRefresh,
  refreshing,
  onClose,
}: ToolsSheetProps): JSX.Element {
  const insets = useSafeAreaInsets();
  const active = view.segments.find((segment) => segment.id === view.segment);
  const empty = active === undefined ? undefined : active.empty;
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={[styles.root, { backgroundColor: palette.bg }]}>
        <Sheet
          palette={palette}
          title="Tools"
          subtitle="What this session offers the model"
          testID="tools-sheet"
          insetBottom={false}
          scroll
          onClose={onClose}
          closeTestID="tools-close"
        >
          <ScrollView
            testID="tools-scroll"
            contentContainerStyle={styles.content}
            showsVerticalScrollIndicator
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                tintColor={palette.sec}
              />
            }
          >
            <View style={[styles.segments, { backgroundColor: palette.fill }]}>
              {view.segments.map((segment) => {
                const on = segment.id === view.segment;
                return (
                  <Pressable
                    key={segment.id}
                    testID={`tools-segment-${segment.id}`}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                    accessibilityLabel={
                      segment.count === null ? segment.label : `${segment.label}, ${segment.count}`
                    }
                    onPress={() => onSegment(segment.id)}
                    style={[styles.segment, on ? { backgroundColor: palette.card } : null]}
                  >
                    <Text
                      maxFontSizeMultiplier={DENSE_FONT_SCALE}
                      style={[
                        typography.subhead,
                        on ? styles.segmentOn : null,
                        { color: on ? palette.label : palette.sec },
                      ]}
                    >
                      {segment.label}
                    </Text>
                    {segment.count === null ? null : (
                      <Text
                        maxFontSizeMultiplier={DENSE_FONT_SCALE}
                        style={[typography.caption, { color: palette.sec }]}
                      >
                        {segment.count}
                      </Text>
                    )}
                  </Pressable>
                );
              })}
            </View>
            <View style={[styles.search, { backgroundColor: palette.fill }]}>
              <Icon name="magnifyingglass" color={palette.sec} size={15} />
              <TextInput
                testID="tools-search"
                value={view.query}
                onChangeText={onQuery}
                placeholder="Search servers, skills and tools"
                placeholderTextColor={palette.sec}
                style={[typography.body, styles.searchInput, { color: palette.label }]}
                autoCorrect={false}
                autoCapitalize="none"
                clearButtonMode="while-editing"
                returnKeyType="search"
                accessibilityLabel="Search servers, skills and tools"
              />
            </View>
            {view.bands.length === 0 ? (
              <EmptyState
                palette={palette}
                testID={view.noMatches ? "tools-nomatch" : "tools-empty"}
                {...(view.noMatches
                  ? { title: "No matches", icon: "magnifyingglass" as const }
                  : empty === undefined
                    ? { loading: active?.phase === "loading" }
                    : {
                        title: empty.title,
                        ...(empty.footnote === undefined ? {} : { body: empty.footnote }),
                      })}
                {...(active?.retry === true
                  ? {
                      action: (
                        <Pressable
                          testID="tools-retry"
                          accessibilityRole="button"
                          onPress={onRefresh}
                          style={styles.retry}
                        >
                          <Text style={[typography.subhead, { color: palette.accent }]}>
                            Try again
                          </Text>
                        </Pressable>
                      ),
                    }
                  : {})}
              />
            ) : (
              <BandSection
                palette={palette}
                onSheet
                testID="tools-bands"
                {...(view.note === undefined ? {} : { footnote: view.note })}
              >
                {view.bands.map((band, index) => (
                  <Band
                    key={band.key}
                    palette={palette}
                    band={band}
                    first={index === 0}
                    onSwitch={onSwitch}
                    onToggle={onToggle}
                  />
                ))}
              </BandSection>
            )}
            <Pressable
              testID="tools-refresh"
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
  content: { gap: 0 },
  segments: {
    flexDirection: "row",
    marginHorizontal: space.inset,
    marginTop: space.inset,
    padding: 3,
    borderRadius: radius.tile,
    gap: 3,
  },
  segment: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    minHeight: 32,
    borderRadius: radius.tile - 3,
  },
  segmentOn: { fontWeight: "600" },
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: size.touch,
    borderRadius: size.touch / 2,
    marginHorizontal: space.inset,
    marginTop: 10,
    marginBottom: 4,
    paddingHorizontal: 14,
  },
  searchInput: { flex: 1, paddingVertical: 8 },
  tools: {
    paddingHorizontal: space.rowX,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  refresh: { alignSelf: "center", paddingVertical: 8, paddingHorizontal: 16 },
  retry: { paddingVertical: 6, paddingHorizontal: 12 },
});
