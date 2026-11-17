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
    // The load-bearing rule: no dialling from the gallery.
    expect(gallery).not.toContain("RemoteSession");
    expect(gallery).not.toContain("LINKS.get");
  });
});
