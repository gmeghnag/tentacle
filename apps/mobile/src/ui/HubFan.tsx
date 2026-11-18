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
import { type HubActionId, type HubItem, itemA11yLabel } from "../hub-actions.ts";
import {
  type FanLayout,
  type FanMotion,
  ITEM_SIZE,
  type Point,
  fanItemLook,
  labelPlacement,
} from "../hub-fan.ts";
import { type Palette, shadow, typography } from "../theme.ts";
import { Icon, type IconName } from "./Icon.tsx";
import { RingArc } from "./RingArc.tsx";

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
 * How faint a dimmed item is: a COLOUR (`fanItemLook`'s `fill`/`sec`), not an
 * opacity — the discs are solid (mobile-hub-badges Q3 B), so a faint layer would
 * let the transcript through again, which is the bug this task fixes.
 */
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
        // What this disc and its rim LOOK like is `fanItemLook`'s (Design 7); a
        // dimmed item is a `fill` disc with a `sec` glyph — faintness is a colour,
        // so the item's opacity stays purely its own spring/fade/highlight motion
        // (a second `opacity` style would win over the animation and draw the disc
        // before the fan opens and behind it after it closes).
        const look = fanItemLook(item, lit);
        const opacity = hi !== null && !lit ? motion.dimOpacity : value;
        return (
          <Animated.View
            key={item.id}
            testID={`hub-item-${item.id}`}
            accessible
            accessibilityRole="button"
            accessibilityLabel={itemA11yLabel(item)}
            accessibilityState={{ disabled: item.dimmed }}
            pointerEvents="none"
            style={[
              styles.item,
              {
                left: at.x - ITEM_SIZE / 2,
                top: at.y - ITEM_SIZE / 2,
                backgroundColor: palette[look.bg],
                borderColor: palette.glassBorder,
                shadowOpacity: palette.shadowOpacity,
                opacity,
                transform: [{ scale }],
              },
            ]}
          >
            <Icon name={GLYPH[item.id]} color={palette[look.fg]} size={20} />
            {/* The count as a shape (owner Q2 C): 36° per item, the hub's running
                arc's own language. No track — the disc is the track. */}
            {look.rim === null ? null : (
              <View testID={`hub-rim-${item.id}`} pointerEvents="none" style={styles.rim}>
                <RingArc
                  diameter={ITEM_SIZE}
                  stroke={2}
                  fraction={look.rim}
                  tone={palette[look.rimTone]}
                />
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
              backgroundColor: palette.card,
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
  // The count rim: the shared partial ring laid over the disc (the disc is the
  // track), so the count never moves the glyph.
  rim: { position: "absolute", top: 0, left: 0 },
  label: {
    position: "absolute",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 10,
    borderWidth: 1,
  },
});
