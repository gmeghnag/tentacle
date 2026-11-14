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
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { ChipView, ComposeNotice } from "../../session-view.ts";
import type { Palette } from "../../theme.ts";

/** The pieces of the screen's view the bar draws (a subset of `session-view.ts`). */
export interface BarView {
  readonly queued: readonly {
    readonly id: string;
    readonly text: string;
    readonly state: "queued" | "sending";
    readonly mine: boolean;
  }[];
  readonly returnedOthers: readonly { readonly id: string; readonly text: string }[];
  readonly outbox: readonly {
    readonly itemId: string;
    readonly text: string;
    readonly state: string;
    readonly decide: boolean;
  }[];
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
  const colour =
    notice.kind === "returned"
      ? palette.accent
      : notice.kind === "not-saved"
        ? palette.danger
        : palette.secondaryLabel;
  return (
    <Text testID={notice.testId} style={[styles.notice, { color: colour }]}>
      {notice.text}
    </Text>
  );
}

/** The queue rows above the field: every writer's waiting row, mine marked. */
export function QueueRows({
  view,
  palette,
  onTake,
}: {
  readonly view: Pick<BarView, "queued" | "returnedOthers">;
  readonly palette: Palette;
  onTake: (id: string) => void;
}): JSX.Element | null {
  if (view.queued.length === 0 && view.returnedOthers.length === 0) {
    return null;
  }
  return (
    <View testID="composer-queue" style={styles.queue}>
      {view.queued.map((row) => (
        <Text
          key={row.id}
          testID={`queued-row-${row.id}-${row.mine ? "mine" : "other"}`}
          style={[styles.queueRow, { color: palette.secondaryLabel }]}
          numberOfLines={2}
        >
          {row.mine ? "↳ " : "↳ (from another device) "}
          {row.text}
        </Text>
      ))}
      {view.returnedOthers.map((row) => (
        <View key={row.id} style={styles.takeRow}>
          <Text
            testID={`returned-other-${row.id}`}
            style={[styles.queueRow, { color: palette.secondaryLabel }]}
            numberOfLines={2}
          >
            ↩ (returned to another device) {row.text}
          </Text>
          <Pressable
            testID={`take-${row.id}`}
            accessibilityRole="button"
            onPress={() => onTake(row.id)}
          >
            <Text style={[styles.take, { color: palette.accent }]}>Take</Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}

/** The photo chips: progress, or the refusal's reason (13c's decision). */
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
    <ScrollView horizontal testID="composer-chips" style={styles.chips}>
      {chips.map((chip, index) => (
        <Pressable
          key={chip.key}
          testID={`chip-${index}-${chip.state}`}
          accessibilityRole="button"
          onPress={() => onRemove(chip.key)}
          style={[styles.chip, { backgroundColor: palette.card }]}
        >
          <Text
            style={[
              styles.chipText,
              { color: chip.state === "refused" ? palette.danger : palette.label },
            ]}
          >
            {chip.state === "uploading" ? "⏳ " : chip.state === "ready" ? "🖼 " : "⚠ "}
            {chip.state === "refused" ? (chip.detail ?? "refused") : (chip.name ?? "photo")}
          </Text>
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
  return (
    <View testID="composer-outbox" style={styles.queue}>
      {rows.map((row) => (
        <Pressable
          key={row.itemId}
          testID={`outbox-row-${row.itemId}-${row.state}`}
          accessibilityRole="button"
          disabled={!row.decide}
          onPress={() => onDecide(row.itemId)}
          style={styles.takeRow}
        >
          <Text style={[styles.queueRow, { color: palette.secondaryLabel }]} numberOfLines={2}>
            {row.state === "waiting"
              ? "◷ waiting for the network — "
              : row.state === "sending"
                ? "↑ sending — "
                : row.state === "uploading"
                  ? "⏳ uploading — "
                  : "⚠ needs your answer — "}
            {row.text}
          </Text>
          {row.decide ? <Text style={[styles.take, { color: palette.accent }]}>Decide</Text> : null}
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  notice: { paddingHorizontal: 16, paddingBottom: 4, fontSize: 12 },
  queue: { paddingHorizontal: 12, paddingBottom: 4, gap: 2 },
  queueRow: { fontSize: 12 },
  takeRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  take: { fontSize: 12, fontWeight: "600" },
  chips: { paddingHorizontal: 12, paddingBottom: 4 },
  chip: { borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4, marginRight: 6 },
  chipText: { fontSize: 12 },
});
