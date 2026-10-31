import { describe, expect, test } from "bun:test";
import { DISMISSED, type PermissionRequest } from "@tentacle/core";
import { relayPolicy } from "../src/relay-policy.ts";
import type { RelayEvent } from "../src/relay-state.ts";

const ask: PermissionRequest = { tool: "shell", level: "ask", title: "run ls", input: {} };

function rig(autoAccept: boolean) {
  const events: RelayEvent[] = [];
  const lines: string[] = [];
  const policy = relayPolicy({
    autoAccept,
    emit: (event) => events.push(event),
    log: (line) => lines.push(line),
  });
  return { policy, events, lines };
}

describe("relay policy (docs/feat/detached-relay.md R1-R3)", () => {
  test("R1 off: the ask is held, nothing answered until it is withdrawn", async () => {
    // Mutation: answer `allowed: true` → resolved before the abort.
    const { policy, events } = rig(false);
    policy.bindOwnsTurn(() => true);
    const controller = new AbortController();
    let settled = false;
    const answer = policy.requester(ask, { signal: controller.signal, turnId: "t" }).then((r) => {
      settled = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(settled).toBe(false);
    expect(events).toEqual([{ type: "ask_raised", tool: "shell" }]);
    controller.abort();
    expect(await answer).toBe(DISMISSED);
    expect(events).toEqual([{ type: "ask_raised", tool: "shell" }, { type: "ask_gone" }]);
  });

  test("R1 an ask already withdrawn is never raised", async () => {
    const { policy, events } = rig(false);
    expect(await policy.requester(ask, { signal: AbortSignal.abort() })).toBe(DISMISSED);
    expect(events).toEqual([]);
  });

  test("R2 on: allow once, one sanitised log line, nothing raised", async () => {
    // Mutation: `scope: "session"` → a lasting approval from a pod's ask.
    const { policy, events, lines } = rig(true);
    policy.bindOwnsTurn(() => true);
    const response = await policy.requester(
      { ...ask, title: "run \u001b[31mls", detail: "evil\nline" },
      { turnId: "t" },
    );
    expect(response).toEqual({ allowed: true, scope: "once" });
    expect(events).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("auto-accepted");
    expect(lines[0]).toContain("shell");
    expect(lines[0]).not.toContain("\u001b");
    expect(lines[0]).not.toContain("evil\nline");
  });

  test("R3 auto-accept never answers a hooks trust ask", async () => {
    // Mutation: pass `own = true` / drop `autoApproves` → answered.
    const { policy, events } = rig(true);
    policy.bindOwnsTurn(() => true);
    const controller = new AbortController();
    void policy.requester(
      { ...ask, kind: "hooks_trust" },
      { signal: controller.signal, turnId: "t" },
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(events).toEqual([{ type: "ask_raised", tool: "shell" }]);
    controller.abort();
  });

  test("R3 auto-accept never answers a foreign turn, or a turn before the session is bound", async () => {
    const { policy, events } = rig(true);
    const controller = new AbortController();
    // Not bound yet: `ownRequest` with no test would say "mine".
    void policy.requester(ask, { signal: controller.signal, turnId: "mine" });
    await new Promise((r) => setTimeout(r, 5));
    policy.bindOwnsTurn((turnId) => turnId === "mine");
    void policy.requester(ask, { signal: controller.signal, turnId: "theirs" });
    void policy.requester(ask, { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 5));
    expect(events.filter((e) => e.type === "ask_raised")).toHaveLength(3);
    controller.abort();
  });
});
