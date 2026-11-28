/**
 * The phone's gallery entry points, pinned at the source (docs/feat/model-artifacts.md
 * D9, T9): ONE route function (so `feat/mobile-hub` calls the same one), a Session
 * info row that reaches it, and the card testID the e2e flow taps.
 *
 * Source pins, not renders: the harness cannot mount a navigator or a `.tsx`, and
 * the decisions themselves are already asserted in `session-info-artifacts.test.ts`
 * (the row and its `opens`) — what is left is the WIRING, which is exactly what
 * silently goes missing.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openArtifactGallery } from "../src/routes.ts";

const root = join(import.meta.dir, "..");
const read = (...parts: readonly string[]): string => readFileSync(join(root, ...parts), "utf8");

describe("openArtifactGallery is the ONE entry (D9)", () => {
  test("it pushes the ArtifactGallery route with what the screen needs", () => {
    const calls: { name: string; params: Record<string, unknown> }[] = [];
    openArtifactGallery(
      { navigate: (name, params) => calls.push({ name, params: { ...params } }) },
      { computerId: "c1", sessionId: "s1", title: "Alpha", archived: false, from: "session-info" },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("ArtifactGallery");
    expect(calls[0]?.params).toMatchObject({
      computerId: "c1",
      sessionId: "s1",
      title: "Alpha",
      from: "session-info",
    });
  });

  test("a card opens ITS artifact: the id rides the route into the gallery (sweep: flow 30)", () => {
    const calls: { params: Record<string, unknown> }[] = [];
    openArtifactGallery(
      { navigate: (_name, params) => calls.push({ params: { ...params } }) },
      {
        computerId: "c1",
        sessionId: "s1",
        title: "A",
        archived: false,
        from: "card",
        open: "page",
      },
    );
    expect(calls[0]?.params.open).toBe("page");
    const screen = read("src", "screens", "SessionScreen.tsx");
    expect(screen).toContain('onOpenArtifacts?.("card", meta.artifactId)');
    const app = read("App.tsx");
    expect(app).toMatch(/onOpenArtifacts=\{\(from, open\) =>/);
    expect(app).toContain("open: route.params.open");
    const gallery = read("src", "screens", "ArtifactGallery.tsx");
    expect(gallery).toContain("galleryItemFor(view, wanted.current)");
    expect(gallery).toMatch(/openArtifact\(target, true\)/);
    // …and closing that viewer goes back to the session (flow 30's last step).
    expect(gallery).toMatch(
      /viewerCloseTarget\(\{ fromCard: fromCard\.current \}\) === "back"\s*\?\s*props\.onBack\(\)/,
    );
  });

  test("the hub and a card reach the same function (no second entry)", () => {
    const routes = read("src", "routes.ts");
    // Exactly one exported opener, and the route registered once in the stack.
    expect(routes.match(/export function open\w*Artifact\w*/g) ?? []).toHaveLength(1);
    const app = read("App.tsx");
    expect(app.match(/name="ArtifactGallery"/g) ?? []).toHaveLength(1);
    expect(app).toContain("openArtifactGallery");
  });

  /**
   * Finding 1 of the S8+S9 Review, pinned end to end: the route, the screening
   * and both taps that lead to it must ALL be wired, or a tap is a no-op (the
   * gallery was built but nothing in `App.tsx` reached it). A source pin, because
   * `App.tsx` imports React Native and cannot be mounted here.
   */
  test("App.tsx wires every link of the chain (route → screen → rows → gallery)", () => {
    const app = read("App.tsx");
    // 1. The route exists in the stack and is what the ONE opener pushes.
    expect(app).toContain('<Stack.Screen\n            name="ArtifactGallery"');
    // 2. The screen is what that route renders, over the feed (never a handle).
    expect(app).toContain("<ArtifactGalleryScreen");
    // 3. The session screen publishes the feed the gallery reads: without this
    //    the gallery is empty and a viewer would have no reader.
    expect(app).toMatch(/artifacts: \{ feed: ARTIFACT_FEEDS\.feed\(computerId, sessionId\) \}/);
    // 4. Both taps: the session route builds the opener's params and hands them
    //    to the screen, which is what puts `onArtifact` on a card and a press on
    //    the Session-info row. TWO hand-offs in `App.tsx` (the navigator → the
    //    session route → the screen): either one alone leaves a tap a no-op —
    //    which is exactly the Review's finding 1.
    expect(app.match(/onOpenArtifacts=/g) ?? []).toHaveLength(2);
    expect(app).toMatch(
      /onOpenArtifacts=\{\(from, open\) =>[\s\S]{0,300}openArtifactGallery\(navigation/,
    );
    const session = read("src", "screens", "SessionScreen.tsx");
    expect(session).toMatch(
      /onArtifact: \(meta\) => onOpenArtifacts\?\.\("card", meta\.artifactId\)/,
    );
    // The cell offers the card only when the screen has a gallery to open.
    expect(session).toContain("const artifactsOn = onOpenArtifacts !== undefined;");
    expect(session).toContain("artifacts: artifactsOn,");
    expect(read("src", "transcript-cell.ts")).toContain("artifacts: env.artifacts,");
  });

  test("the sheet calls it for a row whose `opens` is `artifacts`", () => {
    const sheet = read("src", "screens", "SessionInfoSheet.tsx");
    expect(sheet).toContain("onOpenArtifacts");
    // The row's own path: `opens` decides the press, never the title.
    expect(sheet).toContain('row.opens === "artifacts"');
    // A chevron, because the row leads somewhere (the expand rule's neighbour).
    expect(sheet).toMatch(/opens[\s\S]{0,200}chevron/);
    const session = read("src", "screens", "SessionScreen.tsx");
    expect(session).toContain("onOpenArtifacts");
  });

  test("the transcript card is addressable as artifact-card-<artifactId> (e2e flow 30)", () => {
    const row = read("src", "screens", "transcript", "TranscriptRow.tsx");
    expect(row).toContain("artifact-card-${");
    expect(row).toMatch(/testID=\{`artifact-card-\$\{[^}]+\}`\}/);
    const flow = read("e2e", "flows", "30-artifact-escape.yaml");
    expect(flow).toContain("artifact-card-");
  });

  test("the gallery screen exists and reads the published feed (never a second session)", () => {
    const gallery = read("src", "screens", "ArtifactGallery.tsx");
    expect(gallery).toContain("ARTIFACT_FEEDS");
    // The load-bearing rule, pinned at the CODE: no dialling from the gallery.
    // A comment may name `RemoteSession` (it explains why), an import may not —
    // and neither may the two calls that would dial (`LINKS.get`, `openSession`).
    const code = gallery.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    for (const banned of ["RemoteSession", "LINKS.get", "openSession", "webSocketChannelFactory"]) {
      expect({ banned, found: code.includes(banned) }).toEqual({ banned, found: false });
    }
  });

  test("a chart artifact OPENS as the full-screen chart, and the gallery draws it (T8.1/C8)", () => {
    const viewer = read("src", "screens", "artifacts", "ArtifactViewerModal.tsx");
    // D6: "opening a chart artifact opens the same full-screen chart" — the SAME
    // component a `chart` transcript row's tap opens, given the artifact's own
    // bytes as the tool's args (the spec is the arguments, in both places).
    // The branch is `viewerBody`'s `chart` (artifact-open.test.ts pins the value).
    expect(viewer).toContain('body === "chart"');
    expect(viewer).toContain("<ChartFullScreen");
    expect(viewer).toContain('name: "chart"');
    // The chart is given the READY read's bytes (not the failure text, not "").
    expect(viewer).toContain('const text = ready?.text ?? "";');
    expect(viewer).toMatch(
      /<ChartFullScreen[\s\S]*?tool=\{\{ name: "chart", args: text, status: "ok" \}\}/,
    );
    // Reduce Motion is the app's single hook, never a second prop read.
    expect(viewer).toContain("useReduceMotion");
    // A `chart` viewer's bytes are TEXT: it must not take the image/PDF uri path.
    expect(viewer).toContain("viewerText(choice.kind, bytes)");
    const gallery = read("src", "screens", "ArtifactGallery.tsx");
    // The thumbnail is the PURE modules' decision (caps, decode, re-validation in
    // `chartThumbView`, the marks + view box + legibility in `chart-thumb.ts`).
    expect(gallery).toContain("chartThumbGeometry");
    expect(gallery).toContain("chartThumbAt");
    expect(gallery).toContain("wantsChartThumbnail");
    expect(read("src", "chart-thumb.ts")).toContain("chartThumbView(meta, bytes");
    // The chip exists and passes `only` to the ONE view, never a second list.
    expect(gallery).toContain("CHART_FILTER_LABEL");
    expect(gallery).toContain("GRAFICI_CHIP");
  });

  // docs/fix/mobile-qa-sweep.md bug 1 (owner screenshot): the gallery is a
  // FULL-SCREEN stack screen, so its header needs the safe-area top (else the ✕
  // sits on the status-bar clock), and the viewer it mounts must cover the
  // screen, not share the column with the list (the "half sheet").
  test("the gallery header takes the top inset unless the route is a sheet", () => {
    const app = read("App.tsx");
    const at = app.indexOf('name="ArtifactGallery"');
    expect(at).toBeGreaterThan(-1);
    // The route's whole declaration, from its name to the screen it renders: an
    // `options={({ route }) => …}` arrow contains a ">", so never cut there.
    const end = app.indexOf("<ArtifactGalleryScreen", at);
    expect(end).toBeGreaterThan(at);
    const options = app.slice(at, end);
    expect(options).toContain("options=");
    const sheet = /presentation:\s*"(modal|formSheet|pageSheet)"/.test(options);
    const gallery = read("src", "screens", "ArtifactGallery.tsx");
    expect(gallery.includes("insetTop={false}")).toBe(sheet);
  });

  test("the artifact viewer covers the whole screen (an overlay, not a flex sibling)", () => {
    const viewer = read("src", "screens", "artifacts", "ArtifactViewerModal.tsx");
    expect(viewer).toMatch(
      /root:\s*\{\s*position:\s*"absolute",\s*top:\s*0,\s*right:\s*0,\s*bottom:\s*0,\s*left:\s*0/,
    );
  });
});
