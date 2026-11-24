/**
 * One workflow run (docs/feat/workflows-ui.md D4, slice 3): graph 2C ⇄ cards 2A,
 * a native-stack PUSH. A dumb renderer (AGENTS §7): the run, the step looks, the
 * ask ↔ step pairing and every action are `workflow-run-controller.ts`'s; the
 * graph's geometry is `workflow-graph.ts`'s. An approve card shows the ask's
 * title and detail VERBATIM — scrollable, never truncated (§7: a `run` command is
 * shown as it will run). Glyph + word on every step (never hue alone).
 */
import type { WorkflowStepRow } from "@tentacle/protocol";
import type { JSX } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import type { Palette } from "../theme.ts";
import { space, typography } from "../theme.ts";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Icon } from "../ui/Icon.tsx";
import { PillButton } from "../ui/PillButton.tsx";
import { ScreenHeader } from "../ui/ScreenHeader.tsx";
import { Text } from "../ui/Text.tsx";
import { graphGeometry } from "../workflow-graph.ts";
import { stateLook } from "../workflow-list.ts";
import type { CardAsk, RunMode, RunState, StepCard } from "../workflow-run-controller.ts";
import { stepBlocks } from "../workflow-step-detail.ts";
import { WorkflowStepLayer } from "./WorkflowStep.tsx";

export interface WorkflowRunScreenProps {
  readonly palette: Palette;
  readonly title: string;
  readonly state: RunState;
  readonly onBack: () => void;
  readonly onMode: (mode: RunMode) => void;
  readonly onAnswer: (stepId: string | null, optionId: "allow_once" | "reject_once") => void;
  readonly onStop: () => void;
  readonly onResume: () => void;
  readonly onRerun: (stepId: string) => void;
  /** The session's own screen (where an ask is answered when this screen cannot). */
  readonly onOpenSession: () => void;
  /**
   * Open a step's detail layer (D5): the tap on a graph node AND on a card. The
   * screen does not decide what a tap means — the controller's `openStep` does.
   */
  readonly onOpenStep: (stepId: string) => void;
  /** Close the detail layer (its back, or the backdrop). */
  readonly onCloseStep: () => void;
  /** Reduce Motion, read live by the route (a crossfade instead of the flight). */
  readonly reduceMotion: boolean;
  /** The width the layout is measured against (the layer's flight needs it). */
  readonly width: number;
}

/** The approve block: the ask VERBATIM, then Allow once / Deny (a workflow ask has no "always"). */
function AskBlock({
  palette,
  ask,
  testID,
  onAnswer,
}: {
  readonly palette: Palette;
  readonly ask: CardAsk;
  readonly testID: string;
  readonly onAnswer: (optionId: "allow_once" | "reject_once") => void;
}): JSX.Element {
  return (
    <View testID={testID} style={styles.ask}>
      <Text style={[styles.askTitle, { color: palette.label }]}>{ask.title}</Text>
      <ScrollView style={[styles.detail, { backgroundColor: palette.code }]} nestedScrollEnabled>
        <Text selectable style={[styles.mono, { color: palette.label }]}>
          {ask.detail}
        </Text>
      </ScrollView>
      <View style={styles.buttons}>
        <PillButton
          palette={palette}
          testID={`${testID}-allow`}
          label="Allow once"
          onPress={() => onAnswer("allow_once")}
        />
        <PillButton
          palette={palette}
          testID={`${testID}-deny`}
          kind="destructive"
          label="Deny"
          onPress={() => onAnswer("reject_once")}
        />
      </View>
    </View>
  );
}

function stepLine(step: WorkflowStepRow): string {
  return [step.kind, step.model, step.where === "" ? undefined : step.where]
    .filter((p): p is string => p !== undefined && p !== "")
    .join(" · ");
}

function Card({
  palette,
  card,
  canAnswer,
  onAnswer,
  onRerun,
  onOpenSession,
  onOpenStep,
}: {
  readonly palette: Palette;
  readonly card: StepCard;
  readonly canAnswer: boolean;
  readonly onAnswer: WorkflowRunScreenProps["onAnswer"];
  readonly onRerun: (stepId: string) => void;
  readonly onOpenSession: () => void;
  readonly onOpenStep: (stepId: string) => void;
}): JSX.Element {
  const { step, look, ask } = card;
  const waits = step.state === "needs-approval" || step.state === "waiting";
  return (
    <View
      testID={`workflow-card-${step.id}`}
      style={[styles.card, { backgroundColor: palette.card, borderColor: palette.sep }]}
    >
      <Pressable
        testID={`workflow-card-open-${step.id}`}
        accessibilityRole="button"
        accessibilityLabel={`${step.id} · ${look.word}`}
        onPress={() => onOpenStep(step.id)}
        style={styles.cardHead}
      >
        <View style={styles.rowHead}>
          <Text style={[styles.glyph, { color: palette.label }]}>{look.glyph}</Text>
          <Text style={[styles.name, { color: palette.label }]} numberOfLines={1}>
            {step.id}
          </Text>
          <Text style={[styles.meta, { color: palette.sec }]}>{look.word}</Text>
        </View>
        <Text style={[styles.meta, { color: palette.sec }]} numberOfLines={1}>
          {stepLine(step)}
        </Text>
      </Pressable>
      {step.reason === undefined ? null : (
        <Text style={[styles.meta, { color: palette.sec }]}>{step.reason}</Text>
      )}
      {ask !== null ? (
        <AskBlock
          palette={palette}
          ask={ask}
          testID={`workflow-ask-${step.id}`}
          onAnswer={(optionId) => onAnswer(step.id, optionId)}
        />
      ) : waits && !canAnswer ? (
        <Pressable testID={`workflow-open-session-${step.id}`} onPress={onOpenSession}>
          <Text style={[styles.meta, { color: palette.accent }]}>
            Open the session to answer it
          </Text>
        </Pressable>
      ) : null}
      {step.state === "error" ? (
        <PillButton
          palette={palette}
          testID={`workflow-rerun-${step.id}`}
          kind="secondary"
          label="Re-run step"
          onPress={() => onRerun(step.id)}
        />
      ) : null}
    </View>
  );
}

