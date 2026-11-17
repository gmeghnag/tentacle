/**
 * The inline diagram (docs/feat/model-diagrams.md D6, mockups 1A/3A): the caption
 * (title · type, mono, centred), then the drawing on the conversation background
 * — no card. While rendering: a hairline placeholder of the estimated height;
 * taller than 420 pt: cut, a bottom fade and "tocca per ingrandire"; a render
 * that failed: the source (never an error in the transcript). A tap, or
 * VoiceOver's activate / "Mostra sorgente", opens the full screen.
 *
 * It holds state only; `diagramBlockBody` (diagram-display.ts) picks the body
 * and the tap's tab, `diagram-render-service.ts` renders; this only maps them.
 */
import { type JSX, useEffect, useState, useSyncExternalStore } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import {
  type DiagramBlockBody,
  diagramA11yActions,
  diagramA11yEffect,
  diagramBlockBody,
  diagramCaption,
  diagramUiWords,
} from "../../diagram-display.ts";
import { diagramFileUri, diagramRenderService } from "../../diagram-render-expo.ts";
import type { DiagramRowView } from "../../diagram-row.ts";
import { diagramTheme } from "../../diagram-theme.ts";
import { MONO, type Palette } from "../../theme.ts";
import { CodeBlock } from "../CodeBlock.tsx";
import { useReduceMotion } from "../chart/ChartAppear.tsx";
import { DiagramFullScreen } from "./DiagramFullScreen.tsx";
import { DiagramView } from "./DiagramView.tsx";

export interface DiagramBlockProps {
  readonly view: DiagramRowView;
  readonly palette: Palette;
  /** The width the drawing may use (the row's, minus the page insets). */
  readonly width: number;
  readonly locale: string;
  readonly testID: string;
}

const FADE = 48;

export function DiagramBlock({
  view,
  palette,
  width,
  locale,
  testID,
}: DiagramBlockProps): JSX.Element {
  const [tab, setTab] = useState<"diagram" | "source" | null>(null);
  const reduceMotion = useReduceMotion();
  const words = diagramUiWords(locale);
  const key = view.renderKey;
  const state = useSyncExternalStore(
    (listener) => diagramRenderService.subscribe(key, listener),
    () => diagramRenderService.state(key),
  );
  useEffect(() => {
    diagramRenderService.request({
      key,
      source: view.source.canonical,
      variables: diagramTheme(palette).variables,
    });
  }, [key, view.source.canonical, palette]);

  const body = diagramBlockBody(state, width);
  const render = body.kind === "drawing" ? body.render : null;
  const caption = (
    <Text numberOfLines={1} style={[styles.caption, { color: palette.sec }]}>
      {diagramCaption(view)}
    </Text>
  );
  const content =
    body.kind === "source" ? (
      <CodeBlock
        text={view.source.canonical}
        lang="mermaid"
        palette={palette}
        background={view.tokens.surface}
        testID={`${testID}-source`}
      />
    ) : body.kind === "placeholder" ? (
      <View
        testID={`${testID}-placeholder`}
        style={[styles.placeholder, { height: body.box.height, borderColor: palette.sep }]}
      />
    ) : (
      <DrawingBody body={body} palette={palette} hint={words.zoomHint} testID={testID} />
    );
  return (
    <View style={styles.block}>
      <Pressable
        testID={testID}
        accessible
        accessibilityRole="image"
        accessibilityLabel={view.accessibilityLabel}
        accessibilityActions={[...diagramA11yActions(words)]}
        onAccessibilityAction={(event) => {
          const effect = diagramA11yEffect(event.nativeEvent.actionName);
          if (effect !== null) setTab(effect);
        }}
        onPress={() => setTab(body.tapTab)}
        style={styles.press}
      >
        {caption}
        {content}
      </Pressable>
      {tab === null ? null : (
        <DiagramFullScreen
          view={view}
          render={render}
          tab={tab}
          fileUri={render === null ? null : diagramFileUri(key)}
          words={words}
          palette={palette}
          reduceMotion={reduceMotion !== false}
          testID={`${testID}-full`}
          onTab={setTab}
          onClose={() => setTab(null)}
        />
      )}
    </View>
  );
}

/** The drawing, cut at the cap with a bottom fade and the zoom hint. */
function DrawingBody({
  body,
  palette,
  hint,
  testID,
}: {
  readonly body: Extract<DiagramBlockBody, { kind: "drawing" }>;
  readonly palette: Palette;
  readonly hint: string;
  readonly testID: string;
}): JSX.Element {
  const { render, box } = body;
  return (
    <View style={{ width: box.width, height: box.height }} pointerEvents="none">
      <DiagramView
        svg={render.svg}
        background={palette.page}
        zoom={false}
        width={box.width}
        height={box.height}
        testID={`${testID}-drawing`}
      />
      {box.clipped ? (
        <View style={styles.fade}>
          <Svg width={box.width} height={FADE}>
            <Defs>
              <LinearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={palette.page} stopOpacity="0" />
                <Stop offset="1" stopColor={palette.page} stopOpacity="1" />
              </LinearGradient>
            </Defs>
            <Rect width={box.width} height={FADE} fill="url(#fade)" />
          </Svg>
          <Text style={[styles.hint, { color: palette.sec }]}>{hint}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { paddingVertical: 8 },
  press: { alignItems: "center", gap: 8 },
  caption: { fontFamily: MONO, fontSize: 12, textAlign: "center" },
  placeholder: { alignSelf: "stretch", borderTopWidth: StyleSheet.hairlineWidth },
  fade: { position: "absolute", left: 0, right: 0, bottom: 0, alignItems: "center" },
  hint: { position: "absolute", bottom: 6, fontFamily: MONO, fontSize: 11 },
});
