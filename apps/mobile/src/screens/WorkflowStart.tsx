/**
 * Workflows — the landing (docs/feat/mobile-workflows-landing.md D7; first the
 * Start screen of docs/feat/workflows-ui.md D6): a native-stack PUSH. A dumb
 * renderer (AGENTS §7) — the run bands, each item's actions and why one is dimmed
 * are `workflow-landing.ts`'s; the form, the start's params and every refusal
 * branch are `workflow-start.ts` / `workflow-start-controller.ts`'s; this file
 * maps a view-model to elements.
 *
 * Three things are drawn deliberately:
 * - **square bands** (owner taste): full width, hairlines, no inset card;
 * - **a `run` step's command VERBATIM**, never cut to a line count: it is what an
 *   approval will ask about, and the ask's own detail is capped at 2000 chars;
 * - **every word with its glyph** (the owner is colour-blind: never meaning by hue
 *   alone) — "✓ Approved" / "? Needs approval", and Delete is red AND says Delete.
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
import {
  LANDING_OFFLINE,
  type LandingAct,
  type LandingItem,
  type LandingRuns,
  landingContext,
  landingItems,
} from "../workflow-landing.ts";
import type { ElencoRow } from "../workflow-list.ts";
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
  /** The live runs on top, and how many ended ones `Recent runs` leads to. */
  readonly runs: LandingRuns;
  /** `canStart()` — the controller's own gate; the screen never re-derives it. */
  readonly canStart: boolean;
  readonly onBack: () => void;
  readonly onPull: () => void;
  readonly onOpenRun: (row: ElencoRow) => void;
  readonly onRecent: () => void;
  /** A usable action of an item. */
  readonly onAct: (act: LandingAct, key: string) => void;
  /** A dimmed action: nothing is sent. */
  readonly onDimmed: () => void;
  readonly onCancelDelete: () => void;
  readonly onConfirmDelete: (key: string) => void;
  readonly onCloseRow: () => void;
  readonly onValue: (name: string, value: string) => void;
  /** The form's Start. */
  readonly onStart: () => void;
  /**
   * Open a file in the graph editor (`docs/feat/workflow-editor.md` D8): the
   * item's body. A broken one too — it opens as `broken` there and says why.
   */
  readonly onEdit: (name: string) => void;
  /** "New workflow" (D8): the graph editor in create mode. */
  readonly onNew: () => void;
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
    </View>
  );
}

