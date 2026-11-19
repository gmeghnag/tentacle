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
import { type JSX, memo, useEffect, useRef, useState } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import { Path, Svg } from "react-native-svg";
import { type HubActionId, type HubItem, itemA11yLabel } from "../hub-actions.ts";
import {
  type FanLayout,
  type FanMotion,
  ITEM_SIZE,
  type Point,
  fanItemLook,
  labelPlacement,
} from "../hub-fan.ts";
import { type Flash, pillIndex, pillText } from "../hub-flash.ts";
import { PERF } from "../perf-probe.ts";
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
  tools: "powerplug",
  // Commands draws its own bare `>_` (`CommandsGlyph`): SF Symbols has no glyph
  // for it that is not a framed window (owner Q1: glyph A, a bare `>_`).
  commands: "terminal",
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
  /**
   * The dimmed item whose reason is showing in place, with the clock reading at
   * its tap (mobile-hub-commands C1 Design 7). The timer that ends it is the
   * button's (`FloatingActivity`), which passes `now` back down; `hub-flash.ts`
   * decides the text and the visibility.
   */
  readonly flash: Flash | null;
  /** The clock, read at the tap and again when the flash timer fires. */
  readonly now: number;
  readonly onTapOverlay: (p: Point) => void;
}

/**
 * Memoized (docs/fix/mobile-fan-jank-device.md): the session screen re-renders
 * while a turn streams, and the open fan — a dozen discs, their glyphs and rims
 * — has nothing to redraw unless its own props change. The button hands it
 * stable values (the fan's state, one `motion` object, a stable tap handler).
 */
export const HubFan = memo(HubFanView);

function HubFanView(props: HubFanProps): JSX.Element {
  const { palette, layout, items, hi, motion, band, flash, now } = props;
  // One value per item, created at the open (this view mounts with the fan).
  const grow = useRef(layout.items.map(() => new Animated.Value(0))).current;
  // Started ONCE per open: `grow` is per mount and `motion` is one object per
  // mode (`fanMotion`), so a re-render never restarts the springs mid-flight
  // (the device jank: a restart per streamed delta also re-ran the stagger).
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
    // The perf trace (docs/fix/mobile-fan-jank-device.md): each start, and the end.
    PERF.fanStart();
    Animated.parallel(anims).start(({ finished }) => PERF.fanSettle(finished));
  }, [grow, motion]);

  const [labelSize, setLabelSize] = useState<{ width: number; height: number } | null>(null);
  // ONE pill: the finger's highlight, or the item that is flashing its reason
  // (`hub-flash.ts`). Which text it says is that module's decision too.
  const shown = pillIndex(hi, flash, now);
  const label = shown === null ? null : (items[shown] ?? null);
  const labelText = shown === null || label === null ? null : pillText(label, shown, flash, now);
  const labelAt =
    shown === null || labelSize === null
      ? null
      : labelPlacement(layout, shown, labelSize, {
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
                // Dimmed: a DASHED hairline (owner Q3 A) — a shape, so the state
                // is not carried by the grey alone.
                borderStyle: look.dashed ? "dashed" : "solid",
                shadowOpacity: palette.shadowOpacity,
                opacity,
                transform: [{ scale }],
              },
            ]}
          >
            {/* The glyph at 38 % when dimmed (Q3 A): its own opacity, so the disc
                stays solid and no transcript shows through. */}
            <View style={{ opacity: look.glyphOpacity }}>
              {item.id === "commands" ? (
                <CommandsGlyph color={palette[look.fg]} />
              ) : (
                <Icon name={GLYPH[item.id]} color={palette[look.fg]} size={20} />
              )}
            </View>
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
      {label === null || labelText === null ? null : (
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
            {labelText}
          </Text>
        </View>
      )}
    </View>
  );
}

/**
 * The Commands item's glyph (owner Q1 glyph A): a bare `>_` — a chevron and an
 * underscore, 1.5 stroke on a 24 grid, the same weight and silhouette as the
 * plug and the paperclip, so it reads as "terminal" at 22 pt without a frame
 * inside the disc. Drawn with `react-native-svg` (already a dependency, and the
 * chart glyphs' renderer) because SF Symbols has no bare `>_`.
 */
function CommandsGlyph({ color }: { readonly color: string }): JSX.Element {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24">
      <Path
        d="M5 7.5l4.5 4.5L5 16.5M12 17h7"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
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
