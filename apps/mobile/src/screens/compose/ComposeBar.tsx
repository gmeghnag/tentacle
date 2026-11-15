/**
 * The compose bar's pieces (docs/feat/mobile-compose.md 13d): the queue rows, my
 * returned rows' banner, another device's returned rows with their Take, the
 * outbox's rows, the photo chips and the two secondary buttons (photo, Send now).
 *
 * DUMB renderers (AGENTS §7): every value comes from `session-view.ts`'s
 * view-model, every decision from `composer.ts` / `compose-state.ts` /
 * `compose-chips.ts`. Only colours, glyphs and spacing live here.
 *
 * `testID`s are the flows' contract (RN shows XCUITest no text, plan P9):
 * `composer-queue`, `composer-send-now`, `composer-send-later`, `composer-photo`,
 * `photo-library`, `photo-camera`, `chip-<i>-<state>`, `queued-row-<id>-<mine|other>`,
 * `returned-banner`, `returned-other-<id>`, `take-<id>`, `outbox-row-<itemId>-<state>`,
 * `outbox-decision`, `outbox-send|steer|discard|edit`, `composer-filled`.
 */
import type { JSX } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { outboxCaption, outboxRowLook } from "../../outbox-look.ts";
import type { ChipView, ComposeNotice, OutboxRowView } from "../../session-view.ts";
import { DENSE_FONT_SCALE, type Palette, radius, size, typography } from "../../theme.ts";
import { Icon } from "../../ui/Icon.tsx";

/** The pieces of the screen's view the bar draws (a subset of `session-view.ts`). */
export interface BarView {
  readonly queued: readonly {
    readonly id: string;
    readonly text: string;
    readonly state: "queued" | "sending";
    readonly mine: boolean;
  }[];
  readonly returnedOthers: readonly { readonly id: string; readonly text: string }[];
  readonly outbox: readonly OutboxRowView[];
  readonly chips: readonly ChipView[];
}

/** One notice above the input (`returned-banner` / `not-saved` / `waiting-network`). */
export function NoticeRow({
  notice,
  palette,
}: {
  readonly notice: ComposeNotice;
  readonly palette: Palette;
}): JSX.Element {
  const tone =
    notice.kind === "returned"
      ? { bg: palette.tint, fg: palette.accent, icon: "arrow.down" as const }
      : notice.kind === "not-saved"
        ? { bg: palette.warnBg, fg: palette.red, icon: "exclamationmark.triangle" as const }
        : { bg: palette.warnBg, fg: palette.warnText, icon: "wifi.slash" as const };
  return (
    <View style={[styles.notice, { backgroundColor: tone.bg }]}>
      <Icon name={tone.icon} color={tone.fg} size={14} />
      <Text testID={notice.testId} style={[typography.footnote, styles.flex, { color: tone.fg }]}>
        {notice.text}
      </Text>
    </View>
  );
}

/**
 * The queue (mockup `Compose`): a `fill` card "Queued · the agent reads these at
 * its next step", one row per waiting message (every writer's, mine marked),
 * another device's returned rows with their Take, and **Send now** as a 44 pt
 * `accentFill` pill when `sendNowOffered` says so. `composer-queue` stays on the
 * rows alone, so a flow that waits for it still waits for an actual queued row.
 */
