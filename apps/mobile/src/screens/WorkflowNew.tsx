/**
 * The New-workflow sheet (docs/feat/workflow-editor.md D8, slice 7c; mockup
 * `newSheet`): name, description, where to start from, the template's inputs.
 * A dumb renderer (AGENTS §7): every value — the live name check, the template
 * rows, the inputs, whether Create is on — is `workflow-edit-review.ts`'s
 * `newSheetModel`; the fields' text lives in the route. "Describe it to the
 * model" is NOT here (owner Q2: a follow-up).
 *
 * A `Modal` overlay like the editor's other sheets (`WorkflowEditSheets.tsx`): the
 * editor is a pushed route, and the sheet opens over it before there is a draft.
 */
import type { JSX } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { type Palette, size as SIZE, radius, space, typography } from "../theme.ts";
import { Text, TextInput } from "../ui/Text.tsx";
import type { NewSheetInput, NewSheetModel } from "../workflow-edit-review.ts";

export interface WorkflowNewProps {
  readonly palette: Palette;
  /** `null` = the sheet is down. */
  readonly model: NewSheetModel | null;
  readonly input: NewSheetInput;
  readonly onName: (name: string) => void;
  readonly onDescription: (description: string) => void;
  readonly onTemplate: (id: string) => void;
  readonly onCancel: () => void;
  readonly onCreate: () => void;
}

/** The mockup's `large` detent. */
const DETENT = 0.92;

export function WorkflowNew(props: WorkflowNewProps): JSX.Element {
  const { palette, model, input } = props;
  const window = useWindowDimensions();
  return (
    <Modal
      visible={model !== null}
      transparent
      animationType="fade"
      onRequestClose={props.onCancel}
    >
      <View style={styles.root}>
        <View style={[StyleSheet.absoluteFill, { backgroundColor: palette.scrim }]} />
        {model === null ? null : (
          <View
            testID="workflow-new"
            style={[
              styles.sheet,
              { height: Math.round(window.height * DETENT), backgroundColor: palette.bg },
            ]}
          >
            <View style={[styles.head, { borderBottomColor: palette.sep }]}>
              <Pressable
                testID="workflow-new-cancel"
                accessibilityRole="button"
                hitSlop={8}
                onPress={props.onCancel}
              >
                <Text style={[typography.body, { color: palette.accent }]}>Cancel</Text>
              </Pressable>
              <Text
                accessibilityRole="header"
                numberOfLines={1}
                style={[typography.headline, styles.headTitle, { color: palette.label }]}
              >
                New workflow
              </Text>
              <Pressable
                testID="workflow-new-create"
                accessibilityRole="button"
                accessibilityState={{ disabled: !model.canCreate }}
                disabled={!model.canCreate}
                hitSlop={8}
                onPress={props.onCreate}
              >
                <Text
                  style={[
                    typography.body,
                    styles.strong,
                    { color: model.canCreate ? palette.accent : palette.sec },
                  ]}
                >
                  Create
                </Text>
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
              <View
                style={[styles.band, { backgroundColor: palette.card, borderColor: palette.sep }]}
              >
                <View style={[styles.field, styles.stacked]}>
                  <Text style={[typography.subhead, { color: palette.label }]}>Name</Text>
                  <TextInput
                    testID="workflow-new-name"
                    accessibilityLabel="Name"
                    value={input.name}
                    onChangeText={props.onName}
                    placeholder="task"
                    placeholderTextColor={palette.sec}
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoFocus
                    style={[
                      typography.mono,
                      styles.input,
                      { borderColor: palette.sep, color: palette.label },
                    ]}
                  />
                </View>
                <View style={[styles.hairline, { backgroundColor: palette.sep }]} />
                <View style={[styles.field, styles.stacked]}>
                  <Text style={[typography.subhead, { color: palette.label }]}>Description</Text>
                  <TextInput
                    testID="workflow-new-description"
                    accessibilityLabel="Description"
                    value={input.description}
                    onChangeText={props.onDescription}
                    placeholderTextColor={palette.sec}
                    autoCorrect={false}
                    style={[
                      typography.body,
                      styles.input,
                      { borderColor: palette.sep, color: palette.label },
                    ]}
                  />
                </View>
              </View>
              {/* The live check, in words (never by colour alone), and never a modal. */}
              <Text
                testID={
                  model.nameProblem === null ? "workflow-new-saved-as" : "workflow-new-name-problem"
                }
                style={[
                  typography.footnote,
                  styles.foot,
                  { color: model.nameProblem === null ? palette.sec : palette.orange },
                ]}
              >
                {model.nameProblem ?? model.savedAs}
              </Text>
              <Text style={[styles.label, { color: palette.sec }]}>Start from</Text>
              <View
                style={[styles.band, { backgroundColor: palette.card, borderColor: palette.sep }]}
              >
                {model.templates.map((template, index) => (
                  <View key={template.id}>
                    {index === 0 ? null : (
                      <View style={[styles.hairline, { backgroundColor: palette.sep }]} />
                    )}
                    <Pressable
                      testID={`workflow-new-template-${template.id}`}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: template.on }}
                      onPress={() => props.onTemplate(template.id)}
                      style={styles.field}
                    >
                      <View style={styles.labels}>
                        <Text style={[typography.body, { color: palette.label }]}>
                          {template.label}
                        </Text>
                        <Text style={[typography.footnote, { color: palette.sec }]}>
                          {template.sub}
                        </Text>
                      </View>
                      <Text style={[typography.body, { color: palette.accent }]}>
                        {template.on ? "◉" : "○"}
                      </Text>
                    </Pressable>
                  </View>
                ))}
              </View>
              {model.inputs.length === 0 ? null : (
                <>
                  <Text style={[styles.label, { color: palette.sec }]}>Inputs</Text>
                  <View
                    style={[
                      styles.band,
                      { backgroundColor: palette.card, borderColor: palette.sep },
                    ]}
                  >
                    {model.inputs.map((entry, index) => (
                      <View key={entry.name}>
                        {index === 0 ? null : (
                          <View style={[styles.hairline, { backgroundColor: palette.sep }]} />
                        )}
                        <View testID={`workflow-new-input-${entry.name}`} style={styles.field}>
                          <Text style={[typography.mono, { color: palette.label }]}>
                            {entry.name}
                          </Text>
                          <Text style={[typography.footnote, styles.right, { color: palette.sec }]}>
                            {entry.sub}
                          </Text>
                        </View>
                      </View>
                    ))}
                  </View>
                  <Text style={[typography.footnote, styles.foot, { color: palette.sec }]}>
                    Asked when you run it. From the template; edit later in Settings.
                  </Text>
                </>
              )}
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
  strong: { fontWeight: "600" },
  content: { paddingTop: space.sectionTop, paddingBottom: 32 },
  label: {
    ...typography.caption,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "600",
    letterSpacing: 0.24,
    textTransform: "uppercase",
    paddingHorizontal: space.rowX,
    paddingTop: space.sectionTop,
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
  stacked: { flexDirection: "column", alignItems: "stretch", gap: 8 },
  labels: { flex: 1, gap: 2 },
  right: { marginLeft: "auto" },
  input: { borderRadius: radius.tile, borderWidth: StyleSheet.hairlineWidth, padding: 10 },
  foot: { paddingHorizontal: space.rowX, paddingTop: 8 },
});
