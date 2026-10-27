import { describe, expect, test } from "bun:test";
import {
  DomainErrorCode,
  Method,
  PermissionOutcomeSchema,
  PermissionRequestUpdateSchema,
  PermissionResolvedUpdateSchema,
  RequestSchemas,
  ResolvePermissionParamsSchema,
  ResolvePermissionResultSchema,
  SessionUpdateSchema,
  UPDATE_CLASS,
} from "../src/index.ts";

const request = {
  type: "permission_request",
  requestId: "r1",
  toolCallId: "t1",
  tool: "shell",
  title: "Run shell command",
  options: [{ optionId: "a", name: "Allow", kind: "allow_once" }],
};

describe("permission_request update", () => {
  test("accepts a request with at least one option, optional fields omitted", () => {
    expect(PermissionRequestUpdateSchema.safeParse(request).success).toBe(true);
    expect(
      PermissionRequestUpdateSchema.safeParse({
        ...request,
        explanation: "rm -rf build",
        suggestion: { prefix: "rm" },
      }).success,
    ).toBe(true);
  });

  test("rejects no options, an empty requestId, an empty toolCallId", () => {
    expect(PermissionRequestUpdateSchema.safeParse({ ...request, options: [] }).success).toBe(
      false,
    );
    expect(PermissionRequestUpdateSchema.safeParse({ ...request, requestId: "" }).success).toBe(
      false,
    );
    expect(PermissionRequestUpdateSchema.safeParse({ ...request, toolCallId: "" }).success).toBe(
      false,
    );
  });

  test("is a member of the update union, class blocking", () => {
    expect(SessionUpdateSchema.safeParse(request).success).toBe(true);
    expect(UPDATE_CLASS.permission_request).toBe("blocking");
  });

  test("agent (the asking sub-agent) is optional, kept, its unknown fields stripped, never length-capped", () => {
    // docs/feat/permission-call-attribution.md T8. Mutation: drop `agent` from
    // the schema → stripped from a parsed request → red.
    const agent = { type: "explore", description: "x".repeat(10_000) };
    const parsed = SessionUpdateSchema.parse({ ...request, agent: { ...agent, extra: 1 } });
    expect(parsed).toEqual({ ...request, agent } as typeof parsed);
    expect(SessionUpdateSchema.parse(request)).toEqual(request as typeof parsed);
    expect(
      PermissionRequestUpdateSchema.safeParse({ ...request, agent: { type: "explore" } }).success,
    ).toBe(false);
  });
});

describe("permission_resolved update", () => {
  test("carries a selected option or cancelled", () => {
    const base = { type: "permission_resolved", requestId: "r1" };
    expect(
      PermissionResolvedUpdateSchema.safeParse({
        ...base,
        outcome: { outcome: "selected", optionId: "a" },
      }).success,
    ).toBe(true);
    expect(
      PermissionResolvedUpdateSchema.safeParse({ ...base, outcome: { outcome: "cancelled" } })
        .success,
    ).toBe(true);
    expect(
      SessionUpdateSchema.safeParse({ ...base, outcome: { outcome: "cancelled" } }).success,
    ).toBe(true);
    expect(UPDATE_CLASS.permission_resolved).toBe("mandatory");
  });

  test("outcome: selected needs an optionId", () => {
    expect(PermissionOutcomeSchema.safeParse({ outcome: "selected" }).success).toBe(false);
  });
});

describe("session/resolve_permission", () => {
  test("params: sessionId, requestId, optionId (unknown fields stripped)", () => {
    const params = { sessionId: "s", requestId: "r1", optionId: "allow_once" };
    expect(ResolvePermissionParamsSchema.safeParse(params).success).toBe(true);
    expect(ResolvePermissionParamsSchema.safeParse({ ...params, optionId: "" }).success).toBe(
      false,
    );
    // An answer is an option; cancelling is the turn's own command: an
    // `outcome` field is stripped, never read.
    const extra = ResolvePermissionParamsSchema.safeParse({
      ...params,
      outcome: { outcome: "cancelled" },
    });
    expect(extra.success && extra.data).toEqual(params);
    expect(ResolvePermissionResultSchema.safeParse({}).success).toBe(true);
  });

  test("is registered; the old daemon→client request is gone", () => {
    expect(Method.ResolvePermission).toBe("session/resolve_permission");
    expect(RequestSchemas[Method.ResolvePermission].params).toBe(ResolvePermissionParamsSchema);
    expect(Object.values(Method)).not.toContain("session/request_permission");
  });

  test("PermissionNotPending is its own domain code", () => {
    expect(DomainErrorCode.PermissionNotPending).toBe(-32013);
  });
});
