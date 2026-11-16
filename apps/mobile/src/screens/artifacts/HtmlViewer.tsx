/**
 * HTML / SVG artifact viewer (docs/feat/model-artifacts.md D9, Owner Q5/Q5b).
 *
 * Fully isolated: every WebView prop comes from `artifact-viewer.ts` as data
 * (`htmlViewerProps` → `webViewParts`) and every navigation goes through
 * `navigationPredicate`. There is deliberately NO `onMessage` (without it no
 * `window.ReactNativeWebView` bridge is injected), NO `injectedJavaScript`, NO
 * `onOpenWindow` (a `window.open` then loads in this view and meets the
 * predicate). `test/artifact-viewers-wiring.test.ts` pins all of that.
 *
 * Network is OFF per open; "Allow" asks once and reloads (a new `key`) without
 * the CSP's network clauses — for THIS open only, never remembered.
 */
import { type JSX, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import {
  htmlViewerProps,
  navigationPredicate,
  networkBarLabel,
  webViewParts,
} from "../../artifact-viewer.ts";
import { type Palette, typography } from "../../theme.ts";

export interface HtmlViewerProps {
  readonly palette: Palette;
  /** The verified bytes, decoded as text. */
  readonly body: string;
  /** `viewerFor(meta).scripts` — the owner's per-kind decision. */
  readonly scripts: boolean;
}

export function HtmlViewer({ palette, body, scripts }: HtmlViewerProps): JSX.Element {
  const [network, setNetwork] = useState(false);
  const data = htmlViewerProps({ body, network, scripts });
  const { source, flags } = webViewParts(data);
  const allow = navigationPredicate(data);
  const askNetwork = () =>
    Alert.alert("Allow network?", "The page can then reach the internet until you close it.", [
      { text: "Cancel", style: "cancel" },
      { text: "Allow", onPress: () => setNetwork(true) },
    ]);
  return (
    <View style={styles.fill} testID="artifact-html-viewer">
      <View style={[styles.bar, { borderBottomColor: palette.sep }]}>
        <Text
          testID={network ? "artifact-network-on" : "artifact-network-off"}
          style={[typography.footnote, { color: palette.sec }]}
        >
          {networkBarLabel(network)}
        </Text>
        {network ? null : (
          <Pressable
            testID="artifact-network-allow"
            accessibilityRole="button"
            onPress={askNetwork}
            hitSlop={12}
          >
            <Text style={[typography.footnote, { color: palette.accent }]}>Allow</Text>
          </Pressable>
        )}
      </View>
      <WebView
        key={network ? "online" : "offline"}
        testID="artifact-webview"
        style={styles.fill}
        source={source}
        {...flags}
        originWhitelist={[...flags.originWhitelist]}
        onShouldStartLoadWithRequest={(request) => allow(request.url)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  bar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});
