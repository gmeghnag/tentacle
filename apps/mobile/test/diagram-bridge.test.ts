/**
 * T5.2/T5.3, the security half (docs/feat/model-diagrams.md D5/D6): the ONE
 * message the hidden renderer may send back.
 *
 * Mermaid runs model (and pod) text, so a mermaid XSS could forge a message:
 * `parseDiagramReply` must accept exactly the shape the driver promises and drop
 * everything else — an oversize SVG, a NaN dimension, an id we did not ask for,
 * an extra key, a control character in a sentence that ends up on screen.
 *
 * What it does NOT do: sanitise the SVG's contents. That is the display's job —
 * an inert WebView (`javaScriptEnabled={false}`, no bridge) under `artifactCsp()`
 * (D6): even a `<script>` inside is never executed.
 */
import { describe, expect, test } from "bun:test";
import {
  DIAGRAM_DIM_MAX,
  DIAGRAM_LINE_MAX,
  DIAGRAM_MESSAGE_MAX,
  DIAGRAM_SVG_MAX_BYTES,
  parseDiagramReply,
} from "../src/diagram-bridge.ts";

const ASKED: ReadonlySet<string> = new Set(["r1"]);

const ok = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  ok: true,
  svg: '<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>',
  w: 320.5,
  h: 180,
  ...over,
});

const fail = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  ok: false,
  line: 3,
  message: "Parse error on line 3",
  ...over,
});

describe("parseDiagramReply — the accepted shape", () => {
  test("a renderer's success is the svg and its size", () => {
    expect(parseDiagramReply(ok(), ASKED)).toEqual({
      ok: true,
      id: "r1",
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>',
      width: 320.5,
      height: 180,
    });
  });

  test("a renderer's refusal carries its line and sentence", () => {
    expect(parseDiagramReply(fail(), ASKED)).toEqual({
      ok: false,
      id: "r1",
      line: 3,
      message: "Parse error on line 3",
    });
  });

  test("the answer is a fresh value, not the renderer's own object", () => {
    const raw = ok();
    const parsed = parseDiagramReply(raw, ASKED);
    expect(parsed).not.toBe(raw as unknown);
    // A later mutation of the raw message cannot reach a value already accepted.
    raw.w = 1;
    expect(parsed?.ok === true ? parsed.width : 0).toBe(320.5);
  });
});

describe("parseDiagramReply — the FORGED message (mermaid XSS)", () => {
  test("an id we did not ask for is dropped", () => {
    expect(parseDiagramReply(ok({ id: "r2" }), ASKED)).toBeNull();
    expect(parseDiagramReply(ok({ id: "" }), ASKED)).toBeNull();
    expect(parseDiagramReply(ok({ id: 7 }), ASKED)).toBeNull();
  });

  test("an oversize svg is dropped (the 512 KiB cap), and the cap is BYTES", () => {
    const big = `<svg>${"x".repeat(DIAGRAM_SVG_MAX_BYTES)}</svg>`;
    expect(parseDiagramReply(ok({ svg: big }), ASKED)).toBeNull();
    // A multi-byte label counts its bytes: 2 bytes per `è`, so half the length
    // already exceeds the cap (a `String.length` check would wave it through).
    const wide = `<svg>${"è".repeat(DIAGRAM_SVG_MAX_BYTES / 2)}</svg>`;
    expect(parseDiagramReply(ok({ svg: wide }), ASKED)).toBeNull();
  });

  test("a string that is not one closed <svg> element is not an SVG", () => {
    expect(parseDiagramReply(ok({ svg: "<html><body>hi</body></html>" }), ASKED)).toBeNull();
    expect(parseDiagramReply(ok({ svg: "" }), ASKED)).toBeNull();
    expect(parseDiagramReply(ok({ svg: 42 }), ASKED)).toBeNull();
    expect(parseDiagramReply(ok({ svg: "<svg><g/>" }), ASKED)).toBeNull();
  });

  test("a dimension that is NaN, infinite, zero, negative or past the cap is dropped", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, DIAGRAM_DIM_MAX + 1, "180"]) {
      expect(parseDiagramReply(ok({ w: bad }), ASKED)).toBeNull();
      expect(parseDiagramReply(ok({ h: bad }), ASKED)).toBeNull();
    }
    expect(parseDiagramReply(ok({ w: DIAGRAM_DIM_MAX }), ASKED)).not.toBeNull();
  });

  test("an extra key is dropped, not ignored (only the driver's shape is accepted)", () => {
    expect(parseDiagramReply(ok({ html: "<script>alert(1)</script>" }), ASKED)).toBeNull();
    // The two variants' key sets are disjoint: a "failure" carrying an svg is a lie.
    expect(parseDiagramReply(fail({ svg: "<svg/>" }), ASKED)).toBeNull();
    expect(parseDiagramReply(ok({ line: 2, message: "x" }), ASKED)).toBeNull();
  });

  test("a refusal's line is a sane integer and its sentence a capped string", () => {
    for (const bad of ["3", Number.NaN, -1, 1.5, DIAGRAM_LINE_MAX + 1]) {
      expect(parseDiagramReply(fail({ line: bad }), ASKED)).toBeNull();
    }
    expect(parseDiagramReply(fail({ message: 42 }), ASKED)).toBeNull();
    expect(parseDiagramReply(fail({ message: "" }), ASKED)).toBeNull();
    const long = parseDiagramReply(fail({ message: "x".repeat(5000) }), ASKED);
    expect(long?.ok).toBe(false);
    expect(long?.ok === false ? long.message.length : 0).toBe(DIAGRAM_MESSAGE_MAX);
    expect(long?.ok === false ? long.message.endsWith("…") : false).toBe(true);
  });

  test("control characters never reach the screen (a forged sentence)", () => {
    const parsed = parseDiagramReply(fail({ message: "bad\u001b[31mred\u0007 line" }), ASKED);
    expect(parsed?.ok === false ? parsed.message : "").toBe("bad [31mred  line");
  });
});

describe("parseDiagramReply — not a message at all", () => {
  test("null, arrays, strings, numbers and a missing/garbled ok are dropped", () => {
    for (const junk of [
      null,
      undefined,
      [],
      "ok",
      42,
      {},
      { id: "r1" },
      { id: "r1", ok: "true" },
    ]) {
      expect(parseDiagramReply(junk, ASKED)).toBeNull();
    }
  });
});
