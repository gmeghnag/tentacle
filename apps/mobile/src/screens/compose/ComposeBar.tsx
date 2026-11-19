/**
 * The compose bar's pieces (docs/feat/mobile-compose.md 13d): the notices, another
 * device's returned rows with their Take, the outbox's rows and the photo chips.
 * The pending messages moved into the TRANSCRIPT (`PendingBubble.tsx`) and Send now
 * into the composer's own field (`ui/Composer.tsx`) — docs/feat/mobile-queued-compose.md
 * D1/D4, owner Q3.
 *
 * DUMB renderers (AGENTS §7): every value comes from `session-view.ts`'s
 * view-model, every decision from `composer.ts` / `compose-state.ts` /
 * `compose-chips.ts`. Only colours, glyphs and spacing live here.
 *
 * `testID`s are the flows' contract (RN shows XCUITest no text, plan P9):
 * `composer-queue`, `returned-banner`, `returned-other-<id>`, `take-<id>`,
 * `photo-library`, `photo-camera`, `chip-<i>-<state>`,
 * `outbox-row-<itemId>-<state>`, `outbox-decision`,
 * `outbox-send|steer|discard|edit`. The composer's own ids are `ui/Composer.tsx`'s,
 * and the pending bubbles' are `PendingBubble.tsx`'s.
 */
import type { JSX } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { photoBlock, photoTileStyle } from "../../media-layout.ts";
import { outboxCaption, outboxRowLook } from "../../outbox-look.ts";
import type { ChipView, ComposeNotice, OutboxRowView } from "../../session-view.ts";
import { DENSE_FONT_SCALE, type Palette, radius, size, typography } from "../../theme.ts";
import { Icon } from "../../ui/Icon.tsx";
import { RingArc } from "../../ui/RingArc.tsx";

/** A tile as the style it is drawn in: pinned to the place `photoBlock` decided. */
function boxStyle(tile: ReturnType<typeof photoBlock>["tiles"][number]) {
  return photoTileStyle(tile);
}

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
 * Another device's RETURNED rows with their Take (docs/feat/mobile-queued-compose.md
 * D4, owner Q3). Mine are given back to MY field by themselves, and a pending
 * message now lives in the transcript as a bubble (`PendingBubble.tsx`) — so what
 * is left here is the one thing that needs an explicit act: someone else's words,
 * waiting for a Take. `composer-queue` stays on the card, so a flow that waits for
 * it still waits for an actual row.
 */
export function QueueRows({
  view,
  palette,
  onTake,
}: {
  readonly view: Pick<BarView, "returnedOthers">;
  readonly palette: Palette;
  onTake: (id: string) => void;
}): JSX.Element | null {
  if (view.returnedOthers.length === 0) {
    return null;
  }
  return (
    <View style={[styles.card, { backgroundColor: palette.fill }]}>
      <View testID="composer-queue" style={styles.rows}>
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
    </View>
  );
}

/** The attachment chips (14 pt capsules): progress, or the refusal's reason (13c's decision). */
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
      style={styles.chipRow}
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.chips}
    >
      {chips.map((chip, index) => (
        <Pressable
          key={chip.key}
          testID={`chip-${index}-${chip.state}`}
          accessibilityRole="button"
          accessibilityLabel={`Remove ${chip.name ?? (chip.kind === "document" ? "file" : "photo")}`}
          onPress={() => onRemove(chip.key)}
          style={[styles.chip, { backgroundColor: palette.fill }]}
        >
          {chip.state === "uploading" ? (
            <ActivityIndicator size="small" color={palette.accent} />
          ) : (
            <Icon
              // The KIND's glyph, never a guess from the name: a PDF the person
              // picked from Files is a document chip even before it is named
              // (docs/feat/pdf-read.md D7).
              name={
                chip.state === "refused"
                  ? "exclamationmark.triangle"
                  : chip.kind === "document"
                    ? "doc.on.doc"
                    : "photo"
              }
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
            {chip.state === "refused"
              ? (chip.detail ?? "refused")
              : (chip.name ?? (chip.kind === "document" ? "file" : "photo"))}
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
  onRetry,
}: {
  readonly rows: BarView["outbox"];
  readonly palette: Palette;
  onDecide: (itemId: string) => void;
  /** The "Retry" under a row whose photo upload did not land (S4). */
  onRetry: (itemId: string) => void;
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
        const uploading = row.state === "uploading";
        // The block is `photoBlock`'s (S4): the outbox row draws the SAME layout
        // the sent row does, so a photo does not move when it goes out. An item's
        // photo carries no measured ratio (it is a file the picker wrote), so
        // every tile is the documented square fallback.
        const block = photoBlock(row.photos);
        return (
          <View key={row.itemId} style={styles.outboxItem}>
            {block.tiles.length === 0 ? null : (
              <View
                testID={`outbox-photos-${row.itemId}`}
                style={[styles.outboxPhotos, { width: block.width, height: block.height }]}
              >
                {block.tiles.map((tile) => (
                  <View
                    key={tile.ref.file}
                    style={[styles.outboxTile, boxStyle(tile)]}
                    // A veil per tile, all showing the ONE item-wide progress:
                    // the driver reports the item's current upload, not a tile's.
                    pointerEvents="none"
                  >
                    <Image
                      source={{ uri: tile.ref.file }}
                      style={styles.outboxTileFill}
                      resizeMode="cover"
                      accessibilityIgnoresInvertColors
                    />
                    {!uploading ? null : (
                      <View style={styles.outboxVeil}>
                        {look.percent === null ? (
                          <ActivityIndicator size="small" color={palette.label} />
                        ) : (
                          <RingArc
                            diameter={28}
                            stroke={3}
                            fraction={look.percent / 100}
                            tone={palette.onAccent}
                            track="rgba(255,255,255,0.35)"
                          />
                        )}
                      </View>
                    )}
                  </View>
                ))}
              </View>
            )}
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
                {!look.retry ? null : (
                  // The SAME act the decision sheet's Send performs (S4): one
                  // path, so a retried photo message cannot go twice.
                  <Pressable
                    testID={`outbox-retry-${row.itemId}`}
                    accessibilityRole="button"
                    accessibilityLabel="Send this message again"
                    hitSlop={8}
                    onPress={() => onRetry(row.itemId)}
                  >
                    <Text
                      style={[typography.footnote, { color: palette.accent }]}
                      maxFontSizeMultiplier={DENSE_FONT_SCALE}
                    >
                      Retry
                    </Text>
                  </Pressable>
                )}
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
  // The outbox row's photo block (S4): `photoBlock`'s geometry, right-aligned above
  // the dashed bubble — the sent row's own shape, each tile pinned to its own
  // `x`/`y` (Review round 5, finding 1: a wrapping row cannot draw 3 photos).
  outboxPhotos: { alignSelf: "flex-end" },
  outboxTile: { borderRadius: 16, overflow: "hidden", backgroundColor: "#000000" },
  outboxTileFill: { width: "100%", height: "100%" },
  // The uploading veil (mockup F): the photo dimmed under one ring, never a
  // second animation loop.
  outboxVeil: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  // A ScrollView's base style GROWS (`flexGrow: 1`): in the screen's column the
  // chip row took half the transcript's height (slice 6, flow 18). It is as
  // tall as its chips.
  chipRow: { flexGrow: 0 },
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
