/**
 * The list screens' top bar (slice-6 visual review V1). At rest it is only a
 * status-bar-high strip in the page colour, so content scrolled up is clipped
 * under it instead of running under the clock; once the large title has slid
 * away (`header-collapse.ts`) it becomes the compact bar — the title inline,
 * 17/22 semibold, over blur, with a hairline. Render only: the screen passes
 * `shown` from `useCompactTitle`, which feeds the pure rule the scroll offset.
 */
import { BlurView } from "expo-blur";
import { type JSX, useCallback, useState } from "react";
import {
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { COMPACT_BAR_HEIGHT, compactTitleShown } from "../header-collapse.ts";
import { DENSE_FONT_SCALE, type Palette, space, typography } from "../theme.ts";

export interface CompactBarProps {
  readonly palette: Palette;
  readonly title: string;
  readonly shown: boolean;
  /** The page colour behind the strip at rest (lists: `bg`). */
  readonly surface?: string;
}

export function CompactBar({ palette, title, shown, surface }: CompactBarProps): JSX.Element {
  const insets = useSafeAreaInsets();
  if (!shown) {
    return (
      <View
        pointerEvents="none"
        style={[styles.bar, { height: insets.top, backgroundColor: surface ?? palette.bg }]}
      />
    );
  }
  return (
    <View
      pointerEvents="none"
      style={[
        styles.bar,
        {
          height: insets.top + COMPACT_BAR_HEIGHT,
          paddingTop: insets.top,
          borderBottomColor: palette.sep,
        },
        styles.hairline,
      ]}
    >
      <BlurView intensity={80} tint="systemChromeMaterial" style={StyleSheet.absoluteFill} />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: palette.glass }]} />
      <Text
        accessibilityRole="header"
        numberOfLines={1}
        maxFontSizeMultiplier={DENSE_FONT_SCALE}
        style={[typography.headline, styles.title, { color: palette.label }]}
      >
        {title}
      </Text>
    </View>
  );
}

/** The bar's state for a scroll view: pass `onScroll` + `scrollEventThrottle`. */
export function useCompactTitle(): {
  readonly shown: boolean;
  readonly onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  readonly scrollEventThrottle: number;
} {
  const [shown, setShown] = useState(false);
  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = compactTitleShown(event.nativeEvent.contentOffset.y);
    setShown((prev) => (prev === next ? prev : next));
  }, []);
  return { shown, onScroll, scrollEventThrottle: 16 };
}

const styles = StyleSheet.create({
  bar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    justifyContent: "center",
    overflow: "hidden",
  },
  hairline: { borderBottomWidth: StyleSheet.hairlineWidth },
  title: { textAlign: "center", paddingHorizontal: space.inset * 4 },
});
