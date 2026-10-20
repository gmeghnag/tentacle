import { describe, expect, test } from "bun:test";
import {
  PermissionBroker,
  type PermissionRequest,
  type PermissionResponse,
} from "../src/permission.ts";

const req = (title: string): PermissionRequest => ({
  tool: "shell",
  level: "ask",
  title,
  input: {},
});
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("PermissionBroker", () => {
  test("default: approves with allowAll until a requester is set (headless, in-process)", async () => {
    expect(await new PermissionBroker().request(req("a"))).toEqual({ allowed: true });
  });

  test("passes the signal through to the requester", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const broker = new PermissionBroker(async (_r, options) => {
      seen.push(options?.signal);
      return { allowed: false };
    });
    const controller = new AbortController();
    await broker.request(req("a"), { signal: controller.signal });
    expect(seen).toEqual([controller.signal]);
  });
});

describe("PermissionBroker holdUntilSet (an RPC client's broker)", () => {
  test("holds a request made before any requester, then hands it to the first one set", async () => {
    // Mutation: drop the hold (default allowAll) → resolves {allowed:true} at once.
    const broker = new PermissionBroker(undefined, { holdUntilSet: true });
    let settled: PermissionResponse | undefined;
    void broker.request(req("early")).then((r) => {
      settled = r;
    });
    await tick();
    expect(settled).toBeUndefined();
    const asked: string[] = [];
    broker.setRequester(async (r) => {
      asked.push(r.title);
      return { allowed: true, scope: "once" };
    });
    await tick();
    expect(asked).toEqual(["early"]);
    expect(settled).toEqual({ allowed: true, scope: "once" });
  });

  test("reset() holds again (the TUI unmounted), it does not approve", async () => {
    const broker = new PermissionBroker(undefined, { holdUntilSet: true });
    broker.setRequester(async () => ({ allowed: false }));
    broker.reset();
    let settled = false;
    void broker.request(req("between")).then(() => {
      settled = true;
    });
    await tick();
    expect(settled).toBe(false);
    broker.setRequester(async () => ({ allowed: false }));
    await tick();
    expect(settled).toBe(true);
  });

  test("a held request whose signal aborts is dropped (dismissed), never handed over", async () => {
    const broker = new PermissionBroker(undefined, { holdUntilSet: true });
    const controller = new AbortController();
    const p = broker.request(req("withdrawn"), { signal: controller.signal });
    controller.abort();
    expect(await p).toEqual({ allowed: false, dismissed: true });
    const asked: string[] = [];
    broker.setRequester(async (r) => {
      asked.push(r.title);
      return { allowed: true };
    });
    await tick();
    expect(asked).toEqual([]);
  });

  test("an already-aborted signal is dismissed at once", async () => {
    const broker = new PermissionBroker(undefined, { holdUntilSet: true });
    const controller = new AbortController();
    controller.abort();
    expect(await broker.request(req("x"), { signal: controller.signal })).toEqual({
      allowed: false,
      dismissed: true,
    });
  });

  test("held requests drain in order", async () => {
    const broker = new PermissionBroker(undefined, { holdUntilSet: true });
    void broker.request(req("1"));
    void broker.request(req("2"));
    const asked: string[] = [];
    broker.setRequester(async (r) => {
      asked.push(r.title);
      return { allowed: false };
    });
    await tick();
    expect(asked).toEqual(["1", "2"]);
  });
});
