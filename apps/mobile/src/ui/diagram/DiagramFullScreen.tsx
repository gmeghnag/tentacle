/**
 * The diagram full screen (docs/feat/model-diagrams.md D6, mockup 4A): a
 * landscape-capable modal like the chart's, `Diagramma | Sorgente`, Share (the
 * SVG file, else the source) and "Copia sorgente". The drawing is the same inert
 * `DiagramView`, zoomable (pinch up to 6×, double-tap). Holds only the tab.
 */
import * as Clipboard from "expo-clipboard";
import type { JSX } from "react";
import { Modal, Pressable, ScrollView, Share, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { DiagramRender } from "../../diagram-cache.ts";
import { type DiagramUiWords, diagramCaption, diagramShare } from "../../diagram-display.ts";
import type { DiagramRowView } from "../../diagram-row.ts";
import { MONO, type Palette, typography } from "../../theme.ts";
import { CodeBlock } from "../CodeBlock.tsx";
import { Text } from "../Text.tsx";
import { FULL_SCREEN_ORIENTATIONS, FULL_SCREEN_PRESENTATION } from "../chart/ChartFullScreen.tsx";
import { DiagramView } from "./DiagramView.tsx";

export interface DiagramFullScreenProps {
  readonly view: DiagramRowView;
  readonly render: DiagramRender | null;
  readonly tab: "diagram" | "source";
  readonly fileUri: string | null;
  readonly words: DiagramUiWords;
  readonly palette: Palette;
  readonly reduceMotion: boolean;
  readonly testID: string;
  readonly onTab: (tab: "diagram" | "source") => void;
  readonly onClose: () => void;
}

export function DiagramFullScreen(p: DiagramFullScreenProps): JSX.Element {
  const { view, words, palette, testID } = p;
  const insets = useSafeAreaInsets();
  const source = view.source.canonical;
  const share = () =>
    void Share.share(diagramShare({ title: view.title, source }, p.fileUri)).catch(() => undefined);
  const segment = (tab: "diagram" | "source", label: string) => (
    <Pressable
      testID={`${testID}-tab-${tab}`}
      accessibilityRole="tab"
      accessibilityState={{ selected: p.tab === tab }}
      onPress={() => p.onTab(tab)}
      hitSlop={8}
    >
      <Text
        style={[
          styles.segment,
          { color: p.tab === tab ? palette.label : palette.sec, borderColor: palette.sep },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
  const showDrawing = p.tab === "diagram" && p.render !== null;
  return (
    <Modal
      visible
      testID={testID}
      animationType={p.reduceMotion ? "none" : "fade"}
      presentationStyle={FULL_SCREEN_PRESENTATION}
      supportedOrientations={[...FULL_SCREEN_ORIENTATIONS]}
      onRequestClose={p.onClose}
    >
      <View
        style={[
          styles.screen,
          {
            backgroundColor: palette.page,
            paddingTop: insets.top,
            paddingBottom: insets.bottom,
            paddingLeft: insets.left,
            paddingRight: insets.right,
          },
        ]}
      >
        <View style={styles.header}>
          <Pressable
            testID={`${testID}-close`}
            accessibilityRole="button"
            onPress={p.onClose}
            hitSlop={12}
          >
            <Text style={[typography.body, { color: palette.accent }]}>{words.close}</Text>
          </Pressable>
          <Text numberOfLines={1} style={[styles.caption, { color: palette.sec }]}>
            {diagramCaption(view)}
          </Text>
          <Pressable
            testID={`${testID}-share`}
            accessibilityRole="button"
            onPress={share}
            hitSlop={12}
          >
            <Text style={[typography.body, { color: palette.accent }]}>{words.share}</Text>
          </Pressable>
        </View>
        <View style={styles.tabs}>
          {segment("diagram", words.diagram)}
          {segment("source", words.source)}
        </View>
        {showDrawing && p.render !== null ? (
          <View style={styles.fill} accessible accessibilityLabel={view.accessibilityLabel}>
            <DiagramView
              svg={p.render.svg}
              background={palette.page}
              zoom
              width="100%"
              height="100%"
              testID={`${testID}-drawing`}
            />
          </View>
        ) : (
          <ScrollView style={styles.fill} contentContainerStyle={styles.sourceBody}>
            <CodeBlock
              text={source}
              lang="mermaid"
              palette={palette}
              background={view.tokens.surface}
              testID={`${testID}-source`}
            />
            <Pressable
              testID={`${testID}-copy`}
              accessibilityRole="button"
              onPress={() => void Clipboard.setStringAsync(source).catch(() => undefined)}
              hitSlop={8}
            >
              <Text style={[typography.footnote, styles.copy, { color: palette.accent }]}>
                {words.copySource}
              </Text>
            </Pressable>
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  fill: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 12,
  },
  caption: { flex: 1, textAlign: "center", fontFamily: MONO, fontSize: 13 },
  tabs: { flexDirection: "row", justifyContent: "center", gap: 8, paddingBottom: 8 },
  segment: {
    fontFamily: MONO,
    fontSize: 13,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
  },
  sourceBody: { padding: 16, gap: 12 },
  copy: { textAlign: "right" },
});
