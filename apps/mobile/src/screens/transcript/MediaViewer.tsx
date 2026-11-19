/**
 * A message's photos, full screen (fix/mobile-media-live item 4; the owner's
 * mockup F from feat/mobile-thinking-images S4: tap → full screen with ✕,
 * "2 of 5", swipe, pinch, caption, share).
 *
 * A `Modal` over a scrim, exactly the shape `RenameSheet`/`Sheet` already use.
 * In it: a paging `ScrollView` (one page per photo that HAS pixels), and each
 * page a zooming `ScrollView` — RN's own pinch, no gesture library (Owner Q6).
 * WHICH photos are in it, and which one a tap opened, is the caller's decision
 * (`media-layout.ts` `viewerPages`: a tile the row draws a label for has no
 * pixels and is skipped, never opened as an empty page). `index < 0` = closed,
 * one state, never a parallel `visible` flag.
 */
import { type JSX, useEffect, useState } from "react";
import {
  Image,
  Modal,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { type ViewerItem, viewerPageAt } from "../../media-layout.ts";
import { DENSE_FONT_SCALE, type Palette, radius, space, typography } from "../../theme.ts";
import { Icon } from "../../ui/Icon.tsx";

export interface MediaViewerProps {
  /** The photos to page through, in the message's order. */
  readonly items: readonly ViewerItem[];
  /** The page open right now; -1 = closed. */
  readonly index: number;
  /** The message's own words, under the photos (the viewer's caption). */
  readonly caption: string;
  readonly palette: Palette;
  readonly onClose: () => void;
}

export function MediaViewer({
  items,
  index,
  caption,
  palette,
  onClose,
}: MediaViewerProps): JSX.Element {
  const { width } = useWindowDimensions();
  /** The page the person swiped to (the tap's page is `index` until they do). */
  const [page, setPage] = useState(index);
  // A new tap (or the close) restarts the pager on the tapped page.
  useEffect(() => setPage(index), [index]);
  const current = items[Math.max(0, page)];
  return (
    <Modal
      visible={index >= 0 && current !== undefined}
      animationType="fade"
      transparent
      // Android's back gesture is this screen's second way out; iOS uses the tap
      // on the ✕.
      onRequestClose={onClose}
      supportedOrientations={["portrait", "landscape"]}
    >
      <View style={styles.scrim} testID="media-viewer">
        <View style={styles.bar}>
          {/* "2 of 5" — the message's own count, not the page's position in the
              pager alone: a photo with no pixels is not a page (viewerPages). */}
          <Text
            testID="media-viewer-count"
            numberOfLines={1}
            maxFontSizeMultiplier={DENSE_FONT_SCALE}
            style={[typography.caption, styles.header, { color: palette.label }]}
          >
            {index < 0 ? "" : `${Math.max(0, page) + 1} of ${items.length}`}
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
        <ScrollView
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          // The tap's own page: the pager starts where the person pointed.
          contentOffset={{ x: Math.max(0, index) * width, y: 0 }}
          // The resting page drives the count and Share (`viewerPageAt`, pure).
          onMomentumScrollEnd={(event) =>
            setPage(viewerPageAt(event.nativeEvent.contentOffset.x, width, items.length))
          }
          style={styles.pager}
        >
          {items.map((item) => (
            <ScrollView
              // iOS's own pinch: a page twice the screen's size is reachable.
              key={item.uri}
              maximumZoomScale={4}
              minimumZoomScale={1}
              centerContent
              style={{ width }}
              contentContainerStyle={styles.page}
            >
              <Image
                source={{ uri: item.uri }}
                style={{ width, height: "100%" }}
                resizeMode="contain"
                accessibilityIgnoresInvertColors
                accessibilityLabel={item.label}
              />
            </ScrollView>
          ))}
        </ScrollView>
        <View style={styles.bar}>
          <Text
            numberOfLines={2}
            maxFontSizeMultiplier={DENSE_FONT_SCALE}
            style={[typography.caption, styles.caption, { color: palette.sec }]}
          >
            {caption}
          </Text>
          {current === undefined ? null : (
            <Pressable
              testID="media-viewer-share"
              accessibilityRole="button"
              accessibilityLabel="Share the photo"
              hitSlop={12}
              // iOS shares a `file://` URL as the photo itself (Owner Q6: RN
              // only, no share library).
              onPress={() => void Share.share({ url: current.uri })}
              style={[styles.close, { backgroundColor: palette.fill }]}
            >
              <Icon name="square.and.arrow.up" color={palette.label} size={16} />
            </Pressable>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.92)" },
  pager: { flex: 1 },
  page: { alignItems: "center", justifyContent: "center" },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.transcript,
    paddingHorizontal: space.inset,
    paddingVertical: space.transcript,
  },
  header: { flex: 1 },
  caption: { flex: 1 },
  close: {
    width: 32,
    height: 32,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
});