/** A band of live runs: glyph and word on every row. */
function RunBand({
  palette,
  testID,
  title,
  rows,
  onOpen,
}: {
  readonly palette: Palette;
  readonly testID: string;
  readonly title: string;
  readonly rows: readonly ElencoRow[];
  readonly onOpen: (row: ElencoRow) => void;
}): JSX.Element | null {
  if (rows.length === 0) {
    return null;
  }
  return (
    <View testID={testID}>
      <Text style={[styles.bandTitle, { color: palette.sec }]}>{title}</Text>
      {rows.map((row) => (
        <Pressable
          key={row.key}
          testID={`workflow-run-${row.key}`}
          accessibilityRole="button"
          accessibilityLabel={`${row.name}, ${row.status.word}, ${row.position}`}
          onPress={() => onOpen(row)}
          style={[styles.band, { borderColor: palette.sep }]}
        >
          <View style={styles.rowHead}>
            <Text style={[styles.glyph, { color: palette.label }]}>{row.status.glyph}</Text>
            <Text style={[styles.name, { color: palette.label }]}>{row.name}</Text>
            <Text style={[typography.footnote, { color: palette.sec }]}>{row.when}</Text>
            <Icon name="chevron.right" color={palette.sec} size={14} />
          </View>
          <Text style={[typography.footnote, { color: palette.sec }]}>
            {`${row.status.word} · ${row.position}${row.title === null ? "" : ` · ${row.title}`}`}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

/** The inline delete question, in the action row's place (never a native alert). */
function Confirm({
  palette,
  item,
  onCancel,
  onConfirm,
}: {
  readonly palette: Palette;
  readonly item: LandingItem;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): JSX.Element {
  return (
    <View style={styles.confirm}>
      <Text
        testID={`workflow-delete-question-${item.name}`}
        style={[typography.subhead, { color: palette.label }]}
      >
        {item.confirm}
      </Text>
      <View style={styles.actions}>
        <Pressable
          testID={`workflow-delete-cancel-${item.name}`}
          accessibilityRole="button"
          hitSlop={8}
          onPress={onCancel}
          style={styles.action}
        >
          <Text style={[typography.subhead, { color: palette.label }]}>Cancel</Text>
        </Pressable>
        <Pressable
          testID={`workflow-delete-confirm-${item.name}`}
          accessibilityRole="button"
          hitSlop={8}
          onPress={onConfirm}
          style={styles.action}
        >
          <Icon name="trash" color={palette.red} size={15} />
          <Text style={[typography.subhead, { color: palette.red }]}>Delete</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** One workflow file: its body opens the editor; Start · Approve · Delete below. */
function Item({
  palette,
  item,
  screen,
}: {
  readonly palette: Palette;
  readonly item: LandingItem;
  readonly screen: WorkflowStartScreenProps;
}): JSX.Element {
  const word = item.status?.word ?? "approval unknown";
  return (
    <View style={[styles.band, { borderColor: palette.sep }]}>
      <Pressable
        testID={item.ok ? `workflow-start-row-${item.name}` : `workflow-start-broken-${item.name}`}
        accessibilityRole="button"
        accessibilityLabel={`${item.name}, ${word}`}
        accessibilityHint="Opens it in the editor"
        onPress={() => screen.onEdit(item.name)}
        style={styles.body}
      >
        <View style={styles.rowHead}>
          <Text style={[styles.name, { color: palette.label }]}>{item.name}</Text>
          {item.status === null ? null : (
            <Text style={[typography.footnote, { color: palette.sec }]}>
              {`${item.status.glyph} ${item.status.word}`}
            </Text>
          )}
          <Icon name="chevron.right" color={palette.sec} size={14} />
        </View>
        {item.description === null ? null : (
          <Text style={[typography.subhead, { color: palette.sec }]}>{item.description}</Text>
        )}
        {item.ok ? null : (
          <Text style={[typography.mono, { color: palette.sec }]}>{item.path}</Text>
        )}
      </Pressable>
      {item.errors.length === 0 ? null : (
        <View testID={`workflow-start-errors-${item.name}`} style={styles.errors}>
          {item.errors.map((error) => (
            <Text key={error} style={[typography.mono, { color: palette.label }]}>
              {error}
            </Text>
          ))}
        </View>
      )}
      {item.confirm !== null ? (
        <Confirm
          palette={palette}
          item={item}
          onCancel={screen.onCancelDelete}
          onConfirm={() => screen.onConfirmDelete(item.key)}
        />
      ) : (
        <View style={styles.actions}>
          {item.actions.map((action) => {
            const color = action.destructive ? palette.red : palette.label;
            return (
              <Pressable
                key={action.id}
                testID={`workflow-item-${action.id}-${item.name}`}
                accessibilityRole="button"
                accessibilityLabel={`${action.label} ${item.name}`}
                accessibilityState={{ disabled: !action.enabled }}
                hitSlop={8}
                // Not `disabled`: a dimmed tap still answers with a light haptic.
                onPress={() =>
                  action.enabled ? screen.onAct(action.id, item.key) : screen.onDimmed()
                }
                style={[styles.action, action.enabled ? null : styles.dimmed]}
              >
                <Icon name={action.icon} color={color} size={15} />
                <Text style={[typography.subhead, { color }]}>{action.label}</Text>
              </Pressable>
            );
          })}
        </View>
      )}
      {item.why === null ? null : (
        <Text
          testID={`workflow-item-why-${item.name}`}
          style={[typography.footnote, { color: palette.sec }]}
        >
          {item.why}
        </Text>
      )}
    </View>
  );
}

/** The landing: run bands, Recent runs, the workflow files, the folder. */
function Landing({ screen }: { readonly screen: WorkflowStartScreenProps }): JSX.Element {
  const { palette, state, runs } = screen;
  const view = state.catalogue;
  const items = landingItems(view, landingContext(state), state.confirm);
  return (
    <>
      <RunBand
        palette={palette}
        testID="workflow-landing-needs-you"
        title="Needs you"
        rows={runs.needYou}
        onOpen={screen.onOpenRun}
      />
      <RunBand
        palette={palette}
        testID="workflow-landing-live"
        title="In progress"
        rows={runs.inProgress}
        onOpen={screen.onOpenRun}
      />
      <Pressable
        testID="workflow-landing-recent"
        accessibilityRole="button"
        accessibilityLabel="Recent runs"
        onPress={screen.onRecent}
        style={[styles.band, styles.rowHead, { borderColor: palette.sep }]}
      >
        <Text style={[styles.name, { color: palette.label }]}>Recent runs</Text>
        {runs.recent === 0 ? null : (
          <Text style={[typography.footnote, { color: palette.sec }]}>{`${runs.recent}`}</Text>
        )}
        <Icon name="chevron.right" color={palette.sec} size={14} />
      </Pressable>
      {items.length === 0 ? null : (
        <View>
          <Text style={[styles.bandTitle, { color: palette.sec }]}>Workflows</Text>
          {items.map((item) => (
            <Item key={item.key} palette={palette} item={item} screen={screen} />
          ))}
        </View>
      )}
      {state.kind === "ready" && view?.kind === "empty" ? (
        <EmptyState
          testID="workflow-start-empty"
          palette={palette}
          title={`No workflows in ${view.dir ?? "the workflows folder"}`}
          icon="doc.text"
          action={
            <PillButton
              palette={palette}
              testID="workflow-landing-empty-new"
              label="New workflow"
              icon="plus"
              onPress={screen.onNew}
            />
          }
        />
      ) : null}
      <FolderLine palette={palette} state={state} />
    </>
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
          {state.offline
            ? LANDING_OFFLINE
            : entry.approval?.word === "Needs approval"
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
        title={entry === null ? "Workflows" : entry.name}
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
        right={
          entry === null && state.kind === "ready" ? (
            <Pressable
              testID="workflow-start-new"
              accessibilityRole="button"
              accessibilityLabel="New workflow"
              hitSlop={8}
              onPress={props.onNew}
            >
              <Icon name="plus" color={palette.label} size={18} />
            </Pressable>
          ) : undefined
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
        {entry === null ? (
          <Landing screen={props} />
        ) : (
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
  content: { paddingVertical: space.inset, gap: space.inset },
  folder: { gap: 4, paddingHorizontal: space.inset },
  sectionTitle: { ...typography.footnote, textTransform: "uppercase" },
  bandTitle: {
    ...typography.footnote,
    textTransform: "uppercase",
    paddingHorizontal: space.inset,
    paddingBottom: 6,
  },
  // A square band: full width, one hairline, no radius and no card fill.
  band: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.inset,
    paddingVertical: 12,
    gap: 6,
  },
  body: { gap: 4 },
  rowHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  glyph: { ...typography.body, width: 18, textAlign: "center" },
  name: { ...typography.body, flex: 1, fontWeight: "600" },
  actions: { flexDirection: "row", alignItems: "center", gap: 24, paddingTop: 4 },
  action: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 32 },
  dimmed: { opacity: 0.4 },
  confirm: { gap: 4 },
  errors: { gap: 2 },
  detail: { gap: 10, paddingHorizontal: space.inset },
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
