/**
 * Markdown / text artifact viewer (docs/feat/model-artifacts.md D9): native, no
 * WebView. Markdown renders through the transcript's own `Markdown.tsx` with a
 * `Source` toggle; text is a monospaced block. A link tap goes to `onLink` —
 * the caller confirms it, nothing is opened here.
 */
import { type JSX, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text } from "react-native";
import { parse } from "../../markdown.ts";
import { type Palette, typography } from "../../theme.ts";
import { Markdown } from "../transcript/Markdown.tsx";

export interface MarkdownViewerProps {
  readonly palette: Palette;
  readonly text: string;
  /** `markdown` renders (with a Source toggle); `text` is shown as-is. */
  readonly kind: "markdown" | "text";
  readonly onLink: (href: string) => void;
}

export function MarkdownViewer({ palette, text, kind, onLink }: MarkdownViewerProps): JSX.Element {
  const [source, setSource] = useState(false);
  const parsed = useMemo(() => parse(text), [text]);
  const raw = kind === "text" || source;
  return (
    <ScrollView
      testID="artifact-markdown-viewer"
      style={{ backgroundColor: palette.page }}
      contentContainerStyle={styles.content}
    >
      {kind === "markdown" ? (
        <Pressable
          testID="artifact-source-toggle"
          accessibilityRole="button"
          onPress={() => setSource(!source)}
          style={styles.toggle}
          hitSlop={12}
        >
          <Text style={[typography.footnote, { color: palette.accent }]}>
            {source ? "Rendered" : "Source"}
          </Text>
        </Pressable>
      ) : null}
      {raw ? (
        <Text selectable style={[typography.monoCode, { color: palette.label }]}>
          {text}
        </Text>
      ) : (
        <Markdown parsed={parsed} palette={palette} onLink={onLink} />
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16 },
  toggle: { alignSelf: "flex-end", marginBottom: 8 },
});
