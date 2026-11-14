/**
 * `Pair` — where a computer is paired (docs/feat/mobile-pairing-screen.md 11b.1,
 * Design 4). A DUMB renderer (AGENTS §7): every state and sentence comes from
 * `pairing-flow.ts`'s view-model; this file maps it to elements and carries the
 * testIDs a Maestro flow asserts (RN's new architecture exposes no text to
 * XCUITest, so every value a flow checks is in a testID).
 *
 * The compare code is the point of the screen: the 6 digits, grouped `123 456`,
 * shown large, with "check your computer shows the same code, then answer y
 * there" — the human's `[y/N]` lives on the computer, never here.
 *
 * 11b.2 adds the Scan affordance above the paste card and the camera's own card.
 * Both are PURE VIEW-MODEL output (`camera-access.ts`): this file decides no
 * permission behaviour, it only draws the state it is handed.
 */
import type { JSX, ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { CameraView } from "../camera-access.ts";
import type { PairingView } from "../pairing-flow.ts";
import type { Palette } from "../theme.ts";

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
  const digits = sas.replace(/\s/g, "");
  return digits.length === 6 ? `${digits.slice(0, 3)} ${digits.slice(3)}` : digits;
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
  againName,
  camera,
  onScan,
  onScanClose,
  onOpenSettings,
  scanner,
}: PairScreenProps): JSX.Element {
  return (
    <ScrollView
      style={{ backgroundColor: palette.groupedBackground }}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      {/* The intake owns the live preview: any other stage ends it, so a paste
          after a Scan tap cannot leave the camera running (fix round 1 finding 1). */}
      {scanner === undefined || view.stage !== "intake" ? null : (
        <View
          testID="pair-scanner"
          style={[styles.card, styles.scanner, { backgroundColor: palette.card }]}
        >
          {scanner}
          {/* The preview's own way out, as the screen's chrome: `scanner.tsx`
              stays the native seam alone. A camera opened by a Scan tap must be
              closable without leaving the screen (fix round 1 finding 1). */}
          <Pressable
            testID="pair-scan-close"
            accessibilityRole="button"
            onPress={onScanClose}
            style={[styles.close, { backgroundColor: palette.card }]}
          >
            <Text style={[styles.buttonText, { color: palette.accent }]}>Close camera</Text>
          </Pressable>
        </View>
      )}

      {view.stage === "intake" && camera.scan !== "none" ? (
        <Pressable
          testID="pair-scan"
          accessibilityRole="button"
          onPress={onScan}
          style={[styles.button, { backgroundColor: palette.accent }]}
        >
          <Text style={[styles.buttonText, { color: palette.onAccent }]}>Scan QR code</Text>
        </Pressable>
      ) : null}

      {view.stage !== "intake" || camera.card === undefined ? null : (
        <View
          testID={`pair-camera-${camera.card}`}
          style={[styles.card, { backgroundColor: palette.card }]}
        >
          <Text style={[styles.body, { color: palette.danger }]}>{camera.message ?? ""}</Text>
          {camera.settings ? (
            <Pressable
              testID="pair-camera-settings"
              accessibilityRole="button"
              onPress={onOpenSettings}
              style={[styles.button, { backgroundColor: palette.separator }]}
            >
              <Text style={[styles.buttonText, { color: palette.label }]}>Open Settings</Text>
            </Pressable>
          ) : null}
        </View>
      )}

      {view.stage === "intake" ? (
        <View style={[styles.card, { backgroundColor: palette.card }]}>
          <Text style={[styles.title, { color: palette.label }]}>Pair a computer</Text>
          <Text style={[styles.body, { color: palette.secondaryLabel }]}>
            Run `tentacle pair` on the computer and paste the line it prints.
          </Text>
          {againName === undefined ? null : (
            <Text testID="pair-again-name" style={[styles.body, { color: palette.secondaryLabel }]}>
              Pairing again replaces this phone's entry for '{againName}'.
            </Text>
          )}
          <TextInput
            testID="pair-paste-input"
            value={view.text}
            onChangeText={onText}
            placeholder="tentacle://pair?…"
            placeholderTextColor={palette.secondaryLabel}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            style={[styles.input, { color: palette.label, borderColor: palette.separator }]}
          />
          <Pressable
            testID="pair-paste-submit"
            accessibilityRole="button"
            onPress={onSubmit}
            style={[styles.button, { backgroundColor: palette.accent }]}
          >
            <Text style={[styles.buttonText, { color: palette.onAccent }]}>Continue</Text>
          </Pressable>
        </View>
      ) : null}

      {view.stage === "review" && view.review !== undefined ? (
        <View testID="pair-review" style={[styles.card, { backgroundColor: palette.card }]}>
          <Text style={[styles.title, { color: palette.label }]}>
            Pair with '{view.review.computerName}'?
          </Text>
          <Text style={[styles.body, { color: palette.secondaryLabel }]}>
            It answers on {view.review.addressCount}{" "}
            {view.review.addressCount === 1 ? "address" : "addresses"}.
          </Text>
          {view.review.existing === undefined ? null : (
            <Text testID="pair-already-paired" style={[styles.body, { color: palette.danger }]}>
              Already paired with '{view.review.existing.name}' — pairing again replaces this
              phone's key for it.
            </Text>
          )}
          <Text style={[styles.body, { color: palette.secondaryLabel }]}>
            The name this computer will show for this phone:
          </Text>
          <TextInput
            testID="pair-device-name"
            value={view.review.deviceName}
            onChangeText={onDeviceName}
            autoCapitalize="words"
            autoCorrect={false}
            style={[styles.input, { color: palette.label, borderColor: palette.separator }]}
          />
          {view.review.deviceNameValid ? null : (
            <Text
              testID="pair-device-name-invalid"
              style={[styles.body, { color: palette.danger }]}
            >
              A name is 1–64 characters, without control characters.
            </Text>
          )}
          <Pressable
            testID="pair-confirm"
            accessibilityRole="button"
            onPress={onConfirm}
            style={[
              styles.button,
              { backgroundColor: view.review.deviceNameValid ? palette.accent : palette.separator },
            ]}
          >
            <Text style={[styles.buttonText, { color: palette.onAccent }]}>Pair</Text>
          </Pressable>
        </View>
      ) : null}

      {view.stage === "connecting" ? (
        <View style={[styles.card, { backgroundColor: palette.card }]}>
          <Text testID="pair-connecting" style={[styles.title, { color: palette.label }]}>
            Connecting…
          </Text>
          <Pressable
            testID="pair-cancel"
            accessibilityRole="button"
            onPress={onCancel}
            style={[styles.button, { backgroundColor: palette.separator }]}
          >
            <Text style={[styles.buttonText, { color: palette.label }]}>Cancel</Text>
          </Pressable>
        </View>
      ) : null}

      {view.stage === "compare" && view.sas !== undefined ? (
        <View
          testID={`pair-sas-${view.sas}`}
          style={[styles.card, { backgroundColor: palette.card }]}
        >
          <Text style={[styles.body, { color: palette.secondaryLabel }]}>
            Check that your computer shows the same code, then answer y there.
          </Text>
          <Text style={[styles.sas, { color: palette.label }]}>{groupSas(view.sas)}</Text>
          <Pressable
            testID="pair-cancel"
            accessibilityRole="button"
            onPress={onCancel}
            style={[styles.button, { backgroundColor: palette.separator }]}
          >
            <Text style={[styles.buttonText, { color: palette.label }]}>Cancel</Text>
          </Pressable>
        </View>
      ) : null}

      {view.stage === "done" ? (
        <View testID="pair-done" style={[styles.card, { backgroundColor: palette.card }]}>
          <Text style={[styles.title, { color: palette.label }]}>
            Paired with '{view.computerName ?? ""}'
          </Text>
          <Text style={[styles.body, { color: palette.secondaryLabel }]}>
            You can now use this computer from this phone.
          </Text>
        </View>
      ) : null}

      {view.failure === undefined ? null : (
        <View
          testID={`pair-error-${view.failure.reason}`}
          style={[styles.card, { backgroundColor: palette.card }]}
        >
          <Text style={[styles.body, { color: palette.danger }]}>{view.failure.message}</Text>
          {view.failure.mayStillPrompt === true ? (
            <Text
              testID="pair-may-still-ask"
              style={[styles.body, { color: palette.secondaryLabel }]}
            >
              If the computer is asking, answer n there.
            </Text>
          ) : null}
          {view.failure.retry === "no" ? null : (
            <Pressable
              testID="pair-error-action"
              accessibilityRole="button"
              onPress={onFailureAction}
              style={[styles.button, { backgroundColor: palette.accent }]}
            >
              <Text style={[styles.buttonText, { color: palette.onAccent }]}>
                {view.failure.retry === "edit" ? "Try again" : "Retry"}
              </Text>
            </Pressable>
          )}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, paddingTop: 24, gap: 16 },
  card: { borderRadius: 12, padding: 16, gap: 12 },
  title: { fontSize: 20, fontWeight: "600" },
  body: { fontSize: 15, lineHeight: 21 },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    padding: 12,
    fontSize: 15,
    minHeight: 44,
  },
  button: { borderRadius: 10, paddingVertical: 12, alignItems: "center" },
  scanner: { padding: 0, overflow: "hidden", gap: 0 },
  close: { alignItems: "center", paddingVertical: 10 },
  buttonText: { fontSize: 16, fontWeight: "600" },
  sas: { fontSize: 40, fontWeight: "700", letterSpacing: 4, textAlign: "center" },
});
