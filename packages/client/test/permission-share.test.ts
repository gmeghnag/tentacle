/**
 * docs/feat/session-apps-container-ports.md: a `container_share` ask over the
 * wire — the daemon's options, and what the person's answer sends back. The
 * default approval is the secret link; public only by the explicit choice.
 * Mutation: map an approval to the first `allow_once` of any kind → public by
 * choice is lost.
 */
import { describe, expect, test } from "bun:test";
import { type PermissionResponse, autoApproves } from "@tentacle/core";
import { outcomeToResponse, toPermissionRequestUpdate } from "../../daemon/src/permission-map.ts";
import { PermissionRouter, toPermissionRequest } from "../src/permission-router.ts";

const update = toPermissionRequestUpdate("r1", "c1", {
  kind: "container_share",
  tool: "container_share",
  level: "ask",
  title: "Put it on the INTERNET?",
  input: {},
});

const answered = (response: PermissionResponse): string[] => {
  const router = new PermissionRouter();
  router.request("s", update);
  return router
    .answered("s", "r1", response)
    .flatMap((action) => (action.kind === "send" ? [action.optionId] : []));
};

describe("a container_share ask over the wire", () => {
  test("offers the secret link first, public second, never «always»", () => {
    expect(update.options.map((o) => [o.optionId, o.kind])).toEqual([
      ["share_link", "allow_once"],
      ["share_public", "allow_once"],
      ["reject_once", "reject_once"],
    ]);
    expect(update.options[1]?.name).toContain("PUBLIC");
    // A legacy auto-answer says `allow_once`: not offered, so it decides nothing.
    expect(update.options.some((o) => o.optionId === "allow_once")).toBe(false);
  });

  test("rebuilds as a container_share request, which auto-accept never answers", () => {
    const request = toPermissionRequest(update);
    expect(request.kind).toBe("container_share");
    expect(autoApproves(request)).toBe(false);
  });

  test("an approval is the secret link unless public was chosen", () => {
    expect(answered({ allowed: true, scope: "once" })).toEqual(["share_link"]);
    expect(answered({ allowed: true, scope: "session" })).toEqual(["share_link"]);
    expect(answered({ allowed: true, scope: "once", choice: "public" })).toEqual(["share_public"]);
    expect(answered({ allowed: false, choice: "public" })).toEqual(["reject_once"]);
  });

  test("the daemon reads each option back; only share_public is public", () => {
    const read = (optionId: string) => outcomeToResponse({ outcome: "selected", optionId });
    expect(read("share_link")).toEqual({ allowed: true, scope: "once" });
    expect(read("share_public")).toEqual({ allowed: true, scope: "once", choice: "public" });
    expect(read("reject_once")).toEqual({ allowed: false });
  });

  test("`choice` means nothing on any other ask", () => {
    const other = toPermissionRequestUpdate("r2", "c2", {
      tool: "shell",
      level: "ask",
      title: "t",
      input: {},
    });
    const router = new PermissionRouter();
    router.request("s", other);
    const sent = router.answered("s", "r2", { allowed: true, scope: "once", choice: "public" });
    expect(sent).toContainEqual(expect.objectContaining({ optionId: "allow_once" }));
  });
});
