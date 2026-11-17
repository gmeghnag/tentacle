/**
 * The artifact viewer (docs/feat/model-artifacts.md D9): ONE modal that reads the
 * bytes and shows the viewer `artifact-viewer.ts` names for the kind.
 *
 * Render only (AGENTS §7): which viewer a kind gets, what the WebView's props are
 * and whether a tap shares or opens are `artifact-open.ts` / `artifact-viewer.ts`
 * decisions. What lives here is the effect chain around them: read (the injected
 * port — the app passes the session screen's own `readArtifact`, so no second
 * session is dialled), keep a sha-verified copy in the phone's cache
 * (`artifact-cache.ts`'s plan), then render. A read that fails or a file too big
 * for the cache is SAID, never a blank screen.
 */
import { type JSX, useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { artifactCard } from "@tentacle/core";
import { Directory, File, Paths } from "expo-file-system";
import type { ArtifactMeta } from "@tentacle/protocol";
import { cacheDir, cachePath } from "../../artifact-cache.ts";
import { openTarget, viewerText } from "../../artifact-open.ts";
import { viewerFor, viewerSubtitle } from "../../artifact-viewer.ts";
import { type Palette, typography } from "../../theme.ts";
import { HtmlViewer } from "./HtmlViewer.tsx";
import { ImageViewer } from "./ImageViewer.tsx";
import { MarkdownViewer } from "./MarkdownViewer.tsx";
import { OtherSheet } from "./OtherSheet.tsx";
import { PdfViewer } from "./PdfViewer.tsx";
import { ViewerHeader } from "./ViewerHeader.tsx";

/** How the bytes arrive: the session screen's own reader (never a second session). */
export type ReadBytes = (meta: ArtifactMeta, options?: { signal?: AbortSignal }) => Promise<Uint8Array>;

interface Ready {
  readonly kind: "ready";
  /** `file:` uri of the verified copy (image/pdf), or the decoded text's kinds. */
  readonly fileUri: string;
  readonly text: string | null;
}

type Phase = { readonly kind: "loading" } | Ready | { readonly kind: "failed"; readonly text: string };

/** Where the verified copy lives: `<cache>/artifacts/<computerId>/<sha256>`. */
function cacheFile(computerId: string, sha256: string): File {
  const dir = new Directory(Paths.cache, cacheDir(computerId));
  dir.create({ intermediates: true, idempotent: true });
  return new File(Paths.cache, cachePath(computerId, sha256));
}

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
          // A file kind (image, PDF): the viewer wants a URI, so the verified copy
          // is written. `overwrite: true` is safe — the path IS the content hash.
          const file = cacheFile(computerId, meta.sha256);
          file.create({ overwrite: true });
          file.write(bytes);
          setPhase({ kind: "ready", fileUri: file.uri, text: null });
          return;
        }
        setPhase({ kind: "ready", fileUri: "", text });
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
    return () => control.abort();
  }, [meta, computerId, readBytes, choice.kind]);

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
          ? { onShare: () => props.onShare?.(phase.fileUri) }
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
        <OtherSheet
          palette={palette}
          title={card.title}
          line2={card.line2}
          onShare={() => {
            if (phase.fileUri !== "") {
              props.onShare?.(phase.fileUri);
            }
          }}
        />
      ) : choice.kind === "image" ? (
        <ImageViewer fileUri={phase.fileUri} title={card.title} />
      ) : choice.kind === "pdf" ? (
        <PdfViewer fileUri={phase.fileUri} />
      ) : choice.kind === "webview" ? (
        <HtmlViewer palette={palette} body={phase.text ?? ""} scripts={choice.scripts} />
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
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
});
