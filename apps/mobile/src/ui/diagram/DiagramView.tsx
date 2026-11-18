/**
 * The inert diagram display (docs/feat/model-diagrams.md D6, Owner Q2a): the SVG
 * the hidden renderer returned, in a WebView with the artifacts viewer's
 * isolation and scripts OFF (`diagramDisplayProps` → `htmlViewerProps`). No
 * `onMessage`, no injected script: even a hostile SVG is a picture here.
 * `test/diagram-wiring.test.ts` pins that.
 */
import type { JSX } from "react";
import { WebView } from "react-native-webview";
import { navigationPredicate, webViewParts } from "../../artifact-viewer.ts";
import { diagramDisplayProps } from "../../diagram-display.ts";

export interface DiagramViewProps {
  readonly svg: string;
  /** The page colour (no card: the conversation background). */
  readonly background: string;
  /** Full screen: pinch-zoom and scroll. Inline: a fixed picture. */
  readonly zoom: boolean;
  readonly width: number | "100%";
  readonly height: number | "100%";
  readonly testID: string;
}

export function DiagramView(p: DiagramViewProps): JSX.Element {
  const data = diagramDisplayProps(p.svg, { background: p.background, zoom: p.zoom });
  const { source, flags } = webViewParts(data);
  const allow = navigationPredicate(data);
  return (
    <WebView
      testID={p.testID}
      style={{ width: p.width, height: p.height, backgroundColor: p.background }}
      scrollEnabled={p.zoom}
      source={source}
      {...flags}
      originWhitelist={[...flags.originWhitelist]}
      onShouldStartLoadWithRequest={(request) => allow(request.url)}
    />
  );
}
