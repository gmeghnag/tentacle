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
      /onOpenArtifacts=\{\(from\) =>[\s\S]{0,300}openArtifactGallery\(navigation/,
    );
    const session = read("src", "screens", "SessionScreen.tsx");
    expect(session).toMatch(/onArtifact: \(meta\) => onOpenArtifacts\("card"\)/);
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
});
