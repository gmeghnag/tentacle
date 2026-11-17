/**
 * The hub's radial fan (docs/feat/mobile-hub.md H3, Design 3/4/8): the scrim,
 * the items and the highlighted item's label. Render only — where each item
 * sits is `hub-fan.ts`'s `fanLayout` (solved once, at the open), which item is
 * highlighted is the gesture machine's, the label's spot is `labelPlacement`,
 * and how it moves is `fanMotion`. Coordinates are the band's: this view fills
 * the band, so a tap's local point IS a band point.
 *
 * Touch: during a press the BUTTON's responder owns the finger (the items have
 * no handlers, `pointerEvents="none"`). Lifted in place (sticky), a tap lands on
 * the scrim, which hands its point to the machine (`tapOverlay`): an item within
 * reach commits, anywhere else closes.
 */
import { type JSX, useEffect, useRef, useState } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import type { HubActionId, HubItem } from "../hub-actions.ts";
import {
  type FanLayout,
  type FanMotion,
  ITEM_SIZE,
  type Point,
  labelPlacement,
} from "../hub-fan.ts";
import { DENSE_FONT_SCALE, type Palette, shadow, typography } from "../theme.ts";
import { Icon, type IconName } from "./Icon.tsx";

const GLYPH: Readonly<Record<HubActionId, IconName>> = {
  stop: "stop.fill",
  steer: "bubble.left",
  attach: "photo",
  activity: "bolt.fill",
  artifacts: "doc.on.doc",
  sessions: "folder",
  info: "laptopcomputer",
  scheduled: "clock",
  dictate: "mic",
  new: "square.and.pencil",
  more: "ellipsis",
};

/**
 * How faint a dimmed item is drawn (mobile-hub-tap Design 5). A placeholder: the
 * solid discs of feat/mobile-hub-badges replace it (owner Q5).
 */
const DIMMED_OPACITY = 0.45;

export interface HubFanProps {
  readonly palette: Palette;
  readonly layout: Extract<FanLayout, { kind: "fan" }>;
  /** In the layout's order (the same snapshot). */
  readonly items: readonly HubItem[];
  readonly hi: number | null;
  readonly motion: FanMotion;
  readonly band: { readonly width: number; readonly height: number };
  readonly onTapOverlay: (p: Point) => void;
}

export function HubFan(props: HubFanProps): JSX.Element {
  const { palette, layout, items, hi, motion, band } = props;
  // One value per item, created at the open (this view mounts with the fan).
  const grow = useRef(layout.items.map(() => new Animated.Value(0))).current;
  useEffect(() => {
    const anims = grow.map((value, i) =>
      motion.spring
        ? Animated.spring(value, {
            toValue: 1,
            damping: motion.damping,
            stiffness: motion.stiffness,
            delay: i * motion.staggerMs,
            useNativeDriver: true,
          })
        : Animated.timing(value, { toValue: 1, duration: motion.fadeMs, useNativeDriver: true }),
    );
    Animated.parallel(anims).start();
  }, [grow, motion]);

  const [labelSize, setLabelSize] = useState<{ width: number; height: number } | null>(null);
  const label = hi === null ? null : items[hi];
  const labelAt =
    hi === null || labelSize === null
      ? null
      : labelPlacement(layout, hi, labelSize, {
          left: 0,
          top: 0,
          right: band.width,
          bottom: band.height,
        });

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <View
        testID="hub-scrim"
        style={[StyleSheet.absoluteFill, { backgroundColor: palette.scrim, opacity: 0.4 }]}
        onStartShouldSetResponder={() => true}
        onResponderRelease={(e) =>
          props.onTapOverlay({ x: e.nativeEvent.locationX, y: e.nativeEvent.locationY })
        }
      />
      {layout.items.map((at, i) => {
        const item = items[i];
        if (item === undefined) {
          return null;
        }
        const lit = hi === i;
        const value = grow[i] ?? new Animated.Value(1);
        const scale = value.interpolate({
          inputRange: [0, 1],
          outputRange: [motion.fromScale, lit ? motion.highlightScale : 1],
        });
        const fg = lit ? palette.onAccent : item.danger ? palette.red : palette.accent;
        // A dimmed item has nothing to show: it KEEPS its slot, drawn faint
        // (mobile-hub-tap Design 5 — badges restyles this into a solid disc).
        // The faint level MULTIPLIES the item's own animated opacity (its spring/
        // fade `value`, or the highlight dim): both are opacities of the same
        // view, so a second `opacity` style would win over the animation and draw
        // the disc before the fan opens and behind it after it closes.
        const base = hi !== null && !lit ? motion.dimOpacity : value;
        const opacity = item.dimmed && !lit ? Animated.multiply(base, DIMMED_OPACITY) : base;
        return (
          <Animated.View
            key={item.id}
            testID={`hub-item-${item.id}`}
            accessible
            accessibilityRole="button"
            accessibilityLabel={item.dimmed ? `${item.label}, nothing running` : item.label}
            accessibilityState={{ disabled: item.dimmed }}
            pointerEvents="none"
            style={[
              styles.item,
              {
                left: at.x - ITEM_SIZE / 2,
                top: at.y - ITEM_SIZE / 2,
                backgroundColor: lit
                  ? item.danger
                    ? palette.red
                    : palette.accentFill
                  : palette.glass,
                borderColor: palette.glassBorder,
                shadowOpacity: palette.shadowOpacity,
                opacity,
                transform: [{ scale }],
              },
            ]}
          >
            <Icon name={GLYPH[item.id]} color={fg} size={20} />
            {item.badge === null ? null : (
              <View style={[styles.badge, { backgroundColor: palette.accentFill }]}>
                {item.badge.kind === "count" ? (
                  <Text
                    maxFontSizeMultiplier={DENSE_FONT_SCALE}
                    style={[typography.caption, styles.badgeText, { color: palette.onAccent }]}
                  >
                    {item.badge.n}
                  </Text>
                ) : null}
              </View>
            )}
          </Animated.View>
        );
      })}
      {label === null || label === undefined ? null : (
        <View
          testID="hub-label"
          pointerEvents="none"
          onLayout={(e) => {
            const { width, height } = e.nativeEvent.layout;
            if (labelSize === null || labelSize.width !== width || labelSize.height !== height) {
              setLabelSize({ width, height });
            }
          }}
          style={[
            styles.label,
            {
              backgroundColor: palette.glass,
              borderColor: palette.glassBorder,
              maxWidth: band.width - 16,
              left: labelAt?.x ?? 0,
              top: labelAt?.y ?? 0,
              opacity: labelAt === null ? 0 : 1,
            },
          ]}
        >
          <Text
            numberOfLines={2}
            style={[
              typography.footnote,
              { color: label.danger ? palette.red : palette.label, fontWeight: "600" },
            ]}
          >
            {label.label}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  item: {
    position: "absolute",
    width: ITEM_SIZE,
    height: ITEM_SIZE,
    borderRadius: ITEM_SIZE / 2,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    ...shadow.glass,
  },
  badge: {
    position: "absolute",
    top: -2,
    right: -2,
    minWidth: 12,
    height: 12,
    borderRadius: 6,
    paddingHorizontal: 3,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: { fontSize: 9, fontWeight: "700" },
  label: {
    position: "absolute",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 10,
    borderWidth: 1,
  },
});
