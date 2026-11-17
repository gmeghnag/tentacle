/**
 * The H4b WIRING guard (docs/feat/mobile-hub.md H4b): the hub's Artifacts item
 * opens the gallery through its ONE entry (`openArtifactGallery`, model-artifacts
 * D9) with `from: "hub"`, and the screen's opener can carry that origin.
 *
 * `SessionScreen.tsx` cannot run under `bun test`, so the type half is pinned by
 * `tsc -p apps/mobile` (this file is in its `include`): the assignment below
 * compiles only while the screen's `onOpenArtifacts` accepts every origin the
 * route does. The badge's rule is `hub-session.test.ts`'s.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ArtifactGalleryRoute, openArtifactGallery } from "../src/routes.ts";
import type { SessionScreenProps } from "../src/screens/SessionScreen.tsx";

type ScreenOrigin = Parameters<NonNullable<SessionScreenProps["onOpenArtifacts"]>>[0];

// Compile-time: the screen's opener takes the route's whole `from` union, "hub"
// included. A narrower prop (the pre-H4b `"session-info" | "card"`) fails tsc here.
const EVERY_ORIGIN: readonly ScreenOrigin[] = [
  "session-info",
  "card",
  "hub",
] satisfies readonly ArtifactGalleryRoute["from"][];

const root = join(import.meta.dir, "..");
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), "utf8");

describe("H4b: the hub reaches the gallery through its one entry", () => {
  test('`openArtifactGallery` carries `from: "hub"` to the route unchanged', () => {
    const pushed: ArtifactGalleryRoute[] = [];
    openArtifactGallery(
      { navigate: (_name, params) => pushed.push(params) },
      { computerId: "c1", sessionId: "s1", title: "t", archived: false, from: "hub" },
    );
    expect(pushed.map((p) => p.from)).toEqual(["hub"]);
  });

  test("both hand-offs type the origin as the route's own union, never a copy", () => {
    // A copied literal union would silently drop the next origin the route adds.
    const typed = /onOpenArtifacts\??: \(from: ArtifactGalleryRoute\["from"\]\) => void/g;
    expect(read("src", "screens", "SessionScreen.tsx").match(typed) ?? []).toHaveLength(1);
    expect(read("App.tsx").match(typed) ?? []).toHaveLength(1);
    expect(EVERY_ORIGIN).toContain("hub");
  });
});
