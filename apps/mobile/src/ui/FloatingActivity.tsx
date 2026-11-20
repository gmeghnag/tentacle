/**
 * The floating hub button (docs/feat/mobile-chrome.md Design 6, F2 opt-in;
 * docs/feat/mobile-hub.md H3): a 54 pt glass circle on an edge of the band
 * between the header and the composer. Tap = the hub fan (as does the 400 ms
 * hold, which adds slide-to-select); drag = move it. Render + gesture plumbing
 * only: the press machine and its
 * timer are `hub-session.ts`'s `createHubDriver` (over `hub-gesture.reduce`),
 * the fan's geometry `hub-fan.ts`'s, where it rests and when it shows
 * `floating-button.ts`'s. `PanResponder` (core RN, no gesture library) feeds raw
 * points in: once granted on touch-down it keeps the finger anywhere on screen
 * and refuses to yield (the H3 spike: 155 moves, 659 pt over the transcript,
 * released, never terminated).
 */
import { BlurView } from "expo-blur";
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type AccessibilityActionEvent,
  AccessibilityInfo,
  Animated,
  Easing,
  PanResponder,
  StyleSheet,
  View,
} from "react-native";
import {
  FLOAT_SIZE,
  type FloatBounds,
  type FloatPosition,
  a11y,
  place,
  snap,
} from "../floating-button.ts";
import { hubHaptic } from "../haptic-rules.ts";
import { playHaptic } from "../haptics.ts";
import type { HubActionId, HubItem } from "../hub-actions.ts";
import { dropPlan, fadePlan, glowPlan, levelPlan } from "../hub-button-motion.ts";
import { type FanLayout, type Point, fanMotion } from "../hub-fan.ts";
import { FLASH_MS, type Flash } from "../hub-flash.ts";
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
import { PERF } from "../perf-probe.ts";
import { DENSE_FONT_SCALE, type Palette, shadow, typography } from "../theme.ts";
import { HubFan } from "./HubFan.tsx";
import { Text } from "./Text.tsx";

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
  /** `hub-actions.ts` `buttonBadge`: only a running count, never a dot; null → the hub glyph. */
  readonly count: number | null;
  /**
   * How many news pulses have happened in this session (`hub-actions.ts`
   * `hubPulse`): the button glows once, then nothing (mobile-hub-badges Q1 C).
   * 0 — the first render's baseline — never glows.
   */
  readonly pulse: number;
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
  readonly onDrop: (position: FloatPosition) => void;
  /** The fan opened (true) or closed by any path (false): the screen guards the back-swipe (M2). */
  readonly onFanChange: (open: boolean) => void;
  readonly onCommit: (id: HubActionId) => void;
  /**
   * A dimmed item was tapped in the fan (mobile-hub-commands C1 Design 8): the
   * pill already says why, so this is only what the SCREEN still owes it (the
   * Tools re-pull). Never a sheet, never a notice line — the fan stays open.
   */
  readonly onFlash: (id: HubActionId) => void;
  /** The plain menu with everything: no fan fits, or VoiceOver's long-press / Show all. */
  readonly onMenu: () => void;
}

interface OpenFan {
  readonly layout: Extract<FanLayout, { kind: "fan" }>;
  readonly items: readonly HubItem[];
  readonly hi: number | null;
  /** The dimmed item's in-place label, while it lasts (`hub-flash.ts`). */
  readonly flash: Flash | null;
  /** The clock reading the pill is drawn against (re-read when the timer fires). */
  readonly now: number;
}

