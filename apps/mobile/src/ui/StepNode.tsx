/**
 * One node on the thread of steps (docs/feat/mobile-tool-rows.md Design 3,
 * mockup C): a 1 px `sep` thread in a 10 pt gutter, the node on the first line's
 * centre (a dot, a spinner, a hollow ring, or ∴), then ONE line — name, mono
 * subtitle, the duration — and, when open, the body under it. The line carries
 * NO ∴: owner 17/11 sent it away from a command's duration, so the ∴ on this
 * thread is a thought's node and the folded thought's in the open body. A dumb
 * renderer: every string and decision comes from `tool-steps.ts` /
 * `tool-summary.ts`; this file owns only the look, the 1 s clock and the spin.
 */
import { type JSX, type ReactNode, useEffect, useRef, useState } from "react";
import { Animated, Easing, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import Svg, {
  ClipPath,
  Defs,
  G,
  LinearGradient,
  Rect,
  Stop,
  Text as SvgText,
} from "react-native-svg";
import type { SlotView } from "../compact-slot.ts";
import { DENSE_FONT_SCALE, MONO, type Palette, size, space, typography } from "../theme.ts";
import {
  BREATHE_MS,
  DOT_ORDER,
  type DotPos,
  SHIMMER_MS,
  breatheCurve,
  shimmerSweep,
  thinkingLabel,
  thinkingLook,
} from "../thinking-motion.ts";
import { type StepDot, type ThreadPos, thinkingA11yLabel } from "../tool-steps.ts";
import { type ToolNameParts, liveElapsed } from "../tool-summary.ts";
import { Text } from "./Text.tsx";
import { animateNextLayout } from "./animate.ts";

/** The node's look: a tool's status, an orphan thought (∴), the live footer (breathing ∴). */
/** `wake`: a fired scheduled wake's `◷` (docs/feat/scheduled-fire-row.md). */
export type NodeKind = StepDot | "thought" | "thinking" | "wake";

const GUTTER = 10;
/** The node sits on the first line's centre; the line is one touch target tall. */
const NODE_Y = size.touch / 2;
/** Every ∴ (a thought's node, a folded thought): owner asked a bit larger than 10. */
const THEREFORE_SIZE = 13;

/** Milliseconds since `from`, re-read once a second; null when there is no `from`. */
function useElapsed(from: number | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (from === undefined) {
      return;
    }
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [from]);
  return from === undefined ? null : Math.max(0, now - from);
}

