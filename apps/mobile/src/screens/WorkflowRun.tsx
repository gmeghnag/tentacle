/**
 * One workflow run (docs/fix/workflows-ux.md S6/D3–D4): the graph A render, the
 * summary strip and the ONE ask bar. A dumb renderer (AGENTS §7): what a step IS,
 * what an edge TRACES and what the run SAYS all come from the shared projection
 * (`@tentacle/client`'s `runProjection`/`summary`, D2), where each pill SITS from
 * `workflow-run-layout.ts` (D3), how a phase is drawn from `workflow-marker.ts`
 * (D4) and how a trace is stroked from `workflow-edge.ts`. No branch here decides
 * a phase, a word or a line style — that is the whole point of the slice: the
 * phone's graph and the TUI's words cannot disagree because there is one truth.
 *
 * Two rules the owner set are the reason this looks the way it does:
 * - a TAKEN edge is solid, goto and retry included; only "possible later" is
 *   dashed and "not taken" dotted (`workflow-edge.ts`).
 * - every state is readable without colour: a soft disc with its own glyph, a
 *   plain disc for `not yet`, a dotted ring for `not run`, plus the word.
 *
 * An ask is shown VERBATIM in a bar pinned under the content — never per card
 * (§7: a `run` command is shown as it will run), and never truncated.
 */
import type { WorkflowProjection, WorkflowStepView, WorkflowTimelineRow } from "@tentacle/client";
import { originWords } from "@tentacle/client";
import { summary, timeline } from "@tentacle/client";
import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Pressable, ScrollView, StyleSheet, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { elapsed } from "../activity.ts";
import { type RunClockDeps, startRunClock } from "../run-clock.ts";
import { GUTTER } from "../step-rail.ts";
import { type Palette, size } from "../theme.ts";
import { space, typography } from "../theme.ts";
import { AskSlim } from "../ui/AskSlim.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Icon } from "../ui/Icon.tsx";
import { PillButton } from "../ui/PillButton.tsx";
import { ScreenHeader } from "../ui/ScreenHeader.tsx";
import { Text } from "../ui/Text.tsx";
import { WorkflowMark } from "../ui/WorkflowMark.tsx";
import { EDGE_DIM, type EdgeLook, edgeLook, pillLook } from "../workflow-edge.ts";
import { stateLook } from "../workflow-list.ts";
import { MARKER_SIZE, markerFor } from "../workflow-marker.ts";
import type { AskBar, RunMode, RunState } from "../workflow-run-controller.ts";
import { type RunChip, type RunEdge, type RunNode, runLayout } from "../workflow-run-layout.ts";
import type { NavVisit } from "../workflow-step-detail.ts";
import { stepBody, stepNav, visitWord } from "../workflow-step-detail.ts";
import { WorkflowStepLayer } from "./WorkflowStep.tsx";

export interface WorkflowRunScreenProps {
  readonly palette: Palette;
  readonly title: string;
  readonly state: RunState;
  readonly onBack: () => void;
  readonly onMode: (mode: RunMode) => void;
  /** The slim row's `Review`: bring the parked ask's sheet back over this run. */
  readonly onReviewAsk: () => void;
  /** The slim row's `Answer`: open a question's own text field (it sends nothing). */
  readonly onOpenAnswer: () => void;
  readonly onStop: () => void;
  readonly onResume: () => void;
  readonly onRerun: (stepId: string) => void;
  /** The session's own screen (where an ask is answered when this screen cannot). */
  readonly onOpenSession: () => void;
  /**
   * Open a step's detail layer (D5): the tap on a graph node AND on a rail row. The
   * screen does not decide what a tap means — the controller's `openStep` does. The
   * VISIT is named too, so a step that ran twice opens the row that was tapped.
   */
  readonly onOpenStep: (stepId: string, visit?: NavVisit) => void;
  /** Close the detail layer (its back, or the backdrop). */
  readonly onCloseStep: () => void;
  /** Reduce Motion, read live by the route (a crossfade instead of the flight). */
  readonly reduceMotion: boolean;
  /** The width the layout is measured against (the layer's flight needs it). */
  readonly width: number;
}

