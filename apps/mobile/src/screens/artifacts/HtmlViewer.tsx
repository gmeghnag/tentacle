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
 * the CSP's network clauses — for THIS open only, never remembered. Scripts are
 * OFF by default too (Owner Q5's pre-decided fallback: the escape suite that
 * would justify the primary has not run, and CSP does not govern WebRTC), with
 * the same shape: one tap, this open only.
 */
import { type JSX, useState } from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";
import {
  htmlViewerProps,
  navigationPredicate,
  networkBarLabel,
  scriptsBarLabel,
  webViewParts,
} from "../../artifact-viewer.ts";
import { type Palette, typography } from "../../theme.ts";
import { Text } from "../../ui/Text.tsx";

export interface HtmlViewerProps {
  readonly palette: Palette;
  /** The verified bytes, decoded as text. */
  readonly body: string;
  /** `viewerFor(meta).canRunScripts` — whether the "Run scripts" tap exists. */
  readonly scripts: boolean;
}

export function HtmlViewer({ palette, body, scripts }: HtmlViewerProps): JSX.Element {
  const [network, setNetwork] = useState(false);
  // Owner Q5's fallback: scripts OFF until a person asks for them, for this open.
  const [runScripts, setRunScripts] = useState(false);
  const data = htmlViewerProps({ body, network, scripts: scripts && runScripts });
  const { source, flags } = webViewParts(data);
  const allow = navigationPredicate(data);
  const askNetwork = () =>
    Alert.alert("Allow network?", "The page can then reach the internet until you close it.", [
      { text: "Cancel", style: "cancel" },
      { text: "Allow", onPress: () => setNetwork(true) },
    ]);
  // A page with scripts is arbitrary code from the model or a pod: the confirm
  // says what it means, in one sentence, and nothing is remembered.
  const askScripts = () =>
    Alert.alert(
      "Run scripts?",
      "The page's own code runs until you close it. Its network is still off.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Run", onPress: () => setRunScripts(true) },
      ],
    );
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
      {scripts ? (
        <View style={[styles.bar, { borderBottomColor: palette.sep }]}>
          <Text
            testID={runScripts ? "artifact-scripts-on" : "artifact-scripts-off"}
            style={[typography.footnote, { color: palette.sec }]}
          >
            {scriptsBarLabel(runScripts)}
          </Text>
          {runScripts ? null : (
            <Pressable
              testID="artifact-scripts-run"
              accessibilityRole="button"
              onPress={askScripts}
              hitSlop={12}
            >
              <Text style={[typography.footnote, { color: palette.accent }]}>Run scripts</Text>
            </Pressable>
          )}
        </View>
      ) : null}
      <WebView
        key={`${network ? "online" : "offline"}-${runScripts ? "scripts" : "inert"}`}
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
