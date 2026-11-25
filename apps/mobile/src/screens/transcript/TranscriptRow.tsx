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
import { Image, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import {
  type BandFill,
  type PreviewCardView,
  previewCardView,
  previewStatus,
} from "../../artifact-preview.ts";
import type { LabelMode } from "../../chart-layout-kit.ts";
import { CHART_TOOL, chartRowView } from "../../chart-row.ts";
import { DIAGRAM_TOOL, diagramRowView } from "../../diagram-row.ts";
import type { DiagramStyle } from "../../diagram-settings-store.ts";
import { diffView } from "../../diff-view.ts";
import { type Parsed, parse } from "../../markdown.ts";
import {
  type PhotoBlock,
  type PhotoTile,
  type ViewerPages,
  displayUri,
  photoBlock,
  photoTileStyle,
  userRowParts,
  viewerPages,
} from "../../media-layout.ts";
import type { CopyVia } from "../../message-copy.ts";
import { NOTICE_GLYPHS, type NoticeLook } from "../../notice-group.ts";
import { ROW_FALLBACK_TEXT } from "../../row-guard.ts";
import { type FiredRow, firedRowView } from "../../schedule-view.ts";
import { DENSE_FONT_SCALE, type Palette, isDark, radius, space, typography } from "../../theme.ts";
import { type ThumbnailState, thumbnailFor } from "../../thumbnails.ts";
import {
  type StepCell,
  type ThreadPos,
  contextRowView,
  stepRowView,
  thoughtRowView,
} from "../../tool-steps.ts";
import { subAgentLine } from "../../tool-summary.ts";
import { type ImageRef, type Row, imageRowText } from "../../transcript-rows.ts";
import { FileBody } from "../../ui/FileBody.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { StepBody, StepNode } from "../../ui/StepNode.tsx";
import { Text } from "../../ui/Text.tsx";
import { ChartBlock } from "../../ui/chart/ChartBlock.tsx";
import { DiagramBlock } from "../../ui/diagram/DiagramBlock.tsx";
import { DiffView } from "./DiffView.tsx";
import { Markdown } from "./Markdown.tsx";
import { MediaViewer } from "./MediaViewer.tsx";

/** A tile as the style it is drawn in: pinned to the place `photoBlock` decided. */
function boxStyle(tile: PhotoTile<ImageRef>): ReturnType<typeof photoTileStyle> {
  // The tiles carry their place (Review round 5, finding 1): a wrapping row
  // cannot draw the 3-photo shape (a line is as tall as its tallest item).
  return photoTileStyle(tile);
}

export interface RowProps {
  readonly row: Row;
  readonly palette: Palette;
  readonly onLink: (href: string) => void;
  /** The loaded thumbnails (the driver's state): a ref with no bytes draws its label. */
  readonly thumbnails: ThumbnailState;
  /**
   * The Charts setting in force (docs/feat/mobile-chart-labels.md D7): where a
   * line/area chart names its series. The SESSION SCREEN owns the subscription
   * (`ACTIVITY_SETTINGS`'s pattern) so one chart row is not one listener, and
   * absent = the default (`inside`).
   */
  readonly chartLabels?: LabelMode;
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
  /** The diagram look picked in Settings (docs/fix/mobile-qa-1117.md, bug 3); absent → outline. */
  readonly diagramStyle?: DiagramStyle;
  /**
   * A notice row's drawn shape from `noticeLooks` (docs/feat/mobile-harness-notices.md
   * S1): its glyph and whether it joins the block above. Absent (a test, a row
   * drawn on its own): it draws as a block of its own WITH its own level's glyph.
   */
  readonly look?: NoticeLook;
  /**
   * A long-press on a message row copies it (docs/feat/mobile-copy-text.md D2):
   * the screen decides WHAT (the pure `messageCopy`) and owns the clipboard, the
   * haptic and the pill — this only reports the row. Absent: no long-press at
   * all (a test, or a surface that must not offer one such as the Activity
   * sheet). `via`: a long `press`, or the VoiceOver `action` (no finger to lift,
   * so the pill must not wait for a release).
   */
  readonly onCopy?: (row: Row, via: CopyVia) => void;
  /**
   * The press that copied a message ENDED (docs/feat/mobile-copy-text.md D3):
   * the pill's countdown starts here, so a slow long press does not burn its
   * window under the finger. Absent: the pill counts from the copy itself.
   */
  readonly onCopyRelease?: () => void;
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
  /** Beta `Compact shell rows` (docs/feat/shell-intent-line.md §7): absent → off. */
  readonly compactShell?: boolean;
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

/**
 * The long-press that copies a MESSAGE (docs/feat/mobile-copy-text.md D2): a
 * dumb Pressable around a message row's content, present only when the screen
 * passed `onCopy`. No `onPress` — a tap must keep doing what it did (open a
 * link, play a photo, speak) — and `delayLongPress` 400 ms, the iOS feel.
 *
 * A VoiceOver user cannot long-press a bubble, so the same copy is an
 * accessibility ACTION on the row (the rotor's Actions menu).
 */
function CopyPress({
  row,
  onCopy,
  onCopyRelease,
  children,
}: {
  readonly row: Row;
  readonly onCopy: ((row: Row, via: CopyVia) => void) | undefined;
  readonly onCopyRelease: (() => void) | undefined;
  readonly children: ReactNode;
}): JSX.Element {
  if (onCopy === undefined) {
    return <>{children}</>;
  }
  return (
    <Pressable
      testID={`row-${row.key}-copy`}
      onLongPress={() => onCopy(row, "press")}
      // The release is when a person can look: the pill's window starts there.
      onPressOut={() => onCopyRelease?.()}
      delayLongPress={LONG_PRESS_MS}
      accessibilityActions={[{ name: "copy", label: "Copy message" }]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === "copy") {
          // No touch, so no onPressOut: the pill must count down by itself.
          onCopy(row, "action");
        }
      }}
    >
      {children}
    </Pressable>
  );
}

