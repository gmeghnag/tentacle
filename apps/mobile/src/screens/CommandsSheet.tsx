/**
 * Commands — the sheet the hub's Commands item opens (docs/feat/mobile-hub-commands.md
 * C3 item 16). RENDER ONLY (AGENTS §7): whether a command can run NOW, why not,
 * its one-line explanation and its live state all come from
 * `session-commands.ts`'s `commandRows` view-model; this file decides nothing but
 * placement.
 *
 * The grammar is Session info's / Tools' (docs/feat/mobile-chrome.md Design 4):
 * the E2 band of 44 pt `Row`s, everything `onSheet`. Since
 * docs/feat/mobile-native-sheets.md the PRESENTATION is the stack's (`Sheet`
 * route, a native `formSheet`), so there is no `Modal` here and no `visible`
 * prop: this file is drawn only while it is on screen.
 *  - the state is the row's TRAILING edge, never a second line of the title: the
 *    spinner + `Stop` while this phone's compaction runs, `Compacted ✓`, the
 *    notice grammar's `▲` + `Retry` on a failure, the reason on a dimmed row, the
 *    switch on Auto-accept;
 *  - Clear's armed confirm is IN the row (the question replaces the row, `Cancel` /
 *    `Clear` at its edge): one sheet, never a second one, and the destructive word
 *    is written beside the red, never the hue alone;
 *  - the sheet STAYS OPEN while Compact runs — the row is its live state; once it
 *    closes the footer slot is the only state (C2 item 10).
 */
import type { JSX } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Switch, View } from "react-native";
import { CLEARING, COMPACTING, type CommandRow, commandEdge } from "../session-commands.ts";
import { DENSE_FONT_SCALE, type Palette, space, typography } from "../theme.ts";
import { BandSection } from "../ui/BandSection.tsx";
import { Row } from "../ui/Row.tsx";
import { Sheet } from "../ui/Sheet.tsx";
import { Text } from "../ui/Text.tsx";

export interface CommandsSheetProps {
  readonly palette: Palette;
  /** `session-commands.ts`'s view-model (`state.commands`): the sheet draws these. */
  readonly rows: readonly CommandRow[];
  readonly onCompact: () => void;
  /** The running Compact row's `Stop` (the hub's Stop is the same path). */
  readonly onStopCompact: () => void;
  /** Clear's row tapped: it opens into the inline question. */
  readonly onArmClear: () => void;
  readonly onCancelClear: () => void;
  readonly onClear: () => void;
  /**
   * Rename. The screen closes this sheet and opens the title field — the header
   * title's own path (Owner decision 5), not a second rename surface.
   */
  readonly onRename: () => void;
  /** Retry last prompt: through the composer's own send path (C2). */
  readonly onRetry: () => void;
  readonly onAutoAccept: (on: boolean) => void;
  readonly onClose: () => void;
}

/** The question a Clear row opens into (the row's own explanation stays under it). */
export const CLEAR_QUESTION = "Clear this chat?";

/** A word-button at a row's trailing edge (`Stop`, `Retry`, `Cancel`, `Clear`). */
function Action({
  testID,
  label,
  color,
  onPress,
}: {
  readonly testID: string;
  readonly label: string;
  readonly color: string;
  readonly onPress: () => void;
}): JSX.Element {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={8}
      style={styles.action}
    >
      <Text maxFontSizeMultiplier={DENSE_FONT_SCALE} style={[typography.subhead, { color }]}>
        {label}
      </Text>
    </Pressable>
  );
}

/** The notice grammar's `▲` and its words beside it (a shape alone is not spoken). */
function Glyph({
  testID,
  glyph,
  text,
  color,
}: {
  readonly testID: string;
  readonly glyph: string;
  readonly text: string;
  readonly color: string;
}): JSX.Element {
  return (
    <View style={styles.edge} testID={testID}>
      {/* The SHAPE is the signal, the word is beside it: never the glyph alone. */}
      <Text
        maxFontSizeMultiplier={DENSE_FONT_SCALE}
        style={[typography.footnote, { color }]}
        accessibilityElementsHidden
      >
        {glyph}
      </Text>
      <Text maxFontSizeMultiplier={DENSE_FONT_SCALE} style={[typography.footnote, { color }]}>
        {text}
      </Text>
    </View>
  );
}

/**
 * `Compacted ✓` — the view-model's own words (`session-commands.ts`
 * `COMPACTED_DONE`), which already carry the check, so no second glyph is
 * drawn. The `ctx A → B` figures the plan names are the transcript separator's
 * (`compactionSeparatorText`, `transcript-history.ts`); `CommandRow` carries no
 * figures, so the row shows the footer's own wording (see Execution's drift).
 */
function Done({
  testID,
  text,
  color,
}: {
  readonly testID: string;
  readonly text: string;
  readonly color: string;
}): JSX.Element {
  return (
    <Text
      testID={testID}
      maxFontSizeMultiplier={DENSE_FONT_SCALE}
      style={[typography.footnote, { color }]}
    >
      {text}
    </Text>
  );
}

