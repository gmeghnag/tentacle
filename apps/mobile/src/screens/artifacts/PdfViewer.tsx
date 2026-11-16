/**
 * PDF artifact viewer (docs/feat/model-artifacts.md D9): the same isolated
 * WebView, pointed at the verified cached file, scripts OFF — WKWebView renders
 * the PDF natively (continuous scroll), so no PDF module is needed. The
 * predicate allows exactly that one file uri; no bridge, no injected script.
 */
import type { JSX } from "react";
import { StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";
import { navigationPredicate, pdfViewerProps, webViewParts } from "../../artifact-viewer.ts";

export interface PdfViewerProps {
  /** `file:` uri of the cached, sha-verified copy. */
  readonly fileUri: string;
}

export function PdfViewer({ fileUri }: PdfViewerProps): JSX.Element {
  const data = pdfViewerProps(fileUri);
  const { source, flags } = webViewParts(data);
  const allow = navigationPredicate(data);
  return (
    <View style={styles.fill} testID="artifact-pdf-viewer">
      <WebView
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

const styles = StyleSheet.create({ fill: { flex: 1 } });