/** How long a press must last to copy (docs/feat/mobile-copy-text.md D2). */
const LONG_PRESS_MS = 400;

/** The parsed markdown for a text row (cached by key + version in markdown.ts's caller). */
function parsedOf(text: string): Parsed {
  return parse(text);
}

/** A tile as this row resolved it: its box, its pixels (if any) and its label. */
export interface ShownTile {
  readonly tile: PhotoTile<ImageRef>;
  readonly uri: string | undefined;
  readonly label: string;
}

/**
 * The photo block's RENDER half (mockup F): the tiles `photoBlock` placed, the
 * hairline, the "+N" overlay and the "Image not available" fallback. Hook-free
 * on purpose — the caller owns `broken` and the viewer, so this maps values to
 * elements and nothing else (AGENTS §7), which is also what makes it walkable in
 * a test (`chart-view.test.ts`'s rule: a component with hooks cannot be called).
 */
export function PhotoTiles({
  tiles,
  blockWidth,
  blockHeight,
  palette,
  onOpen,
  onBroken,
}: {
  readonly tiles: readonly ShownTile[];
  readonly blockWidth: number;
  readonly blockHeight: number;
  readonly palette: Palette;
  readonly onOpen: (position: number) => void;
  /** A tile's `<Image>` could not load its file (Review round 2, R2-1). */
  readonly onBroken: (uri: string) => void;
}): JSX.Element {
  return (
    <View testID="row-photos" style={[styles.photos, { width: blockWidth, height: blockHeight }]}>
      {tiles.map(({ tile, uri, label }, position) => (
        <View
          key={tile.ref.id}
          testID={`image-${tile.ref.id}`}
          style={[
            styles.tile,
            // The mockup's "filo sep": a hairline that reads on white and would be
            // a light seam on black, so it is the light mode's only.
            isDark(palette)
              ? null
              : { borderWidth: StyleSheet.hairlineWidth, borderColor: palette.sep },
            { backgroundColor: palette.code },
            boxStyle(tile),
          ]}
        >
          {uri === undefined ? (
            // No bytes reachable at all (a history row, another device's message,
            // a file trimmed under the row): the label is what this build can
            // honestly show.
            <View style={styles.tileLabel}>
              <Icon name="photo" color={palette.sec} size={18} />
              <Text
                numberOfLines={2}
                style={[typography.caption, styles.tileLabelText, { color: palette.sec }]}
              >
                Image not available
              </Text>
            </View>
          ) : (
            <Pressable
              testID={`image-${tile.ref.id}-open`}
              accessibilityRole="imagebutton"
              accessibilityLabel={`Open ${label}`}
              onPress={() => onOpen(position)}
            >
              <Image
                source={{ uri }}
                style={styles.tileFill}
                // A file that cannot be read (trimmed, wiped, moved) turns the tile
                // back into its label instead of an empty frame.
                onError={() => onBroken(uri)}
                // The box is the photo's own shape (its clamp when it has one), so
                // `cover` crops at a bound instead of squashing the photo.
                resizeMode="cover"
                accessibilityIgnoresInvertColors
              />
            </Pressable>
          )}
          {tile.overflow === undefined ? null : (
            // "+N": this tile stands for itself and the photos the block hides
            // (mockup F), so the count is over the photo it draws.
            <View style={styles.more} pointerEvents="none">
              <Text style={[typography.headline, styles.moreText]}>{`+${tile.overflow}`}</Text>
            </View>
          )}
        </View>
      ))}
    </View>
  );
}