/**
 * The slim row pinned under the content (docs/fix/mobile-ask-surfaces.md D6): the
 * ask is never answered here and never drawn verbatim here — its sheet (the card
 * with the command as it will run, §7) is presented over this run by the Session
 * screen under it. The row is what stays when that sheet is parked (`Review`
 * brings it back), when the ask is not this run's (Q1: `Open the session`) or
 * when no sheet exists for the session. One row, whatever the view.
 */
function AskPanel({
  palette,
  bar,
  onReviewAsk,
  onOpenAnswer,
  onOpenSession,
}: {
  readonly palette: Palette;
  readonly bar: AskBar;
  readonly onReviewAsk: () => void;
  readonly onOpenAnswer: () => void;
  readonly onOpenSession: () => void;
}): JSX.Element {
  const row =
    bar.kind === "ask"
      ? {
          title: bar.ask.title,
          origin: bar.ask.origin === undefined ? "This run" : originWords(bar.ask.origin).lead,
          // The controller decided the word (`askBarFor`); a question takes text,
          // not a grant, so its tap opens the sheet's field.
          action: bar.action === "answer" ? "Answer" : "Review",
          onPress: bar.action === "answer" ? onOpenAnswer : onReviewAsk,
        }
      : bar.kind === "foreign"
        ? {
            title: bar.ask.title,
            origin:
              bar.ask.origin === undefined ? "Another request" : originWords(bar.ask.origin).lead,
            action: "Open the session",
            onPress: onOpenSession,
          }
        : {
            title: "Waiting for your answer",
            origin: bar.stepId,
            action: "Open the session",
            onPress: onOpenSession,
          };
  return (
    <View testID="workflow-ask" style={[styles.bar, { borderTopColor: palette.sepChat }]}>
      <AskSlim
        testID={
          bar.kind === "ask"
            ? bar.stepId === null
              ? "workflow-ask-run"
              : `workflow-ask-${bar.stepId}`
            : bar.kind === "foreign"
              ? "workflow-ask-foreign"
              : `workflow-open-session-${bar.stepId}`
        }
        palette={palette}
        title={row.title}
        originShort={row.origin}
        more={0}
        actionLabel={row.action}
        onPress={row.onPress}
      />
    </View>
  );
}

