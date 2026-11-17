/**
 * The transcript↔artifact join (docs/feat/model-artifacts.md D9, T9.1): a
 * reloaded transcript's rows are built from `ChatMessage`s, which carry no
 * tool-result `details`, so each `present` row's card comes from the daemon's
 * `artifact/list`, joined by the call id (`ArtifactMeta.callId`).
 *
 * Pure: every case below is a decision about identity, order or a phase word.
 */
import { describe, expect, test } from "bun:test";
import { ArtifactsUnsupportedError } from "@tentacle/client";
import type { ArtifactMeta } from "@tentacle/protocol";
import {
  EMPTY_JOIN,
  artifactsByCall,
  galleryListable,
  joinRows,
  needsArtifactJoin,
  phaseOfError,
  withList,
  withPhase,
} from "../src/artifact-join.ts";
import type { Row, ToolRow } from "../src/transcript-rows.ts";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function meta(over: Partial<ArtifactMeta> & { readonly artifactId: string }): ArtifactMeta {
  return {
    version: 1,
    sha256: SHA_A,
    size: 1000,
    mimeType: "image/png",
    kind: "image",
    title: `${over.artifactId}.png`,
    callId: `call-${over.artifactId}`,
    createdAt: 0,
    ...over,
  };
}

function tool(name: string, id: string, extra: Partial<ToolRow> = {}): ToolRow {
  return { kind: "tool", key: id, id, name, label: name, args: "", status: "ok", ...extra };
}

describe("artifactsByCall", () => {
  test("keys on the present call, keeping the newest version of a re-present", () => {
    const byCall = artifactsByCall([
      meta({ artifactId: "a", callId: "c1", version: 1 }),
      meta({ artifactId: "a", callId: "c1", version: 2 }),
      meta({ artifactId: "b", callId: "c2", sha256: SHA_B }),
    ]);
    expect(byCall.size).toBe(2);
    expect(byCall.get("c1")?.version).toBe(2);
    expect(byCall.get("c2")?.artifactId).toBe("b");
  });
});

describe("needsArtifactJoin", () => {
  test("true only for a present row still without a card", () => {
    expect(needsArtifactJoin([tool("present", "c1")])).toBe(true);
    expect(needsArtifactJoin([tool("present", "c1", { artifact: meta({ artifactId: "a" }) })])).toBe(
      false,
    );
    expect(needsArtifactJoin([tool("Read", "c2")])).toBe(false);
  });
});

describe("joinRows", () => {
  test("attaches the card of a present row's own call", () => {
    const rows: readonly Row[] = [tool("present", "c1")];
    const joined = joinRows(rows, artifactsByCall([meta({ artifactId: "a", callId: "c1" })]));
    expect(joined).not.toBe(rows);
    const row = joined[0] as ToolRow;
    expect(row.artifact?.artifactId).toBe("a");
  });

  test("never overwrites the card a LIVE turn put on the row", () => {
    const live = meta({ artifactId: "live", callId: "c1" });
    const rows: readonly Row[] = [tool("present", "c1", { artifact: live })];
    const joined = joinRows(rows, artifactsByCall([meta({ artifactId: "other", callId: "c1" })]));
    expect(joined).toBe(rows);
    expect((joined[0] as ToolRow).artifact).toBe(live);
  });

  test("the SAME array comes back when nothing joined (a no-op cannot re-render)", () => {
    const rows: readonly Row[] = [tool("Read", "c9")];
    expect(joinRows(rows, new Map())).toBe(rows);
    const present: readonly Row[] = [tool("present", "c1")];
    expect(joinRows(present, artifactsByCall([]))).toBe(present);
  });

  test("a present row whose call the list does not know stays card-less", () => {
    const rows: readonly Row[] = [tool("present", "c7")];
    expect(joinRows(rows, artifactsByCall([meta({ artifactId: "a", callId: "c1" })]))).toBe(rows);
  });
});

describe("phaseOfError", () => {
  test("an older daemon is `unsupported`, never a retryable error", () => {
    expect(phaseOfError(new ArtifactsUnsupportedError(undefined))).toBe("unsupported");
  });

  test("a dropped link is `offline`", () => {
    expect(phaseOfError(new Error("not connected to the daemon"))).toBe("offline");
  });

  test("anything else is `error` (a retry may help)", () => {
    expect(phaseOfError(new Error("boom"))).toBe("error");
    expect(phaseOfError("not an error")).toBe("error");
  });
});

describe("withList / withPhase / galleryListable", () => {
  test("a landed list is `ready` and carries its byCall join", () => {
    const join = withList(EMPTY_JOIN, [meta({ artifactId: "a", callId: "c1" })]);
    expect(join.phase).toBe("ready");
    expect(join.list).toHaveLength(1);
    expect(join.byCall.get("c1")?.artifactId).toBe("a");
    // The empty join is `loading`: the gallery draws "Loading…", never "No artifacts".
    expect(EMPTY_JOIN.phase).toBe("loading");
  });

  test("withPhase keeps the list it already had (a failure never blanks it)", () => {
    const ready = withList(EMPTY_JOIN, [meta({ artifactId: "a", callId: "c1" })]);
    const failed = withPhase(ready, "offline");
    expect(failed.list).toHaveLength(1);
    expect(failed.phase).toBe("offline");
  });

  test("a gallery may list only a `ready` join, and says which phase stopped it", () => {
    const ready = withList(EMPTY_JOIN, [meta({ artifactId: "a", callId: "c1" })]);
    expect(galleryListable(ready)).toEqual({ ok: true, list: ready.list });
    for (const phase of ["loading", "unsupported", "offline", "error"] as const) {
      expect(galleryListable(withPhase(ready, phase))).toEqual({ ok: false, phase });
    }
  });
});
