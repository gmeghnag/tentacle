/**
 * Start a workflow (docs/feat/workflows-ui.md D6, slice 5b): a native-stack PUSH.
 * A dumb renderer (AGENTS §7) — the catalogue projection, the form, the start's
 * params and every refusal branch are `workflow-start.ts` /
 * `workflow-start-controller.ts`'s; this file maps a view-model to elements.
 *
 * Two things are drawn deliberately:
 * - **a `run` step's command VERBATIM**, never cut to a line count: it is what an
 *   approval will ask about, and the ask's own detail is capped at 2000 chars.
 * - **every word with its glyph** (the owner is colour-blind: never meaning by hue
 *   alone) — "✓ Approved" / "? Needs approval", and a broken row's errors verbatim,
 *   each naming its YAML path.
 */
import type { JSX } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { type Palette, space, typography } from "../theme.ts";
import { Banner } from "../ui/Banner.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Icon } from "../ui/Icon.tsx";
import { PillButton } from "../ui/PillButton.tsx";
import { ScreenHeader } from "../ui/ScreenHeader.tsx";
import { Text, TextInput } from "../ui/Text.tsx";
import type { StartState } from "../workflow-start-controller.ts";
import {
  type CatalogueEntry,
  START_UNAVAILABLE,
  START_UPDATE_TENTACLE,
  formFor,
  openEntry,
} from "../workflow-start.ts";

export interface WorkflowStartScreenProps {
  readonly palette: Palette;
  /** The computer's name (the header's subtitle). */
  readonly computer: string;
  readonly state: StartState;
  /** `canStart()` — the controller's own gate; the screen never re-derives it. */
  readonly canStart: boolean;
  readonly onBack: () => void;
  readonly onPull: () => void;
  readonly onOpenRow: (key: string) => void;
  readonly onCloseRow: () => void;
  readonly onValue: (name: string, value: string) => void;
  readonly onStart: () => void;
}

/** The folder the catalogue read, and the two notices about it. */
function FolderLine({
  palette,
  state,
}: {
  readonly palette: Palette;
  readonly state: StartState;
}): JSX.Element | null {
  const view = state.catalogue;
  if (view === null || view.dir === null) {
    return null;
  }
  return (
    <View style={styles.folder}>
      <Text testID="workflow-start-dir" style={[typography.mono, { color: palette.sec }]}>
        {view.dir}
      </Text>
      {view.gitIgnored ? (
        <Text style={[typography.footnote, { color: palette.sec }]}>
          Not versioned — git ignores this folder
        </Text>
      ) : null}
      {view.truncated ? (
        <Text style={[typography.footnote, { color: palette.sec }]}>
          Not all of it: this folder lists more workflows than tentacle shows
        </Text>
      ) : null}
      {view.elsewhere === null ? null : (
        <Text style={[typography.footnote, { color: palette.sec }]}>
          {`${view.elsewhere.count} workflow${view.elsewhere.count === 1 ? "" : "s"} found in ${view.elsewhere.dir} — tentacle reads this folder only`}
        </Text>
      )}
    </View>
  );
}

/** One valid row: its name, what the daemon says of it, and a way into its form. */
function ValidRow({
  palette,
  entry,
  onPress,
}: {
  readonly palette: Palette;
  readonly entry: CatalogueEntry;
  readonly onPress: () => void;
}): JSX.Element {
  return (
    <Pressable
      testID={`workflow-start-row-${entry.name}`}
      accessibilityRole="button"
      accessibilityLabel={`${entry.name}, ${entry.approval?.word ?? "approval unknown"}`}
      onPress={onPress}
      style={[styles.row, { backgroundColor: palette.card, borderColor: palette.sep }]}
    >
      <View style={styles.rowHead}>
        <Text style={[styles.name, { color: palette.label }]}>{entry.name}</Text>
        {entry.approval === null ? null : (
          <Text style={[typography.footnote, { color: palette.sec }]}>
            {`${entry.approval.glyph} ${entry.approval.word}`}
          </Text>
        )}
        <Icon name="chevron.right" color={palette.sec} size={14} />
      </View>
      {entry.description === null ? null : (
        <Text style={[typography.subhead, { color: palette.sec }]}>{entry.description}</Text>
      )}
    </Pressable>
  );
}