function UserRowView({
  row,
  palette,
  onLink,
  thumbnails,
  onCopy,
  onCopyRelease,
}: RowProps): JSX.Element {
  /**
   * Item 4 / mockup F (feat/mobile-thinking-images S4): the photos are their OWN
   * element ABOVE the bubble, and a photo-only message has no bubble at all
   * (`UserRowBody`, from the pure `userRowParts` + `photoBlock`).
   */
  const user = row as Extract<Row, { kind: "user" }>;
  /**
   * The viewer's pages and the one a tap opened (mockup F: tap → full screen,
   * "2 of 5"). `index` `-1` = closed: one state, never a parallel flag.
   * `viewerPages` skips a tile with no pixels, so the pager never holds an empty
   * page and the header's count is the photos a person can actually see.
   */
  const [viewing, setViewing] = useState<ViewerPages>({ pages: [], index: -1 });
  /**
   * URIs whose `<Image>` has reported a load failure (Review round 2, R2-1): a
   * file can vanish under a row that outlives it (the app trims old copies, a
   * person can wipe the phone's data), and the tile must then draw its label
   * rather than an empty frame. `displayUri` decides; this only remembers.
   */
  const [broken, setBroken] = useState<readonly string[]>([]);
  return (
    <Shell row={user}>
      <UserRowBody
        user={user}
        palette={palette}
        onLink={onLink}
        thumbnails={thumbnails}
        broken={broken}
        onOpen={setViewing}
        onBroken={(uri) => setBroken((had) => (had.includes(uri) ? had : [...had, uri]))}
        {...(onCopy === undefined ? {} : { onCopy })}
        {...(onCopyRelease === undefined ? {} : { onCopyRelease })}
      />
      <MediaViewer
        items={viewing.pages}
        index={viewing.index}
        caption={user.text}
        palette={palette}
        onClose={() => setViewing({ pages: [], index: -1 })}
      />
    </Shell>
  );
}

/**
 * The user row's DRAWN half: the photo block above, the bubble below (or none).
 * Hook-free, so a test can walk it (the state — `broken`, the viewer — is
 * `UserRowView`'s).
 */
export function UserRowBody({
  user,
  palette,
  onLink,
  thumbnails,
  broken,
  onOpen,
  onBroken,
  onCopy,
  onCopyRelease,
}: {
  readonly user: Extract<Row, { kind: "user" }>;
  readonly palette: Palette;
  readonly onLink: RowProps["onLink"];
  readonly thumbnails: RowProps["thumbnails"];
  readonly broken: readonly string[];
  /** A tile with pixels was tapped: the viewer's pages, opened on it. */
  readonly onOpen: (pages: ViewerPages) => void;
  readonly onBroken: (uri: string) => void;
  /** The long-press that copies this message (`RowProps.onCopy`); absent = none. */
  readonly onCopy?: (row: Row, via: CopyVia) => void;
  /** The copy press ended (`RowProps.onCopyRelease`); absent = no re-anchor. */
  readonly onCopyRelease?: () => void;
}): JSX.Element {
  const parts = userRowParts(user);
  const block = photoBlock(user.images);
  /**
   * EVERY photo's pixels as the row may draw them, in message order — the viewer
   * pages all of them, including the ones a "+N" tile hides ("2 of 5").
   */
  const shown = user.images.map((ref) => ({
    // The LOCAL copy wins: it is the only pixels that exist for a photo this
    // phone just sent (`thumbnails.ts:19-25` — no read-back), and a loaded
    // thumbnail is the only source for any other. A URI already known to be
    // unloadable is no answer at all: the label is.
    uri: displayUri(ref.localUri ?? thumbnailFor(thumbnails, ref.id)?.uri, broken),
    label: imageRowText(ref),
  }));
  /** The block's tiles are its first photos, in order: tile `i` is photo `i`. */
  const tiles = block.tiles.map((tile, position) => ({
    tile,
    uri: shown[position]?.uri,
    label: shown[position]?.label ?? imageRowText(tile.ref),
  }));
  return (
    <CopyPress row={user} onCopy={onCopy} onCopyRelease={onCopyRelease}>
      {!parts.photos ? null : (
        // Right-aligned, capped at the block's own 200 pt: the photos are a
        // message element of their own, never the bubble's content.
        <PhotoTiles
          tiles={tiles}
          blockWidth={block.width}
          blockHeight={block.height}
          palette={palette}
          onOpen={(position) => onOpen(viewerPages(shown, position))}
          onBroken={onBroken}
        />
      )}
      {!parts.bubble ? null : (
        <View style={[styles.bubble, { backgroundColor: palette.fill }]}>
          {/* The attached files, one line each (docs/feat/pdf-read.md D5/D7), inside
              the bubble: the `<file>` block they became is the model's, so the file
              is named, never quoted. */}
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
          {/* The caption, inside the bubble — and never an empty block: the bubble
              exists only when it has something to say (`userRowParts`). */}
          {user.text === "" ? null : (
            // The bubble is `fill`; code inside it is `code`, which differs (B4).
            <Markdown
              parsed={parsedOf(user.text)}
              palette={palette}
              onLink={onLink}
              codeBackground={palette.code}
            />
          )}
        </View>
      )}
    </CopyPress>
  );
}

