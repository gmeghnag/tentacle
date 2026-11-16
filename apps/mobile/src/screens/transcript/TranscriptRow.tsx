/**
 * One transcript row (docs/feat/mobile-session-view.md 12c): a DUMB renderer per
 * row kind (AGENTS §7). Every string is daemon-supplied data — plain `Text`,
 * never executed, never a link unless the markdown tree says so.
 *
 * Look (mockup `Conversation`): the person's message is a right-aligned `fill`
 * bubble; the answer is full-width text on the page; reasoning is one collapsed
 * line; a tool call is a `ToolRow` whose output opens below it.
 *
 * The `testID`s are the contract the Maestro flows assert on (text is invisible
 * to XCUITest under RN's new architecture, plan P9):
 * `row-<key>`, `tool-<callId>-<status>`, `tool-<callId>-output`,
 * `tool-<callId>-reply`, `diff-<callId>`, `image-<imageId>`.
 */
import { type JSX, type ReactNode, useState } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { diffView } from "../../diff-view.ts";
import { type Parsed, parse } from "../../markdown.ts";
import { type MediaBox, layoutMedia, mediaBox } from "../../media-layout.ts";
import { firedScheduleHead } from "../../schedule-view.ts";
import { DENSE_FONT_SCALE, type Palette, radius, space, typography } from "../../theme.ts";
import { type ThumbnailState, thumbnailFor } from "../../thumbnails.ts";
import { subAgentLine, toolMeta, toolSummary } from "../../tool-summary.ts";
import { type Row, imageRowText } from "../../transcript-rows.ts";
import { Icon } from "../../ui/Icon.tsx";
import { ToolRow } from "../../ui/ToolRow.tsx";
import { animateNextLayout } from "../../ui/animate.ts";
import { DiffView } from "./DiffView.tsx";
import { Markdown } from "./Markdown.tsx";
import { MediaViewer } from "./MediaViewer.tsx";

/** Lines of a tool's output shown before "show more" (plan F21's bound on screen). */
export const OUTPUT_PREVIEW_LINES = 12;

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
              // loaded thumbnail is the only source for any other.
              const uri = image.localUri ?? thumb?.uri;
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

/** Reasoning: one collapsed `sec` line that opens on tap (presentation state). */
function ReasoningRowView({ row, palette, onLink }: RowProps): JSX.Element {
  const reasoning = row as Extract<Row, { kind: "reasoning" }>;
  const [open, setOpen] = useState(false);
  return (
    <Shell row={reasoning}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => {
          animateNextLayout();
          setOpen((was) => !was);
        }}
        hitSlop={8}
        style={styles.reasoningHead}
      >
        <Text
          maxFontSizeMultiplier={DENSE_FONT_SCALE}
          style={[typography.subhead, { color: palette.sec }]}
        >
          Thinking
        </Text>
        <Icon name={open ? "chevron.down" : "chevron.right"} color={palette.sec} size={12} />
      </Pressable>
      {open ? (
        <View style={[styles.reasoning, { borderLeftColor: palette.sep }]}>
          <Markdown parsed={parsedOf(reasoning.text)} palette={palette} onLink={onLink} />
        </View>
      ) : null}
    </Shell>
  );
}

function ToolRowView({ row, palette, agent }: RowProps): JSX.Element {
  const tool = row as Extract<Row, { kind: "tool" }>;
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const summary = toolSummary(tool);
  const meta = toolMeta(tool);
  const lines = summary.output === "" ? [] : summary.output.split("\n");
  const hidden = Math.max(0, lines.length - OUTPUT_PREVIEW_LINES);
  const shown = all ? lines : lines.slice(0, OUTPUT_PREVIEW_LINES);
  const view = tool.diff === undefined ? null : diffView(tool.diff);
  const progress = subAgentLine(tool.sub);
  return (
    <Shell row={tool}>
      <View style={styles.tool}>
        <ToolRow
          palette={palette}
          label={summary.label}
          subtitle={summary.subtitle}
          trailing={meta.trailing}
          tone={meta.tone}
          expandable={lines.length > 0}
          expanded={open}
          onPress={() => {
            animateNextLayout();
            setOpen((was) => !was);
          }}
          labelTestID={`tool-${tool.id}-${tool.status}`}
        />
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
        {tool.denialReply !== undefined ? (
          <Text
            testID={`tool-${tool.id}-reply`}
            style={[typography.footnote, { color: palette.red }]}
          >
            {`Your reply: ${tool.denialReply}`}
          </Text>
        ) : null}
        {view === null ? null : <DiffView view={view} palette={palette} callId={tool.id} />}
        {open && shown.length > 0 ? (
          <Pressable
            testID={`tool-${tool.id}-output`}
            accessibilityRole="button"
            disabled={hidden === 0}
            onPress={() => setAll((was) => !was)}
            style={[styles.output, { backgroundColor: palette.code }]}
          >
            <Text style={[typography.monoCode, { color: palette.label }]}>{shown.join("\n")}</Text>
            {hidden > 0 && !all ? (
              <Text style={[typography.footnote, { color: palette.accent }]}>
                {`Show ${hidden} more lines`}
              </Text>
            ) : null}
          </Pressable>
        ) : null}
      </View>
    </Shell>
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
      return <ToolRowView {...props} />;
    case "notice":
      return <NoticeRowView {...props} />;
    default:
      return null;
  }
}

const styles = StyleSheet.create({
  row: { paddingHorizontal: space.inset, paddingVertical: space.transcript / 2 },
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
  reasoningHead: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 28 },
  reasoning: { borderLeftWidth: 2, paddingLeft: 12, marginTop: 4 },
  tool: { gap: 8 },
  output: { borderRadius: radius.tile, padding: 12, gap: 6 },
  notice: { textAlign: "center" },
  rule: { height: StyleSheet.hairlineWidth, marginVertical: 6 },
});
