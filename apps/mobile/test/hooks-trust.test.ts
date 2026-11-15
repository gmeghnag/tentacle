/**
 * The phone's project-hooks trust (docs/feat/serve-mcp.md S4, owner Q2=a): a
 * `hooks_trust` ask reaches a PERSON through the link broker, auto-accept never
 * answers it, and nothing is stored from the phone.
 */
import { describe, expect, test } from "bun:test";
import type { PermissionBroker, PermissionRequest } from "@tentacle/core";
import type { HooksTrustParams } from "@tentacle/protocol";
import { phoneHooksTrust, phoneHooksTrustDetail } from "../src/hooks-trust.ts";

const params = (over: Partial<HooksTrustParams> = {}): HooksTrustParams => ({
  sessionId: "s-1",
  folder: "/work/proj",
  hash: "h-1",
  hooks: [{ event: "turn_start", command: "make fmt" }],
  files: [".agents/hooks.json"],
  canAllow: false,
  ...over,
});

/** A broker whose one requester records the ask and answers as told. */
function broker(answer: { allowed: boolean; dismissed?: true }) {
  const asked: PermissionRequest[] = [];
  const instance = {
    request: async (request: PermissionRequest) => {
      asked.push(request);
      return answer;
    },
  } as unknown as PermissionBroker;
  return { broker: instance, asked };
}

describe("phoneHooksTrust", () => {
  test("raises a hooks_trust ask with the folder as its detail", async () => {
    const { broker: link, asked } = broker({ allowed: true });
    const trusted = await phoneHooksTrust(link)(params());
    expect(trusted).toEqual({ trusted: true });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.kind).toBe("hooks_trust");
    expect(asked[0]?.title).toContain("hooks");
    expect(asked[0]?.detail).toContain("/work/proj");
    expect(asked[0]?.detail).toContain("make fmt");
    // Never "always": a phone cannot store a decision for another host's folder.
    expect((asked[0]?.input as { storeBacked?: boolean } | undefined)?.storeBacked).toBe(false);
  });

  test("a deny means the hooks do not run", async () => {
    const { broker: link } = broker({ allowed: false });
    expect(await phoneHooksTrust(link)(params())).toEqual({ trusted: false });
  });

  test("a dismissed prompt (no human answered) is not a trust", async () => {
    const { broker: link } = broker({ allowed: true, dismissed: true });
    // Mutation: `allowed` alone → this answers `trusted: true` for nobody's answer.
    expect(await phoneHooksTrust(link)(params())).toEqual({ trusted: false });
  });
});

describe("phoneHooksTrustDetail", () => {
  test("names the folder, each hook, the files and the can-allow warning", () => {
    const detail = phoneHooksTrustDetail(
      params({
        hooks: [
          { event: "tool_call", matcher: "Bash", command: "guard.sh" },
          { event: "turn_end", command: "notify", model: "small" },
        ],
        canAllow: true,
      }),
    );
    expect(detail.split("\n")[0]).toBe("/work/proj");
    expect(detail).toContain("tool_call Bash → guard.sh");
    expect(detail).toContain("turn_end → notify (model: small)");
    expect(detail).toContain("from .agents/hooks.json");
    expect(detail).toContain("approve tool calls without asking");
  });
});
