/**
 * docs/feat/model-artifacts.md S6b, T6b.1–3 — the PURE opener plan: which file
 * name, which wrap, and whether the person is asked first. Every name on disk is
 * ours (`<sha8>.<ext from OUR kind map>`), never the model's; `other` is never
 * handed to an OS opener; a pod's bytes always ask, and never with the network.
 */
import { describe, expect, test } from "bun:test";
import { artifactCsp } from "@tentacle/core";
import type { ArtifactMeta } from "@tentacle/protocol";
import {
  artifactStep,
  newestArtifact,
  openPlan,
  saveName,
  wrapArtifactBytes,
} from "../src/artifact-open.ts";
import type { DisplayItem } from "../src/state.ts";

function meta(over: Partial<ArtifactMeta> = {}): ArtifactMeta {
  return {
    artifactId: "report",
    version: 1,
    sha256: `ab12cd34${"0".repeat(56)}`,
    size: 14_000,
    mimeType: "text/html",
    kind: "html",
    title: "Load test report",
    callId: "c1",
    createdAt: 1_000,
    ...over,
  };
}

describe("T6b.1 — file names never carry model input", () => {
  test("a hostile title and source still give `<sha8>.<ext from kind>`", () => {
    const plan = openPlan(
      meta({ title: "../../x.command", source: "../../evil.command" }),
      "local",
    );
    expect(plan.file).toBe("ab12cd34.html");
  });

  test("the extension comes from OUR kind map, whatever the name says", () => {
    const cases: [Partial<ArtifactMeta>, string][] = [
      [{ kind: "image", mimeType: "image/png", title: "a.command" }, "ab12cd34.png"],
      [{ kind: "image", mimeType: "image/jpeg" }, "ab12cd34.jpg"],
      [{ kind: "image", mimeType: "image/gif" }, "ab12cd34.gif"],
      [{ kind: "image", mimeType: "image/webp" }, "ab12cd34.webp"],
      [{ kind: "pdf", mimeType: "application/pdf", title: "x.app" }, "ab12cd34.pdf"],
      [{ kind: "markdown", mimeType: "text/markdown" }, "ab12cd34.md"],
      [{ kind: "text", mimeType: "text/plain", title: "run.sh" }, "ab12cd34.txt"],
      // An SVG is wrapped with the HTML prefix, so it MUST be `.html` (S2 review):
      // under `.svg` the meta CSP is ignored and the file is no longer XML.
      [{ kind: "svg", mimeType: "image/svg+xml" }, "ab12cd34.html"],
    ];
    for (const [over, file] of cases) {
      expect(openPlan(meta(over), "local").file).toBe(file);
    }
  });

  test("the saved copy's name is sanitized and its extension is ours", () => {
    expect(saveName(meta({ title: "../../x.command" }))).toBe("x.html");
    expect(saveName(meta({ kind: "other", mimeType: "application/zip", title: "a/b.app" }))).toBe(
      "b.zip",
    );
    expect(
      saveName(meta({ kind: "other", mimeType: "application/x-weird", title: "run.command" })),
    ).toBe("run.bin");
    // Nothing left of the name: the artifact's slug, never an empty / dot file.
    expect(saveName(meta({ title: "...." }))).toBe("report.html");
    expect(saveName(meta({ source: "out/Q3 report.html", title: "t" }))).toBe("Q3 report.html");
  });

  test("a chart artifact saves as its JSON spec — the bytes ARE the spec (C8)", () => {
    // A chart artifact carries `canonicalChartJson(spec)`, so the copy a person
    // keeps is a `.json` they can feed back into the tool — never `.bin` (the
    // mime is not in SAVE_EXT) and never `.txt` (which would read as prose).
    const chart = meta({
      kind: "chart",
      mimeType: "application/vnd.tentacle.chart+json",
      title: "Ricavi 2026",
    });
    expect(saveName(chart)).toBe("Ricavi 2026.json");
    expect(openPlan(chart, "local").file).toBe("ab12cd34.json");
    // Opened, not save-only: watching the chart is what a tap is for.
    expect(artifactStep(chart, "local", "open").kind).toBe("open");
    // No wrap: a spec is data, not a page (the CSP prefix would corrupt it).
    expect(openPlan(chart, "local").wrap).toBeNull();
  });
});

