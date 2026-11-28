/**
 * docs/fix/mobile-fluidity-e2e.md (flow 34): the e2e harness's laptop requester.
 * A withdrawn ask must not linger, and `laptop-prompt … answer=X` answers the
 * asks of ITS turn, whenever they arrive — never another turn's.
 */
import { describe, expect, test } from "bun:test";
import { DISMISSED, type PermissionRequest, type PermissionResponse } from "@tentacle/core";
import { createLaptopAnswerer } from "../e2e/laptop-answerer.ts";

const ALLOWED = { allowed: true, scope: "once" } as const;
const ask = (tool: string, title = tool): PermissionRequest => ({
  tool,
  title,
  level: "ask",
  input: {},
});
const make = () => createLaptopAnswerer();

/** The ask's answer so far (`undefined`: still held). */
function watch(promise: Promise<PermissionResponse>): () => PermissionResponse | undefined {
  let value: PermissionResponse | undefined;
  void promise.then((response) => {
    value = response;
  });
  return () => value;
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Flow 10's leftover: the phone answered, so the laptop's copy is withdrawn. */
async function withdrawn(answerer: ReturnType<typeof make>) {
  const controller = new AbortController();
  const read = watch(
    answerer.requester(ask("fs_write"), { signal: controller.signal, turnId: "turn-10" }),
  );
  controller.abort();
  await settle();
  return read;
}

describe("the harness's laptop answerer", () => {
  test("(a) a withdrawn ask leaves no pending entry and settles as dismissed", async () => {
    const answerer = make();
    const read = await withdrawn(answerer);
    expect(answerer.pendingCount()).toBe(0);
    expect(read()).toEqual(DISMISSED);
  });

  test("(a) an ask already withdrawn when it arrives is never held", async () => {
    const answerer = make();
    const controller = new AbortController();
    controller.abort();
    const read = watch(answerer.requester(ask("fs_write"), { signal: controller.signal }));
    await settle();
    expect(answerer.pendingCount()).toBe(0);
    expect(read()).toEqual(DISMISSED);
  });

  test("(b) with a stale ask, the turn's ask arriving AFTER the hook returned is answered", async () => {
    const answerer = make();
    await withdrawn(answerer);
    answerer.answerTurn("turn-34", "allow");
    const read = watch(answerer.requester(ask("schedule_create"), { turnId: "turn-34" }));
    await settle();
    expect(read()).toEqual(ALLOWED);
    expect(answerer.pendingCount()).toBe(0);
  });

  test("every later ask of that turn is answered too, with the registered answer", async () => {
    const answerer = make();
    answerer.answerTurn("t", "deny");
    const first = watch(answerer.requester(ask("fs_write"), { turnId: "t" }));
    const second = watch(answerer.requester(ask("shell"), { turnId: "t" }));
    await settle();
    expect(first()).toEqual({ allowed: false });
    expect(second()).toEqual({ allowed: false });
  });

  test("an ask of the turn already pending is answered at registration", async () => {
    const answerer = make();
    const read = watch(answerer.requester(ask("fs_write"), { turnId: "t" }));
    answerer.answerTurn("t", "allow");
    await settle();
    expect(read()).toEqual(ALLOWED);
  });

  test("(c) another turn's ask, and one with no turnId, are not answered", async () => {
    const answerer = make();
    answerer.answerTurn("mine", "allow");
    const other = watch(answerer.requester(ask("fs_write"), { turnId: "other" }));
    const anonymous = watch(answerer.requester(ask("fs_write", "no turn")));
    await settle();
    expect(other()).toBeUndefined();
    expect(anonymous()).toBeUndefined();
    expect(answerer.pendingCount()).toBe(2);
  });

  test("a released registration answers no late ask", async () => {
    const answerer = make();
    const release = answerer.answerTurn("t", "allow");
    release();
    const read = watch(answerer.requester(ask("shell"), { turnId: "t" }));
    await settle();
    expect(read()).toBeUndefined();
  });

  test("(d) answerAll answers every LIVE ask, identical ones included, and no withdrawn one", async () => {
    const answerer = make();
    const stale = await withdrawn(answerer);
    const one = watch(answerer.requester(ask("shell"), { turnId: "a" }));
    const two = watch(answerer.requester(ask("shell"), { turnId: "b" }));
    answerer.answerAll("allow");
    await settle();
    expect(one()).toEqual(ALLOWED);
    expect(two()).toEqual(ALLOWED);
    expect(stale()).toEqual(DISMISSED);
    expect(answerer.pendingCount()).toBe(0);
  });
});
