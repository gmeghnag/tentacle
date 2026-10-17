import { expect, test } from "bun:test";
import { accentHex, theme } from "../src/theme.ts";

test("brand accent is the release cyan, single-sourced", () => {
  expect(accentHex).toBe("#06b6d4");
  expect(typeof theme.accent).toBe("function"); // chalk styler present
});