/** The phone's own clock and timers, for the strip's `startRunClock`. */
const RUN_CLOCK: RunClockDeps = {
  now: () => Date.now(),
  schedule: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

/** The run's own facts (D2's `summary`): the outcome and its phase marker, the time, then the detail line. */
function SummaryStrip({
  palette,
  projection,
}: {
  readonly palette: Palette;
  readonly projection: WorkflowProjection;
}): JSX.Element {
  // The strip owns the time (docs/fix/mobile-workflow-run-jank.md): only it
  // repaints on a tick, never the graph, the list or the step layer.
  const { startedAt, endedAt } = projection.run;
  const [now, setNow] = useState(() => Date.now());
  useEffect(
    () =>
      startRunClock(
        { startedAt, ...(endedAt === undefined ? {} : { endedAt }) },
        RUN_CLOCK,
        setNow,
      ),
    [startedAt, endedAt],
  );
  const line = summary(projection, now);
  const look = markerFor({ phase: line.phase, word: line.word }, palette);
  return (
    <View testID="workflow-summary" style={[styles.summary, { borderBottomColor: palette.sep }]}>
      <View style={styles.summaryLine}>
        <WorkflowMark
          palette={palette}
          look={look}
          size={MARKER_SIZE.rail}
          label={line.word}
          blink={false}
        />
        <Text style={[styles.summaryWord, { color: palette.label }]} numberOfLines={1}>
          {line.word}
        </Text>
        <Text style={[styles.summaryTime, { color: palette.label }]}>{line.time}</Text>
      </View>
      <Text testID="workflow-summary-line" style={[styles.meta, { color: palette.sec }]}>
        {line.line2}
      </Text>
    </View>
  );
}

/**
 * One drawn edge. A `go` edge's dash FLOWS (`--wr-flow`: the offset walks a dash
 * period and repeats) and stands still under Reduce Motion — the animation is the
 * only thing that ever says "right now" by movement, so it must be the one the
 * switch stops.
 */
function Edge({
  palette,
  edge,
  reduceMotion,
}: {
  readonly palette: Palette;
  readonly edge: RunEdge;
  readonly reduceMotion: boolean;
}): JSX.Element {
  const look: EdgeLook = edgeLook(edge.trace, palette);
  const flow = useRef(new Animated.Value(0)).current;
  const animate = look.animate && !reduceMotion;
  useEffect(() => {
    if (!animate) {
      flow.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(flow, {
        toValue: 1,
        duration: FLOW_MS,
        easing: Easing.linear,
        // The loop runs for the whole live run: off the JavaScript thread
        // (docs/feat/mobile-ui-fluidity-s7.md, Design 3).
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => {
      loop.stop();
      flow.setValue(0);
    };
  }, [animate, flow]);
  const offset = animate
    ? flow.interpolate({ inputRange: [0, 1], outputRange: [0, -FLOW_OFFSET] })
    : 0;
  return (
    <AnimatedPath
      testID={`workflow-edge-${edge.key}`}
      d={edge.d}
      stroke={look.stroke}
      strokeWidth={look.width}
      strokeOpacity={look.opacity}
      strokeDasharray={look.dashArray}
      strokeDashoffset={offset}
      strokeLinecap="round"
      fill="none"
    />
  );
}

/** The mockup's `wr-flow`: one dash period per `--ms-breathe` (1500 ms). */
const FLOW_MS = 1500;
const FLOW_OFFSET = 18;
const AnimatedPath = Animated.createAnimatedComponent(Path);

/** A counter chip (`✗ 1/2`, `↻ 0/1`), centred on its arc and clear of every pill (D3). */
function Chip({
  palette,
  chip,
}: { readonly palette: Palette; readonly chip: RunChip }): JSX.Element {
  const look = edgeLook(chip.trace, palette);
  return (
    <View
      testID={`workflow-chip-${chip.key}`}
      style={[
        styles.chip,
        {
          left: chip.x - chip.width / 2,
          top: chip.y - chip.height / 2,
          width: chip.width,
          height: chip.height,
          backgroundColor: palette.page,
          borderColor: palette.sep,
          borderStyle: look.dashArray === undefined ? "solid" : "dashed",
        },
      ]}
    >
      <Text style={[styles.chipText, { color: look.stroke }]} numberOfLines={1}>
        {chip.text}
      </Text>
    </View>
  );
}

/** One pill: the phase's marker, the step's name, and the projection's own `meta` line. */
function Pill({
  palette,
  projection,
  node,
  reduceMotion,
  onOpenStep,
}: {
  readonly palette: Palette;
  readonly projection: WorkflowProjection;
  readonly node: RunNode;
  readonly reduceMotion: boolean;
  readonly onOpenStep: (stepId: string) => void;
}): JSX.Element {
  const step: WorkflowStepView | undefined = projection.steps.find((s) => s.id === node.id);
  const look = markerFor(step ?? { phase: node.phase, word: "" }, palette);
  const chrome = pillLook(node.phase);
  const running = node.phase === "running";
  return (
    <Pressable
      testID={`workflow-node-${node.id}`}
      accessibilityRole="button"
      accessibilityLabel={`${node.id} · ${look.word}`}
      onPress={() => onOpenStep(node.id)}
      style={[
        styles.pill,
        {
          left: node.x,
          top: node.y,
          width: node.width,
          height: node.height,
          borderRadius: node.radius,
          backgroundColor: chrome.body ? palette.card : "transparent",
          borderColor: chrome.emphatic ? palette.accent : palette.sep,
          borderWidth: chrome.ringWidth,
          borderStyle: chrome.ring,
        },
      ]}
    >
      <WorkflowMark
        palette={palette}
        look={look}
        size={MARKER_SIZE.pill}
        label={look.word}
        blink={running && !reduceMotion}
      />
      <View style={styles.pillText}>
        <Text
          numberOfLines={1}
          style={[styles.pillName, { color: palette.label, opacity: chrome.dim ? DIM : 1 }]}
        >
          {node.id}
        </Text>
        <Text
          numberOfLines={1}
          style={[styles.pillMeta, { color: palette.sec, opacity: chrome.dim ? DIM : 1 }]}
        >
          {step?.meta ?? look.word}
        </Text>
      </View>
    </Pressable>
  );
}

/** The mockup's `--wr-dim`, for a step that did not happen. */
const DIM = EDGE_DIM;

/** View A: the run's graph, drawn from the shared layout (never a guess at the definition). */
function Graph({
  palette,
  projection,
  reduceMotion,
  onOpenStep,
}: {
  readonly palette: Palette;
  readonly projection: WorkflowProjection;
  readonly reduceMotion: boolean;
  onOpenStep: (stepId: string) => void;
}): JSX.Element {
  const geometry = runLayout(projection);
  return (
    <View
      testID="workflow-graph"
      style={{ width: geometry.width, height: geometry.height, alignSelf: "center" }}
    >
      <Svg width={geometry.width} height={geometry.height} style={StyleSheet.absoluteFill}>
        {geometry.edges.map((edge) => (
          <Edge key={edge.key} palette={palette} edge={edge} reduceMotion={reduceMotion} />
        ))}
      </Svg>
      {geometry.nodes.map((node) => (
        <Pill
          key={node.id}
          palette={palette}
          projection={projection}
          node={node}
          reduceMotion={reduceMotion}
          onOpenStep={onOpenStep}
        />
      ))}
      {geometry.chips.map((chip) => (
        <Chip key={chip.key} palette={palette} chip={chip} />
      ))}
    </View>
  );
}

/**
 * View B (docs/fix/workflows-ux.md D5, S7): the run's TIMELINE, drawn on the chat
 * step-rail look — the visits as they happened, then «Next», then «Not run», each
 * row a marker, the step's name, what happened to it and its duration.
 *
 * It is the SAME `timeline()` the detail's position and arrows read
 * (`workflow-step-detail.ts`), so a row and a `4 of 8` can never disagree. Every
 * row is a tap into the step's detail — the rail is the run's history, and the
 * history is how a person reaches a step that the graph's pills also show.
 */
function Timeline({
  palette,
  projection,
  reduceMotion,
  onOpenStep,
}: {
  readonly palette: Palette;
  readonly projection: WorkflowProjection;
  readonly reduceMotion: boolean;
  readonly onOpenStep: (stepId: string, visit?: NavVisit) => void;
}): JSX.Element {
  const line = timeline(projection);
  const row = (entry: WorkflowTimelineRow, key: string): JSX.Element => (
    <TimelineRow
      key={key}
      palette={palette}
      entry={entry}
      word={visitWord(projection, entry)}
      reduceMotion={reduceMotion}
      onPress={() => onOpenStep(entry.step, visitOf(entry))}
    />
  );
  return (
    <View testID="workflow-timeline" style={styles.timeline}>
      {line.droppedNote === undefined ? null : (
        <Text style={[styles.dropped, { color: palette.sec }]}>{line.droppedNote}</Text>
      )}
      {line.rows.map((entry, i) => row(entry, `visit-${i}-${entry.step}`))}
      <TimelineSection
        palette={palette}
        label="Next"
        entries={line.next}
        render={(entry, i) => row(entry, `next-${i}-${entry.step}`)}
      />
      <TimelineSection
        palette={palette}
        label="Not run"
        entries={line.notRun}
        render={(entry, i) => row(entry, `notrun-${i}-${entry.step}`)}
      />
    </View>
  );
}

/** The visit a row Stands for, so a tap opens THAT visit's detail (not just its step). */
function visitOf(entry: WorkflowTimelineRow): NavVisit | undefined {
  if (entry.attempt === undefined && entry.round === undefined) {
    return undefined;
  }
  return {
    ...(entry.attempt === undefined ? {} : { attempt: entry.attempt }),
    ...(entry.round === undefined ? {} : { round: entry.round }),
  };
}

/** «Next» / «Not run»: a band's label, then its rows — absent entirely when empty. */
function TimelineSection({
  palette,
  label,
  entries,
  render,
}: {
  readonly palette: Palette;
  readonly label: string;
  readonly entries: readonly WorkflowTimelineRow[];
  readonly render: (entry: WorkflowTimelineRow, index: number) => JSX.Element;
}): JSX.Element | null {
  if (entries.length === 0) {
    return null;
  }
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionLabel, { color: palette.sec }]}>{label}</Text>
      {entries.map(render)}
    </View>
  );
}

/**
 * One row of the rail: the phase's marker in the gutter, the step's name and what
 * happened to it, its duration on the right, and — on a `not run` row — the WHY.
 * The marker is a `rail` (18 pt) and blinks only while the run is on it and Reduce
 * Motion allows it; the row's own indent comes from `step-rail.ts`'s gutter, so it
 * lines up with the transcript's steps above and below.
 */
function TimelineRow({
  palette,
  entry,
  word,
  reduceMotion,
  onPress,
}: {
  readonly palette: Palette;
  readonly entry: WorkflowTimelineRow;
  /** The row's word, decided by `visitWord` (an older visit never reads the latest). */
  readonly word: string;
  readonly reduceMotion: boolean;
  readonly onPress: () => void;
}): JSX.Element {
  const look = markerFor({ phase: entry.phase, word }, palette);
  const running = entry.phase === "running";
  return (
    <Pressable
      testID={`workflow-timeline-${entry.step}`}
      accessibilityRole="button"
      accessibilityLabel={`${entry.step} · ${look.word}`}
      onPress={onPress}
      style={styles.tlRow}
    >
      <View style={styles.tlRail}>
        <WorkflowMark
          palette={palette}
          look={look}
          size={MARKER_SIZE.rail}
          label={look.word}
          blink={running && !reduceMotion}
        />
      </View>
      <View style={styles.tlText}>
        <View style={styles.rowHead}>
          <Text style={[styles.name, { color: palette.label }]} numberOfLines={1}>
            {entry.step}
          </Text>
          <Text style={[styles.meta, { color: palette.sec }]} numberOfLines={1}>
            {entry.meta}
          </Text>
          {entry.durationMs === undefined ? null : (
            <Text style={[styles.duration, { color: palette.sec }]}>
              {elapsed(entry.durationMs)}
            </Text>
          )}
        </View>
        {entry.why === undefined ? null : (
          <Text style={[styles.why, { color: palette.sec }]}>
            {entry.why.text}
            {entry.why.small === undefined ? "" : ` ${entry.why.small}`}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

export function WorkflowRunScreen(props: WorkflowRunScreenProps): JSX.Element {
  const { palette, state } = props;
  const run = state.run;
  const projection = state.projection;
  const next: RunMode = state.mode === "graph" ? "list" : "graph";
  // The detail layer (D5): ONE flight at a time — the node tapped, or the rail row.
  const openCard =
    state.openStepId === null ? undefined : state.steps.find((c) => c.step.id === state.openStepId);
  const ready = state.phase === "ready" && run !== null && projection !== null;
  return (
    <View testID="workflow-run" style={[styles.screen, { backgroundColor: palette.page }]}>
      <ScreenHeader
        palette={palette}
        variant="compact"
        title={run?.name ?? props.title}
        subtitle={run === null ? undefined : `v${run.version} · ${run.hash.slice(0, 7)}`}
        left={
          <Pressable
            testID="workflow-run-back"
            accessibilityRole="button"
            accessibilityLabel="Back"
            hitSlop={8}
            onPress={props.onBack}
          >
            <Icon name="chevron.left" color={palette.label} size={18} />
          </Pressable>
        }
        right={
          <Pressable
            testID="workflow-run-mode"
            accessibilityRole="button"
            accessibilityLabel={next === "list" ? "Show the list" : "Show the graph"}
            hitSlop={8}
            onPress={() => props.onMode(next)}
          >
            <Icon
              name={next === "list" ? "list.bullet" : "square.grid.2x2"}
              color={palette.label}
              size={18}
            />
          </Pressable>
        }
      />
      {state.notice === null ? null : (
        <Text testID="workflow-run-notice" style={[styles.notice, { color: palette.sec }]}>
          {state.notice}
        </Text>
      )}
      {state.phase === "ended" ? (
        <EmptyState
          testID="workflow-run-ended"
          palette={palette}
          title="This session has ended"
          action={<PillButton palette={palette} label="Back" onPress={props.onBack} />}
        />
      ) : state.phase === "opening" || (state.phase === "ready" && run === null) ? (
        <EmptyState palette={palette} loading />
      ) : state.phase === "failed" ? (
        <EmptyState
          testID="workflow-run-failed"
          palette={palette}
          title="Could not open the session"
        />
      ) : (
        <>
          {projection === null ? null : <SummaryStrip palette={palette} projection={projection} />}
          <ScrollView contentContainerStyle={styles.content}>
            {state.mode === "graph" && projection !== null ? (
              <Graph
                palette={palette}
                projection={projection}
                reduceMotion={props.reduceMotion}
                onOpenStep={props.onOpenStep}
              />
            ) : projection === null ? null : (
              <Timeline
                palette={palette}
                projection={projection}
                reduceMotion={props.reduceMotion}
                onOpenStep={props.onOpenStep}
              />
            )}
            {run === null ? null : run.endedAt === undefined ? (
              <PillButton
                palette={palette}
                testID="workflow-run-stop"
                kind="destructive"
                label="Stop"
                onPress={props.onStop}
              />
            ) : run.state !== "ok" ? (
              <PillButton
                palette={palette}
                testID="workflow-run-resume"
                kind="secondary"
                label="Resume"
                onPress={props.onResume}
              />
            ) : null}
          </ScrollView>
        </>
      )}
      {ready && state.askBar === null ? null : ready && state.askBar !== null ? (
        <AskPanel
          palette={palette}
          bar={state.askBar}
          onReviewAsk={props.onReviewAsk}
          onOpenAnswer={props.onOpenAnswer}
          onOpenSession={props.onOpenSession}
        />
      ) : null}
      {openCard === undefined || run === null || projection === null ? null : (
        <WorkflowStepLayer
          palette={palette}
          step={openCard.step}
          detail={openCard.detail}
          projection={projection}
          width={props.width}
          reduceMotion={props.reduceMotion}
          runName={run.name}
          /** The detail's position and its prev/next: B's visit order (owner 6b). */
          nav={stepNav(projection, openCard.step.id, run.name, state.openVisit)}
          blocks={stepBody(
            projection,
            openCard.step,
            openCard.detail,
            (kind) => kind,
            (s) => stateLook(s).word,
            openCard.look.tone === "error" ? 1 : 0,
          )}
          onClose={props.onCloseStep}
          onOpenStep={props.onOpenStep}
          onRerun={props.onRerun}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: space.inset, gap: space.inset },
  notice: { ...typography.footnote, paddingHorizontal: space.inset },
  summary: {
    paddingHorizontal: space.inset,
    paddingTop: space.inset - 6,
    paddingBottom: space.inset - 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 4,
  },
  summaryLine: { flexDirection: "row", alignItems: "center", gap: space.inset / 2 },
  summaryWord: { ...typography.headline, flex: 1 },
  summaryTime: { ...typography.body, fontVariant: ["tabular-nums"] },
  timeline: { gap: 2 },
  dropped: { ...typography.footnote, paddingVertical: 6 },
  section: { gap: 2 },
  sectionLabel: { ...typography.caption, paddingTop: space.inset - 6, paddingBottom: 4 },
  tlRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    minHeight: size.touch * 0.66,
    paddingVertical: 6,
  },
  tlRail: { width: GUTTER + MARKER_SIZE.rail, alignItems: "flex-start", paddingTop: 2 },
  tlText: { flex: 1, minWidth: 0, gap: 2 },
  why: { ...typography.footnote },
  duration: { ...typography.footnote, fontVariant: ["tabular-nums"] },
  rowHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  name: { ...typography.body, flex: 1, fontWeight: "600" },
  meta: { ...typography.footnote },
  pill: {
    position: "absolute",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingLeft: 7,
    paddingRight: 12,
    overflow: "hidden",
  },
  pillText: { flex: 1, minWidth: 0 },
  pillName: { ...typography.subheadStrong },
  pillMeta: { ...typography.caption },
  chip: {
    position: "absolute",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 9,
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipText: { ...typography.caption, fontFamily: typography.mono.fontFamily },
  bar: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.inset,
    paddingTop: 12,
    paddingBottom: 12,
    backgroundColor: "transparent",
  },
});
