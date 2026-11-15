/**
 * `Pair` — where a computer is paired (docs/feat/mobile-pairing-screen.md 11b.1,
 * Design 4). A DUMB renderer (AGENTS §7): every state and sentence comes from
 * `pairing-flow.ts`'s view-model; this file maps it to elements and carries the
 * testIDs a Maestro flow asserts (RN's new architecture exposes no text to
 * XCUITest, so every value a flow checks is in a testID).
 *
 * The compare code is the point of the screen: the 6 digits, in two mono boxes
 * (`sasGroups`), with "check your computer shows the same code, then answer y
 * there" — the human's `[y/N]` lives on the computer, never here.
 *
 * 11b.2 adds the Scan affordance and the camera's own card. Both are PURE
 * VIEW-MODEL output (`camera-access.ts`): this file decides no permission
 * behaviour, it only draws the state it is handed.
 *
 * The look is the approved `Pair` mockup (docs/feat/mobile-ui-polish.md Slice 2):
 * the intake is a large-title screen (Scan as the primary action, paste as the
 * alternative); the live camera covers the whole screen with its viewfinder and
 * a glass Cancel; review → connecting → compare → done is a bottom sheet.
 */
import { type ComponentRef, type JSX, type ReactNode, useCallback, useEffect, useRef } from "react";
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { CameraView } from "../camera-access.ts";
import { sasGroups } from "../computer-status.ts";
import { FIELD_REVEAL_IDLE, type FieldRevealEvent, revealStep } from "../field-reveal.ts";
import { PAIR_COPY, pairSheetHeading } from "../pair-copy.ts";
import type { PairingView } from "../pairing-flow.ts";
import { type Palette, size as SIZE, radius, space, typography } from "../theme.ts";
import { Banner } from "../ui/Banner.tsx";
import { CompactBar, useCompactTitle } from "../ui/CompactBar.tsx";
import { GlassButton } from "../ui/GlassButton.tsx";
import { GroupedCard } from "../ui/GroupedCard.tsx";
import { Icon } from "../ui/Icon.tsx";
import { InlineMono } from "../ui/InlineMono.tsx";
import { PillButton } from "../ui/PillButton.tsx";
import { ScreenHeader } from "../ui/ScreenHeader.tsx";
import { SectionHeader } from "../ui/SectionHeader.tsx";
import { Sheet } from "../ui/Sheet.tsx";

export interface PairScreenProps {
  readonly palette: Palette;
  readonly view: PairingView;
  readonly onText: (text: string) => void;
  readonly onSubmit: () => void;
  readonly onDeviceName: (name: string) => void;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  /** The card's own button: `edit` clears the text, `retry` re-runs the pairing. */
  readonly onFailureAction: () => void;
  /** Leave the screen (the header's Cancel) — absent when Pair is the root. */
  readonly onBack?: () => void;
  /** The computer this pairing replaces ("Pair again" from a row), if any. */
  readonly againName?: string;
  /** The camera's state (11b.2), already decided by `camera-access.ts`. */
  readonly camera: CameraView;
  /** The Scan control (or the denied card's Settings action) was tapped. */
  readonly onScan: () => void;
  /** The live preview's Close control (fix round 1 finding 1: it had none). */
  readonly onScanClose: () => void;
  readonly onOpenSettings: () => void;
  /** The live scanner, mounted only while it is open (the screen owns no state). */
  readonly scanner?: ReactNode;
}

/** `123456` → `123 456` (the mockups' grouped form). */
export function groupSas(sas: string): string {
  return sasGroups(sas).join(" ");
}

