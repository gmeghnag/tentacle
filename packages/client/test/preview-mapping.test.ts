/**
 * `previews` is session-level full state (docs/feat/container-apps-devices.md):
 * never a turn event, and never an `unsupported` notice on this build.
 */
import { describe, expect, test } from "bun:test";
import { updateToEvent } from "../src/mapping.ts";

describe("the previews update", () => {
  test("maps to no stream event", () => {
    expect(updateToEvent({ type: "previews", previews: [] }, new Map())).toBeNull();
  });
});
