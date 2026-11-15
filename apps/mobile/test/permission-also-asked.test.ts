/**
 * docs/feat/session-auto-accept.md T6 (phone side): "Also asked on <computer>".
 * The pure rule drops ONE copy of this device's own label; the labels are
 * sanitized before they are shown (a pod could forge one). Mutation: never drop
 * the own label → the sheet names the device you are holding.
 */
import { describe, expect, test } from "bun:test";
import { otherDevicesAsked } from "@tentacle/core";
import type { PermissionRequest } from "@tentacle/core";
import { createPermissionSheet } from "../src/permission-sheet.ts";

function ask(over: Partial<PermissionRequest> = {}): PermissionRequest {
  return { tool: "fs_write", level: "ask", title: "Write", input: {}, ...over };
}

const own = { askedOn: ["iPhone", "laptop", "iPhone"] };

describe("otherDevicesAsked", () => {
  test("drops exactly ONE copy of the own label, keeping the rest in order", () => {
    expect(otherDevicesAsked(own.askedOn, "iPhone")).toEqual(["laptop", "iPhone"]);
  });

  test("no own label (a client that never sent one) drops nothing; absent drops nothing", () => {
    expect(otherDevicesAsked(["laptop"], undefined)).toEqual(["laptop"]);
    expect(otherDevicesAsked(undefined, "iPhone")).toEqual([]);
    expect(otherDevicesAsked([], "iPhone")).toEqual([]);
  });

  test("a label the device does not own stays", () => {
    expect(otherDevicesAsked(["laptop"], "iPhone")).toEqual(["laptop"]);
  });
});

describe("the sheet's alsoAsked note", () => {
  function sheetWith(ownHost: string | undefined, askedOn: readonly string[] | undefined) {
    const sheet = createPermissionSheet({
      now: () => 1000,
      ...(ownHost === undefined ? {} : { ownHost: () => ownHost }),
    });
    void sheet.requester(ask(), {
      ...(askedOn === undefined ? {} : { askedOn }),
    } as never);
    return sheet;
  }

  test("the sheet shows the siblings, never this phone", async () => {
    const sheet = sheetWith("iPhone", ["iPhone", "laptop"]);
    await Promise.resolve();
    const state = sheet.view();
    if (state.kind !== "asking") throw new Error("not asking");
    expect(state.alsoAsked).toEqual(["laptop"]);
  });

  test("the labels are stripped and bounded (a pod's text)", async () => {
    const sheet = sheetWith("iPhone", [
      "iPhone",
      "la\u001b[2Jptop-name-that-is-far-too-long-to-show",
    ]);
    await Promise.resolve();
    const state = sheet.view();
    if (state.kind !== "asking") throw new Error("not asking");
    expect(state.alsoAsked).toHaveLength(1);
    const [label] = state.alsoAsked;
    expect(label).not.toContain("\u001b");
    expect((label ?? "").length).toBeLessThanOrEqual(40);
  });

  test("nothing named → an empty note, and the ask is unchanged", async () => {
    const sheet = sheetWith(undefined, undefined);
    await Promise.resolve();
    const state = sheet.view();
    if (state.kind !== "asking") throw new Error("not asking");
    expect(state.alsoAsked).toEqual([]);
  });
});
