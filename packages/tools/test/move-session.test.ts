/**
 * `move_session` (docs/feat/session-hop.md D9, slice H5): the tool the agent is
 * offered so it can PROPOSE moving its session. Its whole contract is that it
 * decides nothing and builds nothing — it validates its own input and answers one
 * sentence telling the model not to assume the move happened. The laptop asks the
 * owner at the turn's end.
 */
import { describe, expect, test } from "bun:test";
import {
  MOVE_SESSION_DECLINED_HINT,
  MOVE_SESSION_DESCRIPTION,
  MOVE_SESSION_PROPOSED,
  MOVE_SESSION_TOOL_NAME,
  createMoveSessionTool,
} from "../src/move-session.ts";

const tool = createMoveSessionTool();
const ctx = {} as never;

const run = (input: unknown) => tool.execute(input as never, ctx);

describe("H5: the `move_session` tool", () => {
  test("it is named, it is not a permission ask, and it runs alone", () => {
    expect(tool.name).toBe(MOVE_SESSION_TOOL_NAME);
    expect(MOVE_SESSION_TOOL_NAME).toBe("move_session");
    // No daemon-side effect exists to authorize: the ask is the LAPTOP's prompt
    // at the turn's end (D9), through its broker — never a tool permission here.
    expect(tool.permission).toBe("none");
    // It must never be grouped with another call (docs/feat/parallel-tools.md):
    // a proposal is one turn's fact, and a group would let a sibling rewrite it.
    expect(tool.concurrency).toBe("exclusive");
  });

  test("its description says it only PROPOSES, and never claims the move", () => {
    expect(MOVE_SESSION_DESCRIPTION.toLowerCase()).toContain("propose");
    expect(MOVE_SESSION_DESCRIPTION).toContain("Do not assume the move happened");
    // The three targets it can propose, so the model does not invent a fourth.
    expect(MOVE_SESSION_DESCRIPTION).toContain("local");
    expect(MOVE_SESSION_DESCRIPTION).toContain("container");
    expect(MOVE_SESSION_DESCRIPTION).toContain("attach");
    // It is a `container` with an image; never `kubernetes` by name (attach only).
    expect(MOVE_SESSION_DESCRIPTION).not.toContain("kubernetes");
  });

  test("a local move is accepted, and the answer forbids assuming it happened", async () => {
    const result = await run({ target: "local", reason: "the build needs my machine" });
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe(MOVE_SESSION_PROPOSED);
    expect(result.content).toContain("Do not assume the move happened");
  });

  test("a container move carries its image and keep, and is accepted", async () => {
    const result = await run({
      target: "container",
      image: "ghcr.io/tentacle/pod:1.2.3",
      keep: false,
      reason: "run the tests in the image",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe(MOVE_SESSION_PROPOSED);
  });

  test("an attach move names the workload and is accepted", async () => {
    const result = await run({
      target: "attach",
      workload: { engine: "docker", name: "box" },
      reason: "the box already has the deps",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe(MOVE_SESSION_PROPOSED);
  });

  test("a k8s attach takes a container; docker has none", async () => {
    const k8s = await run({
      target: "attach",
      workload: { engine: "kubernetes", name: "web-0", container: "app" },
    });
    expect(k8s.isError).toBeUndefined();
    const docker = await run({
      target: "attach",
      workload: { engine: "docker", name: "box", container: "app" },
    });
    expect(docker.isError).toBe(true);
  });

  test("a malformed input is refused by the SCHEMA, and the model is told why", async () => {
    // The tool never sees a bad input in production (the loop validates first),
    // but its own `execute` must not answer "proposed" to one either: a direct
    // caller (a registry without the loop) gets an honest error.
    const bad = await run({ target: "nowhere" });
    expect(bad.isError).toBe(true);
    expect(bad.content).not.toBe(MOVE_SESSION_PROPOSED);
    if (bad.isError === true) {
      expect(bad.content).toContain("target");
    }
  });

  test("an attach with no workload is refused", async () => {
    const result = await run({ target: "attach" });
    expect(result.isError).toBe(true);
  });

  test("a workload name that an engine could not accept is refused here too", async () => {
    for (const name of ["", "bad name", "a:b", "../x", "a/b"]) {
      const result = await run({ target: "attach", workload: { engine: "docker", name } });
      expect(result.isError).toBe(true);
    }
  });

  test("a `reason` is capped, so a pod cannot paste a page into the owner's prompt", async () => {
    const result = await run({ target: "local", reason: "x".repeat(5_000) });
    expect(result.isError).toBe(true);
  });

  test("the declined hint is one line about a move the owner refused", () => {
    expect(MOVE_SESSION_DECLINED_HINT).toContain("move declined");
  });

  test("its input schema is the one the model is offered", () => {
    // The definition is derived from `inputSchema`; a tool with no schema would
    // offer the model nothing to fill in (docs/feat/tool-schemas.md pattern).
    const schema = tool.inputSchema as unknown as { safeParse(v: unknown): { success: boolean } };
    expect(schema.safeParse({ target: "local" }).success).toBe(true);
    expect(schema.safeParse({ target: "local", image: "x" }).success).toBe(false);
  });
});
