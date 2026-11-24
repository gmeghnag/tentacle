/**
 * The computer's workflow runs (docs/feat/workflows-ui.md D4, slice 3): a
 * native-stack PUSH. A dumb renderer (AGENTS §7): the list, its sections, the
 * offline line and the older-daemon state are `workflow-runs-controller.ts` /
 * `workflow-list.ts`'s; this file maps them to elements. Every row carries a
 * glyph AND a word (the owner is colour-blind: never meaning by hue alone).
 */
import type { JSX } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import type { Palette } from "../theme.ts";
import { space, typography } from "../theme.ts";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Icon } from "../ui/Icon.tsx";
import { ScreenHeader } from "../ui/ScreenHeader.tsx";
import { Text } from "../ui/Text.tsx";
import { type ElencoRow, type ElencoRun, elencoSections } from "../workflow-list.ts";
import { type RunsState, WORKFLOWS_UPDATE_TENTACLE } from "../workflow-runs-controller.ts";

export interface WorkflowRunsScreenProps {
  readonly palette: Palette;
  /** The computer's name (the header's subtitle). */
  readonly computer: string;
  readonly state: RunsState;
  /** The clock the rows' `for 23m` is measured against (injected). */
  readonly now: number;
  readonly onBack: () => void;
  readonly onPull: () => void;
  readonly onOpen: (run: ElencoRun) => void;
}

function RunRow({
  palette,
  row,
  onPress,
}: {
  readonly palette: Palette;
  readonly row: ElencoRow;
  readonly onPress: () => void;
}): JSX.Element {
  return (
    <Pressable
      testID={`workflow-run-${row.key}`}
      accessibilityRole="button"
      accessibilityLabel={`${row.name}, ${row.status.word}, ${row.position}`}
      onPress={onPress}
      style={[styles.row, { backgroundColor: palette.card, borderColor: palette.sep }]}
    >
      <View style={styles.rowHead}>
        <Text style={[styles.glyph, { color: palette.label }]}>{row.status.glyph}</Text>
        <Text style={[styles.name, { color: palette.label }]} numberOfLines={1}>
          {row.name}
        </Text>
        <Text style={[styles.meta, { color: palette.sec }]}>{row.when}</Text>
      </View>
      <Text style={[styles.meta, { color: palette.sec }]} numberOfLines={1}>
        {`${row.status.word} · ${row.position}${row.title === null ? "" : ` · ${row.title}`}`}
      </Text>
      {row.needsUser ? (
        <Text style={[styles.meta, { color: palette.label }]}>? needs you</Text>
      ) : null}
    </Pressable>
  );
}

export function WorkflowRunsScreen(props: WorkflowRunsScreenProps): JSX.Element {
  const { palette, state } = props;
  const sections = elencoSections(state.runs, props.now);
  const needYou = sections.live.filter((r) => r.needsUser);
  const others = sections.live.filter((r) => !r.needsUser);
  const byKey = new Map(state.runs.map((r) => [r.runId, r]));
  const open = (row: ElencoRow) => {
    const run = byKey.get(row.key);
    if (run !== undefined) {
      props.onOpen(run);
    }
  };
  const section = (testID: string, title: string, rows: readonly ElencoRow[]) =>
    rows.length === 0 ? null : (
      <View testID={testID} style={styles.section}>
        <Text style={[styles.sectionTitle, { color: palette.sec }]}>{title}</Text>
        {rows.map((row) => (
          <RunRow key={row.key} palette={palette} row={row} onPress={() => open(row)} />
        ))}
      </View>
    );
  return (
    <View testID="workflow-runs" style={[styles.screen, { backgroundColor: palette.page }]}>
      <ScreenHeader
        palette={palette}
        variant="compact"
        title="Workflows"
        subtitle={props.computer}
        left={
          <Pressable
            testID="workflow-runs-back"
            accessibilityRole="button"
            accessibilityLabel="Back"
            hitSlop={8}
            onPress={props.onBack}
          >
            <Icon name="chevron.left" color={palette.label} size={18} />
          </Pressable>
        }
      />
      {state.offline === null ? null : (
        <Text testID="workflow-runs-offline" style={[styles.offline, { color: palette.sec }]}>
          {state.offline}
        </Text>
      )}
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={false} onRefresh={props.onPull} />}
      >
        {state.kind === "loading" ? <EmptyState palette={palette} loading /> : null}
        {state.kind === "unsupported" ? (
          <EmptyState
            testID="workflow-runs-unsupported"
            palette={palette}
            title={WORKFLOWS_UPDATE_TENTACLE}
            icon="arrow.clockwise"
          />
        ) : null}
        {state.kind === "error" ? (
          <EmptyState
            testID="workflow-runs-error"
            palette={palette}
            title="Could not read the workflow runs"
            body={state.error}
            icon="exclamationmark.triangle"
          />
        ) : null}
        {state.kind === "ready" && state.runs.length === 0 ? (
          <EmptyState testID="workflow-runs-empty" palette={palette} title="No workflow runs" />
        ) : null}
        {section("workflow-runs-needs-you", "Needs you", needYou)}
        {section("workflow-runs-live", "In progress", others)}
        {section("workflow-runs-finished", "Finished", sections.finished)}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: space.inset, gap: space.inset },
  offline: { ...typography.footnote, paddingHorizontal: space.inset },
  section: { gap: 8 },
  sectionTitle: { ...typography.footnote, textTransform: "uppercase" },
  row: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 12, gap: 4 },
  rowHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  glyph: { ...typography.body, width: 18, textAlign: "center" },
  name: { ...typography.body, flex: 1, fontWeight: "600" },
  meta: { ...typography.footnote },
});