describe("T6b.2 — `other` is save-only, never opened", () => {
  test("kind other → save-only, no file to open", () => {
    const plan = openPlan(meta({ kind: "other", mimeType: "application/zip" }), "local");
    expect(plan.kind).toBe("save-only");
    expect(plan.file).toBeNull();
  });

  test("an unknown wire kind reads as other", () => {
    expect(openPlan(meta({ kind: "hologram" }), "local").kind).toBe("save-only");
  });

  test("an image of a type we have no viewer extension for is save-only too", () => {
    expect(openPlan(meta({ kind: "image", mimeType: "image/x-icns" }), "local").kind).toBe(
      "save-only",
    );
  });

  test("the step for other is a notice, never an open or a confirm", () => {
    const step = artifactStep(
      meta({ kind: "other", mimeType: "application/zip" }),
      "local",
      "open",
    );
    expect(step.kind).toBe("notice");
  });
});

describe("T6b.3 — pod origin always confirms, network never offered", () => {
  test("every openable kind from a pod is confirm", () => {
    for (const over of [
      {},
      { kind: "pdf", mimeType: "application/pdf" },
      { kind: "image", mimeType: "image/png" },
      { kind: "markdown", mimeType: "text/markdown" },
    ]) {
      expect(openPlan(meta(over), "pod").kind).toBe("confirm");
    }
  });

  test("a local open of the same bytes goes straight through", () => {
    expect(openPlan(meta(), "local").kind).toBe("open");
    expect(artifactStep(meta(), "local", "open").kind).toBe("open");
  });

  test("pod HTML is never planned with the network, even when asked", () => {
    expect(openPlan(meta(), "pod", "network").network).toBe(false);
    const step = artifactStep(meta(), "pod", "network");
    expect(step.kind).toBe("notice");
  });

  test("the pod confirm names the bytes' origin, and remembers nothing", () => {
    const step = artifactStep(meta(), "pod", "open");
    expect(step.kind).toBe("confirm");
    if (step.kind === "confirm") {
      expect(step.text).toContain("Load test report");
      expect(step.text).toContain("from the pod");
      expect(step.text).toContain("not remembered");
      expect(step.text).toContain("(y/N)");
      expect(step.plan.network).toBe(false);
    }
  });

  // S6a review finding 3: CSP stops sub-resources, NOT top-level navigation (a
  // `location =`, a meta refresh, `window.open`). "network blocked" was a false
  // promise the person approved a pod page on; the line must say what holds.
  test("the pod confirm promises no fetch/XHR — and that it can still navigate away", () => {
    const step = artifactStep(meta(), "pod", "open");
    expect(step.kind).toBe("confirm");
    if (step.kind !== "confirm") {
      return;
    }
    expect(step.text).not.toContain("network blocked");
    expect(step.text).toContain("no fetch/XHR");
    expect(step.text).toContain("can still navigate away");
  });

  test("local network is a confirm with the network on", () => {
    const step = artifactStep(meta(), "local", "network");
    expect(step.kind).toBe("confirm");
    if (step.kind === "confirm") {
      expect(step.plan.network).toBe(true);
      expect(step.text).toContain("network");
    }
  });

  test("save is a save on both origins (the explicit key IS the decision)", () => {
    for (const origin of ["local", "pod"] as const) {
      const step = artifactStep(meta({ title: "../x.command" }), origin, "save");
      expect(step).toEqual({ kind: "save", name: "x.html", wrap: "csp" });
    }
  });
});

