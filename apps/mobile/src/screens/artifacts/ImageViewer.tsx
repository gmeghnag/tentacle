/**
 * Image artifact viewer (docs/feat/model-artifacts.md D9): native pinch and
 * double-tap zoom (a `ScrollView` with `maximumZoomScale={6}`) over the soft
 * dark ground (B1 `#1F1F1E`, never pure black). Render only.
 */
import type { JSX } from "react";
import { Image, ScrollView, StyleSheet, useWindowDimensions } from "react-native";

/** B1's soft dark ground (the mockups' image viewer). */
const GROUND = "#1F1F1E";

export interface ImageViewerProps {
  /** `file:` uri of the cached, sha-verified copy. */
  readonly fileUri: string;
  readonly title: string;
}

export function ImageViewer({ fileUri, title }: ImageViewerProps): JSX.Element {
  const { width, height } = useWindowDimensions();
  return (
    <ScrollView
      testID="artifact-image-viewer"
      style={styles.ground}
      contentContainerStyle={styles.center}
      maximumZoomScale={6}
      minimumZoomScale={1}
      centerContent
      showsHorizontalScrollIndicator={false}
      showsVerticalScrollIndicator={false}
    >
      <Image
        testID="artifact-image"
        accessibilityLabel={title}
        source={{ uri: fileUri }}
        resizeMode="contain"
        style={{ width, height: height * 0.8 }}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  ground: { flex: 1, backgroundColor: GROUND },
  center: { flexGrow: 1, alignItems: "center", justifyContent: "center" },
});