function Graph({
  palette,
  steps,
  onOpenStep,
}: {
  readonly palette: Palette;
  readonly steps: readonly StepCard[];
  readonly onOpenStep: (stepId: string) => void;
}): JSX.Element {
  const geometry = graphGeometry(steps.map((s) => s.step));
  const looks = new Map(steps.map((s) => [s.step.id, s.look]));
  return (
    <View testID="workflow-graph" style={{ width: geometry.width, height: geometry.height }}>
      <Svg width={geometry.width} height={geometry.height} style={StyleSheet.absoluteFill}>
        {geometry.edges.map((edge) => (
          <Path
            key={edge.key}
            d={edge.d}
            stroke={edge.kind === "future" ? palette.sep : palette.sec}
            strokeWidth={1.5}
            strokeDasharray={edge.kind === "future" ? "4 4" : undefined}
            fill="none"
          />
        ))}
      </Svg>
      {geometry.nodes.map((node) => {
        const look = looks.get(node.id);
        return (
          <Pressable
            key={node.id}
            testID={`workflow-node-${node.id}`}
            accessibilityRole="button"
            accessibilityLabel={`${node.id} · ${look?.word ?? node.state}`}
            onPress={() => onOpenStep(node.id)}
            style={[
              styles.node,
              {
                left: node.x,
                top: node.y,
                width: node.width,
                height: node.height,
                borderRadius: node.radius,
                backgroundColor: palette.card,
                borderColor: palette.sep,
              },
            ]}
          >
            <Text style={[styles.nodeText, { color: palette.label }]} numberOfLines={1}>
              {`${look?.glyph ?? "○"} ${node.id} · ${look?.word ?? node.state}`}
              {node.loopLabel === undefined ? "" : ` ${node.loopLabel}`}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function WorkflowRunScreen(props: WorkflowRunScreenProps): JSX.Element {
  const { palette, state } = props;
  const run = state.run;
  const next: RunMode = state.mode === "graph" ? "cards" : "graph";
  // The detail layer (D5): ONE flight at a time — the node tapped, or the card.
  const openCard =
    state.openStepId === null ? undefined : state.steps.find((c) => c.step.id === state.openStepId);
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
            accessibilityLabel={next === "cards" ? "Show cards" : "Show graph"}
            hitSlop={8}
            onPress={() => props.onMode(next)}
          >
            <Icon
              name={next === "cards" ? "list.bullet" : "square.grid.2x2"}
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
        <ScrollView contentContainerStyle={styles.content}>
          {state.runAsk === null ? null : (
            <AskBlock
              palette={palette}
              ask={state.runAsk}
              testID="workflow-ask-run"
              onAnswer={(optionId) => props.onAnswer(null, optionId)}
            />
          )}
          {state.mode === "graph" ? (
            <>
              {state.steps.map((card) =>
                card.ask === null ? null : (
                  <AskBlock
                    key={card.step.id}
                    palette={palette}
                    ask={card.ask}
                    testID={`workflow-ask-${card.step.id}`}
                    onAnswer={(optionId) => props.onAnswer(card.step.id, optionId)}
                  />
                ),
              )}
              <Graph palette={palette} steps={state.steps} onOpenStep={props.onOpenStep} />
            </>
          ) : (
            state.steps.map((card) => (
              <Card
                key={card.step.id}
                palette={palette}
                card={card}
                canAnswer={state.canAnswer}
                onAnswer={props.onAnswer}
                onRerun={props.onRerun}
                onOpenSession={props.onOpenSession}
                onOpenStep={props.onOpenStep}
              />
            ))
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
      )}
      {openCard === undefined || run === null ? null : (
        <WorkflowStepLayer
          palette={palette}
          step={openCard.step}
          detail={openCard.detail}
          steps={run.steps}
          width={props.width}
          reduceMotion={props.reduceMotion}
          runName={run.name}
          blocks={stepBlocks(
            openCard.step,
            openCard.detail,
            (kind) => kind,
            (s) => stateLook(s).word,
            openCard.look.tone === "error" ? 1 : 0,
          )}
          onClose={props.onCloseStep}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: space.inset, gap: space.inset },
  notice: { ...typography.footnote, paddingHorizontal: space.inset },
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 12, gap: 6 },
  cardHead: { gap: 6 },
  rowHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  glyph: { ...typography.body, width: 18, textAlign: "center" },
  name: { ...typography.body, flex: 1, fontWeight: "600" },
  meta: { ...typography.footnote },
  ask: { gap: 8 },
  askTitle: { ...typography.headline },
  detail: { maxHeight: 220, borderRadius: 8, padding: 8 },
  mono: { ...typography.mono },
  buttons: { flexDirection: "row", gap: 8 },
  node: {
    position: "absolute",
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: "center",
    paddingHorizontal: 10,
  },
  nodeText: { ...typography.footnote },
});