/** One broken row: every error VERBATIM (each names its YAML path), and no way to start. */
function BrokenRow({
  palette,
  entry,
}: {
  readonly palette: Palette;
  readonly entry: CatalogueEntry;
}): JSX.Element {
  return (
    <View
      testID={`workflow-start-broken-${entry.name}`}
      style={[styles.row, { backgroundColor: palette.card, borderColor: palette.sep }]}
    >
      <View style={styles.rowHead}>
        <Text style={[styles.name, { color: palette.label }]}>{entry.name}</Text>
        <Text style={[typography.footnote, { color: palette.sec }]}>✗ Cannot run</Text>
      </View>
      <Text style={[typography.mono, { color: palette.sec }]}>{entry.path}</Text>
      <View testID={`workflow-start-errors-${entry.name}`} style={styles.errors}>
        {(entry.errors.length === 0 ? ["this file did not validate"] : entry.errors).map(
          (error) => (
            <Text key={error} style={[typography.mono, { color: palette.label }]}>
              {error}
            </Text>
          ),
        )}
      </View>
    </View>
  );
}

/** The detail of one row: description, every step in full, the inputs form, Start. */
function Detail({
  palette,
  entry,
  state,
  canStart,
  onCloseRow,
  onValue,
  onStart,
}: {
  readonly palette: Palette;
  readonly entry: CatalogueEntry;
  readonly state: StartState;
  readonly canStart: boolean;
  readonly onCloseRow: () => void;
  readonly onValue: (name: string, value: string) => void;
  readonly onStart: () => void;
}): JSX.Element {
  const form = formFor(entry, state.values);
  return (
    <View testID="workflow-start-detail" style={styles.detail}>
      <Pressable
        testID="workflow-start-detail-back"
        accessibilityRole="button"
        accessibilityLabel="Back to the workflows"
        hitSlop={8}
        onPress={onCloseRow}
        style={styles.detailBack}
      >
        <Icon name="chevron.left" color={palette.label} size={16} />
        <Text style={[typography.subhead, { color: palette.label }]}>All workflows</Text>
      </Pressable>
      <Text style={[typography.title3, { color: palette.label }]}>{entry.name}</Text>
      {entry.description === null ? null : (
        <Text style={[typography.subhead, { color: palette.sec }]}>{entry.description}</Text>
      )}
      <Text style={[typography.mono, { color: palette.sec }]}>{entry.path}</Text>
      {entry.approval === null ? null : (
        <Text style={[typography.footnote, { color: palette.sec }]}>
          {`${entry.approval.glyph} ${entry.approval.word}`}
        </Text>
      )}
      <View style={styles.steps}>
        <Text style={[styles.sectionTitle, { color: palette.sec }]}>Steps</Text>
        {entry.steps.map((step) => (
          <View
            key={step.id}
            testID={`workflow-start-step-${step.id}`}
            style={[styles.step, { borderColor: palette.sep }]}
          >
            <View style={styles.rowHead}>
              <Text style={[styles.name, { color: palette.label }]}>{step.id}</Text>
              <Text style={[typography.footnote, { color: palette.sec }]}>
                {`${step.kind} · ${step.where}${step.model === undefined ? "" : ` · ${step.model}`}`}
              </Text>
            </View>
            {/* A `run` step's command as it will run: never cut to a line count. */}
            {step.command === undefined ? null : (
              <Text style={[typography.monoCode, { color: palette.label }]}>{step.command}</Text>
            )}
          </View>
        ))}
      </View>
      {form.fields.length === 0 ? null : (
        <View style={styles.steps}>
          <Text style={[styles.sectionTitle, { color: palette.sec }]}>Inputs</Text>
          {form.fields.map((field) => (
            <View key={field.name} style={styles.field}>
              <Text style={[typography.footnote, { color: palette.sec }]}>
                {field.required ? `${field.name} (required)` : field.name}
              </Text>
              <TextInput
                testID={`workflow-start-input-${field.name}`}
                accessibilityLabel={field.name}
                value={field.value}
                onChangeText={(next) => onValue(field.name, next)}
                placeholder={field.defaultValue ?? ""}
                placeholderTextColor={palette.sec}
                autoCapitalize="none"
                autoCorrect={false}
                style={[
                  styles.input,
                  { backgroundColor: palette.card, borderColor: palette.sep, color: palette.label },
                ]}
              />
            </View>
          ))}
        </View>
      )}
      {state.problems.map((problem) => (
        <Text
          key={`${problem.field ?? "all"}:${problem.text}`}
          style={[typography.footnote, { color: palette.label }]}
        >
          {`! ${problem.text}`}
        </Text>
      ))}
      <PillButton
        palette={palette}
        testID="workflow-start-run"
        label="Start"
        icon="bolt.fill"
        onPress={onStart}
        disabled={!canStart}
        busy={state.starting}
      />
      {canStart || state.starting ? null : (
        <Text style={[typography.footnote, { color: palette.sec }]}>
          {entry.approval?.word === "Needs approval"
            ? "Starting asks you to approve this file first"
            : "Fill in what is missing to start"}
        </Text>
      )}
    </View>
  );
}

