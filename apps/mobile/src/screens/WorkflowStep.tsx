import type { WorkflowProjection } from "@tentacle/client";
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
import { PillButton } from "../ui/PillButton.tsx";
import { Text } from "../ui/Text.tsx";
import { WorkflowMark } from "../ui/WorkflowMark.tsx";
import type { StateLook } from "../workflow-list.ts";
import { stateLook } from "../workflow-list.ts";
import { MARKER_SIZE, markerFor } from "../workflow-marker.ts";
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
import { RUN_WIDTH } from "../workflow-run-layout.ts";
import { DETAIL, detailLayout, logLines, skeletonBars } from "../workflow-skeleton.ts";
import {
  type HeroText,
  type NavSide,
  type NavVisit,
  STEP_NAV,
  type StepBody,
  type StepNav,
  bodyPending,
  canvasMap,
  flight,
  heroBox,
  heroText,
  heroTop,
} from "../workflow-step-detail.ts";

export interface WorkflowStepLayerProps {
  readonly palette: Palette;
  /** The step whose detail is open. */
  readonly step: WorkflowStepRow;
  /** Its prompt/report as this screen holds it (`undefined` = not asked yet). */
  readonly detail: StepDetail | undefined;
  /**
   * The run as the shared projection reads it (S6b): the flight starts from the
   * node the SHARED layout places, so the pill takes off from where it is DRAWN.
   */
  readonly projection: WorkflowProjection;
  readonly width: number;
  readonly reduceMotion: boolean;
  /** The run's name, for the nav bar's back button (`‹ demo-note`). */
  readonly runName: string;
  /** Where this visit sits in B's order, and its two neighbours (owner 6b). */
  readonly nav: StepNav;
  /** The body's blocks, already decided (`stepBody`). */
  readonly blocks: StepBody;
  readonly onClose: () => void;
  /**
   * Follow a `4 of 8` arrow (owner 6b): the neighbour's step and WHICH visit of it,
   * so the detail moves through the history instead of round-robin over the file.
   */
  readonly onOpenStep: (stepId: string, visit?: NavVisit) => void;
  /** «Re-run step» on a FAILED step (owner Q4): the action lives here, not on the list. */
  readonly onRerun: (stepId: string) => void;
}

/** React Native's own curve for the flight, built from the mockup's four points. */
const FLIGHT_EASING = Easing.bezier(
  MORPH_EASING.x1,
  MORPH_EASING.y1,
  MORPH_EASING.x2,
  MORPH_EASING.y2,
);

export function WorkflowStepLayer(props: WorkflowStepLayerProps): JSX.Element {
  const { palette, step, detail, width, reduceMotion, blocks, nav } = props;
  const look: StateLook = stateLook(step.state);
  const text: HeroText = heroText(step, look.word);
  // The detail's nav bar lives UNDER the status bar and the hero lands BELOW it
  // (docs/fix/workflows-ux.md S3): both numbers come from the pure module, and
  // this layer only feeds them to the layout.
  const insets = useSafeAreaInsets();
  const top = heroTop(insets.top);
  // The graph's own logical width (S6b: the run's drawing is 402 pt, wider than the
  // editor's — the canvas map must be told, or the flight starts from the wrong box).
  const canvas = useMemo(() => canvasMap(width, RUN_WIDTH), [width]);
  const pair = useMemo(
    () => flight(props.projection, step.id, canvas, top, DETAIL.inset, width),
    [props.projection, step.id, canvas, top, width],
  );
  const table: MorphTable | null = useMemo(
    () => (pair === null ? null : morphTable(pair.from, pair.to)),
    [pair],
  );
  // The flight runs on open and on a Reduce Motion toggle, never on a status
  // update (docs/fix/mobile-workflow-run-jank.md): its effect depends on values
  // that hold across re-renders, or every update would restart it, set `busy`
  // and swallow a Back tap.
  const motion = useMemo(() => morphLook(reduceMotion), [reduceMotion]);
  const flies = table !== null;
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
    if (motion.kind === "crossfade" || !flies) {
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
  }, [motion, flies, progress, graphFade]);

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
        </View>{" "}
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
          {blocks.say === null ? null : (
            <FadeRow index={0} reduceMotion={reduceMotion} style={styles.sayBox}>
              <Text testID="workflow-step-say" style={[styles.say, { color: palette.label }]}>
                {blocks.say.text}
              </Text>
              {blocks.say.small === undefined ? null : (
                <Text style={[styles.saySmall, { color: palette.sec }]}>{blocks.say.small}</Text>
              )}
            </FadeRow>
          )}
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
          {blocks.asked === null ? null : (
            <FadeRow index={blocks.kv.length} reduceMotion={reduceMotion} style={styles.askedBox}>
              <Text style={[styles.bandLabel, { color: palette.sec }]}>Asked</Text>
              <Text testID="workflow-step-asked" style={[styles.asked, { color: palette.label }]}>
                {blocks.asked}
              </Text>
            </FadeRow>
          )}
          {blocks.answer.length === 0 ? null : (
            <FadeRow
              index={blocks.kv.length + 1}
              reduceMotion={reduceMotion}
              style={styles.askedBox}
            >
              <Text style={[styles.bandLabel, { color: palette.sec }]}>Answer</Text>
              {blocks.answer.map(([label, value], i) => (
                <View
                  // biome-ignore lint/suspicious/noArrayIndexKey: a fixed, ordered answer
                  key={`ans-${label}-${i}`}
                  testID={`workflow-step-answer-${label.toLowerCase()}`}
                  style={styles.kvRow}
                >
                  <Text style={[styles.kvLabel, { color: palette.sec }]}>{label}</Text>
                  <Text style={[styles.kvValue, { color: palette.label }]}>{value}</Text>
                </View>
              ))}
            </FadeRow>
          )}
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
          {step.state === "error" ? (
            <PillButton
              palette={palette}
              testID={`workflow-rerun-${step.id}`}
              kind="secondary"
              label="Re-run step"
              onPress={() => props.onRerun(step.id)}
            />
          ) : null}
        </View>
      </ScrollView>
      <PrevNext palette={palette} nav={nav} onOpenStep={props.onOpenStep} bottom={insets.bottom} />
    </View>
  );
}

