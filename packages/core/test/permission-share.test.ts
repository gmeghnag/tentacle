/**
 * docs/feat/session-apps-container-ports.md OD1: putting a port on the internet
 * is asked every time and answered by a person only.
 */
import { describe, expect, test } from "bun:test";
import {
  EXTERNAL_ANSWER,
  type PermissionRequest,
  autoApproves,
  externalMayAnswer,
  onceOnlyAsk,
} from "../src/permission.ts";

const ask: PermissionRequest = {
  kind: "container_share",
  tool: "container_share",
  level: "ask",
  title: "Put it on the INTERNET?",
  input: {},
};

describe("a container_share ask", () => {
  test("is never answered by auto-accept", () => {
    expect(autoApproves(ask)).toBe(false);
    expect(autoApproves(ask, true)).toBe(false);
  });

  test("is once-only", () => {
    expect(onceOnlyAsk(ask)).toBe(true);
  });

  test("is the owner's alone", () => {
    expect(EXTERNAL_ANSWER.container_share).toBe("owner-only");
    expect(externalMayAnswer("container_share")).toBe(false);
  });
});
