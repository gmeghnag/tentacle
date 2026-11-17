/**
 * The floating hub button (docs/feat/mobile-chrome.md Design 6, F2 opt-in;
 * docs/feat/mobile-hub.md H3): a 54 pt glass circle on an edge of the band
 * between the header and the composer. Tap = Activity; hold 400 ms = the radial
 * fan; drag = move it. Render + gesture plumbing only: the press machine and its
 * timer are `hub-session.ts`'s `createHubDriver` (over `hub-gesture.reduce`),
 * the fan's geometry `hub-fan.ts`'s, where it rests and when it shows
 * `floating-button.ts`'s. `PanResponder` (core RN, no gesture library) feeds raw
 * points in: once granted on touch-down it keeps the finger anywhere on screen
 * and refuses to yield (the H3 spike: 155 moves, 659 pt over the transcript,
 * released, never terminated).
 */
import { BlurView } from "expo-blur";
import { type JSX, useEffect, useMemo, useRef, useState } from "react";
import {
  type AccessibilityActionEvent,
  AccessibilityInfo,
  Animated,
  Easing,
  PanResponder,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  FLOAT_SIZE,
  type FloatBounds,
  type FloatPosition,
  a11y,
  motion,
  place,
  snap,
} from "../floating-button.ts";
import { hubHaptic } from "../haptic-rules.ts";
import { playHaptic } from "../haptics.ts";
import type { HubActionId, HubBadge, HubItem } from "../hub-actions.ts";
import { type FanLayout, type Point, fanMotion } from "../hub-fan.ts";
import type { GestureEffect, GestureState, HubMenu } from "../hub-gesture.ts";
import { hubOpacity } from "../hub-opacity.ts";
import {
  type HubWorld,
  bandPoint,
  createHubDriver,
  hubA11yActions,
  hubA11yRoute,
  mustCancel,
} from "../hub-session.ts";
import { DENSE_FONT_SCALE, type Palette, shadow, typography } from "../theme.ts";
import { HubFan } from "./HubFan.tsx";

/**
 * VoiceOver, Reduce Motion and Reduce Transparency, read live (F23;
 * docs/feat/mobile-hub-opacity.md): toggling any of them converges without a
 * restart.
 */
export function useAccessibilityFlags(): {
  voiceOver: boolean;
  reduceMotion: boolean;
  reduceTransparency: boolean;
} {
  const [voiceOver, setVoiceOver] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [reduceTransparency, setReduceTransparency] = useState(false);
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isScreenReaderEnabled().then((on) => live && setVoiceOver(on));
    void AccessibilityInfo.isReduceMotionEnabled().then((on) => live && setReduceMotion(on));
    void AccessibilityInfo.isReduceTransparencyEnabled().then(
      (on) => live && setReduceTransparency(on),
    );
    const reader = AccessibilityInfo.addEventListener("screenReaderChanged", setVoiceOver);
    const reduce = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    const transparency = AccessibilityInfo.addEventListener(
      "reduceTransparencyChanged",
      setReduceTransparency,
    );
    return () => {
      live = false;
      reader.remove();
      reduce.remove();
      transparency.remove();
    };
  }, []);
  return { voiceOver, reduceMotion, reduceTransparency };
}

