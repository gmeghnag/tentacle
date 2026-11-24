/**
 * The editor's sheets (docs/feat/workflow-editor.md D8, slice 7b): the kind
 * picker, a step's sheet per kind, the goto picker, the `✗ ×n` counter and the
 * workflow Settings. A dumb renderer (AGENTS §7): which sheet is up, what each
 * field reads from the draft, what a control ends in and every refusal are
 * `workflow-edit-sheets.ts`'s. This file maps a `SheetModel` onto elements and
 * decides nothing — no wire call, no effect, no derivation.
 *
 * Drawn as a `Modal` overlay, not a stack route: the editor is itself a pushed
 * screen, and the sheets are quick actions over the graph (the mockup's
 * detents), so the graph must stay visibly underneath. That is also why the
 * detent is a fraction here and a style, not a `formSheet` route.
 *
 * Two things are drawn deliberately:
 * - **a control carries its own words** — the mockup's "− 2 +", "Local | Docker",
 *   "Stop | Go to step" — and the chosen option is ALSO bold, never fill alone
 *   (the owner is colour-blind).
 * - **a row whose sheet refuses it is DISABLED with the reason visible** (the
 *   step itself in the goto picker): a control that does nothing without saying
 *   why is the bug, not the fix.
 */
import type { JSX } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { type Palette, size as SIZE, radius, space, typography } from "../theme.ts";
import { Icon } from "../ui/Icon.tsx";
import { Text, TextInput } from "../ui/Text.tsx";
import {
  SHEET_DETENT,
  type SheetChoice,
  type SheetField,
  type SheetModel,
  type SheetRequest,
} from "../workflow-edit-sheets.ts";

/** What a screen hands a sheet: the model, and one callback per kind of control. */
export interface WorkflowEditSheetsProps {
  readonly palette: Palette;
  /** The sheet to draw; `null` = none is up (nothing is drawn). */
  readonly model: SheetModel | null;
  readonly onClose: () => void;
  /** `Done` (a sheet that has one) — the same close, named the mockup's way. */
  readonly onDone: () => void;
  /** A text field committed (`textAction` by the caller). */
  readonly onText: (key: string, value: string) => void;
  /** A stepper's − / + (`stepperAction`). */
  readonly onStep: (key: string, delta: number) => void;
  /** A segmented option (`segmentAction`). */
  readonly onSegment: (key: string, option: string) => void;
  /** An inline list's row (`choiceAction`). */
  readonly onChoice: (key: string, value: string) => void;
  /** A `pick` row: the picker it opens (`pickOpens`). */
  readonly onOpen: (request: SheetRequest) => void;
}

/** The mockup's detent as a height, so a short sheet is short on every device. */
function detentHeight(detent: SheetModel["detent"], windowHeight: number): number {
  return Math.round(windowHeight * SHEET_DETENT[detent]);
}

/** A stepper: the end that cannot move is DIM, never hidden (`retry 0..5`). */
function Stepper({
  palette,
  field,
  onStep,
}: {
  readonly palette: Palette;
  readonly field: Extract<SheetField, { control: "stepper" }>;
  readonly onStep: (delta: number) => void;
}): JSX.Element {
  const minusOff = field.value <= field.min;
  const plusOff = field.value >= field.max;
  return (
    <View testID={`workflow-sheet-stepper-${field.key}`} style={styles.stepper}>
      <Pressable
        testID={`workflow-sheet-minus-${field.key}`}
        accessibilityRole="button"
        accessibilityLabel={`${field.label}, one less`}
        accessibilityState={{ disabled: minusOff }}
        disabled={minusOff}
        hitSlop={8}
        onPress={() => onStep(-1)}
      >
        <Text style={[typography.title3, { color: minusOff ? palette.sep : palette.accent }]}>
          −
        </Text>
      </Pressable>
      <Text
        testID={`workflow-sheet-value-${field.key}`}
        style={[typography.body, styles.stepperValue, { color: palette.label }]}
      >
        {String(field.value)}
      </Text>
      <Pressable
        testID={`workflow-sheet-plus-${field.key}`}
        accessibilityRole="button"
        accessibilityLabel={`${field.label}, one more`}
        accessibilityState={{ disabled: plusOff }}
        disabled={plusOff}
        hitSlop={8}
        onPress={() => onStep(1)}
      >
        <Text style={[typography.title3, { color: plusOff ? palette.sep : palette.accent }]}>
          +
        </Text>
      </Pressable>
    </View>
  );
}

