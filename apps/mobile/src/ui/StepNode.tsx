/**
 * One node on the thread of steps (docs/feat/mobile-tool-rows.md Design 3,
 * mockup C): a 1 px `sep` rail in a 10 pt gutter, the node on the first line's
 * centre (a dot — blinking while it runs —, or a ring), then ONE line — name, mono
 * subtitle, the duration — and, when open, the body under it. A dumb renderer:
 * every string and decision comes from `tool-steps.ts` / `tool-summary.ts` /
 * `step-blink.ts` / `step-rail.ts`; this file owns only the look, the 1 s clock
 * and the spin.
 *
 * docs/fix/mobile-step-rail.md (owner 22/11): ONE node shape for every step, so
 * the rail reads as one continuous line — a tool's dot, the live thought's dot
 * (the same accent, the same blink clock) and a finished thought's dim ring;
 * a step with a `$ command` line grows a small curved branch off the rail to it
 * (decision 3), and the line shows a failure's `exit N` at its end (decision 2).
 */
import { type JSX, type ReactNode, useContext, useEffect, useRef, useState } from "react";
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
import { STEP_ELAPSED_TICK_MS } from "../motion.ts";
import {
  STEP_BLINK_CURVE,
  STEP_BLINK_LOOP_MS,
  runningDotLook,
  thoughtLook,
} from "../step-blink.ts";
import { BRANCH_REACH, BRANCH_TURN, GUTTER, NODE_Y, branchGeometry } from "../step-rail.ts";
import { DENSE_FONT_SCALE, MONO, type Palette, size, space, typography } from "../theme.ts";
import {
  DOT_ORDER,
  type DotPos,
  SHIMMER_MS,
  shimmerCanvas,
  shimmerFont,
  shimmerLine,
  shimmerSweep,
  thinkingLabel,
  thinkingLook,
} from "../thinking-motion.ts";
import { type StepDot, type ThreadPos, thinkingA11yLabel } from "../tool-steps.ts";
import { type ToolNameParts, liveElapsed } from "../tool-summary.ts";
import { Text } from "./Text.tsx";
import { animateNextLayout } from "./animate.ts";
import { AppFontContext } from "./app-font.ts";

/** The node's look: a tool's status, an orphan thought (a dim ring), the live footer (an accent dot). */
/** `wake`: a fired scheduled wake's `◷` (docs/feat/scheduled-fire-row.md). */
export type NodeKind = StepDot | "thought" | "thinking" | "wake";

/** Every ∴ (a folded thought in the open body): owner asked a bit larger than 10. */
const THEREFORE_SIZE = 13;

/** Milliseconds since `from`, re-read once a second; null when there is no `from`. */
function useElapsed(from: number | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (from === undefined) {
      return;
    }
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), STEP_ELAPSED_TICK_MS);
    return () => clearInterval(id);
  }, [from]);
  return from === undefined ? null : Math.max(0, now - from);
}

/**
 * The ONE blink clock every running step shares (like the TUI's one phase): a
 * 0→1 loop on the native driver, started by the first blinking dot and stopped
 * with the last, so every running dot is ON and OFF at the same moment.
 */
const blink: { value: Animated.Value; users: number; loop: Animated.CompositeAnimation | null } = {
  value: new Animated.Value(0),
  users: 0,
  loop: null,
};