export interface FloatingActivityProps {
  readonly palette: Palette;
  /** The band's measured size (null until measured). */
  readonly bounds: FloatBounds | null;
  readonly position: FloatPosition | undefined;
  /** `floating-button.ts` `visible`: fades out (and stops taking touches) when false. */
  readonly shown: boolean;
  /** `hub-actions.ts` `buttonBadge`: one badge at most; none → the hub glyph. */
  readonly badge: HubBadge | null;
  /** A turn runs: the thin accent arc spins around the button (not a badge). */
  readonly turnRunning: boolean;
  readonly accessibilityLabel: string;
  readonly voiceOver: boolean;
  readonly reduceMotion: boolean;
  /**
   * iOS Reduce Transparency: the body is always solid
   * (docs/feat/mobile-hub-opacity.md). Read live, like the other two.
   */
  readonly reduceTransparency: boolean;
  /**
   * How see-through the body is at rest, as a percentage (`hub-opacity.ts`);
   * absent → 100 %, today's look. Solid while touched or while the fan is open.
   */
  readonly opacity: number | undefined;
  /** The fan's items NOW (`hubActions(...).fan`); `solve` snapshots them at the open. */
  readonly fanItems: readonly HubItem[];
  /** Everything (no six cap): VoiceOver's actions. */
  readonly allItems: readonly HubItem[];
  /** `hub-session.ts` `solveHub` for the current band, spot and items. */
  readonly solve: () => HubMenu;
  readonly onPress: () => void;
  readonly onDrop: (position: FloatPosition) => void;
  /** The fan opened (true) or closed by any path (false): the screen guards the back-swipe (M2). */
  readonly onFanChange: (open: boolean) => void;
  readonly onCommit: (id: HubActionId) => void;
  /** The plain menu with everything: no fan fits, or VoiceOver's long-press / Show all. */
  readonly onMenu: () => void;
}

interface OpenFan {
  readonly layout: Extract<FanLayout, { kind: "fan" }>;
  readonly items: readonly HubItem[];
  readonly hi: number | null;
}

