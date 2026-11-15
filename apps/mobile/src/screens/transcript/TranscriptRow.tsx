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
import { DENSE_FONT_SCALE, type Palette, radius, space, typography } from "../../theme.ts";
import { type ThumbnailState, thumbnailFor } from "../../thumbnails.ts";
import { toolMeta, toolSummary } from "../../tool-summary.ts";
import { type Row, imageRowText } from "../../transcript-rows.ts";
import { Icon } from "../../ui/Icon.tsx";
import { ToolRow } from "../../ui/ToolRow.tsx";
import { DiffView } from "./DiffView.tsx";
import { Markdown } from "./Markdown.tsx";

/** Lines of a tool's output shown before "show more" (plan F21's bound on screen). */
export const OUTPUT_PREVIEW_LINES = 12;

export interface RowProps {
  readonly row: Row;
  readonly palette: Palette;
  readonly onLink: (href: string) => void;
  /** The loaded thumbnails (the driver's state): a ref with no bytes draws its label. */
  readonly thumbnails: ThumbnailState;
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
  return (
    <Shell row={user}>
      <View style={[styles.bubble, { backgroundColor: palette.fill }]}>
        {user.restart === true ? (
          <Text style={[typography.caption, { color: palette.sec }]}>restart prompt</Text>
        ) : null}
        {/* The bubble is `fill`; code inside it is `code`, which differs (B4). */}
        <Markdown
          parsed={parsedOf(user.text)}
          palette={palette}
          onLink={onLink}
          codeBackground={palette.code}
        />
        {user.images.length > 0 ? (
          <View style={styles.images}>
            {user.images.map((image) => {
              const thumb = thumbnailFor(thumbnails, image.id);
              return (
                <View
                  key={image.id}
                  testID={`image-${image.id}`}
                  style={[styles.image, { backgroundColor: palette.code }]}
                >
                  {thumb === undefined ? (
                    // No bytes reachable yet (no read-back method exists): the
                    // label is what this build can honestly show (12b Drift 1).
                    <View style={styles.imageLabel}>
                      <Icon name="photo" color={palette.sec} size={18} />
                      <Text numberOfLines={2} style={[typography.caption, { color: palette.sec }]}>
                        {imageRowText(image)}
                      </Text>
                    </View>
                  ) : (
                    <Image
                      source={{ uri: thumb.uri }}
                      style={styles.thumb}
                      accessibilityIgnoresInvertColors
                    />
                  )}
                </View>
              );
            })}
          </View>
        ) : null}
      </View>
    </Shell>
  );
}

function AssistantRowView({ row, palette, onLink }: RowProps): JSX.Element {
  const assistant = row as Extract<Row, { kind: "assistant" }>;
  return (
    <Shell row={assistant}>
      <Markdown parsed={parsedOf(assistant.text)} palette={palette} onLink={onLink} />
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
        onPress={() => setOpen((was) => !was)}
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

function ToolRowView({ row, palette }: RowProps): JSX.Element {
  const tool = row as Extract<Row, { kind: "tool" }>;
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const summary = toolSummary(tool);
  const meta = toolMeta(tool);
  const lines = summary.output === "" ? [] : summary.output.split("\n");
  const hidden = Math.max(0, lines.length - OUTPUT_PREVIEW_LINES);
  const shown = all ? lines : lines.slice(0, OUTPUT_PREVIEW_LINES);
  const view = tool.diff === undefined ? null : diffView(tool.diff);
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
          onPress={() => setOpen((was) => !was)}
          labelTestID={`tool-${tool.id}-${tool.status}`}
        />
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
  bubble: {
    alignSelf: "flex-end",
    maxWidth: "77%",
    borderRadius: radius.bubble,
    paddingHorizontal: 14,
    paddingVertical: 9,
    gap: 6,
  },
  images: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  image: { borderRadius: 12, overflow: "hidden" },
  imageLabel: {
    width: 96,
    height: 96,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    padding: 6,
  },
  thumb: { width: 96, height: 96 },
  reasoningHead: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 28 },
  reasoning: { borderLeftWidth: 2, paddingLeft: 12, marginTop: 4 },
  tool: { gap: 8 },
  output: { borderRadius: radius.tile, padding: 12, gap: 6 },
  notice: { textAlign: "center" },
  rule: { height: StyleSheet.hairlineWidth, marginVertical: 6 },
});