/** What the row's own tap does, by id — or undefined when only its edge acts. */
function tapFor(id: CommandRow["id"], props: CommandsSheetProps): (() => void) | undefined {
  switch (id) {
    case "compact":
      return props.onCompact;
    case "clear":
      return props.onArmClear;
    case "rename":
      return props.onRename;
    case "retry":
      return props.onRetry;
    case "autoAccept":
      return undefined;
  }
}

/** The trailing edge for a state that is not Clear's inline confirm. */
function edgeFor(row: CommandRow, props: CommandsSheetProps): JSX.Element | null {
  const { palette } = props;
  const state = row.state;
  switch (state.kind) {
    case "ready":
      return null;
    case "dimmed":
      return (
        <Text
          maxFontSizeMultiplier={DENSE_FONT_SCALE}
          style={[typography.footnote, styles.reason, { color: palette.sec }]}
        >
          {state.reason}
        </Text>
      );
    case "running":
      return (
        <View style={styles.edge} testID={`command-${row.id}-running`}>
          <ActivityIndicator size="small" color={palette.sec} />
          <Text
            maxFontSizeMultiplier={DENSE_FONT_SCALE}
            style={[typography.footnote, { color: palette.sec }]}
          >
            {row.id === "compact" ? COMPACTING : CLEARING}
          </Text>
          {row.id === "compact" ? (
            <Action
              testID="command-compact-stop"
              label="Stop"
              color={palette.accent}
              onPress={props.onStopCompact}
            />
          ) : null}
        </View>
      );
    case "done":
      return <Done testID={`command-${row.id}-done`} text={state.text} color={palette.green} />;
    case "failed":
      return (
        <View style={styles.edge}>
          <Glyph
            testID={`command-${row.id}-failed`}
            glyph="▲"
            text={state.text}
            color={palette.orange}
          />
          <Action
            testID={`command-${row.id}-retry`}
            label="Retry"
            color={palette.accent}
            // Only Compact can reach `failed` (`commandRows`: `clearState` has no
            // failed kind), so Retry re-runs a compaction — never a second rule.
            onPress={props.onCompact}
          />
        </View>
      );
    case "confirming":
      return null;
    case "toggle":
      return (
        <Switch
          testID={`command-${row.id}-switch`}
          accessibilityLabel={row.label}
          value={state.on}
          onValueChange={props.onAutoAccept}
        />
      );
  }
}

/** One row: the label, its explanation, and the state at the edge. */
function Command({
  row,
  first,
  props,
}: {
  readonly row: CommandRow;
  readonly first: boolean;
  readonly props: CommandsSheetProps;
}): JSX.Element {
  const { palette } = props;
  const state = row.state;
  if (state.kind === "confirming") {
    // The row OPENS in place into the question: Cancel / Clear at its edge, the
    // destructive word written beside the red (never the hue alone).
    return (
      <Row
        palette={palette}
        title={CLEAR_QUESTION}
        subtitle={row.explain}
        onSheet
        minHeight={44}
        first={first}
        testID={`command-${row.id}`}
        trailing={
          <View style={styles.edge}>
            <Action
              testID="command-clear-cancel"
              label="Cancel"
              color={palette.accent}
              onPress={props.onCancelClear}
            />
            <Action
              testID="command-clear-confirm"
              label="Clear"
              color={palette.red}
              onPress={props.onClear}
            />
          </View>
        }
        trailingKind={commandEdge(state, row.id)}
      />
    );
  }
  const tap = state.kind === "ready" ? tapFor(row.id, props) : undefined;
  return (
    <Row
      palette={palette}
      title={row.label}
      subtitle={row.explain}
      onSheet
      minHeight={44}
      first={first}
      dimmed={state.kind === "dimmed"}
      testID={`command-${row.id}`}
      {...(tap === undefined ? {} : { onPress: tap })}
      trailing={edgeFor(row, props)}
      trailingKind={commandEdge(row.state, row.id)}
    />
  );
}

export function CommandsSheet(props: CommandsSheetProps): JSX.Element {
  const { palette, rows, onClose } = props;
  return (
    <View style={[styles.root, { backgroundColor: palette.bg }]}>
      <Sheet
        palette={palette}
        title="Commands"
        subtitle="What this session can do"
        testID="commands-sheet"
        onClose={onClose}
      >
        <BandSection palette={palette} onSheet testID="commands-bands">
          {rows.map((row, index) => (
            <Command key={row.id} row={row} first={index === 0} props={props} />
          ))}
        </BandSection>
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  // The edge never pushes the label out: `Row` caps the label at 70% and this
  // lets the words wrap inside the rest.
  edge: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 },
  action: { paddingVertical: 4, paddingHorizontal: 2 },
  // The reason never squeezes the label out: it keeps the row's right quarter.
  reason: { flexShrink: 1, maxWidth: space.inset * 8, textAlign: "right" },
});