/** The shared blink clock while `on`; null (a steady dot) otherwise. */
function useSharedBlink(on: boolean): Animated.Value | null {
  useEffect(() => {
    if (!on) {
      return;
    }
    blink.users += 1;
    if (blink.users === 1) {
      blink.value.setValue(0);
      blink.loop = Animated.loop(
        Animated.timing(blink.value, {
          toValue: 1,
          duration: STEP_BLINK_LOOP_MS,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
      );
      blink.loop.start();
    }
    return () => {
      blink.users -= 1;
      if (blink.users === 0) {
        blink.loop?.stop();
        blink.loop = null;
      }
    };
  }, [on]);
  return on ? blink.value : null;
}

/**
 * A running step's node (docs/fix/mobile-running-row.md): the done dot — same
 * place, same size, the `page` ring stopping the thread — in accent, blinking ON
 * and OFF on the TUI's rhythm (`step-blink.ts`); steady under Reduce Motion.
 */
function BlinkingDot({ palette, still }: { palette: Palette; still: boolean }) {
  const look = runningDotLook(still);
  const clock = useSharedBlink(look.blink);
  return (
    <Animated.View
      testID="step-running-dot"
      style={[
        styles.dot,
        { backgroundColor: palette[look.fill], borderColor: palette.page },
        clock === null ? undefined : { opacity: clock.interpolate(STEP_BLINK_CURVE) },
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
 * A static ∴, drawn as three dots — the OPEN BODY's folded thought, which keeps
 * its marker (owner 17/11: the reasoning in the body is what the ∴ belongs to).
 * Drawn, not the font's glyph, which stays tiny even at 13 pt (simulator sweep,
 * docs/fix/mobile-qa-sweep.md).
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

/**
 * The REASONING node (docs/fix/mobile-step-rail.md, owner decision 4): the tool
 * dot's size and place, so the thread has ONE shape. Still thinking ⇒ a filled
 * accent dot on the running step's OWN blink clock; done ⇒ an outline-only ring
 * in the dim `thought` token (a steady ring either way).
 *
 * Exported for its own render test (`step-rail-render.test.ts`): it holds no
 * state, so it can be called directly the way `StepBody` is.
 */
export function ThoughtDot({
  palette,
  live,
  still,
}: { palette: Palette; live: boolean; still: boolean }): JSX.Element {
  const look = thoughtLook(live);
  if (look.node === "thought-done") {
    return (
      <View
        testID="step-thought-ring"
        style={[
          styles.dot,
          styles.thoughtRing,
          { borderColor: palette.thought, backgroundColor: palette.page },
        ]}
      />
    );
  }
  return <BlinkingDot palette={palette} still={still} />;
}

/** An svg `Rect` the native driver can move (S0 of docs/feat/mobile-thinking-images.md). */
const AnimatedRect = Animated.createAnimatedComponent(Rect);
/** The baseline sits this many font sizes below the line box's centre (half of ascent − descent). */
const GLYPH_BASELINE = 0.35;

/**
 * The word "Thinking" (Owner Q1 = "B", docs/feat/mobile-thinking-images.md) — and
 * a described shell step's running sentence: grey, with a soft bright gradient
 * sweeping across it that is CLIPPED to the glyphs — an svg `ClipPath` made of
 * the text itself, so no box can ever show. The grey text and the clip are the
 * same svg text, so the two cannot drift apart; the RN `Text` under them is
 * transparent and only lays out (width, testID, Dynamic Type, the ellipsis). The
 * gradient's `x` is one native-driver clock (S0's verdict). Plain grey RN text
 * under Reduce Motion or before it is measured.
 *
 * docs/fix/mobile-running-row.md — the svg cannot ellipsize and draws in its own
 * canvas, so it is told (a) the text that FITS: `shimmerLine` of the same text's
 * lines, laid out at the label's real width by a never-seen copy; (b) the
 * label's face (`shimmerFont`, the beta's Figtree); (c) a canvas with room past
 * the advance width for an italic tail (`shimmerCanvas`). `wide`: nothing sits
 * beside it, so it may take the line (as the plain label does), not 45 %.
 */
function ThinkingWord({
  palette,
  word,
  reduceMotion,
  wide,
  testID,
}: {
  palette: Palette;
  word: string;
  reduceMotion: boolean;
  wide: boolean;
  testID?: string;
}) {
  const look = thinkingLook(reduceMotion);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const [line, setLine] = useState("");
  const clock = useLoop(SHIMMER_MS, !look.animate);
  const sweep = shimmerSweep(width);
  const font = useContext(AppFontContext);
  const { fontScale } = useWindowDimensions();
  const fontSize = typography.step.fontSize * Math.min(fontScale, DENSE_FONT_SCALE);
  const canvas = shimmerCanvas(width, height, fontSize);
  const glyphs = clock !== null && sweep.band > 0 && height > 0 && line !== "";
  const glyph = {
    x: 0,
    y: height / 2 + fontSize * GLYPH_BASELINE,
    fontSize,
    ...shimmerFont(font, typography.step.fontWeight),
  };
  const x =
    clock === null
      ? null
      : clock.interpolate({ inputRange: [0, 1], outputRange: [sweep.from, sweep.to] });
  return (
    <View style={wide ? styles.nameWide : styles.name}>
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
          setWidth(e.nativeEvent.layout.width);
          setHeight(e.nativeEvent.layout.height);
        }}
      >
        {word}
      </Text>
      {clock === null || width === 0 ? null : (
        <Text
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          pointerEvents="none"
          maxFontSizeMultiplier={DENSE_FONT_SCALE}
          style={[typography.step, styles.italic, styles.measure, { width }]}
          onTextLayout={(e) => setLine(shimmerLine(e.nativeEvent.lines))}
        >
          {word}
        </Text>
      )}
      {!glyphs || x === null ? null : (
        <Svg pointerEvents="none" width={canvas.width} height={canvas.height} style={styles.glyphs}>
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
              <SvgText {...glyph}>{line}</SvgText>
            </ClipPath>
          </Defs>
          <SvgText {...glyph} fill={palette[look.word]}>
            {line}
          </SvgText>
          <G clipPath="url(#thinking-glyphs)">
            <AnimatedRect
              x={x}
              y={0}
              width={sweep.band}
              height={canvas.height}
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
      return <BlinkingDot palette={palette} still={reduceMotion} />;
    case "thought":
      return <ThoughtDot palette={palette} live={false} still={reduceMotion} />;
    case "thinking":
      return <ThoughtDot palette={palette} live still={reduceMotion} />;
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
  /** A second mono line under the name line (a described shell step's `$ cmd`). */
  readonly subline?: string | null;
  /**
   * At the END of that second line: a failed shell call's `exit N`, never cut
   * (docs/fix/mobile-step-rail.md owner decision 2 — written in TEXT, the owner
   * is colour-blind; the red is only a second cue).
   */
  readonly exitSuffix?: string | null;
  /** The name shimmers like the thinking word (a described shell step, running). */
  readonly shimmer?: boolean;
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
  subline,
  exitSuffix,
  shimmer,
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
  const { fontScale } = useWindowDimensions();
  const branch = branchGeometry(fontScale);
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
        {subline == null ? null : (
          // The rail grows a branch to the `$` line (owner decision 3): the line
          // stays continuous, and the sub-line is visibly THIS step's. Its height
          // and turn follow the type (`branchGeometry`), so Dynamic Type cannot
          // shrink it back to a tick.
          <View
            testID="step-subline-branch"
            style={[
              styles.branch,
              { top: branch.top, height: branch.height, borderColor: palette.sep },
              { borderBottomLeftRadius: BRANCH_TURN },
            ]}
          />
        )}
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
                accessibilityHint: "Shows the details",
                accessibilityState: { expanded: open },
              }
            : {})}
          disabled={!tappable}
          onPress={onToggle}
          style={({ pressed }) => [
            styles.line,
            subline != null ? styles.stacked : undefined,
            pressed ? styles.pressed : undefined,
          ]}
        >
          <View style={subline != null ? styles.lineRow : styles.rowFill}>
            {node === "thinking" || shimmer === true ? (
              <ThinkingWord
                palette={palette}
                word={name.tool}
                reduceMotion={reduceMotion}
                wide={subtitle === ""}
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
                  subtitle === "" ? styles.nameWide : undefined,
                  // `sec`, not `label` (docs/fix/mobile-transcript-type.md owner
                  // decision 3): a step row steps back behind the prose by size and
                  // lightness, never by hue alone (the owner is colour-blind).
                  { color: palette.sec },
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
                subtitleItalic === true
                  ? [typography.step, styles.thoughtLine]
                  : typography.stepMono,
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
                  // One size down from the name (13 vs 14), `sec` below: the duration
                  // is the quietest thing on the line (owner decision 3).
                  typography.stepMeta,
                  { color: trailingRed ? palette.red : palette.sec },
                  // The live clock's figures hold one width as they count (S2).
                  node === "thinking" ? styles.tabular : undefined,
                ]}
              >
                {shown}
              </Text>
            )}
          </View>
          {subline == null ? null : (
            <View style={styles.sublineRow}>
              <Text
                numberOfLines={1}
                ellipsizeMode="tail"
                maxFontSizeMultiplier={DENSE_FONT_SCALE}
                style={[typography.stepMono, styles.sublineText, { color: palette.sec }]}
              >
                {subline}
              </Text>
              {exitSuffix == null ? null : (
                <Text
                  numberOfLines={1}
                  maxFontSizeMultiplier={DENSE_FONT_SCALE}
                  style={[typography.stepMono, styles.exitSuffix, { color: palette.red }]}
                >
                  {exitSuffix}
                </Text>
              )}
            </View>
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
  /**
   * A file tool's coloured content (docs/feat/mobile-file-view.md): it takes
   * the body's place instead of `command`/`output`/`diff`.
   */
  readonly file?: ReactNode;
  readonly reply?: string;
  readonly replyTestID?: string;
}

/** The open body: the thought, the command (or its result), the file, the diff, the reply. */
export function StepBody({
  palette,
  thought,
  command,
  output,
  outputTestID,
  onShowAll,
  file,
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
      {file}
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
 * The live "Thinking…" node, the list's footer (Owner Q2): the accent dot a
 * running step draws (blinking, docs/fix/mobile-step-rail.md decision 4) and a
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
 * C2 item 15): `Compacting…` with the same live thought node (an accent dot,
 * static under Reduce Motion) and its live seconds, or a static `Compacted ✓`.
 * `compact-slot.ts` decides which; this only draws it.
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
  // A finished thought: the dot's own box, outline only (owner decision 4).
  thoughtRing: { borderWidth: 2 },
  ring: { width: 9, height: 9, borderRadius: 4.5, borderWidth: 1.2 },
  wake: { fontSize: 13, lineHeight: 15, textAlign: "center" },
  // The folded thought's ∴ in the open body: the glyph's size, three thin dots.
  dotBox: { width: THEREFORE_SIZE, height: THEREFORE_SIZE },
  breathDot: { position: "absolute", width: 3, height: 3, borderRadius: 1.5 },
  glyphs: { position: "absolute", top: 0, left: 0 },
  // The shimmer's measuring copy: laid out at the label's width, never seen.
  measure: { position: "absolute", top: 0, left: 0, opacity: 0 },
  column: { flex: 1, marginLeft: GUTTER },
  line: { minHeight: size.touch, flexDirection: "row", alignItems: "center", gap: 6 },
  // The name line inside `line`: fills it exactly as its children did directly.
  rowFill: { flex: 1, flexDirection: "row", alignItems: "center", gap: 6 },
  // A described shell step: the name line, then the `$` line under it.
  stacked: { flexDirection: "column", alignItems: "stretch", justifyContent: "center", gap: 0 },
  lineRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  pressed: { opacity: 0.6 },
  // The `$` line with the failure's code pinned at its end: the command shrinks
  // (and ellipsises) so `exit N` is never cut (owner decision 2).
  sublineRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  sublineText: { flexShrink: 1 },
  exitSuffix: { flexShrink: 0 },
  /**
   * The branch off the rail to a step's `$` line (decision 3): it leaves the rail
   * below the node and curves onto the sub-line — the `⎿` idea, hung on the rail
   * instead of stamped in front of the text. Left + bottom border only, one
   * radius rounding the turn; `top`/`height`/radius come from `branchGeometry`,
   * which follows the type's Dynamic Type scale.
   */
  branch: {
    position: "absolute",
    left: GUTTER / 2 - 0.5,
    width: BRANCH_REACH,
    borderLeftWidth: 1,
    borderBottomWidth: 1,
  },
  name: { flexShrink: 0, maxWidth: "45%" },
  // No subtitle beside it (a sentence): the name may take the whole line.
  nameWide: { flexShrink: 1, maxWidth: "100%" },
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