describe("T6b.1 — an SVG is WRAPPED, not merely renamed (S6a review finding 1)", () => {
  // The `.html` name alone proves nothing: `wrapOf` could stop wrapping an SVG
  // and every name-based assertion above would still pass (the reviewer's
  // mutation). The wrap is the security property — an unwrapped `.html` opens
  // with scripts AND full network — so it is asserted on all three steps.
  const svg = (over: Partial<ArtifactMeta> = {}): ArtifactMeta =>
    meta({ kind: "svg", mimeType: "image/svg+xml", title: "diagram.svg", ...over });

  test("openPlan wraps an SVG in the CSP, offline by default", () => {
    expect(openPlan(svg(), "local").wrap).toBe("csp");
    expect(openPlan(svg(), "pod").wrap).toBe("csp");
    expect(openPlan(svg(), "local").network).toBe(false);
  });

  test("the open step for an SVG carries `wrap: csp`", () => {
    const step = artifactStep(svg(), "local", "open");
    expect(step.kind).toBe("open");
    if (step.kind === "open") {
      expect(step.plan.wrap).toBe("csp");
      expect(step.plan.file).toBe("ab12cd34.html");
    }
  });

  test("a pod SVG's confirm says the page is wrapped and scripts run", () => {
    const step = artifactStep(svg(), "pod", "open");
    expect(step.kind).toBe("confirm");
    if (step.kind === "confirm") {
      expect(step.plan.wrap).toBe("csp");
      expect(step.text).toContain("your browser");
    }
  });

  test("a SAVED SVG is wrapped too — the save step carries it", () => {
    expect(artifactStep(svg(), "local", "save")).toEqual({
      kind: "save",
      name: "diagram.html",
      wrap: "csp",
    });
  });

  test("the bytes handed to either write path start with the CSP prefix", () => {
    const body = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    for (const wrap of [openPlan(svg(), "local").wrap, "csp" as const]) {
      const out = new TextDecoder().decode(wrapArtifactBytes(wrap, false, body));
      expect(out.startsWith(artifactCsp())).toBe(true);
      expect(out.endsWith('<svg xmlns="http://www.w3.org/2000/svg"/>')).toBe(true);
    }
  });
});

describe("T6b.4 (pure half) — the CSP prefix is the first bytes", () => {
  test("csp wrap prepends the offline policy before the artifact's own bytes", () => {
    const body = new TextEncoder().encode("<script>fetch('https://x')</script>");
    const out = new TextDecoder().decode(wrapArtifactBytes("csp", false, body));
    expect(out.startsWith(artifactCsp())).toBe(true);
    expect(out.endsWith("<script>fetch('https://x')</script>")).toBe(true);
  });

  test("the network variant carries the network policy, and no wrap is the bytes as is", () => {
    const body = new Uint8Array([1, 2, 3]);
    const net = new TextDecoder().decode(wrapArtifactBytes("csp", true, body).slice(0, 200));
    expect(net.startsWith(artifactCsp({ network: true }).slice(0, 200))).toBe(true);
    expect(wrapArtifactBytes(null, false, body)).toBe(body);
  });
});

describe("the chord's target: the newest artifact in the transcript", () => {
  const tool = (id: string, m?: ArtifactMeta): DisplayItem => ({
    kind: "tool",
    id,
    name: "present",
    args: "{}",
    status: "ok",
    ...(m ? { detail: { kind: "artifact", artifact: m } } : {}),
  });

  test("the one presented last wins, wherever its row is", () => {
    const a = meta({ artifactId: "a", createdAt: 3_000 });
    const b = meta({ artifactId: "b", createdAt: 2_000 });
    expect(newestArtifact([tool("1", a), tool("2", b), tool("3")])?.artifactId).toBe("a");
  });

  test("a tie is broken by transcript order (the later row)", () => {
    const a = meta({ artifactId: "a" });
    const b = meta({ artifactId: "b" });
    expect(newestArtifact([tool("1", a), tool("2", b)])?.artifactId).toBe("b");
  });

  test("no card → undefined", () => {
    expect(newestArtifact([tool("1")])).toBeUndefined();
  });
});
