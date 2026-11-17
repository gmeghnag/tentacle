import type { ArtifactMeta } from "@tentacle/protocol";
import type { ArtifactKind } from "@tentacle/protocol";
/**
 * The artifacts gallery (docs/feat/model-artifacts.md D9): this session's
 * artifacts, newest first, under day headings, with the "new" mark the Session
 * info row counts.
 *
 * It holds NO handle and dials nothing: a second `RemoteSession` of one id steals
 * the session screen's stream, so this screen READS what that screen published on
 * the session's feed (`ARTIFACT_FEEDS`) and asks it for a refresh on mount. Every
 * decision — the rows, the order, the days, the unseen count — is
 * `artifact-gallery.ts`'s; every card's words are `@tentacle/core`'s. What is
 * here is the mapping to elements and the two seen marks.
 */
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { AppLogField } from "../app-log.ts";
import { ARTIFACT_FEEDS, type ArtifactSnapshot } from "../artifact-feed.ts";
import {
  CHART_FILTER_LABEL,
  type GalleryItem,
  galleryItemFor,
  galleryKindCount,
  gallerySummary,
  galleryView,
  viewerCloseTarget,
} from "../artifact-gallery.ts";
import { ARTIFACT_SEEN } from "../artifact-seen-expo.ts";
import {
  markArtifactOpened,
  markGalleryOpened,
  seenFor,
  sessionKey,
} from "../artifact-seen-store.ts";
import { type ChartRowView, chartThumbView, wantsChartThumbnail } from "../chart-row.ts";
import { DENSE_FONT_SCALE, type Palette, radius, space, typography } from "../theme.ts";
import { Icon } from "../ui/Icon.tsx";
import { ScreenHeader } from "../ui/ScreenHeader.tsx";
import { ChartThumbnail } from "../ui/chart/ChartThumbnail.tsx";
import { ArtifactViewerModal, type ReadBytes } from "./artifacts/ArtifactViewerModal.tsx";

/** The tile's own box: a thumbnail's size, never the row's height (the tile is 40×40). */
const THUMB_SIZE = { width: 40, height: 32 } as const;

/** The `Grafici` chip's test id (the e2e flow and this file's wiring test agree on it). */
const GRAFICI_CHIP = "artifact-gallery-chip-charts";

/** The device's language, for a chart's numbers and dates (as the transcript row does). */
function deviceLocale(): string {
  return Intl.DateTimeFormat().resolvedOptions().locale;
}
export interface ArtifactGalleryScreenProps {
  readonly palette: Palette;
  readonly computerId: string;
  readonly sessionId: string;
  readonly title: string;
  /** A transcript card's artifact id: open its viewer at once. */
  readonly open?: string;
  /** The session was in the Archived section: its bytes need an explicit reopen. */
  readonly archived: boolean;
  readonly onBack: () => void;
  readonly onLink: (href: string) => void;
  readonly onShare?: (fileUri: string) => void;
  /** A viewer that threw while drawing (its log fields: class only, never the message). */
  readonly onRenderError?: (fields: Record<string, AppLogField>) => void;
}

/** What the screen says when it has no rows to show, and why. */
function emptyWords(snapshot: ArtifactSnapshot, archived: boolean): string {
  if (snapshot.phase === "unsupported") {
    return "Needs a newer tentacle on this computer";
  }
  if (snapshot.phase === "loading") {
    return "Loading…";
  }
  if (snapshot.phase === "offline") {
    return "Offline — reconnect to see its artifacts";
  }
  if (snapshot.phase === "error") {
    return "Couldn't load the artifacts";
  }
  // `ready` with nothing in it: an archived session's bytes need a reopen (the
  // serve daemon's own rule), so the words say what to do instead of "none".
  return archived ? "Reopen to view" : "No artifacts yet";
}

