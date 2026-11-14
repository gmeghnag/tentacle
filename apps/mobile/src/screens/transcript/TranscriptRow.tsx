/**
 * One transcript row (docs/feat/mobile-session-view.md 12c): a DUMB renderer per
 * row kind (AGENTS §7). Every string is daemon-supplied data — plain `Text`,
 * never executed, never a link unless the markdown tree says so.
 *
 * The `testID`s are the contract the Maestro flows assert on (text is invisible
 * to XCUITest under RN's new architecture, plan P9):
 * `row-<key>`, `tool-<callId>-<status>`, `diff-<callId>`, `image-<imageId>`.
 */
import { type JSX, type ReactNode, useState } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { diffView } from "../../diff-view.ts";
import { type Parsed, parse } from "../../markdown.ts";
import type { Palette } from "../../theme.ts";
import { type ThumbnailState, thumbnailFor } from "../../thumbnails.ts";
import { toolSummary } from "../../tool-summary.ts";
import { type Row, imageRowText } from "../../transcript-rows.ts";
import { DiffView } from "./DiffView.tsx";
import { Markdown } from "./Markdown.tsx";

/** Lines of a tool's output shown before "show more" (plan F21's bound on screen). */
export const OUTPUT_PREVIEW_LINES = 6;

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
  palette,
  background,
}: {
  readonly row: Row;
  readonly children: ReactNode;
  readonly palette: Palette;
  readonly background?: string;
}): JSX.Element {
  return (
    <View
      testID={`row-${row.key}`}
      style={[styles.row, background === undefined ? undefined : { backgroundColor: background }]}
    >
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
    <Shell row={user} palette={palette}>
      <View style={[styles.bubble, { backgroundColor: palette.card }]}>
        {user.restart === true ? (
          <Text style={[styles.caption, { color: palette.secondaryLabel }]}>restart prompt</Text>
        ) : null}
        {/* The bubble IS `card`: code inside it takes the page colour (B4). */}
        <Markdown
          parsed={parsedOf(user.text)}
          palette={palette}
          onLink={onLink}
          codeBackground={palette.groupedBackground}
        />
        {user.images.length > 0 ? (
          <View style={styles.images}>
            {user.images.map((image) => {
              const thumb = thumbnailFor(thumbnails, image.id);
              return (
                <View key={image.id} testID={`image-${image.id}`} style={styles.image}>
                  {thumb === undefined ? (
                    // No bytes reachable yet (no read-back method exists): the
                    // label is what this build can honestly show (12b Drift 1).
                    <Text style={[styles.caption, { color: palette.secondaryLabel }]}>
                      {imageRowText(image)}
                    </Text>
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
    <Shell row={assistant} palette={palette}>
      <Markdown parsed={parsedOf(assistant.text)} palette={palette} onLink={onLink} />
    </Shell>
  );
}

function ReasoningRowView({ row, palette, onLink }: RowProps): JSX.Element {
  const reasoning = row as Extract<Row, { kind: "reasoning" }>;
  return (
    <Shell row={reasoning} palette={palette}>
      <View style={[styles.reasoning, { borderLeftColor: palette.separator }]}>
        <Text style={[styles.caption, { color: palette.secondaryLabel }]}>thinking</Text>
        <Markdown parsed={parsedOf(reasoning.text)} palette={palette} onLink={onLink} />
      </View>
    </Shell>
  );
}

function ToolRowView({ row, palette, onLink, thumbnails }: RowProps): JSX.Element {
  const tool = row as Extract<Row, { kind: "tool" }>;
  const [expanded, setExpanded] = useState(false);
  const summary = toolSummary(tool);
  const output = summary.output;
  const lines = output === "" ? [] : output.split("\n");
  const hidden = Math.max(0, lines.length - OUTPUT_PREVIEW_LINES);
  const shown = expanded ? lines : lines.slice(0, OUTPUT_PREVIEW_LINES);
  const view = tool.diff === undefined ? null : diffView(tool.diff);
  return (
    <Shell row={tool} palette={palette}>
      <View style={[styles.bubble, { backgroundColor: palette.card }]}>
        <View style={styles.toolHead}>
          <Text
            testID={`tool-${tool.id}-${tool.status}`}
            style={[styles.toolLabel, { color: palette.label }]}
            numberOfLines={1}
          >
            {`${summary.label} · ${tool.status}`}
          </Text>
          {tool.durationMs === undefined ? null : (
            <Text style={[styles.caption, { color: palette.secondaryLabel }]}>
              {`${Math.round(tool.durationMs)} ms`}
            </Text>
          )}
        </View>
        {summary.subtitle !== "" ? (
          <Text style={[styles.args, { color: palette.secondaryLabel }]} numberOfLines={2}>
            {summary.subtitle}
          </Text>
        ) : null}
        {tool.denialReply !== undefined ? (
          <Text
            testID={`tool-${tool.id}-reply`}
            style={[styles.caption, { color: palette.danger }]}
          >
            {`your reply: ${tool.denialReply}`}
          </Text>
        ) : null}
        {view === null ? null : <DiffView view={view} palette={palette} callId={tool.id} />}
        {shown.length > 0 ? (
          <Pressable
            testID={`tool-${tool.id}-output`}
            accessibilityRole="button"
            onPress={() => setExpanded((was) => !was)}
          >
            <Text style={[styles.output, { color: palette.secondaryLabel }]}>
              {shown.join("\n")}
            </Text>
            {hidden > 0 && !expanded ? (
              <Text style={[styles.caption, { color: palette.accent }]}>
                {`[${hidden} more lines]`}
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
    <Shell row={notice} palette={palette}>
      {notice.separator === true ? (
        <View style={[styles.rule, { backgroundColor: palette.separator }]} />
      ) : null}
      <Text style={[styles.caption, { color: palette.secondaryLabel }]}>{notice.text}</Text>
      {notice.body === undefined ? null : (
        <Text style={[styles.caption, { color: palette.secondaryLabel }]}>{notice.body}</Text>
      )}
      {notice.separator === true ? (
        <View style={[styles.rule, { backgroundColor: palette.separator }]} />
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
  row: { paddingHorizontal: 12, paddingVertical: 6 },
  bubble: { borderRadius: 10, padding: 10, gap: 6 },
  images: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  image: { borderRadius: 6, overflow: "hidden" },
  thumb: { width: 96, height: 96 },
  caption: { fontSize: 12 },
  reasoning: { borderLeftWidth: 2, paddingLeft: 8, gap: 4 },
  toolHead: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  toolLabel: { fontSize: 14, fontWeight: "600", flexShrink: 1 },
  args: { fontFamily: "Menlo", fontSize: 12 },
  output: { fontFamily: "Menlo", fontSize: 12, lineHeight: 17 },
  rule: { height: StyleSheet.hairlineWidth, marginVertical: 6 },
});
