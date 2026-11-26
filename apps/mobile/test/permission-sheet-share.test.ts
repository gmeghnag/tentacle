/**
 * The phone's answers to a `container_share` ask
 * (docs/feat/session-apps-container-ports.md): the secret link first and filled,
 * PUBLIC second and never filled, no «always».
 */
import { describe, expect, test } from "bun:test";
import type { PermissionRequest } from "@tentacle/core";
import { optionStyle, responseFor, sheetOptions } from "../src/permission-sheet.ts";

const ask: PermissionRequest = {
  kind: "container_share",
  tool: "container_share",
  level: "ask",
  title: "Put it on the INTERNET?",
  input: {},
};

describe("a container_share ask on the phone", () => {
  test("secret link, public, no: in that order, never «always»", () => {
    expect(sheetOptions(ask).map((o) => [o.optionId, o.label])).toEqual([
      ["allow_once", "Share with a secret link"],
      ["share_public", "Share PUBLICLY: anyone with the address"],
      ["reject_once", "No"],
    ]);
  });

  test("only the public button answers public", () => {
    expect(responseFor("allow_once", "", "container_share")).toEqual({
      allowed: true,
      scope: "once",
    });
    expect(responseFor("share_public", "", "container_share")).toEqual({
      allowed: true,
      scope: "once",
      choice: "public",
    });
  });

  test("public is never the filled (default) button", () => {
    expect(optionStyle("allow_once").pill).toBe("primary");
    expect(optionStyle("share_public").pill).toBe("secondary");
  });
});
