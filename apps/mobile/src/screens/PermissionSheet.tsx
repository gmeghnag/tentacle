/**
 * The permission sheet (docs/fix/mobile-ask-surfaces.md): drawn from
 * `permission-sheet.ts`'s state inside the native `Sheet` route — the
 * presentation (a `formSheet`, the grabber, the detents) is the route's, never
 * this component's (docs/feat/mobile-native-sheets.md D4). Every decision (the
 * age guard, the options, the reply, the origin, the preview) lives in pure
 * modules (`permission-sheet.ts`, `ask-card.ts`, `ask-park.ts`; AGENTS §7).
 *
 * The peek detent draws the one-row `AskSlim` (never buttons: the command is not
 * seen from there); the others draw `AskCard`. The sheet is NOT blocking: a
 * swipe PARKS the ask (the screen's banner), it never withdraws it.
 *
 * testIDs (the flows' contract): `perm-sheet`, `perm-slim`, `perm-<optionId>`,
 * `perm-menu`, `perm-reply-input`, `perm-reply-send`, `perm-arming`,
 * `perm-returned`, `perm-returned-dismiss`, `perm-auto-accept`.
 */
import { type ComponentRef, type JSX, useEffect, useRef } from "react";
import {
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  View,
  useWindowDimensions,
} from "react-native";
import { askCard } from "../ask-card.ts";
import { askSurface } from "../ask-park.ts";
import type { PermissionSheet, SheetState } from "../permission-sheet.ts";
import { DENSE_FONT_SCALE, type Palette, radius, size, typography } from "../theme.ts";
import { AskCard } from "../ui/AskCard.tsx";
import { AskSlim } from "../ui/AskSlim.tsx";
import { Text, TextInput } from "../ui/Text.tsx";

/** The command box's mono advance (14 pt monospace ≈ 0.6 em), so `cols` is arithmetic. */
const MONO_ADVANCE = 0.6;
const MONO_SIZE = 14;
/** Sheet padding (20 × 2) + the command box padding (12 × 2). */
const CHROME_WIDTH = 64;

export interface PermissionSheetViewProps {
  readonly sheet: PermissionSheet;
  readonly state: SheetState;
  readonly palette: Palette;
  /** The detent index the sheet is at (0 = peek), fed by the route's `sheetDetentChange`. */
  readonly detent: number;
}