export function FloatingActivity(props: FloatingActivityProps): JSX.Element | null {
  const {
    palette,
    bounds,
    position,
    shown,
    badge,
    turnRunning,
    voiceOver,
    reduceMotion,
    reduceTransparency,
    opacity: setting,
  } = props;
  const at = bounds === null ? null : place(position, bounds);
  const xy = useRef(new Animated.ValueXY(at ?? { x: 0, y: 0 })).current;
  const opacity = useRef(new Animated.Value(0)).current;
  /** The body layer's own level, under the outer fade (`hub-opacity.ts`). */
  const bodyLevel = useRef(new Animated.Value(1)).current;
  // While a finger holds it, the fan is up or the snap runs, a re-placement must not yank it.
  const moving = useRef(false);
  // The responder and the driver are created once; they read the latest props through this.
  const latest = useRef(props);
  latest.current = props;
  const [fan, setFan] = useState<OpenFan | null>(null);
  // Whether it is engaged (a finger on it, a drag, the fan): solid while it is
  // (`hub-opacity.ts`). A press emits NO effect on down (`hub-gesture.ts:108`),
  // so this cannot come from an effect — it is the machine's state, synced by
  // the one wrapper below (docs/feat/mobile-hub-opacity.md Design 3).
  const [engaged, setEngaged] = useState<GestureState["kind"]>("idle");

  // Re-placed when the stored spot or the band changes (keyboard, rotation).
  const atX = at?.x;
  const atY = at?.y;
  useEffect(() => {
    if (atX !== undefined && atY !== undefined && !moving.current) {
      xy.setValue({ x: atX, y: atY });
    }
  }, [atX, atY, xy]);

  // Fades in/out (150 ms); once faded OUT it unmounts, so neither VoiceOver nor
  // a test finds an invisible button.
  const fadeMs = motion(reduceMotion).fadeMs;
  const [rendered, setRendered] = useState(shown);
  useEffect(() => {
    if (shown) {
      setRendered(true);
    }
    Animated.timing(opacity, {
      toValue: shown ? 1 : 0,
      duration: fadeMs,
      useNativeDriver: false,
    }).start(({ finished }) => {
      if (finished && !shown) {
        setRendered(false);
      }
    });
  }, [shown, fadeMs, opacity]);

  // How see-through the BODY is (docs/feat/mobile-hub-opacity.md): the setting at
  // rest, 1 while touched / with the fan open / under Reduce Transparency. It is a
  // level of its own, INSIDE the outer fade, and the arc is its sibling — so the
  // arc's effective opacity is `fade × 1`, the body's `fade × level`.
  const level = hubOpacity({
    setting,
    gesture: engaged,
    fanOpen: fan !== null,
    reduceTransparency,
  });
  useEffect(() => {
    Animated.timing(bodyLevel, {
      // Up is instant (feedback at once); back down takes the fade.
      toValue: level.body,
      duration: level.body === 1 ? 0 : fadeMs,
      useNativeDriver: false,
    }).start();
  }, [level.body, fadeMs, bodyLevel]);

  // The press: the button's spot at the grant, and the menu solved at the open.
  const press = useRef<{ start: Point; menu: HubMenu | null }>({
    start: { x: 0, y: 0 },
    menu: null,
  });
  // A press cancelled before anything moved emits nothing: let re-placement resume.
  const settle = () => {
    if (driver.state().kind === "idle") {
      moving.current = false;
    }
  };
  const back = () => {
    xy.setValue(press.current.start);
    moving.current = false;
  };
  const drop = (delta: Point) => {
    const p = latest.current;
    const start = press.current.start;
    const centre = { x: start.x + delta.x + FLOAT_SIZE / 2, y: start.y + delta.y + FLOAT_SIZE / 2 };
    const dropped = p.bounds === null ? null : snap(centre, p.bounds);
    const target = dropped === null || p.bounds === null ? null : place(dropped, p.bounds);
    if (dropped === null || target === null) {
      back();
      return;
    }
    if (motion(p.reduceMotion).spring) {
      Animated.spring(xy, { toValue: target, useNativeDriver: false }).start(() => {
        moving.current = false;
      });
    } else {
      xy.setValue(target);
      opacity.setValue(0);
      Animated.timing(opacity, {
        toValue: 1,
        duration: motion(true).fadeMs,
        useNativeDriver: false,
      }).start();
      moving.current = false;
    }
    p.onDrop(dropped);
  };
  // The machine's effects, mapped to what they look like (no decision here).
  const apply = (effects: readonly GestureEffect[]) => {
    for (const effect of effects) {
      playHaptic(hubHaptic(effect));
      switch (effect.kind) {
        case "open": {
          const menu = press.current.menu;
          if (effect.layout.kind === "fan" && menu !== null) {
            const byId = new Map(latest.current.fanItems.map((item) => [item.id, item]));
            const items = menu.ids.flatMap((id) => byId.get(id as HubActionId) ?? []);
            setFan({ layout: effect.layout, items, hi: null });
          } else {
            moving.current = false;
            latest.current.onMenu();
          }
          break;
        }
        case "highlight":
          setFan((open) => (open === null ? null : { ...open, hi: effect.index }));
          break;
        case "commit":
          latest.current.onCommit(effect.id as HubActionId);
          break;
        case "close":
          setFan(null);
          moving.current = false;
          break;
        case "tap":
          back();
          latest.current.onPress();
          break;
        case "dragTo":
          xy.setValue({
            x: press.current.start.x + effect.delta.x,
            y: press.current.start.y + effect.delta.y,
          });
          break;
        case "drop":
          drop(effect.delta);
          break;
        case "dragCancel":
          back();
          break;
        case "haptic":
          break;
      }
    }
    // The state AFTER the effects is the whole answer: a 400 ms hold that opened
    // the fan, a commit, a close, a tap-overlay — every path ends here, so the
    // body can never stay solid after one (`docs/feat/mobile-hub-opacity.md`).
    setEngaged(driver.state().kind);
  };
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const driver = useMemo(
    () =>
      createHubDriver({
        solve: () => {
          const menu = latest.current.solve();
          press.current.menu = menu;
          return menu;
        },
        now: () => Date.now(),
        arm: (fire, ms) => setTimeout(fire, ms),
        disarm: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        apply: (effects) => applyRef.current(effects),
      }),
    [],
  );

  // The fan's open state, reported on every change and on unmount (M2: the
  // back-swipe is restored on every close path).
  const fanOpen = fan !== null;
  useEffect(() => {
    latest.current.onFanChange(fanOpen);
  }, [fanOpen]);
  useEffect(
    () => () => {
      driver.dispose();
      latest.current.onFanChange(false);
    },
    [driver],
  );

  // A sheet/drawer arriving, VoiceOver on, or the band moving cancels an open
  // fan or a press (M6, M10, M15): no commit, no haptic.
  const world: HubWorld = {
    shown,
    voiceOver,
    width: bounds?.width ?? 0,
    height: bounds?.height ?? 0,
  };
  const prevWorld = useRef(world);
  useEffect(() => {
    if (mustCancel(prevWorld.current, world)) {
      driver.cancel();
      settle();
      setEngaged(driver.state().kind);
    }
    prevWorld.current = world;
  });

  // A press emits no effect on down (`hub-gesture.ts:108`), so `apply` alone
  // cannot see it: every direct call into the machine syncs the body's level too.
  const pan = useMemo(() => {
    let local: Point = { x: 0, y: 0 };
    const pointOf = (g: { dx: number; dy: number }) =>
      bandPoint({ buttonAt: press.current.start, local }, { x: g.dx, y: g.dy });
    return PanResponder.create({
      // F21: a touch that STARTS on the button is the button's (the back-swipe
      // keeps every other edge touch). VoiceOver: not draggable (F23).
      onStartShouldSetPanResponder: () => a11y(latest.current.voiceOver).draggable,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (event) => {
        const p = latest.current;
        if (driver.state().kind === "idle") {
          const from = p.bounds === null ? null : place(p.position, p.bounds);
          press.current.start = from ?? { x: 0, y: 0 };
          local = { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY };
          moving.current = true;
        }
        driver.down(pointOf({ dx: 0, dy: 0 }), Date.now());
        setEngaged(driver.state().kind);
      },
      onPanResponderMove: (_event, g) => driver.move(pointOf(g), Date.now()),
      onPanResponderRelease: (_event, g) => {
        driver.up(pointOf(g), Date.now());
        setEngaged(driver.state().kind);
      },
      onPanResponderTerminate: () => {
        driver.cancel();
        setEngaged(driver.state().kind);
        if (driver.state().kind === "idle") {
          moving.current = false;
        }
      },
    });
  }, [driver]);

  // The running-turn arc: one turn per 1.2 s; still under Reduce Motion.
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!turnRunning || reduceMotion) {
      spin.stopAnimation();
      spin.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 1200,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [turnRunning, reduceMotion, spin]);

  if (at === null || !rendered || bounds === null) {
    return null;
  }
  const { arc } = level;
  const onAccessibilityAction = (event: AccessibilityActionEvent) => {
    const route = hubA11yRoute(event.nativeEvent.actionName);
    if (route.kind === "tap") {
      props.onPress();
    } else if (route.kind === "menu") {
      props.onMenu();
    } else if (route.kind === "commit") {
      props.onCommit(route.id);
    }
  };
  return (
    <>
      {fan === null ? null : (
        <HubFan
          palette={palette}
          layout={fan.layout}
          items={fan.items}
          hi={fan.hi}
          motion={fanMotion(reduceMotion)}
          band={bounds}
          onTapOverlay={(p) => {
            driver.tapOverlay(p);
            setEngaged(driver.state().kind);
          }}
        />
      )}
      <Animated.View
        testID="floating-activity"
        accessible
        accessibilityRole="button"
        accessibilityLabel={props.accessibilityLabel}
        accessibilityHint={
          voiceOver ? "Double-tap for Activity. Swipe up or down for more actions." : undefined
        }
        accessibilityActions={hubA11yActions(props.allItems).map((action) => ({ ...action }))}
        onAccessibilityAction={onAccessibilityAction}
        onAccessibilityTap={props.onPress}
        pointerEvents={shown ? "auto" : "none"}
        style={[
          styles.circle,
          {
            opacity,
            transform: xy.getTranslateTransform(),
          },
        ]}
        {...(a11y(voiceOver).draggable ? pan.panHandlers : {})}
      >
        {/* The BODY layer: blur, glass, border, glyph/badge, its shadow — and the
            rest opacity. RN multiplies a layer's opacity into it, so the shadow
            fades with the body instead of a faint body casting a full one. */}
        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            styles.clip,
            styles.body,
            {
              borderColor: palette.glassBorder,
              shadowOpacity: palette.shadowOpacity,
              opacity: bodyLevel,
            },
          ]}
        >
          <BlurView
            pointerEvents="none"
            intensity={60}
            tint="systemUltraThinMaterial"
            style={[StyleSheet.absoluteFill, styles.clip]}
          />
          <Animated.View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, styles.clip, { backgroundColor: palette.glass }]}
          />
          {badge?.kind === "count" ? (
            <Text
              testID="hub-badge-count"
              maxFontSizeMultiplier={DENSE_FONT_SCALE}
              numberOfLines={1}
              style={[typography.footnote, styles.count, { color: palette.accent }]}
            >
              {badge.n}
            </Text>
          ) : (
            <View testID="hub-glyph" pointerEvents="none" style={styles.grid}>
              {[0, 1, 2, 3].map((i) => (
                <View key={i} style={[styles.dot, { backgroundColor: palette.accent }]} />
              ))}
            </View>
          )}
          {badge?.kind === "dot" ? (
            <View
              testID="hub-badge-dot"
              pointerEvents="none"
              style={[styles.newDot, { backgroundColor: palette.accentFill }]}
            />
          ) : null}
        </Animated.View>
        {/* The arc is the body's SIBLING: it follows the outer fade only, so it
            stays solid at any setting. Below 75 % it thickens and gains a
            page-coloured halo, which is why it has to be outside the body. */}
        {turnRunning ? (
          <Animated.View
            testID="hub-arc"
            pointerEvents="none"
            style={[
              styles.arcBox,
              {
                transform: [
                  {
                    rotate: spin.interpolate({
                      inputRange: [0, 1],
                      outputRange: ["0deg", "360deg"],
                    }),
                  },
                ],
              },
            ]}
          >
            {arc.halo ? (
              <View
                testID="hub-arc-halo"
                pointerEvents="none"
                style={[styles.arc, { borderTopColor: palette.page, borderWidth: arc.width + 3 }]}
              />
            ) : null}
            <View
              style={[styles.arc, { borderTopColor: palette.accent, borderWidth: arc.width }]}
            />
          </Animated.View>
        ) : null}
      </Animated.View>
    </>
  );
}