/** A 10 pt ring that turns (native driver); still under Reduce Motion. */
function Spinner({ color, page, still }: { color: string; page: string; still: boolean }) {
  const turn = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (still) {
      return;
    }
    const loop = Animated.loop(
      Animated.timing(turn, {
        toValue: 1,
        duration: 900,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [still, turn]);
  if (still) {
    return <View style={[styles.dot, { backgroundColor: color, borderColor: page }]} />;
  }
  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  return (
    <Animated.View
      style={[
        styles.spinner,
        { borderColor: color, borderTopColor: page, backgroundColor: page },
        { transform: [{ rotate }] },
      ]}
    />
  );
}

/** A 0→1 clock looping every `ms` on the native driver; null under Reduce Motion. */
function useLoop(ms: number, still: boolean): Animated.Value | null {
  const clock = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (still) {
      return;
    }
    clock.setValue(0);
    const loop = Animated.loop(
      Animated.timing(clock, {
        toValue: 1,
        duration: ms,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [ms, still, clock]);
  return still ? null : clock;
}

/** Where each ∴ dot sits in its 13 pt box (thin dots, the glyph's own shape). */
const DOT_AT: Readonly<Record<DotPos, { left: number; top: number }>> = {
  top: { left: 5, top: 1.5 },
  right: { left: 8.5, top: 8 },
  left: { left: 1.5, top: 8 },
};

/**
 * A static ∴ (a thought's node, a folded thought), DRAWN as the
 * live node's three dots: the font's glyph stays tiny even at 13 pt (simulator
 * sweep, docs/fix/mobile-qa-sweep.md), and drawn, every ∴ is the same size.
 */
function ThereforeDots({
  color,
  background,
  style,
}: {
  color: string;
  background?: string;
  style?: object;
}) {
  return (
    <View
      style={[
        styles.dotBox,
        background === undefined ? undefined : { backgroundColor: background },
        style,
      ]}
    >
      {DOT_ORDER.map((pos) => (
        <View key={pos} style={[styles.breathDot, DOT_AT[pos], { backgroundColor: color }]} />
      ))}
    </View>
  );
}

/** The live node (mockup B): ∴ in accent, its dots breathing top → right → left. */
function BreathingTherefore({ palette, still }: { palette: Palette; still: boolean }) {
  const look = thinkingLook(still);
  const clock = useLoop(BREATHE_MS, !look.animate);
  return (
    <View testID="thinking-therefore" style={[styles.dotBox, { backgroundColor: palette.page }]}>
      {DOT_ORDER.map((pos, i) => (
        <Animated.View
          key={pos}
          style={[
            styles.breathDot,
            DOT_AT[pos],
            { backgroundColor: palette[look.glyph] },
            clock === null ? undefined : { opacity: clock.interpolate(breatheCurve(i)) },
          ]}
        />
      ))}
    </View>
  );
}

/** An svg `Rect` the native driver can move (S0 of docs/feat/mobile-thinking-images.md). */
const AnimatedRect = Animated.createAnimatedComponent(Rect);
/** The baseline sits this many font sizes below the line box's centre (half of ascent − descent). */
const GLYPH_BASELINE = 0.35;

/**
 * The word "Thinking" (Owner Q1 = "B", docs/feat/mobile-thinking-images.md): grey,
 * with a soft bright gradient sweeping across it that is CLIPPED to the glyphs —
 * an svg `ClipPath` made of the word itself, so no box can ever show. The grey
 * word and the clip are the same svg text, so the two cannot drift apart; the RN
 * `Text` under them is transparent and only lays out (width, testID, Dynamic
 * Type). The gradient's `x` is one native-driver clock (S0's verdict). Plain grey
 * RN text under Reduce Motion or before it is measured.
 */
function ThinkingWord({
  palette,
  word,
  reduceMotion,
  testID,
}: {
  palette: Palette;
  word: string;
  reduceMotion: boolean;
  testID?: string;
}) {
  const look = thinkingLook(reduceMotion);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const clock = useLoop(SHIMMER_MS, !look.animate);
  const sweep = shimmerSweep(width);
  const { fontScale } = useWindowDimensions();
  const glyphs = clock !== null && sweep.band > 0 && height > 0;
  const fontSize = typography.step.fontSize * Math.min(fontScale, DENSE_FONT_SCALE);
  const glyph = {
    x: 0,
    y: height / 2 + fontSize * GLYPH_BASELINE,
    fontSize,
    fontWeight: typography.step.fontWeight,
    fontStyle: "italic" as const,
  };
  const x =
    clock === null
      ? null
      : clock.interpolate({ inputRange: [0, 1], outputRange: [sweep.from, sweep.to] });
  return (
    <View style={styles.name}>
      <Text
        testID={testID}
        numberOfLines={1}
        maxFontSizeMultiplier={DENSE_FONT_SCALE}
        style={[
          typography.step,
          styles.italic,
          { color: glyphs ? "transparent" : palette[look.word] },
        ]}
        onLayout={(e) => {
          setWidth(Math.round(e.nativeEvent.layout.width));
          setHeight(Math.round(e.nativeEvent.layout.height));
        }}
      >
        {word}
      </Text>
      {!glyphs || x === null ? null : (
        <Svg pointerEvents="none" width={width} height={height} style={styles.glyphs}>
          <Defs>
            <LinearGradient id="thinking-shine" x1="0" y1="0" x2="1" y2="0">
              {sweep.stops.map((s) => (
                <Stop
                  key={s.offset}
                  offset={s.offset}
                  stopColor={palette.label}
                  stopOpacity={s.opacity}
                />
              ))}
            </LinearGradient>
            <ClipPath id="thinking-glyphs">
              <SvgText {...glyph}>{word}</SvgText>
            </ClipPath>
          </Defs>
          <SvgText {...glyph} fill={palette[look.word]}>
            {word}
          </SvgText>
          <G clipPath="url(#thinking-glyphs)">
            <AnimatedRect
              x={x}
              y={0}
              width={sweep.band}
              height={height}
              fill="url(#thinking-shine)"
            />
          </G>
        </Svg>
      )}
    </View>
  );
}

function Node({
  kind,
  palette,
  reduceMotion,
}: { kind: NodeKind; palette: Palette; reduceMotion: boolean }): JSX.Element {
  switch (kind) {
    case "ok":
    case "error":
      return (
        <View
          style={[
            styles.dot,
            {
              backgroundColor: kind === "ok" ? palette.green : palette.red,
              borderColor: palette.page,
            },
          ]}
        />
      );
    case "running":
      return <Spinner color={palette.accent} page={palette.page} still={reduceMotion} />;
    case "thought":
      return <ThereforeDots color={palette.sec} background={palette.page} />;
    case "thinking":
      return <BreathingTherefore palette={palette} still={reduceMotion} />;
    case "wake":
      // The clock glyph, harness-grey on the page (it masks the rail like a dot).
      return (
        <Text
          maxFontSizeMultiplier={DENSE_FONT_SCALE}
          style={[styles.wake, { color: palette.sec, backgroundColor: palette.page }]}
        >
          ◷
        </Text>
      );
    default:
      // queued: a hollow ring.
      return (
        <View style={[styles.ring, { borderColor: palette.sec, backgroundColor: palette.page }]} />
      );
  }
}

export interface StepNodeProps {
  readonly palette: Palette;
  readonly node: NodeKind;
  readonly reduceMotion: boolean;
  readonly name: ToolNameParts;
  readonly nameItalic?: boolean;
  readonly subtitle: string;
  /** Sans italic (a thought's first line) instead of mono (a command). */
  readonly subtitleItalic?: boolean;
  readonly trailing: string;
  readonly trailingRed: boolean;
  /** A running step's start (`row.at`): the trailing text is its live clock. */
  readonly liveFrom?: number;
  readonly thread: ThreadPos;
  readonly open: boolean;
  /** Absent: the body would be empty, so the line is not tappable. */
  readonly onToggle?: () => void;
  readonly a11yLabel: string;
  /** On the name: `tool-<callId>-<status>` (the flows' contract). */
  readonly labelTestID?: string;
  /** Drawn under the line while open. */
  readonly body?: ReactNode;
  /** Always drawn under the line, beside the thread (sub-agent progress, Activity link). */
  readonly below?: ReactNode;
}

export function StepNode({
  palette,
  node,
  reduceMotion,
  name,
  nameItalic,
  subtitle,
  subtitleItalic,
  trailing,
  trailingRed,
  liveFrom,
  thread,
  open,
  onToggle,
  a11yLabel,
  labelTestID,
  body,
  below,
}: StepNodeProps): JSX.Element {
  const elapsed = useElapsed(liveFrom);
  const shown = elapsed === null ? trailing : liveElapsed(elapsed);
  const tappable = onToggle !== undefined;
  return (
    <View style={styles.node}>
      <View
        style={styles.gutter}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {thread.up ? <View style={[styles.up, { backgroundColor: palette.sep }]} /> : null}
        {thread.down ? <View style={[styles.down, { backgroundColor: palette.sep }]} /> : null}
        <View style={styles.nodeBox}>
          <Node kind={node} palette={palette} reduceMotion={reduceMotion} />
        </View>
      </View>
      <View style={styles.column}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={a11yLabel}
          {...(tappable
            ? {
                accessibilityHint: "Shows the thought, command and result",
                accessibilityState: { expanded: open },
              }
            : {})}
          disabled={!tappable}
          onPress={onToggle}
          style={({ pressed }) => [styles.line, pressed ? styles.pressed : undefined]}
        >
          {node === "thinking" ? (
            <ThinkingWord
              palette={palette}
              word={name.tool}
              reduceMotion={reduceMotion}
              {...(labelTestID === undefined ? {} : { testID: labelTestID })}
            />
          ) : (
            <Text
              testID={labelTestID}
              numberOfLines={1}
              maxFontSizeMultiplier={DENSE_FONT_SCALE}
              style={[
                typography.step,
                styles.name,
                { color: palette.label },
                nameItalic === true ? styles.italic : undefined,
              ]}
            >
              {name.server === undefined ? null : (
                <Text style={[styles.server, { color: palette.sec }]}>{`${name.server} · `}</Text>
              )}
              {name.tool}
            </Text>
          )}
          <Text
            numberOfLines={1}
            maxFontSizeMultiplier={DENSE_FONT_SCALE}
            style={[
              subtitleItalic === true ? [typography.step, styles.thoughtLine] : typography.stepMono,
              styles.subtitle,
              { color: palette.sec },
            ]}
          >
            {subtitle}
          </Text>
          {shown === "" ? null : (
            <Text
              numberOfLines={1}
              maxFontSizeMultiplier={DENSE_FONT_SCALE}
              style={[
                typography.caption,
                { color: trailingRed ? palette.red : palette.sec },
                // The live clock's figures hold one width as they count (S2).
                node === "thinking" ? styles.tabular : undefined,
              ]}
            >
              {shown}
            </Text>
          )}
        </Pressable>
        {below}
        {open && body !== undefined ? (
          <View style={[styles.body, { borderTopColor: palette.sepChat }]}>{body}</View>
        ) : null}
      </View>
    </View>
  );
}

export interface StepBodyProps {
  readonly palette: Palette;
  readonly thought: string | null;
  readonly command: readonly string[];
  readonly output: {
    readonly text: string;
    readonly hidden: number;
    readonly error: boolean;
  } | null;
  readonly outputTestID?: string;
  readonly onShowAll?: () => void;
  /** The diff (`DiffView`), moved here from always-visible (Owner Q7). */
  readonly diff?: ReactNode;
  readonly reply?: string;
  readonly replyTestID?: string;
}

/** The open body: the thought, the full command, the result (`⎿`), the diff, the reply. */
export function StepBody({
  palette,
  thought,
  command,
  output,
  outputTestID,
  onShowAll,
  diff,
  reply,
  replyTestID,
}: StepBodyProps): JSX.Element {
  return (
    <>
      {thought === null ? null : (
        <View style={styles.thought}>
          <ThereforeDots color={palette.sec} style={styles.thoughtMark} />
          <Text style={[styles.thoughtText, { color: palette.sec }]}>{thought}</Text>
        </View>
      )}
      {command.length === 0 ? null : (
        <Text style={[styles.code, { color: palette.label }]}>{command.join("\n")}</Text>
      )}
      {output === null ? null : (
        <Pressable
          testID={outputTestID}
          accessibilityRole="button"
          disabled={output.hidden === 0}
          onPress={onShowAll}
        >
          <Text style={[styles.code, { color: output.error ? palette.red : palette.sec }]}>
            {output.text}
          </Text>
          {output.hidden === 0 ? null : (
            <Text style={[typography.footnote, { color: palette.accent }]}>
              {`… +${output.hidden} more lines`}
            </Text>
          )}
        </Pressable>
      )}
      {diff}
      {reply === undefined ? null : (
        <Text testID={replyTestID} style={[typography.footnote, { color: palette.red }]}>
          {`Your reply: ${reply}`}
        </Text>
      )}
    </>
  );
}

/**
 * The live "Thinking…" node, the list's footer (Owner Q2): a breathing ∴ and a
 * shimmering word (mockup B + D, `thinking-motion.ts`; static under Reduce Motion), the
 * seconds since it appeared (its mount is the tail's identity: a tool or text in
 * between unmounts it), and a tap that opens the live thought.
 */
export function ThinkingNode({
  palette,
  thought,
  up,
  reduceMotion,
}: {
  readonly palette: Palette;
  readonly thought: string;
  readonly up: boolean;
  readonly reduceMotion: boolean;
}): JSX.Element {
  const start = useRef(Date.now()).current;
  const ms = useElapsed(start) ?? 0;
  const label = thinkingLabel(ms);
  const [open, setOpen] = useState(false);
  return (
    <View testID="thinking-footer" style={[styles.footer, up ? undefined : styles.runStart]}>
      <StepNode
        palette={palette}
        node="thinking"
        reduceMotion={reduceMotion}
        name={{ tool: label.word }}
        nameItalic
        subtitle=""
        trailing={label.seconds}
        trailingRed={false}
        thread={{ up, down: false }}
        open={open}
        {...(thought === ""
          ? {}
          : {
              onToggle: () => {
                animateNextLayout(reduceMotion);
                setOpen((was) => !was);
              },
            })}
        a11yLabel={thinkingA11yLabel(ms)}
        body={<StepBody palette={palette} thought={thought} command={[]} output={null} />}
      />
    </View>
  );
}

/**
 * The compaction slot in the Thinking node's place (docs/feat/mobile-hub-commands.md
 * C2 item 15): `Compacting…` with the same breathing ∴ (static under Reduce
 * Motion) and its live seconds, or a static `Compacted ✓`. `compact-slot.ts`
 * decides which; this only draws it.
 */
export function CompactSlotNode({
  palette,
  slot,
  reduceMotion,
}: {
  readonly palette: Palette;
  readonly slot: SlotView;
  readonly reduceMotion: boolean;
}): JSX.Element {
  const running = slot.kind === "compacting";
  return (
    <View testID={`compact-slot-${slot.kind}`} style={[styles.footer, styles.runStart]}>
      <StepNode
        palette={palette}
        node={running ? "thinking" : "ok"}
        reduceMotion={reduceMotion}
        name={{ tool: running ? "Compacting…" : "Compacted ✓" }}
        nameItalic={running}
        subtitle=""
        trailing=""
        trailingRed={false}
        {...(running ? { liveFrom: slot.since } : {})}
        thread={{ up: false, down: false }}
        open={false}
        a11yLabel={running ? "Compacting" : "Compacted"}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  node: { flexDirection: "row" },
  gutter: { width: GUTTER },
  up: { position: "absolute", left: GUTTER / 2 - 0.5, width: 1, top: 0, height: NODE_Y },
  down: { position: "absolute", left: GUTTER / 2 - 0.5, width: 1, top: NODE_Y, bottom: 0 },
  nodeBox: {
    position: "absolute",
    top: NODE_Y - 7,
    left: -2,
    width: GUTTER + 4,
    height: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  // A 7 pt dot ringed 3 pt in `page`, so the thread stops short of it.
  dot: { width: 13, height: 13, borderRadius: 6.5, borderWidth: 3 },
  ring: { width: 9, height: 9, borderRadius: 4.5, borderWidth: 1.2 },
  spinner: { width: 10, height: 10, borderRadius: 5, borderWidth: 1.5 },
  wake: { fontSize: 13, lineHeight: 15, textAlign: "center" },
  // The live ∴ (B): the glyph's size (`THEREFORE_SIZE`), drawn as three thin dots.
  dotBox: { width: THEREFORE_SIZE, height: THEREFORE_SIZE },
  breathDot: { position: "absolute", width: 3, height: 3, borderRadius: 1.5 },
  glyphs: { position: "absolute", top: 0, left: 0 },
  column: { flex: 1, marginLeft: GUTTER },
  line: { minHeight: size.touch, flexDirection: "row", alignItems: "center", gap: 6 },
  pressed: { opacity: 0.6 },
  name: { flexShrink: 0, maxWidth: "45%" },
  server: { fontWeight: "400" },
  italic: { fontStyle: "italic" },
  tabular: { fontVariant: ["tabular-nums"] },
  subtitle: { flex: 1 },
  thoughtLine: { fontStyle: "italic", fontWeight: "400" },
  body: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 8, paddingBottom: 10, gap: 8 },
  thought: { flexDirection: "row", gap: 6 },
  // The first text line is 19 pt tall: centre the 13 pt box on it.
  thoughtMark: { marginTop: (19 - THEREFORE_SIZE) / 2 },
  thoughtText: { flex: 1, fontSize: 13.5, lineHeight: 19, fontStyle: "italic" },
  code: { fontSize: 12, lineHeight: 17, fontFamily: MONO },
  footer: { paddingHorizontal: space.inset, marginBottom: 6 },
  runStart: { marginTop: 6 },
});