function AssistantRowView({
  row,
  palette,
  onLink,
  speak,
  onSpeak,
  onCopy,
  onCopyRelease,
}: RowProps): JSX.Element {
  const assistant = row as Extract<Row, { kind: "assistant" }>;
  const speaking = speak === "speaking";
  return (
    <Shell row={assistant}>
      <CopyPress row={assistant} onCopy={onCopy} onCopyRelease={onCopyRelease}>
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
      </CopyPress>
    </Shell>
  );
}

/**
 * A fired scheduled wake (docs/feat/scheduled-fire-row.md): the tool/thought
 * rows' timeline node with a `◷`, `Wake 15:54` and the prompt on one line —
 * collapsed until tapped, then the prompt in full under it. No bubble.
 */
function FiredRowView({
  row,
  palette,
  step,
  fired,
}: RowProps & { readonly fired: FiredRow }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <StepShell row={row} thread={LONE}>
      <StepNode
        palette={palette}
        node="wake"
        reduceMotion={step?.reduceMotion ?? false}
        name={{ tool: fired.name }}
        subtitle={fired.subtitle}
        subtitleItalic
        trailing=""
        trailingRed={false}
        thread={LONE}
        open={open}
        {...(fired.body.trim() === "" ? {} : { onToggle: () => setOpen((was) => !was) })}
        a11yLabel={fired.a11yLabel}
        labelTestID="row-fired-wake"
        body={
          <Text selectable style={[typography.body, styles.firedBody, { color: palette.sec }]}>
            {fired.body}
          </Text>
        }
      />
    </StepShell>
  );
}

/**
 * A palette whose prose draws in the secondary grey: a step's body is a FACT
 * about the run, like every other step line (`sec`), never prose-level text
 * (docs/feat/mobile-reset-in-timeline.md, the owner is colour-blind: weight
 * and the name carry the hierarchy, not hue).
 */
function secTinted(palette: Palette): Palette {
  return { ...palette, label: palette.sec };
}

/**
 * A context reset / a compaction (docs/feat/mobile-reset-in-timeline.md): a
 * timeline NODE, like a step — `↺ Context reset` with the prompt's first line
 * (italic, `sec`) or `⤡ Compacted` with its figures (mono), and the prompt or
 * the summary as MARKDOWN one tap away. Every decision is `contextRowView`'s
 * (pure, `tool-steps.ts`); this only draws it.
 */
