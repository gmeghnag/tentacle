/**
 * Review (docs/feat/workflow-editor.md D8, slice 7c; mockup `reviewScreen`):
 * exactly what Save will write, from the daemon's `dryRun:true` answer — the
 * "Will be written" rows, each patch (the transcript's own `DiffView`, the
 * renderer the permission sheet's diffs use), the hash and version, the notes,
 * and the "Save N files" button. "nothing written yet" stays in the header until
 * the write is confirmed.
 *
 * A dumb renderer (AGENTS §7): every value is `workflow-edit-review.ts`'s
 * `reviewModel`; whether the button is on is the controller's `canConfirm`.
 */
import type { JSX } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { type Palette, space, typography } from "../theme.ts";
import { PillButton } from "../ui/PillButton.tsx";
import { ScreenHeader } from "../ui/ScreenHeader.tsx";
import { Text } from "../ui/Text.tsx";
import type { ReviewModel } from "../workflow-edit-review.ts";
import { DiffView } from "./transcript/DiffView.tsx";

export interface WorkflowEditReviewProps {
  readonly palette: Palette;
  readonly model: ReviewModel;
  /** `canConfirm()`: off while the write is in flight. */
  readonly canConfirm: boolean;
  /** The write is in flight (`saving`): the button shows it. */
  readonly saving: boolean;
  /** A refusal's sentence, if one came back while this screen is up. */
  readonly notice: string | null;
  /** `‹ Edit` — back to the draft, nothing sent (`cancelReview`). */
  readonly onBack: () => void;
  /** The confirm: the `dryRun:false` write (`confirmSave`). */
  readonly onConfirm: () => void;
}

export function WorkflowEditReview(props: WorkflowEditReviewProps): JSX.Element {
  const { palette, model } = props;
  return (
    <View testID="workflow-review" style={[styles.screen, { backgroundColor: palette.page }]}>
      <ScreenHeader
        palette={palette}
        variant="compact"
        title="Review"
        subtitle="nothing written yet"
        titleTestID="workflow-review-title"
        left={
          <Pressable
            testID="workflow-review-back"
            accessibilityRole="button"
            accessibilityLabel="Back to editing"
            hitSlop={8}
            onPress={props.onBack}
          >
            <Text style={[typography.body, { color: palette.accent }]}>‹ Edit</Text>
          </Pressable>
        }
      />
      <ScrollView testID="workflow-review-scroll" contentContainerStyle={styles.content}>
        <Text style={[styles.label, { color: palette.sec }]}>Will be written</Text>
        <View style={[styles.band, { backgroundColor: palette.card, borderColor: palette.sep }]}>
          {model.rows.map((row, index) => (
            <View key={row.path}>
              {index === 0 ? null : (
                <View style={[styles.hairline, { backgroundColor: palette.sep }]} />
              )}
              <View testID={`workflow-review-file-${index}`} style={styles.row}>
                <Text
                  numberOfLines={1}
                  ellipsizeMode="head"
                  style={[typography.footnote, styles.path, { color: palette.label }]}
                >
                  {row.path}
                </Text>
                <Text style={[typography.footnote, { color: palette.sec }]}>{row.value}</Text>
              </View>
            </View>
          ))}
        </View>
        {model.notes.map((note, index) => (
          <Text
            // biome-ignore lint/suspicious/noArrayIndexKey: notes are a fixed, ordered list
            key={`note-${index}`}
            testID={`workflow-review-note-${index}`}
            style={[typography.footnote, styles.note, { color: palette.label }]}
          >
            {`⚠ ${note}`}
          </Text>
        ))}
        <View style={styles.diffs}>
          {model.patches.map((patch, index) => (
            <DiffView
              key={patch.key}
              palette={palette}
              view={patch.view}
              callId={patch.key}
              initiallyOpen={index === 0}
            />
          ))}
        </View>
        <View style={[styles.band, { backgroundColor: palette.card, borderColor: palette.sep }]}>
          <View style={styles.row}>
            <Text style={[typography.body, { color: palette.label }]}>Hash</Text>
            <Text testID="workflow-review-hash" style={[typography.mono, { color: palette.sec }]}>
              {model.hash}
            </Text>
          </View>
          <View style={[styles.hairline, { backgroundColor: palette.sep }]} />
          <View style={styles.row}>
            <Text style={[typography.body, { color: palette.label }]}>Version</Text>
            <Text
              testID="workflow-review-version"
              style={[typography.body, { color: palette.sec }]}
            >
              {model.version}
            </Text>
          </View>
        </View>
        <Text style={[typography.footnote, styles.note, { color: palette.sec }]}>
          {model.hashFoot}
        </Text>
      </ScrollView>
      {props.notice === null ? null : (
        <Text
          testID="workflow-review-notice"
          style={[typography.footnote, styles.note, { color: palette.label }]}
        >
          {props.notice}
        </Text>
      )}
      <View style={[styles.foot, { borderTopColor: palette.sep }]}>
        <PillButton
          palette={palette}
          testID="workflow-review-confirm"
          kind="primary"
          label={model.button}
          disabled={!props.canConfirm}
          busy={props.saving}
          onPress={props.onConfirm}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { paddingBottom: 24 },
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
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingHorizontal: space.rowX,
    paddingVertical: 12,
  },
  path: { flexShrink: 1 },
  note: { paddingHorizontal: space.rowX, paddingTop: 8 },
  diffs: { gap: 8, padding: space.inset },
  foot: {
    paddingHorizontal: space.inset,
    paddingTop: 12,
    paddingBottom: 28,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
