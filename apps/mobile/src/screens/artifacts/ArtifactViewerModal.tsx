import { artifactCard } from "@tentacle/core";
import type { ArtifactMeta } from "@tentacle/protocol";
/**
 * The artifact viewer (docs/feat/model-artifacts.md D9): ONE modal that reads the
 * bytes and shows the viewer `artifact-viewer.ts` names for the kind.
 *
 * Render only (AGENTS §7): which viewer a kind gets, what the WebView's props are
 * and whether a tap shares or opens are `artifact-open.ts` / `artifact-viewer.ts`
 * decisions. What lives here is the effect chain around them: read (the injected
 * port — the app passes the session screen's own `readArtifact`, so no second
 * session is dialled), keep a sha-verified copy through the cache STORE
 * (`artifact-cache-store.ts`: the 200 MB LRU, and the version on screen is the
 * one it never evicts), then render. A read that fails or a file too big to keep
 * is SAID, never a blank screen — and Share hands over a copy NAMED for a person
 * (`<sanitized title>.<ext>`), never the 64-hex content hash.
 */
import { type JSX, useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { ARTIFACT_CACHE } from "../../artifact-cache-expo.ts";
import { openTarget, viewerText } from "../../artifact-open.ts";
import { viewerFor, viewerSubtitle } from "../../artifact-viewer.ts";
import { type Palette, typography } from "../../theme.ts";
import { useReduceMotion } from "../../ui/chart/ChartAppear.tsx";
import { ChartFullScreen } from "../../ui/chart/ChartFullScreen.tsx";
import { HtmlViewer } from "./HtmlViewer.tsx";
import { ImageViewer } from "./ImageViewer.tsx";
import { MarkdownViewer } from "./MarkdownViewer.tsx";
import { OtherSheet } from "./OtherSheet.tsx";
import { PdfViewer } from "./PdfViewer.tsx";
import { ViewerHeader } from "./ViewerHeader.tsx";

/** How the bytes arrive: the session screen's own reader (never a second session). */
export type ReadBytes = (
  meta: ArtifactMeta,
  options?: { signal?: AbortSignal },
) => Promise<Uint8Array>;

interface Ready {
  readonly kind: "ready";
  /** `file:` uri of the verified copy (image/pdf), or the decoded text's kinds. */
  readonly fileUri: string;
  readonly text: string | null;
  /** The cache's one-line note (`tooBigNote`), or `null` when the file fits. */
  readonly note: string | null;
}

type Phase =
  | { readonly kind: "loading" }
  | Ready
  | { readonly kind: "failed"; readonly text: string };

/** Where the verified copy lives: `<cache>/artifacts/<computerId>/<sha256>`. */
export interface ArtifactViewerModalProps {
  readonly palette: Palette;
  readonly computerId: string;
  readonly meta: ArtifactMeta;
  /** How many versions the artifact has (the header's picker shows when > 1). */
  readonly versions: number;
  readonly readBytes: ReadBytes;
  readonly onClose: () => void;
  readonly onLink: (href: string) => void;
  /** Another version was picked (the header's `v2 ▾`): the caller swaps `meta`. */
  readonly onPickVersion?: () => void;
  readonly onShare?: (fileUri: string) => void;
}

export function ArtifactViewerModal(props: ArtifactViewerModalProps): JSX.Element {
  const { palette, meta, computerId, readBytes } = props;
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  // Reduce Motion is the app's ONE hook (C7); `null` (not read yet) animates, as
  // the chart components' own default does.
  const reduceMotion = useReduceMotion();
  const card = artifactCard(meta);
  const choice = viewerFor(meta);
  const target = openTarget(card);

  useEffect(() => {
    const control = new AbortController();
    setPhase({ kind: "loading" });
    void (async () => {
      try {
        const bytes = await readBytes(meta, { signal: control.signal });
        if (control.signal.aborted) {
          return;
        }
        const text = viewerText(choice.kind, bytes);
        if (text === null) {
          // A file kind (image, PDF): the viewer wants a URI, so the verified
          // copy is kept through the cache STORE — which is what applies the
          // 200 MB LRU, never evicts this version while it is on screen, and
          // says so when the file cannot fit at all. `artifact-cache-store.ts`.
          ARTIFACT_CACHE.hold(computerId, meta.sha256);
          const kept = ARTIFACT_CACHE.put(computerId, meta, bytes);
          setPhase({
            kind: "ready",
            // Too big to keep: the bytes were NOT written, so there is no uri to
            // show — the note says why and Share stays off (never a dead uri).
            fileUri: kept.uri ?? "",
            text: null,
            note: kept.note,
          });
          return;
        }
        setPhase({ kind: "ready", fileUri: "", text, note: null });
      } catch (error) {
        if (!control.signal.aborted) {
          setPhase({
            kind: "failed",
            text:
              error instanceof Error && /verify|sha256/i.test(error.message)
                ? "Couldn't verify this file"
                : "Couldn't read this artifact",
          });
        }
      }
    })();
    // Closing the viewer releases the hold: the version may be evicted again.
    return () => {
      control.abort();
      ARTIFACT_CACHE.hold(computerId, null);
    };
  }, [meta, computerId, readBytes, choice.kind]);

  // What Share hands over: a copy NAMED `<sanitized title>.<ext>` (D9), never the
  // 64-hex content-hash path — a recipient cannot open an extensionless blob.
  const share = (): void => {
    const copy = ARTIFACT_CACHE.shareCopy(computerId, meta);
    if (copy !== null) {
      props.onShare?.(copy.uri);
    }
  };

  return (
    <View style={[styles.root, { backgroundColor: palette.bg }]} testID="artifact-viewer">
      <ViewerHeader
        palette={palette}
        title={card.title}
        subtitle={viewerSubtitle(card)}
        version={meta.version}
        versions={props.versions}
        onClose={props.onClose}
        {...(phase.kind === "ready" && phase.fileUri !== "" && props.onShare !== undefined
          ? { onShare: share }
          : {})}
        {...(props.onPickVersion === undefined ? {} : { onPickVersion: props.onPickVersion })}
      />
      {phase.kind === "loading" ? (
        <View style={styles.center} testID="artifact-loading">
          <ActivityIndicator color={palette.accent} />
        </View>
      ) : phase.kind === "failed" ? (
        <View style={styles.center}>
          <Text testID="artifact-error" style={[typography.subhead, { color: palette.red }]}>
            {phase.text}
          </Text>
        </View>
      ) : target.kind === "share" || choice.kind === "none" ? (
        <View style={styles.fill}>
          {phase.note === null ? null : <CacheNote palette={palette} note={phase.note} />}
          <OtherSheet
            palette={palette}
            title={card.title}
            line2={card.line2}
            // Share is this kind's ONLY action (D9): it makes the named copy.
            onShare={share}
          />
        </View>
      ) : choice.kind === "chart" ? (
        // D6: opening a chart artifact opens the SAME full-screen chart a
        // `chart` transcript row's tap does (docs/feat/model-charts.md C8). The
        // bytes ARE the spec — the tool presents its canonical arguments — so
        // the artifact's text is the tool's args, and the component
        // re-validates them: a forged or newer-than-this-build spec renders
        // nothing at all rather than half a chart.
        <ChartFullScreen
          tool={{ name: "chart", args: phase.text ?? "", status: "ok" }}
          palette={palette}
          locale={deviceLocale()}
          reduceMotion={reduceMotion === true}
          testID="artifact-chart"
          onClose={props.onClose}
        />
      ) : phase.fileUri === "" ? (
        // A file kind whose bytes are not on disk: too big for the cache. The
        // note says what it is and why there is nothing to render or share.
        <View style={styles.center}>
          {phase.note === null ? (
            <Text testID="artifact-error" style={[typography.subhead, { color: palette.sec }]}>
              Couldn't keep this file
            </Text>
          ) : (
            <CacheNote palette={palette} note={phase.note} />
          )}
        </View>
      ) : choice.kind === "image" ? (
        <ImageViewer fileUri={phase.fileUri} title={card.title} />
      ) : choice.kind === "pdf" ? (
        <PdfViewer fileUri={phase.fileUri} />
      ) : choice.kind === "webview" ? (
        <HtmlViewer palette={palette} body={phase.text ?? ""} scripts={choice.canRunScripts} />
      ) : (
        <MarkdownViewer
          palette={palette}
          text={phase.text ?? ""}
          kind={choice.kind === "markdown" ? "markdown" : "text"}
          onLink={props.onLink}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  fill: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  note: { paddingHorizontal: 24, paddingTop: 12, textAlign: "center" },
});

/** The device's language, for a chart's numbers and dates (as the transcript row does). */
function deviceLocale(): string {
  return Intl.DateTimeFormat().resolvedOptions().locale;
}

/**
 * The cache's one-line note (D9): the file is too big to keep on this phone. It
 * is shown, never swallowed — the viewer says what happened instead of leaving a
 * person with a blank page and no way to share.
 */
function CacheNote(props: { readonly palette: Palette; readonly note: string }): JSX.Element {
  return (
    <Text
      testID="artifact-cache-note"
      style={[typography.footnote, styles.note, { color: props.palette.sec }]}
    >
      {props.note}
    </Text>
  );
}