function ContextRowView({ row, palette, onLink, step }: RowProps): JSX.Element {
  const context = row as Extract<Row, { kind: "context" }>;
  const cell = step?.cell;
  const thread = cell?.kind === "context" ? cell.thread : LONE;
  const full = step?.full ?? false;
  const view = contextRowView(context, full);
  const body = view.body;
  return (
    <StepShell row={context} thread={thread}>
      <StepNode
        palette={palette}
        node={view.node}
        reduceMotion={step?.reduceMotion ?? false}
        name={{ tool: view.name }}
        subtitle={view.subtitle}
        subtitleItalic={view.italic}
        trailing=""
        trailingRed={false}
        thread={thread}
        open={step?.open ?? false}
        {...(view.tappable && step !== undefined ? { onToggle: step.onToggle } : {})}
        a11yLabel={view.a11yLabel}
        labelTestID={`context-${context.event}-${context.key}`}
        {...(body === null || step?.open !== true
          ? {}
          : {
              body: (
                <View style={styles.contextBody}>
                  {/* Parsed only while open, and only the cut that is shown: a
                      closed step costs no parse (`contextRowView` decides the
                      cut, a ``` fence included). */}
                  <Markdown
                    parsed={parsedOf(body.text)}
                    palette={secTinted(palette)}
                    onLink={onLink}
                  />
                  {body.hidden === 0 ? null : (
                    // The screen's `full` state, never a local one (it survives
                    // cell recycling like `open`: `SessionScreen.tsx` `fullSteps`).
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Show all ${body.hidden} more ${
                        body.hidden === 1 ? "line" : "lines"
                      }`}
                      disabled={step === undefined}
                      onPress={step?.onShowAll}
                    >
                      <Text
                        testID={`context-${context.event}-${context.key}-more`}
                        style={[typography.footnote, styles.contextMore, { color: palette.accent }]}
                      >
                        {`… ${body.hidden} more ${body.hidden === 1 ? "line" : "lines"} · tap to see all`}
                      </Text>
                    </Pressable>
                  )}
                </View>
              ),
            })}
      />
    </StepShell>
  );
}

/**
 * Reasoning: nothing when it is folded into a step or the live footer
 * (`hidden`), else a `Thought · 12 s` node — ∴ in the dot's place (Owner Q1),
 * collapsed and not expandable (docs/fix/thought-placeholder.md).
 */
function ReasoningRowView({ row, palette, step }: RowProps): JSX.Element | null {
  const reasoning = row as Extract<Row, { kind: "reasoning" }>;
  const cell = step?.cell;
  if (cell?.kind === "hidden") {
    return null;
  }
  const thread = cell?.kind === "thought" ? cell.thread : LONE;
  const view = thoughtRowView(cell?.kind === "thought" ? cell : { ms: reasoning.ms });
  // Collapsed and never expandable (docs/fix/thought-placeholder.md): no toggle,
  // no body — only the duration is ever stored, so live shows what a reload can.
  return (
    <StepShell row={reasoning} thread={thread}>
      <StepNode
        palette={palette}
        node="thought"
        reduceMotion={step?.reduceMotion ?? false}
        name={{ tool: "Thought" }}
        subtitle={view.subtitle}
        subtitleItalic
        trailing=""
        trailingRed={false}
        thread={thread}
        open={false}
        a11yLabel={view.a11yLabel}
        labelTestID={`thought-${reasoning.key}`}
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
  const labels = props.chartLabels ?? "inside";
  const view = chartRowView(tool, {
    width: screen.width - 2 * space.inset,
    fontScale: screen.fontScale,
    locale: deviceLocale(),
    palette: props.palette,
    labels,
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
        labels={labels}
      />
    </Shell>
  );
}

/**
 * A `diagram` call (docs/feat/model-diagrams.md D6): the diagram takes the row's
 * place, like a chart. A call that is running, failed, refused after a reopen,
 * or does not re-lint is the generic tool row (`diagramRowView` → `null`).
 */
function DiagramRowView(props: RowProps): JSX.Element {
  const tool = props.row as Extract<Row, { kind: "tool" }>;
  const screen = useWindowDimensions();
  const view = diagramRowView(tool, {
    palette: props.palette,
    fontScale: screen.fontScale,
    ...(props.diagramStyle === undefined ? {} : { style: props.diagramStyle }),
  });
  if (view === null) {
    return <ToolRowView {...props} />;
  }
  return (
    <Shell row={tool}>
      <DiagramBlock
        view={view}
        palette={props.palette}
        width={screen.width - 2 * space.inset}
        locale={deviceLocale()}
        testID={`diagram-${tool.id}`}
      />
    </Shell>
  );
}

/**
 * A tool call: one `StepNode` on the thread (its cell from the screen's
 * `stepLayout`), the command, result, diff and reply in its open body — never
 * the folded reasoning (owner 21/11, docs/fix/mobile-running-row.md);
 * the sub-agent progress and Activity link always under the line. A presented
 * artifact is its card instead (a block: `isBlockRow`, no thread).
 */
function ToolRowView({ row, palette, agent, thumbnails, onArtifact, step }: RowProps): JSX.Element {
  const tool = row as Extract<Row, { kind: "tool" }>;
  const cell = step?.cell;
  const thread = cell?.kind === "step" ? cell.thread : LONE;
  const view = stepRowView(
    tool,
    cell?.kind === "step" ? cell.thought : null,
    step?.full ?? false,
    cell?.kind === "step" && cell.thoughtFirst,
    step?.compactShell === true,
  );
  const diff = tool.diff === undefined ? null : diffView(tool.diff);
  const progress = subAgentLine(tool.sub);
  // A presented artifact IS this row's visible body (docs/feat/model-artifacts.md
  // D9): a band row, not a tool call with a blob of text under it.
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
  if (artifact !== undefined) {
    return (
      <Shell row={tool}>
        <View style={styles.tool}>
          <ArtifactCardRow
            meta={artifact}
            thumbnails={thumbnails}
            palette={palette}
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
        subline={view.subline}
        exitSuffix={view.exitSuffix}
        shimmer={view.shimmer}
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
            thought={null}
            command={view.command}
            output={view.output}
            outputTestID={`tool-${tool.id}-output`}
            {...(step === undefined ? {} : { onShowAll: step.onShowAll })}
            {...(view.file === undefined
              ? {
                  diff:
                    diff === null ? null : (
                      <DiffView view={diff} palette={palette} callId={tool.id} />
                    ),
                }
              : {
                  // A FILE tool's content (docs/feat/mobile-file-view.md): the
                  // coloured body replaces both the plain output and the diff
                  // block, and carries `diff-<callId>` itself.
                  file: (
                    <FileBody
                      view={view.file}
                      palette={palette}
                      callId={tool.id}
                      full={step?.full ?? false}
                      {...(step === undefined ? {} : { onShowAll: step.onShowAll })}
                    />
                  ),
                })}
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
 * The artifact card with its PREVIEW band on top (docs/feat/mobile-file-preview-cards.md,
 * the owner's variant A): the band — a PDF / HTML page's top, the image, a
 * markdown file's first lines, or the kind's symbol while loading / when no
 * preview could be made — then the meta row (symbol, title, core's type line,
 * chevron). One Pressable: a tap opens the existing viewer (`save` shares).
 *
 * Render only: every decision (which preview, the band's height before the
 * bytes, what each state draws, gone = no band, dimmed, not tappable) is
 * `previewCardView`'s, tested in `artifact-preview.test.ts`.
 */
function ArtifactCardRow({
  meta,
  thumbnails,
  palette,
  onPress,
}: {
  readonly meta: ArtifactMeta;
  readonly thumbnails: ThumbnailState;
  readonly palette: Palette;
  readonly onPress?: () => void;
}): JSX.Element {
  const screen = useWindowDimensions();
  const width = screen.width - 2 * space.inset;
  const view = previewCardView(meta, previewStatus(thumbnails, meta), width);
  return (
    <ArtifactCardBody
      view={view}
      artifactId={meta.artifactId}
      palette={palette}
      width={width}
      {...(onPress === undefined ? {} : { onPress })}
    />
  );
}

/** The card's drawn half: hook-free, so a test can walk it. */
export function ArtifactCardBody({
  view,
  artifactId,
  palette,
  width,
  onPress,
}: {
  readonly view: PreviewCardView;
  /** The artifact's id: the e2e flow's own handle (`artifact-card-<artifactId>`). */
  readonly artifactId: string;
  readonly palette: Palette;
  readonly width: number;
  readonly onPress?: () => void;
}): JSX.Element {
  const disabled = view.disabled || onPress === undefined;
  return (
    <Pressable
      testID={`artifact-card-${artifactId}`}
      accessibilityRole="button"
      accessibilityLabel={view.a11yLabel}
      accessibilityState={{ disabled: view.disabled }}
      disabled={disabled}
      onPress={onPress}
      style={styles.card}
    >
      {view.band === null ? null : (
        <View
          testID={`artifact-card-band-${view.band.fill.kind}`}
          accessible={false}
          style={[
            styles.band,
            { height: view.band.height, backgroundColor: palette.code, borderColor: palette.sep },
          ]}
        >
          <BandContent fill={view.band.fill} symbol={view.symbol} palette={palette} width={width} />
        </View>
      )}
      <View style={styles.cardMeta}>
        <View style={view.dim ? styles.dimmed : null}>
          <Icon name={view.symbol} color={palette.sec} size={20} weight="light" />
        </View>
        <View style={styles.cardBody}>
          <Text
            numberOfLines={1}
            ellipsizeMode="middle"
            maxFontSizeMultiplier={DENSE_FONT_SCALE}
            style={[typography.subhead, { color: view.dim ? palette.sec : palette.label }]}
          >
            {view.card.title}
          </Text>
          <Text
            numberOfLines={1}
            maxFontSizeMultiplier={DENSE_FONT_SCALE}
            style={[typography.footnote, { color: palette.sec }, view.dim ? styles.dimmed : null]}
          >
            {view.card.line2}
          </Text>
        </View>
        {view.trailing === null ? null : (
          <Icon
            name={view.trailing === "share" ? "square.and.arrow.up" : "chevron.right"}
            color={palette.sec}
            size={13}
            weight="semibold"
          />
        )}
      </View>
    </Pressable>
  );
}

/** What the band holds, as elements (the fill is `previewCardView`'s). */
function BandContent({
  fill,
  symbol,
  palette,
  width,
}: {
  readonly fill: BandFill;
  readonly symbol: PreviewCardView["symbol"];
  readonly palette: Palette;
  readonly width: number;
}): JSX.Element {
  switch (fill.kind) {
    case "loading":
    case "symbol":
      // Loading: the symbol stepped back (no spinner); failed: full strength.
      return (
        <View style={[styles.bandCenter, fill.kind === "loading" ? styles.loadingSymbol : null]}>
          <Icon name={symbol} color={palette.sec} size={28} weight="light" />
        </View>
      );
    case "picture":
      return fill.align === "cover" ? (
        <Image
          testID="artifact-card-thumbnail"
          source={{ uri: fill.uri }}
          style={styles.bandCover}
          resizeMode="cover"
        />
      ) : (
        // A page: drawn at the band's width, its TOP at the band's top (RN's
        // `cover` centres, which would show the middle of page 1).
        <Image
          testID="artifact-card-thumbnail"
          source={{ uri: fill.uri }}
          style={{ position: "absolute", top: 0, left: 0, width, height: fill.drawnHeight }}
          resizeMode="stretch"
        />
      );
    case "lines":
      return (
        <View style={styles.bandLines}>
          {fill.lines.map((line, at) => (
            <Text
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed, never-reordered list of lines
              key={at}
              numberOfLines={1}
              allowFontScaling={false}
              style={
                line.style === "heading"
                  ? [styles.lineHeading, { color: palette.label }]
                  : line.style === "mono"
                    ? [typography.stepMono, { color: palette.label }]
                    : [typography.caption, { color: palette.sec }]
              }
            >
              {line.style === "bullet" ? `•  ${line.text}` : line.text}
            </Text>
          ))}
        </View>
      );
  }
}

/**
 * A harness line (docs/feat/mobile-harness-notices.md S1, Owner Q2): left-aligned
 * with a fixed-width glyph column, like the TUI — `◇` grey, `▲` amber (the SHAPE
 * is the signal, the colour only a cue). A row whose look says `joined` drops its
 * top padding so consecutive lines read as ONE block, and a continuation keeps the
 * glyph column EMPTY so its text hangs aligned under the block's head.
 */
function NoticeRowView({ row, palette, look: given }: RowProps): JSX.Element {
  const notice = row as Extract<Row, { kind: "notice" }>;
  // No look (a test, a row drawn on its own): a block of its own, WITH its glyph
  // — which is what a notice outside any block reads as.
  const look: NoticeLook = given ?? {
    glyph: notice.level === "warn" ? NOTICE_GLYPHS.warn : NOTICE_GLYPHS.info,
    joined: false,
  };
  const warn = look.glyph === NOTICE_GLYPHS.warn;
  return (
    <View
      testID={`row-${notice.key}`}
      style={[styles.row, look.joined ? styles.joined : undefined]}
    >
      <View style={styles.harness}>
        {/* The column is always there (`harnessGlyph` is a fixed width), so a
            continuation's text hangs under the block's head instead of shifting. */}
        <Text
          style={[
            typography.footnote,
            styles.harnessGlyph,
            { color: warn ? palette.orange : palette.sec },
          ]}
        >
          {look.glyph ?? ""}
        </Text>
        <View style={styles.harnessBody}>
          <Text
            style={[typography.footnote, { color: palette.sec }]}
            // The glyph is not read reliably (VoiceOver skips it or says "up
            // pointing triangle"): the level is spoken in words instead.
            {...(warn ? { accessibilityLabel: `Warning: ${notice.text}` } : {})}
          >
            {notice.text}
          </Text>
          {notice.body === undefined ? null : (
            <Text style={[typography.footnote, { color: palette.sec }]}>{notice.body}</Text>
          )}
        </View>
      </View>
    </View>
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
    case "user": {
      // A fired scheduled wake is a timeline node, not a bubble the person typed
      // (docs/feat/scheduled-fire-row.md): decided in `firedRowView`, live = reload.
      const fired = firedRowView(props.row.text, props.row.schedule, Date.now());
      return fired === null ? (
        <UserRowView {...props} />
      ) : (
        <FiredRowView {...props} fired={fired} />
      );
    }
    case "assistant":
      return <AssistantRowView {...props} />;
    case "reasoning":
      return <ReasoningRowView {...props} />;
    case "tool":
      if (props.row.name === CHART_TOOL) return <ChartRowView {...props} />;
      if (props.row.name === DIAGRAM_TOOL) return <DiagramRowView {...props} />;
      return <ToolRowView {...props} />;
    case "notice":
      return <NoticeRowView {...props} />;
    case "context":
      return <ContextRowView {...props} />;
    default:
      return null;
  }
}

const styles = StyleSheet.create({
  row: { paddingHorizontal: space.inset, paddingVertical: space.transcript / 2 },
  // A fired wake's prompt, opened under its node (scheduled-fire-row).
  firedBody: { paddingTop: 2, paddingBottom: space.transcript / 2 },
  // The artifact card (docs/feat/mobile-file-preview-cards.md, variant A): the
  // preview band on top, then the meta row. No inset card around it: the band
  // is the file's own picture, the row sits in the transcript like any other.
  card: { flexDirection: "column", gap: 8, paddingVertical: 8 },
  band: {
    width: "100%",
    borderRadius: radius.tile,
    // A white page on a white transcript needs its edge.
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  bandCenter: { flex: 1, alignItems: "center", justifyContent: "center" },
  loadingSymbol: { opacity: 0.5 },
  bandCover: { width: "100%", height: "100%" },
  bandLines: { paddingVertical: 12, paddingHorizontal: 14, gap: 2 },
  lineHeading: { fontSize: 13, lineHeight: 18, fontWeight: "600" },
  cardMeta: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 40 },
  cardBody: { flex: 1, gap: 2 },
  dimmed: { opacity: 0.6 },
  speak: { alignSelf: "flex-start", paddingTop: 4, paddingRight: 8 },
  bubble: {
    alignSelf: "flex-end",
    maxWidth: "77%",
    borderRadius: radius.bubble,
    paddingHorizontal: 14,
    paddingVertical: 9,
    gap: 6,
  },
  // The photo block (mockup F): its OWN element, right-aligned above the bubble.
  // Its width and height are `photoBlock`'s, and each tile is pinned to its own
  // `x`/`y` inside it (Review round 5, finding 1) — a wrapping row cannot draw
  // the 3-photo shape: its line is as tall as the tall tile, so the third tile
  // would land BELOW it and leave the bottom-right slot empty.
  photos: {
    alignSelf: "flex-end",
    marginBottom: 4,
  },
  // The 16 pt radius (mockup F), on EVERY tile's corners: the tiles carry no
  // position, so the block cannot tell an outer corner from an inner one (drift
  // recorded in the task doc). A tile is clipped to it.
  tile: { borderRadius: 16, overflow: "hidden" },
  tileFill: { width: "100%", height: "100%" },
  tileLabel: { flex: 1, alignItems: "center", justifyContent: "center", gap: 4, padding: 6 },
  tileLabelText: { textAlign: "center" },
  // "+N": the hidden photos' count, over a scrim on the tile that stands for them.
  more: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  moreText: { color: "#FFFFFF" },
  // The attached files' rows (docs/feat/pdf-read.md D5): a glyph and one line
  // each, `sec`-coloured so they read as facts about the message, not prose.
  documents: { gap: 2 },
  document: { flexDirection: "row", alignItems: "center", gap: 6 },
  // A step's cell (docs/feat/mobile-tool-rows.md): no vertical padding, so the
  // thread touches its neighbour; 6 pt at each end of a run.
  step: { paddingHorizontal: space.inset },
  runStart: { marginTop: 6 },
  runEnd: { marginBottom: 6 },
  // The sub-agent progress line and Activity link, under the step's line.
  below: { gap: 4, paddingBottom: 6 },
  tool: { gap: 8 },
  notice: { textAlign: "center" },
  // A harness line (S1): a glyph column and the text beside it, hanging under
  // the head. `joined` drops the row's own top padding so a block reads as one.
  joined: { paddingTop: 0 },
  harness: { flexDirection: "row", gap: 6 },
  harnessGlyph: { width: 12, textAlign: "center" },
  harnessBody: { flex: 1, gap: 2 },
  // A context step's open body (docs/feat/mobile-reset-in-timeline.md): the
  // prompt/summary as markdown, tinted secondary — a step's body is a fact.
  contextBody: { gap: 6, paddingTop: 2, paddingBottom: space.transcript / 2 },
  contextMore: { paddingTop: 2 },
  fallback: { fontStyle: "italic" },
});
