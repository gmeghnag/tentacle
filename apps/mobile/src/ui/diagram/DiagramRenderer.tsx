/**
 * The ONE hidden diagram renderer of a session screen (docs/feat/model-diagrams.md
 * D6, Owner Q2a): our generated page (bundled mermaid + driver) under
 * `artifactCsp()`, offline. It is the only WebView in the app with an
 * `onMessage`, and the message goes straight to the service, which accepts it
 * only through `parseDiagramReply`. It draws nothing on screen: the inert
 * `DiagramView` shows the SVG it returns.
 *
 * A dumb mount: `diagram-render-service.ts` decides what is asked and when.
 */
import { type JSX, useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { navigationPredicate, webViewParts } from "../../artifact-viewer.ts";
import { diagramRendererProps } from "../../diagram-display.ts";
import { diagramRenderService, loadRendererPage } from "../../diagram-render-expo.ts";

export function DiagramRenderer(): JSX.Element | null {
  const [page, setPage] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  // `WebView<P = undefined>` types its props `WebViewProps & P`: a bare `WebView`
  // ref pins P to `undefined` and every prop to `never`.
  const view = useRef<WebView<object> | null>(null);
  const detach = useRef<(() => void) | null>(null);

  useEffect(() => {
    let live = true;
    loadRendererPage().then(
      (html) => live && setPage(html),
      () => undefined, // no page: every diagram row keeps its source (the service never attaches)
    );
    return () => {
      live = false;
      detach.current?.();
      detach.current = null;
    };
  }, []);

  if (page === null) return null;
  const data = diagramRendererProps(page);
  const { source, flags } = webViewParts(data);
  const allow = navigationPredicate(data);
  const attach = () => {
    detach.current?.();
    detach.current = diagramRenderService.attach({
      inject: (script) => view.current?.injectJavaScript(script),
      reload: () => {
        detach.current?.();
        detach.current = null;
        setGeneration((n) => n + 1);
      },
    });
  };
  return (
    <View
      style={styles.hidden}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <WebView
        key={`renderer-${generation}`}
        ref={view}
        testID="diagram-renderer"
        style={styles.fill}
        onLoadEnd={attach}
        onMessage={(event: WebViewMessageEvent) =>
          diagramRenderService.receive(event.nativeEvent.data)
        }
        source={source}
        {...flags}
        originWhitelist={[...flags.originWhitelist]}
        onShouldStartLoadWithRequest={(request: { url: string }) => allow(request.url)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // Laid out (mermaid measures text), never seen, never touched.
  hidden: { position: "absolute", left: 0, top: 0, width: 320, height: 2, opacity: 0 },
  fill: { flex: 1 },
});
