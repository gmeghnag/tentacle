/**
 * Session info's ARTIFACTS section (docs/feat/model-artifacts.md D9, T9.3): one
 * row — `Artifacts · 3 · 1 new ›` — that opens the gallery, and its own pull, so
 * an older daemon says "needs a newer tentacle" instead of taking the sheet down.
 *
 * Pure: every phase the section can be in is asserted here, not in the sheet.
 */
import { describe, expect, test } from "bun:test";
import type { ArtifactMeta } from "@tentacle/protocol";
import { type ArtifactSeen, NOTHING_SEEN, markArtifactOpened } from "../src/artifact-seen-store.ts";
import {
  type ArtifactFacts,
  type InfoFacts,
  type Pull,
  artifactsSection,
  sessionInfoView,
} from "../src/session-info.ts";

function meta(over: Partial<ArtifactMeta> & { readonly artifactId: string }): ArtifactMeta {
  return {
    version: 1,
    sha256: "a".repeat(64),
    size: 1000,
    mimeType: "image/png",
    kind: "image",
    title: `${over.artifactId}.png`,
    callId: `call-${over.artifactId}`,
    createdAt: 0,
    ...over,
  };
}

const ready = <T>(value: T): Pull<T> => ({ state: "ready", value });

function artifacts(over: Partial<ArtifactFacts> = {}): ArtifactFacts {
  return { pull: ready([meta({ artifactId: "a" })]), seen: NOTHING_SEEN, now: 0, ...over };
}

function facts(over: Partial<InfoFacts> = {}): InfoFacts {
  return {
    phase: "open",
    link: "up",
    now: 0,
    title: "Fix the flaky test",
    computerName: "MacBook Pro",
    daemon: { version: "1.4.0" },
    mcp: ready({ servers: [] }),
    skills: ready({ slash: [], skills: [], problems: [], moreProblems: 0 }),
    context: ready({ used: 0, exact: true }),
    entry: ready(null),
    autoAccept: false,
    ...over,
  };
}

describe("the artifacts section", () => {
  test("is not drawn at all when the sheet was built without the pull", () => {
    expect(artifactsSection(facts())).toBeNull();
    expect(sessionInfoView(facts()).sections.some((s) => s.id === "artifacts")).toBe(false);
  });

  test("sits after the session's own facts and before the computer-wide ones", () => {
    const view = sessionInfoView(facts({ artifacts: artifacts() }));
    const ids = view.sections.map((s) => s.id);
    expect(ids.indexOf("artifacts")).toBeGreaterThan(ids.indexOf("session"));
    expect(ids.indexOf("artifacts")).toBeLessThan(ids.indexOf("mcp"));
  });

  test("not attached: `not-open`, with the words that say why", () => {
    const section = artifactsSection(facts({ phase: "opening", artifacts: artifacts() }));
    expect(section?.phase).toBe("not-open");
    expect(section?.rows).toEqual([]);
    expect(section?.empty?.title).toBe("Open the session to see its artifacts");
  });

  test("a pull still running is `loading` (never an empty gallery)", () => {
    const section = artifactsSection(
      facts({ artifacts: artifacts({ pull: { state: "loading" } }) }),
    );
    expect(section?.phase).toBe("loading");
  });

  test("an older daemon says so, and offers no Retry (it can never help)", () => {
    const section = artifactsSection(
      facts({ artifacts: artifacts({ pull: { state: "error", kind: "unsupported" } }) }),
    );
    expect(section?.phase).toBe("unsupported");
    expect(section?.empty?.title).toBe("Needs a newer tentacle on MacBook Pro");
    expect(section?.retry).toBeUndefined();
  });

  test("a dropped link is `offline`; a plain failure is retryable", () => {
    const offline = artifactsSection(
      facts({ artifacts: artifacts({ pull: { state: "error", kind: "offline" } }) }),
    );
    expect(offline?.phase).toBe("offline");
    const broken = artifactsSection(
      facts({ artifacts: artifacts({ pull: { state: "error", kind: "error" } }) }),
    );
    expect(broken?.phase).toBe("error");
    expect(broken?.retry).toBe(true);
  });

  test("none yet: `empty` with the hint, and no row at all", () => {
    const section = artifactsSection(facts({ artifacts: artifacts({ pull: ready([]) }) }));
    expect(section?.phase).toBe("empty");
    expect(section?.rows).toEqual([]);
    expect(section?.empty?.title).toBe("No artifacts yet");
    expect(section?.empty?.footnote).toBe("Ask the agent to present a file");
  });

  test("READY: one row, `3 artifacts · 1 new`, that opens the gallery", () => {
    const list = [
      meta({ artifactId: "a", sha256: "a".repeat(64) }),
      meta({ artifactId: "b", sha256: "b".repeat(64) }),
      meta({ artifactId: "c", sha256: "c".repeat(64), version: 2, createdAt: 1 }),
    ];
    const section = artifactsSection(facts({ artifacts: artifacts({ pull: ready(list) }) }));
    expect(section?.phase).toBe("ready");
    expect(section?.rows).toHaveLength(1);
    const row = section?.rows[0];
    // ARTIFACTS, not versions: three versions of one artifact is one thing to see.
    expect(row?.title).toBe("Artifacts");
    expect(row?.value).toBe("3 artifacts · 3 new");
    expect(row?.opens).toBe("artifacts");
    expect(row?.key).toBe("artifacts");
  });

  test("nothing new: the count alone, never `· 0 new`", () => {
    const seen: ArtifactSeen = { lastGalleryAt: 10, opened: [meta({ artifactId: "a" }).sha256] };
    const section = artifactsSection(facts({ artifacts: artifacts({ seen }) }));
    expect(section?.rows[0]?.value).toBe("1 artifact");
  });

  test("one artifact reads `1 artifact`, and an opened version stops being new", () => {
    const seen = markArtifactOpened(NOTHING_SEEN, meta({ artifactId: "a" }).sha256);
    const section = artifactsSection(facts({ artifacts: artifacts({ seen }) }));
    expect(section?.rows[0]?.value).toBe("1 artifact");
  });

  test("a link that is down dims the section but keeps its row", () => {
    const section = artifactsSection(facts({ link: "down", artifacts: artifacts() }));
    expect(section?.phase).toBe("ready");
    expect(section?.dim).toBe(true);
    expect(section?.rows).toHaveLength(1);
  });
});
