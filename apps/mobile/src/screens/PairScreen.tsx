/**
 * `Pair` — where a computer is paired (docs/feat/mobile-app-shell.md). 11a ships
 * only the placeholder: pairing (QR + compare code, the Keychain registry) is
 * task 9/11b. A dumb renderer (AGENTS §7): it shows the text it is handed.
 *
 * It also surfaces a dev-build misconfiguration, because a bad
 * `EXPO_PUBLIC_TENTACLE_URL` must be visible and named — never a crash and
 * never a silent empty screen.
 */
import type { JSX } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import type { Palette } from "../theme.ts";

export interface PairScreenProps {
  readonly palette: Palette;
  /** A build-config problem, already worded (names the variable). */
  readonly configError?: string;
}

export function PairScreen({ palette, configError }: PairScreenProps): JSX.Element {
  return (
    <ScrollView
      style={{ backgroundColor: palette.background }}
      contentContainerStyle={styles.content}
    >
      <Text testID="pair-placeholder" style={[styles.title, { color: palette.label }]}>
        Pair a computer — coming with `tentacle pair`
      </Text>
      <Text style={[styles.body, { color: palette.secondaryLabel }]}>
        This build has no computer to show. Pairing arrives with `tentacle pair`.
      </Text>
      {configError === undefined ? null : (
        <View style={[styles.card, { backgroundColor: palette.card }]}>
          <Text testID="pair-config-error" style={[styles.body, { color: palette.danger }]}>
            {configError}
          </Text>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, paddingTop: 32, gap: 12 },
  title: { fontSize: 22, fontWeight: "600" },
  body: { fontSize: 15, lineHeight: 21 },
  card: { borderRadius: 12, padding: 16 },
});
