import type { WorkflowStepRow } from "@tentacle/protocol";
/**
 * The step detail's LAYER (docs/feat/workflows-ui.md D5, slice 4): a dumb
 * renderer (AGENTS §7) that morphs one graph pill into the detail's header and
 * fills the body in behind it.
 *
 * Why a layer and not a navigation push: a native-stack transition cannot morph
 * from a pill inside a canvas — it slides a whole screen. So the detail is drawn
 * INSIDE `WorkflowRun`, over the graph, and the back reverses the same flight.
 *
 * Every number comes from `workflow-step-detail.ts` + `workflow-morph.ts`
 * (the box pair, the table `Animated` interpolates, the row stagger, the skeleton
 * bars); this file only feeds them to React Native. Two animation values, on
 * purpose: the FLIGHT is a layout animation (`useNativeDriver: false` — width,
 * height, radius and font size are layout props the native driver refuses), and
 * the graph's fade/scale is a native one (opacity + transform). Reduce Motion
 * replaces the flight with one crossfade and stills the skeleton's shimmer.
 */
import { type JSX, type ReactNode, useEffect, useMemo, useRef } from "react";
import { Animated, Easing, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Palette } from "../theme.ts";
import { space, typography } from "../theme.ts";
import { Icon } from "../ui/Icon.tsx";
import { Text } from "../ui/Text.tsx";
import type { StateLook } from "../workflow-list.ts";
import { stateLook } from "../workflow-list.ts";
import {
  CROSSFADE_MS,
  MORPH_EASING,
  type MorphTable,
  ROW_FADE_MS,
  morphLook,
  morphTable,
  rowStartMs,
} from "../workflow-morph.ts";
import type { StepDetail } from "../workflow-run-controller.ts";
import { DETAIL, detailLayout, logLines, skeletonBars } from "../workflow-skeleton.ts";
import {
  type HeroText,
  STEP_NAV,
  bodyPending,
  canvasMap,
  flight,
  heroBox,
  heroText,
  heroTop,
  navText,
} from "../workflow-step-detail.ts";

export interface WorkflowStepLayerProps {
  readonly palette: Palette;
  /** The step whose detail is open. */
  readonly step: WorkflowStepRow;
  /** Its prompt/report as this screen holds it (`undefined` = not asked yet). */
  readonly detail: StepDetail | undefined;
  /** The run's steps, for the node's on-screen box (the flight's start). */
  readonly steps: readonly WorkflowStepRow[];
  readonly width: number;
  readonly reduceMotion: boolean;
  /** The run's name, for the nav bar's back button (`‹ demo-note`). */
  readonly runName: string;
  /** The rows the body holds, already decided (`stepBlocks`). */
  readonly blocks: ReturnType<typeof import("../workflow-step-detail.ts").stepBlocks>;
  readonly onClose: () => void;
}

/** React Native's own curve for the flight, built from the mockup's four points. */
const FLIGHT_EASING = Easing.bezier(
  MORPH_EASING.x1,
  MORPH_EASING.y1,
  MORPH_EASING.x2,
  MORPH_EASING.y2,
);