/**
 * The bottom bar (owner 6b, option c): the neighbour's marker + name + what it was,
 * either side of a «4 of 8». At the ends there is no arrow to nowhere — the bar says
 * «Start of run» / «End of run» instead.
 */
function PrevNext({
  palette,
  nav,
  onOpenStep,
  bottom,
}: {
  readonly palette: Palette;
  readonly nav: StepNav;
  readonly onOpenStep: (stepId: string, visit?: NavVisit) => void;
  readonly bottom: number;
}): JSX.Element {
  return (
    <View
      testID="workflow-step-prevnext"
      style={[styles.pager, { borderTopColor: palette.sep, paddingBottom: Math.max(8, bottom) }]}
    >
      <NavArrow palette={palette} side={nav.prev} which="prev" onOpenStep={onOpenStep} />
      <NavArrow palette={palette} side={nav.next} which="next" onOpenStep={onOpenStep} />
    </View>
  );
}

/** One half of the pager: the neighbour, or the honest end of the run. */
function NavArrow({
  palette,
  side,
  which,
  onOpenStep,
}: {
  readonly palette: Palette;
  readonly side: NavSide;
  readonly which: "prev" | "next";
  readonly onOpenStep: (stepId: string, visit?: NavVisit) => void;
}): JSX.Element {
  if (side.kind === "end") {
    return (
      <View testID={`workflow-step-${which}-end`} style={[styles.pagerSide, styles.pagerEnd]}>
        <Text style={[styles.pagerEndText, { color: palette.sec }]}>{side.label}</Text>
      </View>
    );
  }
  const look = markerFor(side, palette);
  return (
    <Pressable
      testID={`workflow-step-${which}-${side.step}`}
      accessibilityRole="button"
      accessibilityLabel={`${which === "prev" ? "Previous" : "Next"}: ${side.step} · ${look.word}`}
      hitSlop={8}
      onPress={() => onOpenStep(side.step, side.visit)}
      style={[styles.pagerSide, which === "next" ? styles.pagerNext : null]}
    >
      {which === "prev" ? <Icon name="chevron.left" color={palette.sec} size={14} /> : null}
      <WorkflowMark
        palette={palette}
        look={look}
        size={MARKER_SIZE.rail}
        label={look.word}
        blink={false}
      />
      <View style={styles.pagerText}>
        <Text
          numberOfLines={1}
          style={[
            styles.pagerName,
            { color: palette.label },
            which === "next" ? styles.pagerRight : null,
          ]}
        >
          {side.step}
        </Text>
        <Text
          numberOfLines={1}
          style={[
            styles.pagerMeta,
            { color: palette.sec },
            which === "next" ? styles.pagerRight : null,
          ]}
        >
          {side.meta}
        </Text>
      </View>
      {which === "next" ? <Icon name="chevron.right" color={palette.sec} size={14} /> : null}
    </Pressable>
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
  sayBox: { gap: 4, paddingBottom: 4 },
  say: { ...typography.body },
  saySmall: { ...typography.footnote },
  askedBox: { gap: 4 },
  bandLabel: { ...typography.caption, textTransform: "uppercase" },
  asked: { ...typography.body },
  pager: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: DETAIL.inset,
    paddingTop: 10,
    backgroundColor: "transparent",
  },
  pagerSide: { flex: 1, flexDirection: "row", alignItems: "center", gap: 6, minHeight: 44 },
  pagerNext: { justifyContent: "flex-end" },
  pagerEnd: { justifyContent: "flex-start" },
  pagerEndText: { ...typography.footnote },
  pagerText: { flexShrink: 1, minWidth: 0 },
  pagerName: { ...typography.footnote, fontWeight: "600" },
  pagerMeta: { ...typography.caption },
  pagerRight: { textAlign: "right" },
  kvRow: { flexDirection: "row", justifyContent: "space-between", minHeight: DETAIL.rowHeight },
  kvLabel: { ...typography.footnote },
  kvValue: { ...typography.footnote, flexShrink: 1, textAlign: "right" },
  logBlock: { borderRadius: 8, padding: 8, gap: 2, minHeight: 40 },
  mono: { ...typography.mono },
});