export function FloatingActivity(props: FloatingActivityProps): JSX.Element | null {
  const {
    palette,
    bounds,
    position,
    shown,
    count,
    pulse,
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
  // The dimmed item's label flash has ONE timer (mobile-hub-commands C1 Design 7):
  // armed by the machine's `flash` effect, cleared on every way out of the fan.
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disarmFlash = () => {
    if (flashTimer.current !== null) {
      clearTimeout(flashTimer.current);
      flashTimer.current = null;
    }
  };
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
  // a test finds an invisible button. Every animation here is on the native
  // driver (`hub-button-motion.ts`): a JS thread busy with a streaming turn
  // cannot stutter it.
  const [rendered, setRendered] = useState(shown);
  useEffect(() => {
    if (shown) {
      setRendered(true);
    }
    Animated.timing(opacity, fadePlan(shown, reduceMotion)).start(({ finished }) => {
      if (finished && !shown) {
        setRendered(false);
      }
    });
  }, [shown, reduceMotion, opacity]);

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
    // Up is instant (feedback at once); back down takes the fade (`levelPlan`).
    Animated.timing(bodyLevel, levelPlan(level.body, reduceMotion)).start();
  }, [level.body, reduceMotion, bodyLevel]);

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
    const plan = dropPlan(target, p.reduceMotion);
    if (plan.kind === "spring") {
      Animated.spring(xy, plan.spring).start(() => {
        moving.current = false;
      });
    } else {
      xy.setValue(plan.at);
      opacity.setValue(plan.fadeFrom);
      Animated.timing(opacity, plan.fade).start();
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
            PERF.fanOpen();
            setFan({ layout: effect.layout, items, hi: null, flash: null, now: Date.now() });
          } else {
            moving.current = false;
            latest.current.onMenu();
          }
          break;
        }
        case "highlight":
          setFan((open) => (open === null ? null : { ...open, hi: effect.index }));
          break;
        // A dimmed item was tapped: its own pill says why for FLASH_MS and the
        // fan stays open (`hub-flash.ts` decides the text; this only times it).
        case "flash": {
          const flash = { index: effect.index, at: Date.now() };
          // The screen's side of a dimmed tap (the Tools re-pull), before the
          // pill is timed: the id is the fan's own snapshot (`press.menu`), as a
          // commit's is.
          const id = press.current.menu?.ids[effect.index];
          if (id !== undefined) {
            latest.current.onFlash(id as HubActionId);
          }
          disarmFlash();
          setFan((open) => (open === null ? null : { ...open, flash, now: flash.at }));
          flashTimer.current = setTimeout(() => {
            flashTimer.current = null;
            // One re-render past the window: the pill falls back to the label.
            setFan((open) =>
              open === null ? null : { ...open, flash: null, now: flash.at + FLASH_MS },
            );
          }, FLASH_MS);
          break;
        }
        case "commit":
          latest.current.onCommit(effect.id as HubActionId);
          break;
        case "close":
          disarmFlash();
          setFan(null);
          moving.current = false;
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
    if (!fanOpen) {
      PERF.fanClose();
    }
    latest.current.onFanChange(fanOpen);
  }, [fanOpen]);
  useEffect(
    () => () => {
      driver.dispose();
      // The flash is the fan's: it never outlives it or the button (C1 Design 7).
      if (flashTimer.current !== null) {
        clearTimeout(flashTimer.current);
        flashTimer.current = null;
      }
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
        PERF.touch(event.nativeEvent.timestamp);
        driver.down(pointOf({ dx: 0, dy: 0 }), Date.now());
        setEngaged(driver.state().kind);
      },
      onPanResponderMove: (_event, g) => driver.move(pointOf(g), Date.now()),
      onPanResponderRelease: (event, g) => {
        PERF.touch(event.nativeEvent.timestamp);
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

  // Stable, so the memoized fan is not redrawn by a streaming screen's re-render.
  const onTapOverlay = useCallback(
    (p: Point) => {
      driver.tapOverlay(p);
      setEngaged(driver.state().kind);
    },
    [driver],
  );

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

  // The one-shot glow of news arriving (mobile-hub-badges Design 5, owner Q1 C):
  // a sibling of the body like the running arc, so it follows the outer fade. It
  // plays on a CHANGE of `pulse`; the first render (pulse 0) is the baseline and
  // never glows (F1). A second pulse stops the running one and restarts from 0, so
  // two increases never stack two rings (F5).
  const pulseAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (pulse === 0) {
      return;
    }
    const plan = glowPlan(reduceMotion);
    pulseAnim.stopAnimation();
    pulseAnim.setValue(0);
    const anim = Animated.sequence(
      plan.fade.map((step) =>
        Animated.timing(pulseAnim, { ...step, useNativeDriver: plan.native }),
      ),
    );
    anim.start();
    return () => anim.stop();
  }, [pulse, reduceMotion, pulseAnim]);

  if (at === null || !rendered || bounds === null) {
    return null;
  }
  const { arc } = level;
  const onAccessibilityAction = (event: AccessibilityActionEvent) => {
    const route = hubA11yRoute(event.nativeEvent.actionName);
    if (route.kind === "menu") {
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
          flash={fan.flash}
          now={fan.now}
          onTapOverlay={onTapOverlay}
        />
      )}
      <Animated.View
        testID="floating-activity"
        accessible
        accessibilityRole="button"
        accessibilityLabel={props.accessibilityLabel}
        accessibilityHint={
          voiceOver ? "Double-tap for actions. Swipe up or down for more actions." : undefined
        }
        accessibilityActions={hubA11yActions(props.allItems).map((action) => ({ ...action }))}
        onAccessibilityAction={onAccessibilityAction}
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
        {/* The BODY layer: the shadow, blur, glass, border, glyph/badge — and the
            rest opacity. RN multiplies a layer's opacity into it, so the badge and
            the glyph fade with it, and it carries the body's level on the shadow
            too, so a faint body casts a faint one (at 100 %: the look of before
            this setting).

            The shadow is on THIS layer, not on a child ring: iOS clips a layer's
            shadow to the layer, so a child of a clipped box loses it (RN sets
            `layer.mask` for `overflow: hidden`, RN `RCTView.m`
            `updateClippingForLayer`), and a child that paints nothing at all gets
            no shadow either — RN only computes a `shadowPath` for a view with a
            solid background (`RCTUpdateShadowPathForView`), and otherwise falls
            back to the layer's own pixels, which an empty layer does not have.
            So the clip lives on the glass fill below, and this box — rounded, but
            never `overflow: hidden` — casts. */}
        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
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
          {count === null ? (
            <View testID="hub-glyph" pointerEvents="none" style={styles.grid}>
              {[0, 1, 2, 3].map((i) => (
                <View key={i} style={[styles.dot, { backgroundColor: palette.accent }]} />
              ))}
            </View>
          ) : (
            <Text
              testID="hub-badge-count"
              maxFontSizeMultiplier={DENSE_FONT_SCALE}
              numberOfLines={1}
              style={[typography.footnote, styles.count, { color: palette.accent }]}
            >
              {count}
            </Text>
          )}
        </Animated.View>
        {/* The news glow: the same place as the running arc and for the same
            reason — a sibling of the body, so it follows the outer fade only, and
            nothing of it is left behind once it has played (owner Q1 C). */}
        {pulse === 0 ? null : (
          <Animated.View
            testID="hub-glow"
            pointerEvents="none"
            style={[
              styles.glow,
              {
                borderColor: palette.accent,
                opacity: pulseAnim,
                transform: [
                  {
                    scale: pulseAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [1, glowPlan(reduceMotion).scale],
                    }),
                  },
                ],
              },
            ]}
          />
        )}
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
  // The clip belongs to the PAINTED layers only: a layer's shadow is clipped by
  // the layer itself, so a clipped box that casts has no shadow.
  clip: { borderRadius: FLOAT_SIZE / 2, overflow: "hidden" },
  // The body layer fills the circle exactly and carries the shadow: rounded, but
  // deliberately UNCLIPPED (no `overflow`) — it must also have CONTENT for the
  // shadow to exist, which is why the shadow is here and not on an empty ring
  // beside it (the glass fill and the glyph are this layer's children, exactly
  // the structure that cast the shadow before this setting existed).
  body: {
    position: "absolute",
    left: 0,
    top: 0,
    width: FLOAT_SIZE,
    height: FLOAT_SIZE,
    borderRadius: FLOAT_SIZE / 2,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
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
  // The news glow: an accent ring just outside the body (FLOAT_SIZE + 8), sized
  // so its peak scale grows outward from the button's centre.
  glow: {
    position: "absolute",
    top: -4,
    left: -4,
    width: FLOAT_SIZE + 8,
    height: FLOAT_SIZE + 8,
    borderRadius: (FLOAT_SIZE + 8) / 2,
    borderWidth: 2,
  },
});