export function QueueRows({
  view,
  palette,
  onTake,
  sendNow,
  onSendNow,
}: {
  readonly view: Pick<BarView, "queued" | "returnedOthers">;
  readonly palette: Palette;
  onTake: (id: string) => void;
  /** **Send now** offered (D1's secondary button, `sendNowOffered`). */
  readonly sendNow: boolean;
  onSendNow: () => void;
}): JSX.Element | null {
  const rows = view.queued.length + view.returnedOthers.length;
  if (rows === 0 && !sendNow) {
    return null;
  }
  return (
    <View style={[styles.card, { backgroundColor: palette.fill }]}>
      {rows === 0 ? null : (
        <View testID="composer-queue" style={styles.rows}>
          <Text
            maxFontSizeMultiplier={DENSE_FONT_SCALE}
            style={[typography.footnote, { color: palette.sec }]}
          >
            <Text style={{ fontWeight: "600", color: palette.label }}>Queued</Text>
            {" · the agent reads these at its next step"}
          </Text>
          {view.queued.map((row) => (
            <View
              key={row.id}
              testID={`queued-row-${row.id}-${row.mine ? "mine" : "other"}`}
              style={styles.queueRow}
            >
              <Icon name="clock" color={palette.sec} size={14} />
              <Text
                numberOfLines={2}
                style={[typography.subhead, styles.flex, { color: palette.label }]}
              >
                {row.text}
                {row.mine ? null : (
                  <Text style={{ color: palette.sec }}>{"  · another device"}</Text>
                )}
              </Text>
            </View>
          ))}
          {view.returnedOthers.map((row) => (
            <View key={row.id} style={styles.queueRow}>
              <Icon name="arrow.down" color={palette.sec} size={14} />
              <Text
                testID={`returned-other-${row.id}`}
                numberOfLines={2}
                style={[typography.subhead, styles.flex, { color: palette.sec }]}
              >
                {row.text}
                {"  · returned to another device"}
              </Text>
              <Pressable
                testID={`take-${row.id}`}
                accessibilityRole="button"
                accessibilityLabel={`Take “${row.text}” into your field`}
                hitSlop={10}
                onPress={() => onTake(row.id)}
              >
                <Text style={[typography.subheadStrong, { color: palette.accent }]}>Take</Text>
              </Pressable>
            </View>
          ))}
        </View>
      )}
      {sendNow ? (
        <Pressable
          testID="composer-send-now"
          accessibilityRole="button"
          accessibilityLabel="Send now: stop the current step and send these"
          onPress={onSendNow}
          style={({ pressed }) => [
            styles.sendNow,
            { backgroundColor: palette.accentFill },
            pressed ? { opacity: 0.7 } : undefined,
          ]}
        >
          <Icon name="bolt.fill" color={palette.onAccent} size={15} />
          <Text style={[typography.subheadStrong, { color: palette.onAccent }]}>Send now</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** The photo chips (14 pt capsules): progress, or the refusal's reason (13c's decision). */
export function Chips({
  chips,
  palette,
  onRemove,
}: {
  readonly chips: readonly ChipView[];
  readonly palette: Palette;
  onRemove: (key: string) => void;
}): JSX.Element | null {
  if (chips.length === 0) {
    return null;
  }
  return (
    <ScrollView
      horizontal
      testID="composer-chips"
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.chips}
    >
      {chips.map((chip, index) => (
        <Pressable
          key={chip.key}
          testID={`chip-${index}-${chip.state}`}
          accessibilityRole="button"
          accessibilityLabel={`Remove ${chip.name ?? "photo"}`}
          onPress={() => onRemove(chip.key)}
          style={[styles.chip, { backgroundColor: palette.fill }]}
        >
          {chip.state === "uploading" ? (
            <ActivityIndicator size="small" color={palette.accent} />
          ) : (
            <Icon
              name={chip.state === "ready" ? "photo" : "exclamationmark.triangle"}
              color={chip.state === "refused" ? palette.red : palette.accent}
              size={14}
            />
          )}
          <Text
            numberOfLines={1}
            style={[
              typography.footnote,
              styles.chipText,
              { color: chip.state === "refused" ? palette.red : palette.label },
            ]}
          >
            {chip.state === "refused" ? (chip.detail ?? "refused") : (chip.name ?? "photo")}
          </Text>
          <Icon name="xmark" color={palette.sec} size={11} />
        </Pressable>
      ))}
    </ScrollView>
  );
}

/** The outbox's rows: what the phone still holds, and where it is. */
export function OutboxRows({
  rows,
  palette,
  onDecide,
}: {
  readonly rows: BarView["outbox"];
  readonly palette: Palette;
  onDecide: (itemId: string) => void;
}): JSX.Element | null {
  if (rows.length === 0) {
    return null;
  }
  const caption = outboxCaption(rows);
  return (
    <View testID="composer-outbox" style={styles.outbox} accessibilityLabel="Waiting to send">
      {rows.map((row) => {
        const look = outboxRowLook(row);
        const border = look.cue === "attention" ? palette.orange : palette.dash;
        return (
          <View key={row.itemId} style={styles.outboxItem}>
            <View style={styles.outboxLine}>
              {look.options ? (
                <Pressable
                  testID={`outbox-options-${row.itemId}`}
                  accessibilityRole="button"
                  accessibilityLabel="Options for this waiting message"
                  onPress={() => onDecide(row.itemId)}
                  style={styles.outboxOptions}
                >
                  <Icon name="ellipsis" color={palette.sec} size={18} />
                </Pressable>
              ) : null}
              <Pressable
                testID={`outbox-row-${row.itemId}-${row.state}`}
                accessibilityRole="button"
                disabled={!row.decide}
                onPress={() => onDecide(row.itemId)}
                style={[styles.outboxBubble, { borderColor: border }]}
              >
                <Text style={[typography.bubble, { color: palette.label }]} numberOfLines={6}>
                  {row.text}
                </Text>
              </Pressable>
            </View>
            {look.status === null ? null : (
              <View style={styles.outboxStatus}>
                {look.cue === "spinner" ? (
                  <ActivityIndicator size="small" color={palette.sec} />
                ) : look.cue === "attention" ? (
                  <Icon name="exclamationmark.triangle" color={palette.orange} size={13} />
                ) : null}
                <Text
                  style={[
                    typography.footnote,
                    { color: look.cue === "attention" ? palette.orange : palette.sec },
                  ]}
                  maxFontSizeMultiplier={DENSE_FONT_SCALE}
                >
                  {look.status}
                </Text>
              </View>
            )}
          </View>
        );
      })}
      {caption === null ? null : (
        <View style={styles.outboxStatus}>
          <Icon name="wifi.slash" color={palette.sec} size={13} />
          <Text
            style={[typography.footnote, { color: palette.sec }]}
            maxFontSizeMultiplier={DENSE_FONT_SCALE}
          >
            {caption}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  notice: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 12,
    marginBottom: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.tile,
  },
  card: {
    marginHorizontal: 12,
    marginBottom: 6,
    padding: 12,
    gap: 10,
    borderRadius: radius.queue,
  },
  rows: { gap: 8 },
  queueRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  sendNow: {
    minHeight: size.touch,
    borderRadius: size.touch / 2,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  // `OutboxRows` (mockup `Offline`): right-aligned dashed bubbles, ≈ 77 % wide.
  outbox: { paddingHorizontal: 16, paddingBottom: 8, gap: 8, alignItems: "flex-end" },
  outboxItem: { alignItems: "flex-end", gap: 4, maxWidth: "85%" },
  outboxLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  outboxOptions: {
    width: size.touch,
    height: size.touch,
    alignItems: "center",
    justifyContent: "center",
  },
  outboxBubble: {
    flexShrink: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: radius.bubble,
    borderWidth: 1.5,
    borderStyle: "dashed",
  },
  outboxStatus: { flexDirection: "row", alignItems: "center", gap: 6, paddingRight: 4 },
  chips: { paddingHorizontal: 12, paddingBottom: 6, gap: 6 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 32,
    borderRadius: 16,
    paddingHorizontal: 10,
  },
  chipText: { maxWidth: 160 },
});