export function WorkflowStepLayer(props: WorkflowStepLayerProps): JSX.Element {
  const { palette, step, detail, steps, width, reduceMotion, blocks } = props;
  const look: StateLook = stateLook(step.state);
  const text: HeroText = heroText(step, look.word);
  // The detail's nav bar lives UNDER the status bar and the hero lands BELOW it
  // (docs/fix/workflows-ux.md S3): both numbers come from the pure module, and
  // this layer only feeds them to the layout.
  const insets = useSafeAreaInsets();
  const top = heroTop(insets.top);
  const nav = navText(steps, step.id, props.runName);
  const canvas = useMemo(() => canvasMap(width), [width]);
  const pair = useMemo(
    () => flight(steps, step.id, canvas, top, DETAIL.inset, width),
    [steps, step.id, canvas, top, width],
  );
  const table: MorphTable | null = useMemo(
    () => (pair === null ? null : morphTable(pair.from, pair.to)),
    [pair],
  );
  const motion = morphLook(reduceMotion);
  const progress = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;
  const graphFade = useRef(new Animated.Value(reduceMotion ? 0 : 1)).current;
  /** One flight at a time: set while the morph animates, cleared only when it settles. */
  const busy = useRef(false);
  const close = () => {
    // A back tap DURING the flight is ignored, so a half-drawn hero never closes
    // onto a graph it is still covering (D5, failure-mode table).
    if (!busy.current) {
      props.onClose();
    }
  };

  useEffect(() => {
    // Reduce Motion: no flight at all, just the crossfade onto the final layout.
    if (motion.kind === "crossfade" || table === null) {
      progress.setValue(1);
      busy.current = true;
      Animated.timing(graphFade, {
        toValue: 0,
        duration: CROSSFADE_MS,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) {
          busy.current = false;
        }
      });
      return;
    }
    busy.current = true;
    Animated.parallel([
      Animated.timing(progress, {
        toValue: 1,
        duration: motion.flightMs,
        easing: FLIGHT_EASING,
        // Layout props (width/height/radius/font size) are JS-driven by necessity.
        useNativeDriver: false,
      }),
      Animated.timing(graphFade, {
        toValue: 0,
        duration: motion.flightMs,
        easing: FLIGHT_EASING,
        useNativeDriver: true,
      }),
    ]).start(({ finished }) => {
      // Settled: the layer's own taps work again.
      if (finished) {
        busy.current = false;
      }
    });
  }, [motion, table, progress, graphFade]);

  const interp = (values: readonly number[]) =>
    values.length < 2
      ? new Animated.Value(values[0] ?? 0)
      : progress.interpolate({ inputRange: table?.inputRange ?? [0, 1], outputRange: values });

  const boxes = detailLayout(blocks, width);
  const bars = bodyPending(detail) ? skeletonBars(blocks, width, reduceMotion) : [];
  const logBoxes = boxes.filter((b) => b.section === "log");
  const hero = heroBox(top, DETAIL.inset, width);

  return (
    <View testID="workflow-step-layer" style={[styles.root, { backgroundColor: palette.page }]}>
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: graphFade }]} pointerEvents="none">
        <Pressable
          testID="workflow-step-backdrop"
          accessibilityRole="button"
          accessibilityLabel="Back to the graph"
          onPress={close}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
      <ScrollView contentContainerStyle={{ paddingBottom: DETAIL.inset }}>
        <View style={[styles.nav, { paddingTop: insets.top }]}>
          <Pressable
            testID="workflow-step-back"
            accessibilityRole="button"
            accessibilityLabel="Back to the graph"
            hitSlop={8}
            onPress={close}
            style={styles.back}
          >
            <Icon name="chevron.left" color={palette.label} size={18} />
            <Text numberOfLines={1} style={[styles.backText, { color: palette.label }]}>
              {nav.back}
            </Text>
          </Pressable>
          {nav.position === null ? null : (
            <Text testID="workflow-step-position" style={[styles.position, { color: palette.sec }]}>
              {nav.position}
            </Text>
          )}
        </View>
        {table === null ? null : (
          <Animated.View
            testID={`workflow-step-hero-${step.id}`}
            style={[
              styles.hero,
              {
                left: interp(table.box.x) as unknown as number,
                top: interp(table.box.y) as unknown as number,
                width: interp(table.box.width) as unknown as number,
                height: interp(table.box.height) as unknown as number,
                borderRadius: interp(table.radius) as unknown as number,
                columnGap: interp(table.gap) as unknown as number,
                paddingLeft: interp(table.padLeft) as unknown as number,
                paddingRight: interp(table.padRight) as unknown as number,
                backgroundColor: palette.card,
                borderColor: palette.sep,
              },
            ]}
          >
            <Animated.View
              style={[
                styles.badge,
                {
                  width: interp(table.badge) as unknown as number,
                  height: interp(table.badge) as unknown as number,
                  borderRadius: interp(table.badge) as unknown as number,
                  backgroundColor: palette.code,
                },
              ]}
            >
              <Animated.Text
                style={[
                  { color: palette.label, fontSize: interp(table.glyphSize) as unknown as number },
                ]}
              >
                {look.glyph}
              </Animated.Text>
            </Animated.View>
            <View style={styles.heroText}>
              <Animated.Text
                numberOfLines={1}
                style={[
                  styles.heroTitle,
                  { color: palette.label, fontSize: interp(table.titleSize) as unknown as number },
                ]}
              >
                {text.id}
              </Animated.Text>
              <Animated.Text
                numberOfLines={1}
                style={[
                  styles.heroSubtitle,
                  {
                    color: palette.sec,
                    fontSize: interp(table.subtitleSize) as unknown as number,
                  },
                ]}
              >
                {text.subtitle}
              </Animated.Text>
            </View>
          </Animated.View>
        )}
        <View style={{ height: STEP_NAV.gap + hero.height + DETAIL.heroGap + DETAIL.blockGap }}>
          {/* The flight's box is absolutely positioned: this spacer keeps the body
              BELOW the landed hero (which itself starts below the nav bar), so the
              rows never slide under it. */}
        </View>
        <View style={styles.body}>
          {blocks.kv.map(([label, value], i) => (
            <FadeRow
              // biome-ignore lint/suspicious/noArrayIndexKey: a kv list is a fixed, ordered set of labels
              key={`kv-${label}-${i}`}
              index={i}
              reduceMotion={reduceMotion}
              style={styles.kvRow}
            >
              <Text style={[styles.kvLabel, { color: palette.sec }]}>{label}</Text>
              <Text style={[styles.kvValue, { color: palette.label }]}>{value}</Text>
            </FadeRow>
          ))}
          {logBoxes.length === 0 && bars.length === 0 ? null : (
            <FadeRow
              index={blocks.kv.length}
              reduceMotion={reduceMotion}
              style={[styles.logBlock, { backgroundColor: palette.code }]}
            >
              {bodyPending(detail)
                ? bars
                    .filter((b) => b.key.startsWith("bar-log-"))
                    .map((bar) => (
                      <View
                        key={bar.key}
                        testID={`workflow-step-bar-${bar.key}`}
                        style={{
                          height: Math.max(6, bar.height),
                          marginTop: 2,
                          width: `${Math.round(bar.widthFraction * 100)}%`,
                          borderRadius: bar.radius,
                          backgroundColor: palette.sep,
                          opacity: bar.motion === "still" ? 0.5 : 0.8,
                        }}
                      />
                    ))
                : logLines(blocks.log.join("\n")).map((line, i) => (
                    <Text
                      // biome-ignore lint/suspicious/noArrayIndexKey: a log block is positional text
                      key={`line-${i}`}
                      selectable
                      style={[styles.mono, { color: palette.label }]}
                    >
                      {line}
                    </Text>
                  ))}
            </FadeRow>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

/** One body row, faded in on the mockup's stagger (instant under Reduce Motion). */
function FadeRow({
  index,
  reduceMotion,
  style,
  children,
}: {
  readonly index: number;
  readonly reduceMotion: boolean;
  readonly style?: object;
  readonly children: ReactNode;
}): JSX.Element {
  const value = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;
  useEffect(() => {
    if (reduceMotion) {
      value.setValue(1);
      return;
    }
    // A staggered fade whose LENGTH is the pure module's (`rowOpacityAt`): the
    // choreography stays testable, this only schedules the same curve.
    Animated.timing(value, {
      toValue: 1,
      // ONE source for the fade's length: the pure module's own constant.
      duration: ROW_FADE_MS,
      delay: rowStartMs(index),
      easing: Easing.linear,
      useNativeDriver: true,
    }).start();
  }, [index, reduceMotion, value]);
  return <Animated.View style={[style, { opacity: value }]}>{children}</Animated.View>;
}

const styles = StyleSheet.create({
  root: StyleSheet.absoluteFill,
  nav: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.inset,
  },
  back: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    flexShrink: 1,
    height: STEP_NAV.height,
  },
  backText: { ...typography.headline, flexShrink: 1 },
  position: { ...typography.footnote },
  hero: {
    position: "absolute",
    flexDirection: "row",
    alignItems: "center",
    borderWidth: StyleSheet.hairlineWidth,
  },
  badge: { alignItems: "center", justifyContent: "center" },
  heroText: { flex: 1 },
  heroTitle: { fontWeight: "600" },
  heroSubtitle: {},
  body: { paddingHorizontal: DETAIL.inset, gap: DETAIL.rowGap },
  kvRow: { flexDirection: "row", justifyContent: "space-between", minHeight: DETAIL.rowHeight },
  kvLabel: { ...typography.footnote },
  kvValue: { ...typography.footnote, flexShrink: 1, textAlign: "right" },
  logBlock: { borderRadius: 8, padding: 8, gap: 2, minHeight: 40 },
  mono: { ...typography.mono },
});