/** A 2–3 option switch: the chosen one is bold AND on its filled chip. */
function Segmented({
  palette,
  field,
  onSegment,
}: {
  readonly palette: Palette;
  readonly field: Extract<SheetField, { control: "segmented" }>;
  readonly onSegment: (option: string) => void;
}): JSX.Element {
  return (
    <View
      testID={`workflow-sheet-seg-${field.key}`}
      style={[styles.segmented, { backgroundColor: palette.fill }]}
    >
      {field.options.map((option) => (
        <Pressable
          key={option.label}
          testID={`workflow-sheet-seg-${field.key}-${option.label}`}
          accessibilityRole="button"
          accessibilityState={{ selected: option.on }}
          onPress={() => onSegment(option.label)}
          style={[styles.segment, option.on ? { backgroundColor: palette.card } : null]}
        >
          <Text
            style={[
              typography.footnote,
              { color: option.on ? palette.label : palette.sec },
              option.on ? styles.segmentOn : null,
            ]}
          >
            {option.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

/** One row of an inline list: a tick when it is the file's value, dim when it cannot be picked. */
function ChoiceRow({
  palette,
  choice,
  testID,
  onPress,
}: {
  readonly palette: Palette;
  readonly choice: SheetChoice;
  readonly testID: string;
  readonly onPress: () => void;
}): JSX.Element {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: choice.off, selected: choice.on }}
      disabled={choice.off}
      onPress={onPress}
      style={[styles.choiceRow, choice.off ? styles.dim : null]}
    >
      {choice.glyph === null ? null : (
        <Text style={[typography.footnote, styles.choiceGlyph, { color: palette.sec }]}>
          {choice.glyph}
        </Text>
      )}
      <View style={styles.choiceText}>
        <Text style={[typography.body, { color: palette.label }]}>{choice.label}</Text>
        {choice.sub === null ? null : (
          <Text style={[typography.caption, { color: palette.sec }]}>{choice.sub}</Text>
        )}
      </View>
      {choice.on ? <Icon name="checkmark" color={palette.accent} size={16} /> : null}
    </Pressable>
  );
}

/** One field: the label column, then the control its model names. */
function Field({
  palette,
  field,
  onText,
  onStep,
  onSegment,
  onChoice,
  onOpen,
}: {
  readonly palette: Palette;
  readonly field: SheetField;
  readonly onText: (key: string, value: string) => void;
  readonly onStep: (key: string, delta: number) => void;
  readonly onSegment: (key: string, option: string) => void;
  readonly onChoice: (key: string, value: string) => void;
  readonly onOpen: (request: SheetRequest) => void;
}): JSX.Element {
  const label = (
    <View style={styles.labelColumn}>
      <Text style={[typography.body, { color: palette.label }]}>{field.label}</Text>
      {"sub" in field && field.sub !== null ? (
        <Text style={[typography.caption, { color: palette.sec }]}>{field.sub}</Text>
      ) : null}
    </View>
  );
  if (field.control === "text") {
    return (
      <View
        testID={`workflow-sheet-field-${field.key}`}
        style={[styles.field, styles.fieldStacked]}
      >
        {label}
        <TextInput
          testID={`workflow-sheet-input-${field.key}`}
          accessibilityLabel={field.label}
          value={field.value}
          // Committed as typed: the controller is the ONE place a value is judged
          // (a timeout that is not a duration sends nothing), so no copy lives here.
          onChangeText={(next) => onText(field.key, next)}
          placeholder={field.placeholder ?? ""}
          placeholderTextColor={palette.sec}
          multiline={field.multiline}
          autoCapitalize="none"
          autoCorrect={false}
          style={[
            field.mono ? typography.mono : typography.body,
            styles.input,
            {
              backgroundColor: palette.card,
              borderColor: palette.sep,
              color: palette.label,
              minHeight: field.multiline ? 72 : SIZE.rowSetting,
            },
          ]}
        />
      </View>
    );
  }
  if (field.control === "choice") {
    return (
      <View testID={`workflow-sheet-field-${field.key}`} style={styles.fieldStacked}>
        {label}
        <View style={[styles.choiceList, { borderColor: palette.sep }]}>
          {field.options.map((choice) => (
            <ChoiceRow
              key={`${field.key}-${choice.value === "" ? "default" : choice.value}`}
              palette={palette}
              choice={choice}
              testID={`workflow-sheet-choice-${field.key}-${choice.value === "" ? "default" : choice.value}`}
              onPress={() => onChoice(field.key, choice.value)}
            />
          ))}
        </View>
      </View>
    );
  }
  return (
    <View testID={`workflow-sheet-field-${field.key}`} style={styles.field}>
      {label}
      {field.control === "stepper" ? (
        <Stepper palette={palette} field={field} onStep={(delta) => onStep(field.key, delta)} />
      ) : null}
      {field.control === "segmented" ? (
        <Segmented
          palette={palette}
          field={field}
          onSegment={(option) => onSegment(field.key, option)}
        />
      ) : null}
      {field.control === "value" ? (
        <Text style={[typography.body, styles.valueText, { color: palette.sec }]}>
          {field.value}
        </Text>
      ) : null}
      {field.control === "pick" ? (
        <Pressable
          testID={`workflow-sheet-pick-${field.key}`}
          accessibilityRole="button"
          accessibilityLabel={`${field.label}: ${field.value}`}
          onPress={() => {
            if (field.opens !== null) {
              onOpen(field.opens);
            }
          }}
          style={styles.pick}
        >
          <Text style={[typography.body, { color: palette.accent }]}>{field.value}</Text>
          <Icon name="chevron.right" color={palette.sep} size={14} weight="bold" />
        </Pressable>
      ) : null}
    </View>
  );
}

/** One band: the rows, then the footnote (a problem reads `bad`, not `sec`). */
function Section({
  palette,
  section,
  index,
  onText,
  onStep,
  onSegment,
  onChoice,
  onOpen,
}: {
  readonly palette: Palette;
  readonly section: SheetModel["sections"][number];
  readonly index: number;
  readonly onText: (key: string, value: string) => void;
  readonly onStep: (key: string, delta: number) => void;
  readonly onSegment: (key: string, option: string) => void;
  readonly onChoice: (key: string, value: string) => void;
  readonly onOpen: (request: SheetRequest) => void;
}): JSX.Element {
  return (
    <View style={styles.section}>
      {section.label === null ? null : (
        <Text style={[styles.sectionLabel, { color: palette.sec }]}>{section.label}</Text>
      )}
      <View
        testID={`workflow-sheet-section-${index}`}
        style={[
          styles.band,
          { backgroundColor: palette.bandOnSheet, borderColor: palette.sepSheet },
        ]}
      >
        {section.fields.map((field, at) => (
          <View key={field.key} style={at === 0 ? null : { borderTopColor: palette.sepSheet }}>
            <View
              style={at === 0 ? null : [styles.hairline, { backgroundColor: palette.sepSheet }]}
            />
            <Field
              palette={palette}
              field={field}
              onText={onText}
              onStep={onStep}
              onSegment={onSegment}
              onChoice={onChoice}
              onOpen={onOpen}
            />
          </View>
        ))}
      </View>
      {section.foot === null ? null : (
        <Text
          style={[
            typography.caption,
            styles.foot,
            { color: section.footBad ? palette.orange : palette.sec },
          ]}
        >
          {section.foot}
        </Text>
      )}
    </View>
  );
}

export function WorkflowEditSheets(props: WorkflowEditSheetsProps): JSX.Element {
  const { palette, model } = props;
  const window = useWindowDimensions();
  return (
    <Modal visible={model !== null} transparent animationType="fade" onRequestClose={props.onClose}>
      <View style={styles.root}>
        <Pressable
          accessibilityLabel="Dismiss"
          style={[StyleSheet.absoluteFill, { backgroundColor: palette.scrim }]}
          onPress={props.onClose}
        />
        {model === null ? null : (
          <View
            testID="workflow-sheet"
            style={[
              styles.sheet,
              {
                height: detentHeight(model.detent, window.height),
                backgroundColor: palette.bg,
              },
            ]}
          >
            <View style={[styles.head, { borderBottomColor: palette.sep }]}>
              <Pressable
                testID="workflow-sheet-cancel"
                accessibilityRole="button"
                hitSlop={8}
                onPress={props.onClose}
              >
                <Text style={[typography.body, { color: palette.accent }]}>{model.cancel}</Text>
              </Pressable>
              <Text
                testID="workflow-sheet-title"
                accessibilityRole="header"
                numberOfLines={1}
                style={[typography.headline, styles.headTitle, { color: palette.label }]}
              >
                {model.title}
              </Text>
              {model.done === null ? (
                // A slot, not a gap: the title stays centred on every sheet.
                <View style={styles.headSlot} />
              ) : (
                <Pressable
                  testID="workflow-sheet-done"
                  accessibilityRole="button"
                  hitSlop={8}
                  onPress={props.onDone}
                >
                  <Text style={[typography.body, styles.strong, { color: palette.accent }]}>
                    {model.done}
                  </Text>
                </Pressable>
              )}
            </View>
            {model.note === null ? null : (
              <Text
                testID="workflow-sheet-note"
                style={[typography.footnote, styles.note, { color: palette.orange }]}
              >
                {model.note}
              </Text>
            )}
            <ScrollView
              testID="workflow-sheet-scroll"
              contentContainerStyle={styles.content}
              keyboardShouldPersistTaps="handled"
            >
              {model.sections.map((section, index) => (
                <Section
                  // biome-ignore lint/suspicious/noArrayIndexKey: sections are a fixed, ordered set of bands
                  key={`section-${index}`}
                  palette={palette}
                  section={section}
                  index={index}
                  onText={props.onText}
                  onStep={props.onStep}
                  onSegment={props.onSegment}
                  onChoice={props.onChoice}
                  onOpen={props.onOpen}
                />
              ))}
            </ScrollView>
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "flex-end" },
  sheet: {
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    overflow: "hidden",
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: SIZE.headerList,
    paddingHorizontal: space.inset,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  headTitle: { flex: 1, textAlign: "center" },
  headSlot: { minWidth: 48 },
  strong: { fontWeight: "600" },
  note: { paddingHorizontal: space.inset, paddingTop: 10 },
  content: { paddingBottom: 32 },
  section: { marginTop: space.sectionTop },
  sectionLabel: {
    ...typography.caption,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "600",
    letterSpacing: 0.24,
    textTransform: "uppercase",
    paddingHorizontal: space.rowX,
    paddingBottom: 6,
  },
  band: { borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth },
  hairline: { height: StyleSheet.hairlineWidth, marginLeft: space.rowX },
  field: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: space.rowX,
    paddingVertical: 12,
    minHeight: SIZE.rowSetting,
  },
  fieldStacked: { flexDirection: "column", alignItems: "stretch", gap: 8 },
  labelColumn: { flexShrink: 1, gap: 2 },
  input: { borderRadius: radius.tile, borderWidth: StyleSheet.hairlineWidth, padding: 10 },
  stepper: { flexDirection: "row", alignItems: "center", gap: 14, marginLeft: "auto" },
  stepperValue: { minWidth: 22, textAlign: "center" },
  segmented: { flexDirection: "row", borderRadius: radius.tile, padding: 2, marginLeft: "auto" },
  segment: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.tile - 2 },
  segmentOn: { fontWeight: "600" },
  valueText: { flex: 1, textAlign: "right" },
  pick: { flexDirection: "row", alignItems: "center", gap: 6, marginLeft: "auto" },
  choiceList: {
    borderRadius: radius.tile,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  choiceRow: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, minHeight: 48 },
  choiceGlyph: { width: 20, textAlign: "center" },
  choiceText: { flex: 1, gap: 2 },
  foot: { paddingHorizontal: space.rowX, paddingTop: 8 },
  dim: { opacity: 0.4 },
});
