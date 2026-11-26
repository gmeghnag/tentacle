/**
 * docs/feat/a2a.md slice S5: which ask kinds an external caller (A2A / MCP)
 * may ever answer. Mutation: mark `workflow_approve` (or any lasting kind)
 * `once` → red.
 *
 * docs/feat/a2a-client.md C6/C11 (a2c-4): a remote agent's `question` and a
 * model-proposed `agent_add` are owner-only and NEVER auto-accepted.
 * Mutation: let auto-accept answer `question` (or `agent_add`) → red.
 */
import { describe, expect, test } from "bun:test";
import {
  EXTERNAL_ANSWER,
  type PermissionKind,
  type PermissionRequest,
  autoApproves,
  externalMayAnswer,
  onceOnlyAsk,
} from "../src/permission.ts";

describe("external answer table", () => {
  test("only a tool ask is caller-answerable; every lasting kind is owner-only", () => {
    expect(EXTERNAL_ANSWER).toEqual({
      tool: "once",
      hooks_trust: "owner-only",
      session_hop: "owner-only",
      workflow_approve: "owner-only",
      browser_action: "owner-only",
      question: "owner-only",
      agent_add: "owner-only",
      app_publish: "owner-only",
      container_preview: "owner-only",
    });
    const kinds = Object.keys(EXTERNAL_ANSWER) as PermissionKind[];
    expect(kinds.filter((k) => externalMayAnswer(k))).toEqual(["tool"]);
  });

  test("an unknown (unmapped) kind is never answerable", () => {
    expect(externalMayAnswer(undefined)).toBe(false);
  });
});

const req = (kind: PermissionKind): PermissionRequest => ({
  kind,
  tool: "a2a:acme",
  level: "ask",
  title: "acme asks",
  input: {},
});

// docs/feat/session-apps-publish.md D3: publishing a page to the public internet.
// Mutations: drop `app_publish` from `onceOnlyAsk`, or let `autoApproves` accept
// it → red.
describe("app_publish (session apps D3)", () => {
  test("auto-accept never answers it, even on its own turn", () => {
    expect(autoApproves(req("app_publish"), true)).toBe(false);
    expect(autoApproves(req("app_publish"))).toBe(false);
  });

  test("once-only: no «always» rule can ever be made", () => {
    expect(onceOnlyAsk(req("app_publish"))).toBe(true);
  });

  test("an external caller never answers it", () => {
    expect(externalMayAnswer("app_publish")).toBe(false);
  });
});

// docs/feat/container-apps-devices.md OD2: showing a container port to the
// paired devices. Mutations: drop it from `onceOnlyAsk`, or let `autoApproves`
// accept it → red.
describe("container_preview (container-apps-devices OD2)", () => {
  test("auto-accept never answers it, even on its own turn", () => {
    expect(autoApproves(req("container_preview"), true)).toBe(false);
    expect(autoApproves(req("container_preview"))).toBe(false);
  });

  test("once-only: no «always» rule can ever be made", () => {
    expect(onceOnlyAsk(req("container_preview"))).toBe(true);
  });

  test("an external caller never answers it", () => {
    expect(externalMayAnswer("container_preview")).toBe(false);
  });
});

describe("a2a-client kinds (C6/C11)", () => {
  test("auto-accept never answers a remote question or a proposed agent, even on its own turn", () => {
    expect(autoApproves(req("question"), true)).toBe(false);
    expect(autoApproves(req("agent_add"), true)).toBe(false);
    // The consent to SEND (C3) is an ordinary tool ask: auto mode answers it (A10).
    expect(autoApproves(req("tool"), true)).toBe(true);
  });

  test("agent_add is once-only (no «always»); a question is not a permission menu", () => {
    expect(onceOnlyAsk(req("agent_add"))).toBe(true);
    expect(onceOnlyAsk(req("question"))).toBe(false);
  });
});
