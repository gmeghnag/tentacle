/**
 * One node on the thread of steps (docs/feat/mobile-tool-rows.md Design 3,
 * mockup C): a 1 px `sep` thread in a 10 pt gutter, the node on the first line's
 * centre (a dot, a spinner, a hollow ring, or ∴), then ONE line — name, mono
 * subtitle, ∴, trailing text — and, when open, the body under it. A dumb
 * renderer: every string and decision comes from `tool-steps.ts` /
 * `tool-summary.ts`; this file owns only the look, the 1 s clock and the spin.
 */
import { type JSX, type ReactNode, useEffect, useRef, useState } from "react";
import { Animated, Easing, Pressable, StyleSheet, Text, View } from "react-native";
import { DENSE_FONT_SCALE, MONO, type Palette, size, space, typography } from "../theme.ts";
import { type StepDot, type ThreadPos, thinkingA11yLabel } from "../tool-steps.ts";
import { type ToolNameParts, liveElapsed } from "../tool-summary.ts";
import { animateNextLayout } from "./animate.ts";

/** The node's look: a tool's status, an orphan thought (∴), the live footer (ring). */
export type NodeKind = StepDot | "thought" | "thinking";

const GUTTER = 10;
/** The node sits on the first line's centre; the line is one touch target tall. */
const NODE_Y = size.touch / 2;
/** Every ∴ (the thought node, the row marker, a folded thought): owner asked a bit larger than 10. */
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
      return (
        <Text
          maxFontSizeMultiplier={DENSE_FONT_SCALE}
          style={[styles.therefore, { color: palette.sec, backgroundColor: palette.page }]}
        >
          ∴
        </Text>
      );
    default:
      // queued, and the live "Thinking…" footer: a hollow ring.
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
  /** The ∴ after the subtitle: a thought is folded into this step. */
  readonly marker: boolean;
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
  marker,
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
          {marker ? (
            <Text
              maxFontSizeMultiplier={DENSE_FONT_SCALE}
              style={[styles.marker, { color: palette.sec }]}
            >
              ∴
            </Text>
          ) : null}
          {shown === "" ? null : (
            <Text
              numberOfLines={1}
              maxFontSizeMultiplier={DENSE_FONT_SCALE}
              style={[typography.caption, { color: trailingRed ? palette.red : palette.sec }]}
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
          <Text style={[styles.thoughtMark, { color: palette.sec }]}>∴</Text>
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
 * The live "Thinking…" node, the list's footer (Owner Q2): a hollow ring, the
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
  const [open, setOpen] = useState(false);
  return (
    <View testID="thinking-footer" style={[styles.footer, up ? undefined : styles.runStart]}>
      <StepNode
        palette={palette}
        node="thinking"
        reduceMotion={reduceMotion}
        name={{ tool: "Thinking…" }}
        nameItalic
        subtitle=""
        marker={false}
        trailing={liveElapsed(ms)}
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
  therefore: { fontSize: THEREFORE_SIZE, lineHeight: 14, textAlign: "center" },
  column: { flex: 1, marginLeft: GUTTER },
  line: { minHeight: size.touch, flexDirection: "row", alignItems: "center", gap: 6 },
  pressed: { opacity: 0.6 },
  name: { flexShrink: 0, maxWidth: "45%" },
  server: { fontWeight: "400" },
  italic: { fontStyle: "italic" },
  subtitle: { flex: 1 },
  thoughtLine: { fontStyle: "italic", fontWeight: "400" },
  marker: { fontSize: THEREFORE_SIZE, opacity: 0.8 },
  body: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 8, paddingBottom: 10, gap: 8 },
  thought: { flexDirection: "row", gap: 6 },
  thoughtMark: { fontSize: THEREFORE_SIZE, lineHeight: 19 },
  thoughtText: { flex: 1, fontSize: 13.5, lineHeight: 19, fontStyle: "italic" },
  code: { fontSize: 12, lineHeight: 17, fontFamily: MONO },
  footer: { paddingHorizontal: space.inset, marginBottom: 6 },
  runStart: { marginTop: 6 },
});