const styles = StyleSheet.create({
  // The outer box: position, size and the show/hide fade — nothing painted. The
  // body layer owns the glass, the border and the shadow, and the arc is its
  // sibling, so the fade multiplies into both and the rest level into the body
  // only.
  circle: {
    position: "absolute",
    left: 0,
    top: 0,
    width: FLOAT_SIZE,
    height: FLOAT_SIZE,
    borderRadius: FLOAT_SIZE / 2,
  },
  clip: { borderRadius: FLOAT_SIZE / 2, overflow: "hidden" },
  // The body layer carries the shadow now (it fades with the level, so a faint
  // body does not cast a full one); it fills the circle exactly.
  body: {
    position: "absolute",
    left: 0,
    top: 0,
    width: FLOAT_SIZE,
    height: FLOAT_SIZE,
    alignItems: "center",
    justifyContent: "center",
    ...shadow.glass,
  },
  count: { fontWeight: "600", fontVariant: ["tabular-nums"] },
  // The spinning box (the arc and its halo, one turn per 1.2 s). Square, so the
  // rotation is a pure spin around the circle's centre.
  arcBox: {
    position: "absolute",
    top: 0,
    left: 0,
    width: FLOAT_SIZE,
    height: FLOAT_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  arc: {
    position: "absolute",
    top: 2,
    left: 2,
    width: FLOAT_SIZE - 6,
    height: FLOAT_SIZE - 6,
    borderRadius: (FLOAT_SIZE - 6) / 2,
    borderWidth: 2,
    borderColor: "transparent",
  },
  grid: { width: 14, height: 14, flexDirection: "row", flexWrap: "wrap", gap: 4 },
  dot: { width: 5, height: 5, borderRadius: 2.5 },
  newDot: { position: "absolute", top: 6, right: 6, width: 9, height: 9, borderRadius: 4.5 },
});
