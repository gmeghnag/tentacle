/**
 * The pending messages, where they will land (docs/feat/mobile-queued-compose.md
 * D1/D2): the transcript's FOOTER, one right-aligned user-bubble shape per queued
 * row, dimmed, with a clock glyph and a footnote. A tap on one of MINE opens the
 * E1 inline menu (Edit · Send now · Cancel), whose items are `bubbleActions`' —
 * never re-decided here.
 *
 * DUMB renderer (AGENTS §7): the bubbles, their order, their phase and whether a
 * menu exists at all are `compose-queue.ts`'s (`pendingBubbles` / `bubbleActions`).
 * Which bubble's menu is OPEN is the one piece of state here, and it is
 * presentation: one at a time, a second tap closes it.
 *
 * `testID`s are the flows' contract (RN shows XCUITest no text, plan P9):
 * `pending-<id>-<mine|other>` on the bubble (tappable only when it has actions),
 * and `pending-<id>-edit|send-now|cancel` on the menu's items.
 */
import { type JSX, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import {
  type PendingBubble as Bubble,
  type BubbleAction,
  type BubbleContext,
  bubbleActions,
} from "../../compose-queue.ts";
import { DENSE_FONT_SCALE, type Palette, radius, space, typography } from "../../theme.ts";
import { Icon } from "../../ui/Icon.tsx";
import { Text } from "../../ui/Text.tsx";

/** What each menu item says, in the order `bubbleActions` returns them. */
const LABEL: Readonly<Record<BubbleAction, string>> = {
  edit: "Edit",
  "send-now": "Send now",
  cancel: "Cancel",
};

export interface PendingBubblesProps {
  readonly bubbles: readonly Bubble[];
  readonly palette: Palette;
  /** Whether a bubble can be acted on right now (link, turn, unqueue, send-now). */
  readonly ctx: BubbleContext;
  readonly onAction: (id: string, action: BubbleAction) => void;
}

/** The bubble's face: its words, its phase, and whose it is. */
function BubbleBody({
  bubble,
  palette,
}: {
  readonly bubble: Bubble;
  readonly palette: Palette;
}): JSX.Element {
  const sending = bubble.phase === "sending";
  return (
    <View style={[styles.bubble, { backgroundColor: palette.fill }]}>
      <Text style={[typography.body, { color: sending ? palette.sec : palette.label }]}>
        {bubble.text}
      </Text>
      <View style={styles.footnote}>
        <Icon name={sending ? "bolt.fill" : "clock"} color={palette.sec} size={12} />
        <Text
          maxFontSizeMultiplier={DENSE_FONT_SCALE}
          style={[typography.caption, { color: palette.sec }]}
        >
          {sending ? "Sending now · stopping the step" : "Pending · next step"}
          {bubble.mine ? "" : " · another device"}
        </Text>
      </View>
    </View>
  );
}

/** One pending message: its face, and — for mine, while it waits — the menu. */
function BubbleView({
  bubble,
  palette,
  ctx,
  open,
  onToggle,
  onAction,
}: {
  readonly bubble: Bubble;
  readonly palette: Palette;
  readonly ctx: BubbleContext;
  readonly open: boolean;
  onToggle: () => void;
  readonly onAction: (action: BubbleAction) => void;
}): JSX.Element {
  const actions = bubbleActions(bubble, ctx);
  const testID = `pending-${bubble.id}-${bubble.mine ? "mine" : "other"}`;
  const face = <BubbleBody bubble={bubble} palette={palette} />;
  return (
    <View style={[styles.row, { paddingHorizontal: space.inset }]}>
      {actions.length === 0 ? (
        // Another writer's words (or one already in flight): shown, never acted
        // on (owner Q3) — and still observable, which is what a flow asserts.
        <View testID={testID} style={styles.rowInner}>
          {face}
        </View>
      ) : (
        <Pressable
          testID={testID}
          accessibilityRole="button"
          accessibilityLabel={`${bubble.text} — pending, ${actions.length} actions`}
          onPress={onToggle}
          style={styles.rowInner}
        >
          {face}
        </Pressable>
      )}
      {!open || actions.length === 0 ? null : (
        <View style={styles.menu}>
          {actions.map((action) => (
            <Pressable
              key={action}
              testID={`pending-${bubble.id}-${action}`}
              accessibilityRole="button"
              accessibilityLabel={LABEL[action]}
              hitSlop={8}
              onPress={() => onAction(action)}
            >
              <Text
                style={[
                  typography.subheadStrong,
                  { color: action === "cancel" ? palette.red : palette.accent },
                ]}
              >
                {LABEL[action]}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

/**
 * The footer itself. Nothing at all when no message waits: a heading over an empty
 * list would promise a message that is not there.
 */
export function PendingBubbles({
  bubbles,
  palette,
  ctx,
  onAction,
}: PendingBubblesProps): JSX.Element | null {
  const [open, setOpen] = useState<string | null>(null);
  if (bubbles.length === 0) {
    return null;
  }
  return (
    <View testID="pending-bubbles" style={styles.stack}>
      {bubbles.map((bubble) => (
        <BubbleView
          key={bubble.id}
          bubble={bubble}
          palette={palette}
          ctx={ctx}
          open={open === bubble.id}
          onToggle={() => setOpen((current) => (current === bubble.id ? null : bubble.id))}
          onAction={(action) => {
            setOpen(null);
            onAction(bubble.id, action);
          }}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 6, paddingTop: 6 },
  row: { alignItems: "flex-end", gap: 4 },
  // The bubble keeps the user bubble's own width rule (the tap target is it) —
  // 77 % of what the row's inset leaves; the hub no longer reserves a column
  // (docs/feat/mobile-hub-center.md, owner 2: it floats).
  rowInner: { maxWidth: "77%", alignSelf: "flex-end" },
  bubble: {
    borderRadius: radius.bubble,
    paddingHorizontal: 14,
    paddingVertical: 9,
    gap: 4,
    // A pending message is not yet the conversation's: it reads a step dimmer.
    opacity: 0.72,
  },
  footnote: { flexDirection: "row", alignItems: "center", gap: 4 },
  menu: { flexDirection: "row", flexWrap: "wrap", gap: 18, paddingRight: 6, paddingBottom: 2 },
});
