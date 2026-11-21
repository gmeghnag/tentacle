/**
 * An artifact with no viewer (kind `other`, or a kind this build does not
 * know): glyph, title, the card's `ZIP · 3.4 MB` line and **Share…** — never
 * rendered, never executed (docs/feat/model-artifacts.md D9). Render only; the
 * caller hands Share a sanitized-name copy (`shareName`) to RN core `Share`.
 */
import type { JSX } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { type Palette, typography } from "../../theme.ts";
import { Icon } from "../../ui/Icon.tsx";
import { Text } from "../../ui/Text.tsx";

export interface OtherSheetProps {
  readonly palette: Palette;
  readonly title: string;
  /** The card's type-and-size line (`viewerSubtitle`). */
  readonly line2: string;
  readonly onShare: () => void;
}

export function OtherSheet({ palette, title, line2, onShare }: OtherSheetProps): JSX.Element {
  return (
    <View testID="artifact-other-sheet" style={[styles.body, { backgroundColor: palette.page }]}>
      <Icon name="folder" color={palette.sec} size={44} />
      <Text numberOfLines={2} style={[typography.headline, styles.title, { color: palette.label }]}>
        {title}
      </Text>
      <Text style={[typography.footnote, { color: palette.sec }]}>{line2}</Text>
      <Pressable
        testID="artifact-share"
        accessibilityRole="button"
        onPress={onShare}
        style={[styles.button, { backgroundColor: palette.accentFill }]}
      >
        <Text style={[typography.headline, { color: palette.onAccent }]}>Share…</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 8 },
  title: { textAlign: "center" },
  button: { marginTop: 16, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12 },
});
