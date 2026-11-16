/**
 * One attached photo, full screen (fix/mobile-media-live item 4, the owner's
 * "tapping the image opens it full screen").
 *
 * A `Modal` + `Image` over a scrim, exactly the shape `RenameSheet`/`Sheet`
 * already use — and deliberately dumb: it draws the URI it is given and offers
 * one way out (tap, or the close glyph). WHICH URI to open is the caller's
 * decision (`TranscriptRow`'s: a ref that has a local copy, never one that
 * cannot be fetched).
 *
 * No zoom, no paging, no share: those are not in this task, and a half-built
 * gesture layer is worse than none.
 */
import type { JSX } from "react";
import { Image, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { DENSE_FONT_SCALE, type Palette, radius, space, typography } from "../../theme.ts";
import { Icon } from "../../ui/Icon.tsx";

export interface MediaViewerProps {
  /** The image open right now; null = closed (one state, never a parallel flag). */
  readonly open: { readonly uri: string; readonly label: string } | null;
  readonly palette: Palette;
  readonly onClose: () => void;
}

export function MediaViewer({ open, palette, onClose }: MediaViewerProps): JSX.Element {
  return (
    <Modal
      visible={open !== null}
      animationType="fade"
      transparent
      // Android's back gesture is this screen's second way out; iOS uses the tap
      // and the close glyph.
      onRequestClose={onClose}
      supportedOrientations={["portrait", "landscape"]}
    >
      <View style={styles.scrim} testID="media-viewer">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close the photo"
          onPress={onClose}
          style={styles.imageArea}
        >
          {open === null ? null : (
            <Image
              source={{ uri: open.uri }}
              style={styles.image}
              resizeMode="contain"
              accessibilityIgnoresInvertColors
            />
          )}
        </Pressable>
        <View style={styles.bar}>
          <Text
            numberOfLines={1}
            maxFontSizeMultiplier={DENSE_FONT_SCALE}
            style={[typography.caption, styles.label, { color: palette.sec }]}
          >
            {open?.label ?? ""}
          </Text>
          <Pressable
            testID="media-viewer-close"
            accessibilityRole="button"
            accessibilityLabel="Close"
            hitSlop={12}
            onPress={onClose}
            style={[styles.close, { backgroundColor: palette.fill }]}
          >
            <Icon name="xmark" color={palette.label} size={16} />
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.92)" },
  imageArea: { flex: 1, alignItems: "center", justifyContent: "center" },
  image: { width: "100%", height: "100%" },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.transcript,
    paddingHorizontal: space.inset,
    paddingBottom: space.inset * 2,
  },
  label: { flex: 1 },
  close: {
    width: 32,
    height: 32,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
});