export function PairScreen({
  palette,
  view,
  onText,
  onSubmit,
  onDeviceName,
  onConfirm,
  onCancel,
  onFailureAction,
  onBack,
  againName,
  camera,
  onScan,
  onScanClose,
  onOpenSettings,
  scanner,
}: PairScreenProps): JSX.Element {
  const insets = useSafeAreaInsets();
  const inSheet = view.stage !== "intake";
  const compact = useCompactTitle();
  const title = againName === undefined ? "Pair a computer" : "Pair again";
  const heading = pairSheetHeading(view);
  // Keep the paste field and Continue above the keyboard (`field-reveal.ts`):
  // the avoiding view shrinks the screen, the list keeps its offset, so the
  // field — the last card — would sit under the keyboard.
  const list = useRef<ComponentRef<typeof ScrollView>>(null);
  const reveal = useRef(FIELD_REVEAL_IDLE);
  const feed = useCallback((event: FieldRevealEvent) => {
    const step = revealStep(reveal.current, event);
    reveal.current = step.state;
    if (step.reveal) {
      list.current?.scrollToEnd({ animated: true });
    }
  }, []);
  useEffect(() => {
    const shown = Keyboard.addListener("keyboardDidShow", () => feed("keyboard-shown"));
    const hidden = Keyboard.addListener("keyboardDidHide", () => feed("keyboard-hidden"));
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, [feed]);
  const failure =
    view.failure === undefined ? null : (
      <Banner
        palette={palette}
        tone="error"
        flush
        testID={`pair-error-${view.failure.reason}`}
        title={PAIR_COPY.failedTitle}
        body={
          view.failure.mayStillPrompt === true
            ? `${view.failure.message} If the computer is asking, answer n there.`
            : view.failure.message
        }
        {...(view.failure.mayStillPrompt === true ? { bodyTestID: "pair-may-still-ask" } : {})}
      />
    );
  // The failure and its own button, as ONE block: in the intake's list, in the
  // review sheet, or as the whole `failed` sheet.
  const failureBlock =
    view.failure === undefined ? null : (
      <View style={styles.sheetBody}>
        {failure}
        {view.failure.retry === "no" ? null : (
          <PillButton
            testID="pair-error-action"
            palette={palette}
            label={view.failure.retry === "edit" ? "Try again" : "Retry"}
            onPress={onFailureAction}
          />
        )}
      </View>
    );

  return (
    <KeyboardAvoidingView behavior="padding" style={[styles.root, { backgroundColor: palette.bg }]}>
      <ScrollView
        ref={list}
        onContentSizeChange={() => feed("content-resized")}
        onScroll={compact.onScroll}
        scrollEventThrottle={compact.scrollEventThrottle}
        // Behind a sheet the intake is only scenery under the scrim.
        accessibilityElementsHidden={inSheet}
        importantForAccessibility={inSheet ? "no-hide-descendants" : "auto"}
        style={styles.root}
        contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        <ScreenHeader
          palette={palette}
          title={title}
          left={
            onBack === undefined ? undefined : (
              <GlassButton
                testID="pair-back"
                palette={palette}
                label="Cancel"
                accessibilityLabel="Cancel"
                onPress={onBack}
              />
            )
          }
        />

        {/* The intake stays rendered behind a sheet, under the scrim (N1). */}
        {view.stage === "intake" || inSheet ? (
          <>
            <View style={styles.block}>
              <GroupedCard palette={palette}>
                <View style={styles.hero}>
                  <View style={[styles.heroTile, { backgroundColor: palette.tint }]}>
                    <Icon name="qrcode.viewfinder" color={palette.accent} size={28} />
                  </View>
                  <Text style={[typography.headline, styles.center, { color: palette.label }]}>
                    Scan the QR code
                  </Text>
                  <Text style={[typography.subhead, styles.center, { color: palette.sec }]}>
                    Run{" "}
                    <InlineMono palette={palette} size={typography.subhead.fontSize}>
                      tentacle pair
                    </InlineMono>{" "}
                    on your computer and point the camera at the QR code.
                  </Text>
                  {againName === undefined ? null : (
                    <Text
                      testID="pair-again-name"
                      style={[typography.footnote, styles.center, { color: palette.sec }]}
                    >
                      {PAIR_COPY.again(againName)}
                    </Text>
                  )}
                  {camera.scan !== "none" ? (
                    <View style={styles.stretch}>
                      <PillButton
                        testID="pair-scan"
                        palette={palette}
                        icon="qrcode.viewfinder"
                        label="Scan QR code"
                        onPress={onScan}
                      />
                    </View>
                  ) : null}
                </View>
              </GroupedCard>
            </View>

            {camera.card === undefined ? null : (
              <View style={styles.block}>
                <Banner
                  palette={palette}
                  testID={`pair-camera-${camera.card}`}
                  tone="warn"
                  icon="exclamationmark.triangle"
                  title="Camera unavailable"
                  body={camera.message ?? ""}
                  {...(camera.settings
                    ? {
                        action: {
                          label: "Open Settings",
                          onPress: onOpenSettings,
                          testID: "pair-camera-settings",
                        },
                      }
                    : {})}
                />
              </View>
            )}

            {failureBlock === null || inSheet ? null : (
              <View style={[styles.block, styles.insetBlock]}>{failureBlock}</View>
            )}

            <View style={styles.block}>
              <SectionHeader palette={palette} title="Or paste the line it prints" />
              <GroupedCard palette={palette}>
                <View style={styles.paste}>
                  <TextInput
                    testID="pair-paste-input"
                    value={view.text}
                    onChangeText={onText}
                    onFocus={() => feed("focus")}
                    onBlur={() => feed("blur")}
                    placeholder="tentacle://pair?…"
                    placeholderTextColor={palette.sec}
                    autoCapitalize="none"
                    autoCorrect={false}
                    multiline
                    style={[
                      typography.mono,
                      styles.field,
                      { color: palette.label, backgroundColor: palette.fill },
                    ]}
                  />
                  <PillButton
                    testID="pair-paste-submit"
                    palette={palette}
                    kind={view.submit === "ready" ? "secondary" : "neutral"}
                    disabled={view.submit === "empty"}
                    label="Continue"
                    onPress={onSubmit}
                  />
                </View>
              </GroupedCard>
            </View>
          </>
        ) : null}
      </ScrollView>

      <CompactBar palette={palette} title={title} shown={compact.shown && !inSheet} />

      {inSheet ? (
        // The scrim: dims the intake and swallows its touches.
        <View
          style={[styles.scrim, { backgroundColor: palette.scrim }]}
          onStartShouldSetResponder={() => true}
        />
      ) : null}

      {inSheet ? (
        <Sheet
          palette={palette}
          floating
          {...(heading.title === undefined ? {} : { title: heading.title })}
          {...(heading.centred === true ? { centred: true } : {})}
          subtitle={
            view.stage === "compare" ? (
              <>
                {PAIR_COPY.compareBefore}
                <InlineMono palette={palette} size={typography.subhead.fontSize}>
                  {PAIR_COPY.compareKey}
                </InlineMono>
                {PAIR_COPY.compareAfter}
              </>
            ) : (
              heading.subtitle
            )
          }
        >
          {view.stage === "review" && view.review !== undefined ? (
            <View testID="pair-review" style={styles.sheetBody}>
              {view.review.existing === undefined ? null : (
                <Text
                  testID="pair-already-paired"
                  style={[typography.subhead, { color: palette.orange }]}
                >
                  {PAIR_COPY.already(view.review.existing.name)}
                </Text>
              )}
              <Text style={[typography.footnote, styles.label, { color: palette.sec }]}>
                NAME SHOWN ON THE COMPUTER
              </Text>
              <TextInput
                testID="pair-device-name"
                value={view.review.deviceName}
                onChangeText={onDeviceName}
                autoCapitalize="words"
                autoCorrect={false}
                returnKeyType="done"
                style={[
                  typography.body,
                  styles.field,
                  { color: palette.label, backgroundColor: palette.fill },
                ]}
              />
              {view.review.deviceNameValid ? null : (
                <Text
                  testID="pair-device-name-invalid"
                  style={[typography.footnote, { color: palette.red }]}
                >
                  A name is 1–64 characters, without control characters.
                </Text>
              )}
              {failureBlock}
              <PillButton
                testID="pair-confirm"
                palette={palette}
                label="Pair"
                disabled={!view.review.deviceNameValid}
                onPress={onConfirm}
              />
            </View>
          ) : null}

          {view.stage === "connecting" ? (
            <View style={styles.sheetBody}>
              <View style={styles.waiting}>
                <ActivityIndicator color={palette.accent} />
                <Text testID="pair-connecting" style={[typography.subhead, { color: palette.sec }]}>
                  {PAIR_COPY.connecting}
                </Text>
              </View>
              <PillButton
                testID="pair-cancel"
                palette={palette}
                kind="neutral"
                label="Cancel"
                onPress={onCancel}
              />
            </View>
          ) : null}

          {view.stage === "compare" && view.sas !== undefined ? (
            <View testID={`pair-sas-${view.sas}`} style={styles.sheetBody}>
              <View style={styles.sasRow} accessibilityLabel={`Code ${groupSas(view.sas)}`}>
                {sasGroups(view.sas).map((group, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: the groups are positional (first/second half)
                  <View key={index} style={[styles.sasBox, { backgroundColor: palette.fill }]}>
                    <Text
                      allowFontScaling={false}
                      style={[typography.sas, { color: palette.label }]}
                    >
                      {group}
                    </Text>
                  </View>
                ))}
              </View>
              <View style={styles.waiting}>
                <ActivityIndicator color={palette.accent} />
                <Text style={[typography.subhead, { color: palette.sec }]}>
                  {PAIR_COPY.waiting}
                </Text>
              </View>
              <PillButton
                testID="pair-cancel"
                palette={palette}
                kind="neutral"
                label={PAIR_COPY.mismatch}
                onPress={onCancel}
              />
            </View>
          ) : null}

          {view.stage === "done" ? (
            <View testID="pair-done" style={[styles.sheetBody, styles.doneBody]}>
              <View style={[styles.heroTile, { backgroundColor: palette.tint }]}>
                <Icon name="checkmark" color={palette.green} size={28} />
              </View>
              <Text style={[typography.subhead, styles.center, { color: palette.sec }]}>
                {PAIR_COPY.done}
              </Text>
            </View>
          ) : null}

          {view.stage === "failed" ? failureBlock : null}
        </Sheet>
      ) : null}

      {/* The intake owns the live preview: any other stage ends it, so a paste
          after a Scan tap cannot leave the camera running (fix round 1 finding 1).
          It covers the whole screen (mockup `Pair`), the camera's own dark chrome. */}
      {scanner === undefined || view.stage !== "intake" ? null : (
        <View testID="pair-scanner" style={[styles.scanner, { backgroundColor: palette.camera }]}>
          {scanner}
          {/* The preview's own way out, as the screen's chrome: `scanner.tsx`
              stays the native seam alone. A camera opened by a Scan tap must be
              closable without leaving the screen (fix round 1 finding 1). */}
          <View style={[styles.scannerBar, { top: insets.top + 4 }]}>
            <GlassButton
              testID="pair-scan-close"
              palette={palette}
              onDark
              label="Cancel"
              accessibilityLabel="Close camera"
              onPress={onScanClose}
            />
          </View>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  block: { marginTop: space.sectionSessions },
  insetBlock: { paddingHorizontal: space.inset },
  center: { textAlign: "center" },
  stretch: { alignSelf: "stretch", marginTop: 6 },
  // ONE inner gutter for both intake cards (P3): the Scan button, the paste
  // field and "Continue" share their left and right edges.
  hero: { alignItems: "center", gap: 8, padding: space.cardInner },
  heroTile: {
    width: SIZE.iconTileLarge + 12,
    height: SIZE.iconTileLarge + 12,
    borderRadius: radius.iconTileLarge + 2,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  paste: { padding: space.cardInner, gap: 12 },
  field: { borderRadius: radius.tile, paddingHorizontal: 14, minHeight: 48, paddingVertical: 13 },
  label: { marginTop: 4, letterSpacing: -0.08 },
  sheetBody: { gap: 12, marginTop: 4 },
  doneBody: { alignItems: "center" },
  waiting: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10 },
  // The chips hug their digits, centred (mockup `Pair` compare: 6/14, gap 14).
  sasRow: { flexDirection: "row", gap: 14, justifyContent: "center", marginVertical: 4 },
  sasBox: {
    borderRadius: radius.tile,
    paddingVertical: 6,
    paddingHorizontal: 14,
    alignItems: "center",
  },
  scanner: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  scrim: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  scannerBar: { position: "absolute", left: space.inset },
});
