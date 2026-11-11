import { describe, expect, test } from "bun:test";
import { hasDsmlToolCallMarkup } from "../src/dsml.ts";

const B = "\uFF5C";
const OPEN = `<${B}DSML${B} invoke>`;
const CLOSE = `</${B}DSML${B} invoke>`;
const PARAM = `<${B}DSML${B} parameter name="fs_write">`;

/**
 * The INCIDENT's own bytes, copied character for character from
 * `.tentacle/tmp/orchestration/runs/exec-history-validity.log` lines 773-778
 * (only the long base64 body is shortened). Note the shape: the prose prefix,
 * then the DSML block — and **no opening invoke tag at all**, only parameter
 * tags (each carrying attributes) and the closers. That is the shape the
 * matcher must recognise (docs/fix/deepseek-dsml-leak.md, Review HIGH-1).
 */
const INCIDENT = [
  "Base64 works reliably. Appending the rest.</｜DSML｜ parameter>",
  '<｜DSML｜ parameter name="fs_write">',
  '<｜DSML｜ parameter name="content" string="true">CiAgdGVzdCgiYW4gZW1w</｜DSML｜ parameter>',
  '<｜DSML｜ parameter name="path" string="true">/Users/gmeghnag/tentacle/.tentacle/worktrees/history-validity/packages/providers/test/p4.txt</｜DSML｜ parameter>',
  "</｜DSML｜ invoke>",
  "</｜DSML｜ calls>",
].join("\n");

/** The same block without the prose prefix. */
const BLOCK = INCIDENT.split("\n").slice(1).join("\n");

describe("hasDsmlToolCallMarkup", () => {
  test("recognises the INCIDENT's own bytes: no opening invoke tag, attributes on every tag", () => {
    // The premise: the log's reply really has no opening invoke tag.
    expect(INCIDENT.includes(OPEN)).toBe(false);
    expect(INCIDENT.includes(PARAM)).toBe(true);
    expect(INCIDENT.length).toBe(372);
    expect(hasDsmlToolCallMarkup(INCIDENT)).toBe(true);
    expect(hasDsmlToolCallMarkup(BLOCK)).toBe(true);
  });

  test("recognises the template's full block, an opening invoke WITH attributes", () => {
    expect(
      hasDsmlToolCallMarkup(`<${B}DSML${B} invoke name="fs_write">\n${PARAM}\nx\n${CLOSE}\n`),
    ).toBe(true);
    expect(hasDsmlToolCallMarkup(`Base64 works.\n${OPEN}\n${PARAM}\nx\n${CLOSE}\n`)).toBe(true);
  });

  test("ignores ordinary prose", () => {
    expect(hasDsmlToolCallMarkup("The write succeeded. Here is the plan.")).toBe(false);
  });

  test("ignores a bare mention of DSML", () => {
    expect(hasDsmlToolCallMarkup("DSML is a markup format DeepSeek uses.")).toBe(false);
    expect(hasDsmlToolCallMarkup(`${PARAM} only, no closing tag`)).toBe(false);
  });

  test("ignores an orphan closing tag on its own", () => {
    expect(hasDsmlToolCallMarkup(`${CLOSE}\n</${B}DSML${B} calls>`)).toBe(false);
  });

  test("ignores a TRUNCATED block (the next round replaces it)", () => {
    expect(hasDsmlToolCallMarkup(`${OPEN}\n${PARAM}\nunfinished`)).toBe(false);
    // Cut before its FIRST closer: the block never finished.
    expect(hasDsmlToolCallMarkup(BLOCK.slice(0, BLOCK.indexOf("</")))).toBe(false);
  });

  test("matches the incident text regardless of surrounding prose", () => {
    expect(hasDsmlToolCallMarkup(`line one\n${OPEN}\n${PARAM}\n${CLOSE}\nline three`)).toBe(true);
  });
});
