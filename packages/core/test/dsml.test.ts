import { describe, expect, test } from "bun:test";
import { hasDsmlToolCallMarkup } from "../src/dsml.ts";

const B = "\uFF5C";
const OPEN = `<${B}DSML${B} invoke>`;
const CLOSE = `</${B}DSML${B} invoke>`;
const PARAM = `<${B}DSML${B} parameter name="fs_write">`;

describe("hasDsmlToolCallMarkup", () => {
  test("recognises a whole DSML tool-call block", () => {
    expect(hasDsmlToolCallMarkup(`Base64 works.\n${OPEN}\n${PARAM}\nx\n${CLOSE}\n`)).toBe(true);
  });

  test("ignores ordinary prose", () => {
    expect(hasDsmlToolCallMarkup("The write succeeded. Here is the plan.")).toBe(false);
  });

  test("ignores a bare mention of DSML", () => {
    expect(hasDsmlToolCallMarkup("DSML is a markup format DeepSeek uses.")).toBe(false);
    expect(hasDsmlToolCallMarkup(`${PARAM} only, no invoke`)).toBe(false);
  });

  test("ignores a TRUNCATED block (the next round replaces it)", () => {
    expect(hasDsmlToolCallMarkup(`${OPEN}\n${PARAM}\nunfinished`)).toBe(false);
  });

  test("matches the incident text regardless of surrounding prose", () => {
    expect(hasDsmlToolCallMarkup(`line one\n${OPEN}\n${PARAM}\n${CLOSE}\nline three`)).toBe(true);
  });
});