export function PermissionSheetView({
  sheet,
  state,
  palette,
  detent,
}: PermissionSheetViewProps): JSX.Element {
  const { width } = useWindowDimensions();
  const cols = Math.max(10, Math.floor((width - CHROME_WIDTH) / (MONO_SIZE * MONO_ADVANCE)));
  // The session's shared auto-accept (docs/feat/session-auto-accept.md D6): its
  // VALUE is read here and now; the controller re-emits on the link's own change.
  const link = sheet.autoAccept;
  const view = askCard(state, {
    origin: state.kind === "asking" && state.origin !== undefined ? state.origin : { kind: "main" },
    cols,
    ageMs: null,
    hasAutoAccept: link !== null,
  });
  const asking = state.kind === "asking" ? state : null;
  // A pageSheet is not resized by the keyboard: the ScrollView insets itself by
  // it and scrolls its END (the reply's Send) into view (flow 08c).
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  useEffect(() => {
    const shown = Keyboard.addListener("keyboardDidShow", () => {
      scroll.current?.scrollToEnd({ animated: true });
    });
    return () => shown.remove();
  }, []);
  if (view !== null && view.kind === "asking" && askSurface(detent) === "slim") {
    return (
      <View testID="perm-sheet" style={[styles.slim, { backgroundColor: palette.sheet }]}>
        <AskSlim
          testID="perm-slim"
          palette={palette}
          title={view.title}
          originShort={view.origin.lead}
          more={sheet.queued}
          // Not a button: the sheet cannot be raised from code, so the row says
          // how (a dimmed hint), never a tap that does nothing (finding 3).
          actionLabel="Drag up"
        />
      </View>
    );
  }
  return (
    <ScrollView
      ref={scroll}
      testID="perm-sheet"
      automaticallyAdjustKeyboardInsets
      style={{ backgroundColor: palette.sheet }}
      keyboardShouldPersistTaps="handled"
    >
      {view !== null && view.kind === "asking" && asking !== null ? (
        <AskCard
          palette={palette}
          view={view}
          onAnswer={(optionId) => sheet.answer(optionId)}
          onMenu={(id) => {
            if (id === "auto_accept") {
              if (link !== null) {
                void link.set(!link.current())?.catch(() => {});
              }
              return;
            }
            sheet.answer(id);
          }}
        >
          {link === null ? null : (
            <View style={styles.autoRow}>
              <Text style={[typography.footnote, styles.flex, { color: palette.sec }]}>
                {link.shared()
                  ? "Auto-accept · this session, on every device"
                  : "Auto-accept · not shared by this computer — update tentacle"}
              </Text>
              <Switch
                testID="perm-auto-accept"
                accessibilityLabel="Auto-accept for this session, on every device"
                value={link.current()}
                disabled={!link.shared()}
                // The session's link, never a stored approval (each ask is `allow_once`).
                onValueChange={(on) => {
                  void link.set(on)?.catch(() => {});
                }}
              />
            </View>
          )}
          {asking.replyText === "" && !asking.replyOpen ? null : (
            <>
              <TextInput
                testID="perm-reply-input"
                style={[
                  typography.body,
                  styles.reply,
                  { color: palette.label, backgroundColor: palette.fill },
                ]}
                placeholder="Tell it what to do instead"
                placeholderTextColor={palette.sec}
                value={asking.replyText}
                onChangeText={(text) => sheet.setReplyText(text)}
                multiline
              />
              <Pressable
                testID="perm-reply-send"
                accessibilityRole="button"
                accessibilityLabel="Send reply"
                accessibilityState={{ disabled: !asking.armed }}
                disabled={!asking.armed}
                onPress={() => sheet.sendReply()}
                style={[styles.send, { backgroundColor: palette.tint }]}
              >
                <Text
                  maxFontSizeMultiplier={DENSE_FONT_SCALE}
                  style={[typography.headline, { color: palette.accent }]}
                >
                  Send reply
                </Text>
              </Pressable>
            </>
          )}
        </AskCard>
      ) : null}
      {sheet.autoAccepted === null ? null : (
        <Text
          testID="perm-auto-accepted"
          style={[typography.footnote, styles.pad, { color: palette.sec }]}
        >
          {sheet.autoAccepted}
        </Text>
      )}
      {view !== null && view.kind === "returned" ? (
        <View style={styles.returned}>
          <Text testID="perm-returned" style={[typography.headline, { color: palette.red }]}>
            {view.notice}
          </Text>
          <View style={[styles.detailBox, { backgroundColor: palette.codeOnSheet }]}>
            <Text style={[typography.body, { color: palette.label }]}>{view.text}</Text>
          </View>
          <Pressable
            testID="perm-returned-dismiss"
            accessibilityRole="button"
            accessibilityLabel="OK"
            onPress={() => sheet.clearReturned()}
            style={[styles.send, { backgroundColor: palette.fill }]}
          >
            <Text style={[typography.headline, { color: palette.label }]}>OK</Text>
          </Pressable>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  pad: { paddingHorizontal: 20 },
  slim: { paddingHorizontal: 12, paddingTop: 8 },
  autoRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  returned: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 40, gap: 16 },
  detailBox: { borderRadius: radius.tile, padding: 14 },
  reply: { borderRadius: radius.tile, padding: 14, minHeight: 96 },
  send: {
    minHeight: size.bigButton,
    borderRadius: size.bigButton / 2,
    alignItems: "center",
    justifyContent: "center",
  },
});
