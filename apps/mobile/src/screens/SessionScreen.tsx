/**
 * `Session` — a PLACEHOLDER in 11a (docs/feat/mobile-app-shell.md, Owner Q5):
 * it shows what the list already knows and calls nothing. `session/open` would
 * ATTACH the phone to the session (`attached` +1, steering semantics); that
 * transcript is task 12's.
 */
import type { JSX } from "react";
import { ScrollView, StyleSheet, Text } from "react-native";
import type { Palette } from "../theme.ts";

export interface SessionScreenProps {
  readonly palette: Palette;
  readonly title: string;
  /** The project label the list knew (`projectLabel`). */
  readonly project: string;
  /** `running` / `attached n` / `idle`, from the row's badges. */
  readonly state: string;
}

export function SessionScreen({ palette, title, project, state }: SessionScreenProps): JSX.Element {
  return (
    <ScrollView
      testID="session-placeholder"
      style={{ backgroundColor: palette.groupedBackground }}
      contentContainerStyle={styles.content}
    >
      <Text style={[styles.title, { color: palette.label }]}>{title}</Text>
      <Text style={[styles.body, { color: palette.secondaryLabel }]}>{project}</Text>
      <Text style={[styles.body, { color: palette.secondaryLabel }]}>{state}</Text>
      <Text style={[styles.body, { color: palette.secondaryLabel }]}>
        The transcript is coming with `tentacle` on this phone.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 8 },
  title: { fontSize: 22, fontWeight: "600" },
  body: { fontSize: 15 },
});
