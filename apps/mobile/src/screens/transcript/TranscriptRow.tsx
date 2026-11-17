import { type ArtifactCardView, artifactCard } from "@tentacle/core";
import type { ArtifactMeta } from "@tentacle/protocol";
/**
 * One transcript row (docs/feat/mobile-session-view.md 12c): a DUMB renderer per
 * row kind (AGENTS §7). Every string is daemon-supplied data — plain `Text`,
 * never executed, never a link unless the markdown tree says so.
 *
 * Look (mockup `Conversation`): the person's message is a right-aligned `fill`
 * bubble; the answer is full-width text on the page; a tool call — and a thought
 * — is a `StepNode` on a thread of steps (docs/feat/mobile-tool-rows.md, mockup
 * C) whose body opens below it.
 *
 * The `testID`s are the contract the Maestro flows assert on (text is invisible
 * to XCUITest under RN's new architecture, plan P9):
 * `row-<key>`, `tool-<callId>-<status>`, `tool-<callId>-output`,
 * `tool-<callId>-reply`, `diff-<callId>`, `image-<imageId>`.
 */
import { type JSX, type ReactNode, useState } from "react";
import { Image, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { CHART_TOOL, chartRowView } from "../../chart-row.ts";
import { diffView } from "../../diff-view.ts";
import { type Parsed, parse } from "../../markdown.ts";
import { type MediaBox, displayUri, layoutMedia, mediaBox } from "../../media-layout.ts";
import { ROW_FALLBACK_TEXT } from "../../row-guard.ts";
import { firedScheduleHead } from "../../schedule-view.ts";
import { DENSE_FONT_SCALE, type Palette, radius, space, typography } from "../../theme.ts";
import { type Thumbnail, type ThumbnailState, thumbnailFor } from "../../thumbnails.ts";
import { type StepCell, type ThreadPos, stepRowView, thoughtRowView } from "../../tool-steps.ts";
import { subAgentLine } from "../../tool-summary.ts";
import { type Row, imageRowText } from "../../transcript-rows.ts";
import { Icon } from "../../ui/Icon.tsx";
import { StepBody, StepNode } from "../../ui/StepNode.tsx";
import { ChartBlock } from "../../ui/chart/ChartBlock.tsx";
import { DiffView } from "./DiffView.tsx";
import { Markdown } from "./Markdown.tsx";
import { MediaViewer } from "./MediaViewer.tsx";

/**
 * The width a bubble's media is laid out at, in points (item 4). The bubble caps
 * at 77% of the page (see `styles.bubble`), and the phone's narrowest supported
 * width is 320 pt: 0.77 × 320 − 2 × 14 (the bubble's own padding) ≈ 218. A fixed
 * figure is what keeps this a pure decision — the real width would need an
 * `onLayout` round-trip, and the photo is drawn `cover` in a box of the right
 * SHAPE, so a few points either way crop rather than distort.
 */
export const MEDIA_BUBBLE_WIDTH = 218;

/** The image's own box, from the pure layout (`mediaBox`). */
function boxStyle(box: MediaBox): { width: number; height: number } {
  return { width: box.width, height: box.height };
}

export interface RowProps {
  readonly row: Row;
  readonly palette: Palette;
  readonly onLink: (href: string) => void;
  /** The loaded thumbnails (the driver's state): a ref with no bytes draws its label. */
  readonly thumbnails: ThumbnailState;
  /**
   * The read-aloud button under an assistant row (docs/feat/mobile-voice.md
   * Design §5): `readAloudOffered` / `speakingRowKey` decide it; absent = none.
   */
  readonly speak?: "offered" | "speaking";
  readonly onSpeak?: (row: { readonly key: string; readonly text: string }) => void;
  /**
   * An `agent_task` card's child in the Activity sheet (`activity.ts`
   * `agentCardTarget`, docs/feat/mobile-chrome.md S8): its id and the tap.
   * Absent: a plain tool row.
   */
  readonly agent?: { readonly id: string; readonly onOpen: () => void };
  /**
   * A `present` row's card was tapped (docs/feat/model-artifacts.md D9): its
   * version's meta, which the screen routes to the gallery/viewer. Absent: the
   * card is still drawn, just not pressable (a test with no router).
   */
  readonly onArtifact?: (meta: ArtifactMeta) => void;
  /**
   * How a tool or reasoning row draws on the thread of steps
   * (docs/feat/mobile-tool-rows.md S2). Absent: a lone, closed step.
   */
  readonly step?: StepProps;
}

/**
 * The screen-owned half of a step: its cell from `stepLayout` and the open /
 * show-all state, which lives in the SCREEN so a virtualised cell that unmounts
 * does not lose it.
 */
export interface StepProps {
  readonly cell: StepCell | undefined;
  readonly open: boolean;
  /** Every output line (the "… +N more lines" row was tapped). */
  readonly full: boolean;
  readonly reduceMotion: boolean;
  readonly onToggle: () => void;
  readonly onShowAll: () => void;
}

/** A step with no neighbour on its thread: just the node. */
const LONE: ThreadPos = { up: false, down: false };

/**
 * A step's cell: no vertical padding, so the thread touches the next cell; the
 * run's 12 pt margin is split at its two ends (6 above its first node, 6 below
 * its last).
 */
function StepShell({
  row,
  thread,
  children,
}: { readonly row: Row; readonly thread: ThreadPos; readonly children: ReactNode }): JSX.Element {
  return (
    <View
      testID={`row-${row.key}`}
      style={[
        styles.step,
        thread.up ? undefined : styles.runStart,
        thread.down ? undefined : styles.runEnd,
      ]}
    >
      {children}
    </View>
  );
}

function Shell({
  row,
  children,
}: { readonly row: Row; readonly children: ReactNode }): JSX.Element {
  return (
    <View testID={`row-${row.key}`} style={styles.row}>
      {children}
    </View>
  );
}

/** The parsed markdown for a text row (cached by key + version in markdown.ts's caller). */
function parsedOf(text: string): Parsed {
  return parse(text);
}

function UserRowView({ row, palette, onLink, thumbnails }: RowProps): JSX.Element {
  const user = row as Extract<Row, { kind: "user" }>;
  // A fired turn's own head (cron-tool S6, M8 option B): the styled row a LIVE
  // `turn_start.schedule` ref earns. No ref → nothing here, and the durable
  // `[scheduled …]` prefix inside the bubble's text is the whole message (option
  // A, which is also what a reload shows: the ref is display data, never stored).
  const fired = firedScheduleHead(user.schedule);
  /** Item 4's geometry: media boxes at the bubble's width, caption below iff there are words. */
  const layout = layoutMedia(user.images, {
    width: MEDIA_BUBBLE_WIDTH,
    hasText: user.text !== "",
  });
  const captionBelow = layout.captionBelow;
  /** The photo open full screen (item 4). One state: null = closed. */
  const [viewing, setViewing] = useState<{ uri: string; label: string } | null>(null);
  /**
   * URIs whose `<Image>` has reported a load failure (Review round 2, R2-1): a
   * file can vanish under a row that outlives it (the app trims old copies, a
   * person can wipe the phone's data), and the bubble must then draw its label
   * rather than an empty frame. `displayUri` decides; this only remembers.
   */
  const [broken, setBroken] = useState<readonly string[]>([]);
  return (
    <Shell row={user}>
      <View style={[styles.bubble, { backgroundColor: palette.fill }]}>
        {fired === "" ? null : (
          <Text
            testID="row-scheduled-head"
            numberOfLines={1}
            maxFontSizeMultiplier={DENSE_FONT_SCALE}
            style={[typography.caption, { color: palette.accent }]}
          >
            {fired}
          </Text>
        )}
        {user.restart === true ? (
          <Text style={[typography.caption, { color: palette.sec }]}>restart prompt</Text>
        ) : null}
        {/* Item 4 (the owner's WhatsApp shape): the media FIRST, full bubble
            width; the caption BELOW it, inside the same bubble. */}
        {user.images.length === 0 ? null : (
          <View style={styles.images}>
            {user.images.map((image) => {
              const thumb = thumbnailFor(thumbnails, image.id);
              // The LOCAL copy wins: it is the only pixels that exist for a photo
              // this phone just sent (`thumbnails.ts:19-25` — no read-back), and a
              // loaded thumbnail is the only source for any other. A URI already
              // known to be unloadable is no answer at all: the label is.
              const uri = displayUri(image.localUri ?? thumb?.uri, broken);
              const box = mediaBox(image, MEDIA_BUBBLE_WIDTH);
              const label = imageRowText(image);
              return (
                <View
                  key={image.id}
                  testID={`image-${image.id}`}
                  style={[styles.image, { backgroundColor: palette.code }, boxStyle(box)]}
                >
                  {uri === undefined ? (
                    // No bytes reachable at all (a history row, another device's
                    // message): the label is what this build can honestly show.
                    <View style={styles.imageLabel}>
                      <Icon name="photo" color={palette.sec} size={18} />
                      <Text numberOfLines={2} style={[typography.caption, { color: palette.sec }]}>
                        {label}
                      </Text>
                    </View>
                  ) : (
                    <Pressable
                      testID={`image-${image.id}-open`}
                      accessibilityRole="imagebutton"
                      accessibilityLabel={`Open ${label}`}
                      onPress={() => setViewing({ uri, label })}
                    >
                      <Image
                        source={{ uri }}
                        style={styles.imageFill}
                        // A file that cannot be read (trimmed, wiped, moved) turns
                        // the bubble back into its label instead of an empty frame.
                        onError={() =>
                          setBroken((had) => (had.includes(uri) ? had : [...had, uri]))
                        }
                        // The box is the photo's own shape (or the clamp), so `cover`
                        // crops at the clamp instead of squashing the photo.
                        resizeMode="cover"
                        accessibilityIgnoresInvertColors
                      />
                    </Pressable>
                  )}
                </View>
              );
            })}
          </View>
        )}
        {/* The attached files, one line each (docs/feat/pdf-read.md D5/D7), under
            the media and inside the same bubble: the `<file>` block they became
            is the model's, so the file is named, never quoted. */}
        {user.documents === undefined || user.documents.length === 0 ? null : (
          <View testID="row-documents" style={styles.documents}>
            {user.documents.map((line) => (
              <View key={line} style={styles.document}>
                <Icon name="doc.on.doc" color={palette.sec} size={14} />
                <Text
                  numberOfLines={2}
                  maxFontSizeMultiplier={DENSE_FONT_SCALE}
                  style={[typography.caption, { color: palette.sec }]}
                >
                  {line}
                </Text>
              </View>
            ))}
          </View>
        )}
        {/* The caption, BELOW the media and inside the same bubble — and never an
            empty block: a photo-only bubble has no text area at all (item 4).
            `hasText` is the words' own presence; the markdown source is its truth. */}
        {!captionBelow ? null : (
          // The bubble is `fill`; code inside it is `code`, which differs (B4).
          <Markdown
            parsed={parsedOf(user.text)}
            palette={palette}
            onLink={onLink}
            codeBackground={palette.code}
          />
        )}
      </View>
      <MediaViewer open={viewing} palette={palette} onClose={() => setViewing(null)} />
    </Shell>
  );
}

function AssistantRowView({ row, palette, onLink, speak, onSpeak }: RowProps): JSX.Element {
  const assistant = row as Extract<Row, { kind: "assistant" }>;
  const speaking = speak === "speaking";
  return (
    <Shell row={assistant}>
      <Markdown parsed={parsedOf(assistant.text)} palette={palette} onLink={onLink} />
      {speak === undefined || onSpeak === undefined ? null : (
        <Pressable
          testID={speaking ? "assistant-speak-stop" : "assistant-speak"}
          accessibilityRole="button"
          accessibilityLabel={speaking ? "Stop reading" : "Read aloud"}
          onPress={() => onSpeak({ key: assistant.key, text: assistant.text })}
          hitSlop={8}
          style={styles.speak}
        >
          <Icon
            name={speaking ? "stop.circle" : "speaker.wave.2"}
            color={speaking ? palette.accent : palette.sec}
            size={16}
          />
        </Pressable>
      )}
    </Shell>
  );
}

/**
 * Reasoning: nothing when it is folded into a step or the live footer
 * (`hidden`), else a `Thought` node — ∴ in the dot's place, its first line in
 * italic, the whole thought on tap (Owner Q1).
 */
function ReasoningRowView({ row, palette, step }: RowProps): JSX.Element | null {
  const reasoning = row as Extract<Row, { kind: "reasoning" }>;
  const cell = step?.cell;
  if (cell?.kind === "hidden") {
    return null;
  }
  const text = cell?.kind === "thought" ? cell.text : reasoning.text;
  const thread = cell?.kind === "thought" ? cell.thread : LONE;
  const view = thoughtRowView(text);
  return (
    <StepShell row={reasoning} thread={thread}>
      <StepNode
        palette={palette}
        node="thought"
        reduceMotion={step?.reduceMotion ?? false}
        name={{ tool: "Thought" }}
        subtitle={view.subtitle}
        subtitleItalic
        marker={false}
        trailing=""
        trailingRed={false}
        thread={thread}
        open={step?.open ?? false}
        {...(step === undefined || text.trim() === "" ? {} : { onToggle: step.onToggle })}
        a11yLabel={view.a11yLabel}
        body={<StepBody palette={palette} thought={text} command={[]} output={null} />}
      />
    </StepShell>
  );
}

/** The device's language, for the chart's numbers and dates (Hermes' Intl reads the device). */
function deviceLocale(): string {
  return Intl.DateTimeFormat().resolvedOptions().locale;
}

/**
 * A `chart` call (docs/feat/model-charts.md slice C6): the chart itself takes the
 * row's place, full width on the page — no tool chrome (owner rule). A spec that
 * does not re-validate, or a failed / refused call, is the generic tool row.
 */
function ChartRowView(props: RowProps): JSX.Element {
  const tool = props.row as Extract<Row, { kind: "tool" }>;
  const screen = useWindowDimensions();
  const view = chartRowView(tool, {
    width: screen.width - 2 * space.inset,
    fontScale: screen.fontScale,
    locale: deviceLocale(),
    palette: props.palette,
  });
  if (view === null) {
    return <ToolRowView {...props} />;
  }
  return (
    <Shell row={tool}>
      <ChartBlock
        view={view}
        tool={tool}
        palette={props.palette}
        locale={deviceLocale()}
        testID={`chart-${tool.id}`}
      />
    </Shell>
  );
}

/**
 * A tool call: one `StepNode` on the thread (its cell from the screen's
 * `stepLayout`), the thought, command, result, diff and reply in its open body;
 * the sub-agent progress and Activity link always under the line. A presented
 * artifact is its card instead (a block: `isBlockRow`, no thread).
 */
function ToolRowView({ row, palette, agent, thumbnails, onArtifact, step }: RowProps): JSX.Element {
  const tool = row as Extract<Row, { kind: "tool" }>;
  const cell = step?.cell;
  const thread = cell?.kind === "step" ? cell.thread : LONE;
  const view = stepRowView(tool, cell?.kind === "step" ? cell.thought : null, step?.full ?? false);
  const diff = tool.diff === undefined ? null : diffView(tool.diff);
  const progress = subAgentLine(tool.sub);
  // A presented artifact IS this row's visible body (docs/feat/model-artifacts.md
  // D9): a band row, not a tool call with a blob of text under it.
  const card = tool.artifact === undefined ? null : artifactCard(tool.artifact);
  const artifact = tool.artifact;
  const below =
    progress === null && agent === undefined ? null : (
      <View style={styles.below}>
        {progress === null ? null : (
          // Item 10: a foreground sub-agent's latest activity, so a long child
          // does not look like a hang.
          <Text
            testID={`tool-${tool.id}-progress`}
            numberOfLines={1}
            maxFontSizeMultiplier={DENSE_FONT_SCALE}
            style={[typography.footnote, { color: palette.sec }]}
          >
            {progress}
          </Text>
        )}
        {agent === undefined ? null : (
          // S8: the card's second entry into Activity (the header pill is the first).
          <Pressable
            testID={`tool-${tool.id}-activity`}
            accessibilityRole="button"
            accessibilityLabel={`Open ${agent.id} in Activity`}
            hitSlop={6}
            onPress={agent.onOpen}
          >
            <Text
              maxFontSizeMultiplier={DENSE_FONT_SCALE}
              style={[typography.footnote, { color: palette.accent }]}
            >
              {`${agent.id} · Activity ›`}
            </Text>
          </Pressable>
        )}
      </View>
    );
  if (card !== null && artifact !== undefined) {
    return (
      <Shell row={tool}>
        <View style={styles.tool}>
          <ArtifactCardRow
            card={card}
            artifactId={artifact.artifactId}
            palette={palette}
            thumbnail={thumbnailFor(thumbnails, artifact.sha256)}
            {...(onArtifact === undefined ? {} : { onPress: () => onArtifact(artifact) })}
          />
          {below}
        </View>
      </Shell>
    );
  }
  return (
    <StepShell row={tool} thread={thread}>
      <StepNode
        palette={palette}
        node={view.dot}
        reduceMotion={step?.reduceMotion ?? false}
        name={view.name}
        subtitle={view.subtitle}
        marker={view.thought !== null}
        trailing={view.trailing}
        trailingRed={view.trailingRed}
        {...(view.live && tool.at !== undefined ? { liveFrom: tool.at } : {})}
        thread={thread}
        open={step?.open ?? false}
        {...(view.tappable && step !== undefined ? { onToggle: step.onToggle } : {})}
        a11yLabel={view.a11yLabel}
        labelTestID={`tool-${tool.id}-${tool.status}`}
        below={below}
        body={
          <StepBody
            palette={palette}
            thought={view.thought}
            command={view.command}
            output={view.output}
            outputTestID={`tool-${tool.id}-output`}
            {...(step === undefined ? {} : { onShowAll: step.onShowAll })}
            diff={
              diff === null ? null : <DiffView view={diff} palette={palette} callId={tool.id} />
            }
            {...(tool.denialReply === undefined
              ? {}
              : { reply: tool.denialReply, replyTestID: `tool-${tool.id}-reply` })}
          />
        }
      />
    </StepShell>
  );
}

/**
 * The artifact card, as a minimal BAND row (docs/feat/model-artifacts.md D9,
 * owner choice A): a 40 pt tile — the image's thumbnail when this phone has its
 * bytes, else the kind's glyph — the title, the card's type-and-size line, and a
 * chevron. No rounded inset card, no border: it sits in the transcript like any
 * other band row.
 *
 * Everything shown is `@tentacle/core`'s card (`artifactCard`): the kind narrowed
 * once, the words the Mac uses too. A `save` card (`other`: a .zip, an extension
 * this build does not know) shows the Share glyph instead of a chevron, because
 * tapping it SHARES — it never opens a viewer.
 */
function ArtifactCardRow({
  card,
  artifactId,
  palette,
  thumbnail,
  onPress,
}: {
  readonly card: ArtifactCardView;
  /** The artifact's id: the e2e flow's own handle (`artifact-card-<artifactId>`). */
  readonly artifactId: string;
  readonly palette: Palette;
  readonly thumbnail: Thumbnail | undefined;
  readonly onPress?: () => void;
}): JSX.Element {
  return (
    <Pressable
      testID={`artifact-card-${artifactId}`}
      accessibilityRole="button"
      accessibilityLabel={`${card.title}, ${card.line2}`}
      disabled={onPress === undefined}
      onPress={onPress}
      style={[styles.card, { borderColor: palette.sep }]}
    >
      <View style={[styles.cardTile, { backgroundColor: palette.code }]}>
        {thumbnail === undefined ? (
          <Text style={[typography.subhead, { color: palette.sec }]}>{card.glyph}</Text>
        ) : (
          <Image
            testID="artifact-card-thumbnail"
            source={{ uri: thumbnail.uri }}
            style={styles.cardThumb}
            resizeMode="cover"
          />
        )}
      </View>
      <View style={styles.cardBody}>
        <Text
          numberOfLines={1}
          maxFontSizeMultiplier={DENSE_FONT_SCALE}
          style={[typography.subhead, { color: palette.label }]}
        >
          {card.title}
        </Text>
        <Text
          numberOfLines={1}
          maxFontSizeMultiplier={DENSE_FONT_SCALE}
          style={[typography.footnote, { color: palette.sec }]}
        >
          {card.line2}
        </Text>
      </View>
      <Icon
        name={card.action === "save" ? "square.and.arrow.up" : "chevron.right"}
        color={palette.sec}
        size={14}
        weight="bold"
      />
    </Pressable>
  );
}

function NoticeRowView({ row, palette }: RowProps): JSX.Element {
  const notice = row as Extract<Row, { kind: "notice" }>;
  return (
    <Shell row={notice}>
      {notice.separator === true ? (
        <View style={[styles.rule, { backgroundColor: palette.sep }]} />
      ) : null}
      <Text style={[typography.footnote, styles.notice, { color: palette.sec }]}>
        {notice.text}
      </Text>
      {notice.body === undefined ? null : (
        <Text style={[typography.footnote, styles.notice, { color: palette.sec }]}>
          {notice.body}
        </Text>
      )}
      {notice.separator === true ? (
        <View style={[styles.rule, { backgroundColor: palette.sep }]} />
      ) : null}
    </Shell>
  );
}

/**
 * What a row that threw while drawing reads as (`RowGuard`,
 * docs/fix/mobile-crash-ibm-chart.md): a quiet notice in the row's place.
 */
export function RowFallback({ palette }: { readonly palette: Palette }): JSX.Element {
  return (
    <View testID="row-fallback" style={styles.row}>
      <Text style={[typography.footnote, styles.notice, styles.fallback, { color: palette.sec }]}>
        {ROW_FALLBACK_TEXT}
      </Text>
    </View>
  );
}

/** One row, by kind. A missing kind renders nothing (never a crash on new data). */
export function TranscriptRow(props: RowProps): JSX.Element | null {
  switch (props.row.kind) {
    case "user":
      return <UserRowView {...props} />;
    case "assistant":
      return <AssistantRowView {...props} />;
    case "reasoning":
      return <ReasoningRowView {...props} />;
    case "tool":
      return props.row.name === CHART_TOOL ? (
        <ChartRowView {...props} />
      ) : (
        <ToolRowView {...props} />
      );
    case "notice":
      return <NoticeRowView {...props} />;
    default:
      return null;
  }
}

const styles = StyleSheet.create({
  row: { paddingHorizontal: space.inset, paddingVertical: space.transcript / 2 },
  // The artifact card (D9): a band row — a 40 pt tile, the title and its type
  // line, a chevron. No inset card and no border of its own: it sits in the
  // transcript like any other row, which is the owner's choice A.
  card: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8 },
  cardTile: {
    width: 40,
    height: 40,
    borderRadius: radius.tile,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  cardThumb: { width: "100%", height: "100%" },
  cardBody: { flex: 1, gap: 2 },
  speak: { alignSelf: "flex-start", paddingTop: 4, paddingRight: 8 },
  bubble: {
    alignSelf: "flex-end",
    maxWidth: "77%",
    borderRadius: radius.bubble,
    paddingHorizontal: 14,
    paddingVertical: 9,
    gap: 6,
  },
  images: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  // The attached files' rows (docs/feat/pdf-read.md D5): a glyph and one line
  // each, `sec`-coloured so they read as facts about the message, not prose.
  documents: { gap: 2 },
  document: { flexDirection: "row", alignItems: "center", gap: 6 },
  // The image fills its own box (whose shape `mediaBox` decided): full bubble
  // width, rounded to the bubble (item 4).
  image: { borderRadius: radius.bubble, overflow: "hidden" },
  imageFill: { width: "100%", height: "100%" },
  imageLabel: {
    width: 96,
    height: 96,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    padding: 6,
  },
  // A step's cell (docs/feat/mobile-tool-rows.md): no vertical padding, so the
  // thread touches its neighbour; 6 pt at each end of a run.
  step: { paddingHorizontal: space.inset },
  runStart: { marginTop: 6 },
  runEnd: { marginBottom: 6 },
  // The sub-agent progress line and Activity link, under the step's line.
  below: { gap: 4, paddingBottom: 6 },
  tool: { gap: 8 },
  notice: { textAlign: "center" },
  fallback: { fontStyle: "italic" },
  rule: { height: StyleSheet.hairlineWidth, marginVertical: 6 },
});