export function WorkflowStartScreen(props: WorkflowStartScreenProps): JSX.Element {
  const { palette, state } = props;
  const view = state.catalogue;
  const entry = state.openKey === null ? null : openEntry(view, state.openKey);
  return (
    <View testID="workflow-start" style={[styles.screen, { backgroundColor: palette.page }]}>
      <ScreenHeader
        palette={palette}
        variant="compact"
        title={entry === null ? "Start a workflow" : entry.name}
        subtitle={props.computer}
        left={
          <Pressable
            testID="workflow-start-header-back"
            accessibilityRole="button"
            accessibilityLabel="Back"
            hitSlop={8}
            onPress={props.onBack}
          >
            <Icon name="chevron.left" color={palette.label} size={18} />
          </Pressable>
        }
      />
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={false} onRefresh={props.onPull} />}
      >
        {state.notice === null ? null : (
          <Banner
            palette={palette}
            body={state.notice}
            tone="warn"
            testID="workflow-start-notice"
          />
        )}
        {state.banner === null ? null : (
          <Banner
            palette={palette}
            body={state.banner}
            tone="info"
            icon="arrow.clockwise"
            testID="workflow-start-banner"
          />
        )}
        {state.kind === "opening" || state.kind === "loading" ? (
          <EmptyState palette={palette} loading />
        ) : null}
        {state.kind === "unsupported" ? (
          <EmptyState
            testID="workflow-start-unsupported"
            palette={palette}
            title={START_UPDATE_TENTACLE}
            icon="arrow.clockwise"
          />
        ) : null}
        {state.kind === "unavailable" ? (
          <EmptyState
            testID="workflow-start-unavailable"
            palette={palette}
            title={START_UNAVAILABLE}
            body={view?.reason ?? undefined}
            icon="exclamationmark.triangle"
          />
        ) : null}
        {state.kind === "ended" || state.kind === "failed" ? (
          <EmptyState
            testID="workflow-start-error"
            palette={palette}
            title="Could not open the workflows"
            body={state.error ?? undefined}
            icon="exclamationmark.triangle"
          />
        ) : null}
        {entry === null ? <FolderLine palette={palette} state={state} /> : null}
        {state.kind === "ready" && view?.kind === "empty" ? (
          <EmptyState
            testID="workflow-start-empty"
            palette={palette}
            title="No workflows here"
            body={`Put a workflow file in ${view.dir ?? "the workflows folder"}`}
            icon="doc.text"
          />
        ) : null}
        {entry === null
          ? (view?.valid ?? []).map((row) => (
              <ValidRow
                key={row.key}
                palette={palette}
                entry={row}
                onPress={() => props.onOpenRow(row.key)}
              />
            ))
          : null}
        {entry === null
          ? (view?.invalid ?? []).map((row) => (
              <BrokenRow key={row.key} palette={palette} entry={row} />
            ))
          : null}
        {entry === null ? null : (
          <Detail
            palette={palette}
            entry={entry}
            state={state}
            canStart={props.canStart}
            onCloseRow={props.onCloseRow}
            onValue={props.onValue}
            onStart={props.onStart}
          />
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: space.inset, gap: space.inset },
  folder: { gap: 4 },
  sectionTitle: { ...typography.footnote, textTransform: "uppercase" },
  row: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 12, gap: 4 },
  rowHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  name: { ...typography.body, flex: 1, fontWeight: "600" },
  errors: { gap: 2 },
  detail: { gap: 10 },
  detailBack: { flexDirection: "row", alignItems: "center", gap: 4 },
  steps: { gap: 8 },
  step: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, padding: 10, gap: 4 },
  field: { gap: 4 },
  input: {
    ...typography.body,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
});
