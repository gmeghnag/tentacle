import { describe, expect, test } from "bun:test";
import {
  BROWSER_EXTENSION_ID,
  BROWSER_EXTENSION_STORE_ID,
  browserExtensionIds,
  isExtensionId,
} from "../src/index.ts";

const STORE = "abcdefghijklmnopabcdefghijklmnop";

describe("extension ids: the dev (key-pinned) id and the Chrome Web Store id", () => {
  test("no store id yet → only the dev id", () => {
    expect(browserExtensionIds(undefined)).toEqual([BROWSER_EXTENSION_ID]);
  });

  test("a store id → dev id first, then the store id", () => {
    expect(browserExtensionIds(STORE)).toEqual([BROWSER_EXTENSION_ID, STORE]);
  });

  test("a store id equal to the dev id is listed once", () => {
    expect(browserExtensionIds(BROWSER_EXTENSION_ID)).toEqual([BROWSER_EXTENSION_ID]);
  });

  test("a malformed store id is refused loudly, never dropped", () => {
    expect(() => browserExtensionIds("not-an-id")).toThrow(/BROWSER_EXTENSION_STORE_ID/);
    expect(() => browserExtensionIds("ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP")).toThrow();
    expect(() => browserExtensionIds(`${STORE}q`)).toThrow();
  });

  test("an extension id is 32 letters a–p (Chrome's alphabet)", () => {
    expect(isExtensionId(BROWSER_EXTENSION_ID)).toBe(true);
    expect(isExtensionId(STORE)).toBe(true);
    expect(isExtensionId("qbcdefghijklmnopabcdefghijklmnop")).toBe(false);
    expect(isExtensionId("")).toBe(false);
  });

  // The owner pastes the store-assigned id into link-schema.ts after the first
  // upload: this pins that the paste is a real, distinct id.
  test("the shipped store id is unset, or a valid id different from the dev id", () => {
    if (BROWSER_EXTENSION_STORE_ID !== undefined) {
      expect(isExtensionId(BROWSER_EXTENSION_STORE_ID)).toBe(true);
      expect(BROWSER_EXTENSION_STORE_ID).not.toBe(BROWSER_EXTENSION_ID);
    }
    expect(browserExtensionIds()[0]).toBe(BROWSER_EXTENSION_ID);
  });
});