export function ArtifactGalleryScreen(props: ArtifactGalleryScreenProps): JSX.Element {
  const { palette, computerId, sessionId, archived } = props;
  const insets = useSafeAreaInsets();
  const feed = useMemo(() => ARTIFACT_FEEDS.feed(computerId, sessionId), [computerId, sessionId]);
  // The bytes come from the OWNER of the handle, published on the same feed (a
  // second `RemoteSession` of one id would steal its stream). Absent (the
  // session screen is gone) the viewer says so instead of blanking.
  const readBytes = useCallback<ReadBytes>(
    (meta, options) => {
      const reader = feed.read();
      return reader === undefined
        ? Promise.reject(new Error("no artifact reader: open the session first"))
        : reader(meta, options);
    },
    [feed],
  );
  const [snapshot, setSnapshot] = useState<ArtifactSnapshot>(() => feed.current());
  const [open, setOpen] = useState<{ meta: ArtifactMeta; versions: number } | null>(null);
  const [seenVersion, setSeenVersion] = useState(0);
  // The `Grafici` chip (C8): `undefined` = every kind, which is the default — a
  // filter that had to be cleared would hide an artifact from someone who never
  // asked for it. The chip is offered only when there IS a chart.
  const [only, setOnly] = useState<ArtifactKind | undefined>(undefined);
  const key = sessionKey(computerId, sessionId);
  const seen = seenFor(ARTIFACT_SEEN.current(), key);
  // `galleryView` is pure and its inputs are small: computed per render rather
  // than memoised on a value object that would change identity anyway.
  const now = Date.now();
  const view = galleryView(snapshot.list, seen, now, "", only);
  const chartCount = galleryKindCount(snapshot.list, "chart");
  // The tiles' layouts, by sha256: one fetch per version, and only for an
  // artifact `wantsChartThumbnail` says may be drawn (`chart-row.ts`: the kind
  // and the 64 KiB cap — the same cap the validator enforces).
  const [thumbs, setThumbs] = useState<ReadonlyMap<string, ChartRowView>>(() => new Map());
  const inFlight = useRef(new Set<string>());
  const window = useWindowDimensions();

  useEffect(() => {
    for (const meta of snapshot.list) {
      if (!wantsChartThumbnail(meta) || inFlight.current.has(meta.sha256)) {
        continue;
      }
      inFlight.current.add(meta.sha256);
      void readBytes(meta).then(
        (bytes) => {
          const drawn = chartThumbView(meta, bytes, {
            width: THUMB_SIZE.width,
            height: THUMB_SIZE.height,
            fontScale: window.fontScale,
            locale: deviceLocale(),
            palette,
          });
          // A spec this build cannot draw (a pod's forgery, a newer spec) lays
          // out nothing: the tile keeps the card's glyph, never a blank box.
          if (drawn !== null) {
            setThumbs((prev) => new Map(prev).set(meta.sha256, drawn));
          }
        },
        () => {
          // An unreadable version keeps its glyph: the row still opens, and the
          // viewer says what went wrong there (never a second error here).
        },
      );
    }
  }, [snapshot.list, readBytes, palette, window.fontScale]);

  useEffect(() => {
    const off = feed.subscribe(setSnapshot);
    // The screen that owns the handle re-reads: this one cannot (no second session).
    feed.requestRefresh();
    return off;
  }, [feed]);

  // Opening the gallery is "I have seen what it lists" (the seen record's rule).
  useEffect(() => {
    if (seenVersion > 0) {
      return;
    }
    setSeenVersion(1);
    void ARTIFACT_SEEN.set({
      ...ARTIFACT_SEEN.current(),
      [key]: markGalleryOpened(seenFor(ARTIFACT_SEEN.current(), key), now),
    }).catch(() => {
      // A newer build's record on this phone: nothing is marked, nothing is lost.
    });
  }, [key, now, seenVersion]);

  // Whether the open viewer came from a transcript card (closing it goes back).
  const fromCard = useRef(false);
  const openArtifact = useCallback(
    (item: GalleryItem, card = false) => {
      fromCard.current = card;
      setOpen({ meta: item.newest, versions: item.versions });
      const current = seenFor(ARTIFACT_SEEN.current(), key);
      void ARTIFACT_SEEN.set({
        ...ARTIFACT_SEEN.current(),
        [key]: markArtifactOpened(current, item.newest.sha256),
      }).catch(() => {});
    },
    [key],
  );

  // A transcript card's artifact (`open`): its viewer opens once, as soon as its
  // row is listed (the list may still be loading on the first render).
  const wanted = useRef(props.open);
  const target = galleryItemFor(view, wanted.current);
  useEffect(() => {
    if (target !== null) {
      wanted.current = undefined;
      openArtifact(target, true);
    }
  }, [target, openArtifact]);

  const listable = snapshot.phase === "ready" && !view.empty;
  return (
    <View style={[styles.root, { backgroundColor: palette.page }]} testID="artifact-gallery">
      <ScreenHeader
        palette={palette}
        title="Artifacts"
        subtitle={props.title}
        left={
          <Pressable
            testID="artifact-gallery-close"
            accessibilityRole="button"
            accessibilityLabel="Close"
            hitSlop={8}
            onPress={props.onBack}
          >
            <Icon name="xmark" color={palette.label} size={18} />
          </Pressable>
        }
      />
      <Text
        testID="artifact-gallery-summary"
        maxFontSizeMultiplier={DENSE_FONT_SCALE}
        style={[typography.footnote, styles.summary, { color: palette.sec }]}
      >
        {gallerySummary(view)}
      </Text>
      {chartCount === 0 ? null : (
        // The `Grafici` chip (C8): it narrows the SAME list (`galleryView`'s
        // `only`), never a second view, and is offered only when there is a
        // chart — a chip whose only outcome is "no match" is not a control.
        <Pressable
          testID={GRAFICI_CHIP}
          accessibilityRole="button"
          accessibilityState={{ selected: only === "chart" }}
          onPress={() => setOnly(only === "chart" ? undefined : "chart")}
          style={[
            styles.chip,
            {
              backgroundColor: only === "chart" ? palette.accent : palette.code,
              borderColor: palette.sep,
            },
          ]}
        >
          <Text
            maxFontSizeMultiplier={DENSE_FONT_SCALE}
            style={[typography.caption, { color: only === "chart" ? palette.page : palette.label }]}
          >
            {`${CHART_FILTER_LABEL} · ${chartCount}`}
          </Text>
        </Pressable>
      )}
      {listable ? (
        <FlatList
          testID="artifact-gallery-list"
          data={view.sections}
          keyExtractor={(section) => section.day}
          contentContainerStyle={{ paddingBottom: insets.bottom + space.inset }}
          renderItem={({ item: section }) => (
            <View style={styles.section}>
              <Text
                maxFontSizeMultiplier={DENSE_FONT_SCALE}
                style={[typography.caption, styles.day, { color: palette.sec }]}
              >
                {section.day}
              </Text>
              {section.items.map((item) => (
                <Pressable
                  key={item.key}
                  testID={`artifact-gallery-row-${item.key}`}
                  accessibilityRole="button"
                  accessibilityLabel={`${item.card.title}, ${item.card.line2}`}
                  onPress={() => openArtifact(item)}
                  style={[styles.row, { borderBottomColor: palette.sep }]}
                >
                  <View style={[styles.tile, { backgroundColor: palette.code }]}>
                    {thumbs.get(item.newest.sha256) === undefined ? (
                      <Text style={[typography.subhead, { color: palette.sec }]}>
                        {item.card.glyph}
                      </Text>
                    ) : (
                      // The drawn tile (C8): the plot alone, from the artifact's
                      // own spec bytes, re-validated by `chartThumbView`.
                      <ChartThumbnail
                        view={thumbs.get(item.newest.sha256) as ChartRowView}
                        testID={`artifact-gallery-thumb-${item.key}`}
                      />
                    )}
                  </View>
                  <View style={styles.body}>
                    <Text
                      numberOfLines={1}
                      maxFontSizeMultiplier={DENSE_FONT_SCALE}
                      style={[typography.subhead, { color: palette.label }]}
                    >
                      {item.card.title}
                    </Text>
                    <Text
                      numberOfLines={1}
                      maxFontSizeMultiplier={DENSE_FONT_SCALE}
                      style={[typography.footnote, { color: palette.sec }]}
                    >
                      {item.versions > 1
                        ? `${item.card.line2} · ${item.versions} versions`
                        : item.card.line2}
                    </Text>
                  </View>
                  {item.unseen ? (
                    <View testID={`artifact-gallery-new-${item.key}`} style={styles.newDot} />
                  ) : null}
                  <Text style={[typography.footnote, { color: palette.sec }]}>{item.time}</Text>
                </Pressable>
              ))}
            </View>
          )}
        />
      ) : (
        <View style={styles.center}>
          <Text
            testID="artifact-gallery-empty"
            style={[typography.subhead, styles.empty, { color: palette.sec }]}
          >
            {emptyWords(snapshot, archived)}
          </Text>
        </View>
      )}
      {open === null ? null : (
        <ArtifactViewerModal
          palette={palette}
          computerId={computerId}
          meta={open.meta}
          versions={open.versions}
          readBytes={readBytes}
          onClose={() =>
            viewerCloseTarget({ fromCard: fromCard.current }) === "back"
              ? props.onBack()
              : setOpen(null)
          }
          onLink={props.onLink}
          {...(props.onShare === undefined ? {} : { onShare: props.onShare })}
          {...(props.onRenderError === undefined ? {} : { onRenderError: props.onRenderError })}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  summary: { paddingHorizontal: space.inset, paddingBottom: 8 },
  section: { paddingHorizontal: space.inset },
  day: { paddingTop: 12, paddingBottom: 4 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tile: {
    width: 40,
    height: 40,
    borderRadius: radius.tile,
    alignItems: "center",
    justifyContent: "center",
  },
  chip: {
    alignSelf: "flex-start",
    marginHorizontal: space.inset,
    marginBottom: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.tile,
    borderWidth: StyleSheet.hairlineWidth,
  },
  body: { flex: 1, gap: 2 },
  newDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: "#4C8DFF",
  },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  empty: { textAlign: "center" },
});
