/**
 * Which address to dial (docs/feat/mobile-pairing-screen.md 11b.1, Tests).
 * The two load-bearing rules: a terminal `unauthorized` STOPS the loop, and the
 * loop starts at the address that answered last.
 */
import { describe, expect, test } from "bun:test";
import { ChannelError } from "@tentacle/client";
import { type DialMemory, firstAnswering, isTerminalDialError } from "../src/address-dial.ts";

const A = "ws://a.local:4001/e2e";
const B = "ws://b.local:4001/e2e";
const C = "ws://c.local:4001/e2e";
const memory = (lastGood?: number): DialMemory => ({ lastGood });

describe("firstAnswering", () => {
  test("tries the addresses in order and stops at the first that answers", async () => {
    const tried: string[] = [];
    const answer = await firstAnswering(
      [A, B, C],
      async (address) => {
        tried.push(address);
        if (address !== B) {
          throw new ChannelError("unreachable", "no route");
        }
        return "b";
      },
      memory(),
    );
    expect(answer).toBe("b");
    expect(tried).toEqual([A, B]);
  });

  test("starts at the remembered good address (and wraps)", async () => {
    const tried: string[] = [];
    const mem = memory(2);
    await firstAnswering(
      [A, B, C],
      async (address) => {
        tried.push(address);
        if (address === A) {
          return "a";
        }
        throw new ChannelError("unreachable", "no route");
      },
      mem,
    );
    // C first (last known good), then wraps to A: the order is a ring, not a restart.
    expect(tried).toEqual([C, A]);
    // A answered, so IT is remembered now.
    expect(mem.lastGood).toBe(0);
  });

  test("a stale memory (more addresses than it knows) starts at 0", async () => {
    const tried: string[] = [];
    await firstAnswering(
      [A],
      async (address) => {
        tried.push(address);
        return "a";
      },
      memory(9),
    );
    expect(tried).toEqual([A]);
  });

  test("STOPS on unauthorized without dialling the next (mutation: continue → red)", async () => {
    const tried: string[] = [];
    const denied = new ChannelError("unauthorized", "the daemon refused this device");
    const caught = await firstAnswering(
      [A, B, C],
      async (address) => {
        tried.push(address);
        throw denied;
      },
      memory(),
    ).catch((error: unknown) => error);
    expect(caught).toBe(denied);
    // The property: a second address was NEVER dialled.
    expect(tried).toEqual([A]);
  });

  test("falls through on every other failure and throws the LAST one", async () => {
    const failures = [
      new ChannelError("unreachable", "first"),
      new ChannelError("rejected", "second"),
      new Error("third"),
    ];
    const tried: string[] = [];
    const caught = await firstAnswering(
      [A, B, C],
      async (address) => {
        tried.push(address);
        const index = [A, B, C].indexOf(address);
        throw failures[index];
      },
      memory(),
    ).catch((error: unknown) => error);
    // Every address was tried, and the LAST error is rethrown UNCHANGED: the link
    // machine and `describeError` classify an error by its own kind, so wrapping
    // it would hide exactly what they read.
    expect(tried).toEqual([A, B, C]);
    expect(caught).toBe(failures[2]);
  });

  test("no addresses at all is a failure, not a hang", async () => {
    const caught = await firstAnswering([], async () => "x", memory()).catch(
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(ChannelError);
    expect((caught as ChannelError).kind).toBe("unreachable");
  });

  test("isTerminalDialError: only unauthorized", () => {
    expect(isTerminalDialError(new ChannelError("unauthorized", "x"))).toBe(true);
    expect(isTerminalDialError(new ChannelError("unreachable", "x"))).toBe(false);
    expect(isTerminalDialError(new ChannelError("rejected", "x"))).toBe(false);
    expect(isTerminalDialError(new ChannelError("gone", "x"))).toBe(false);
    expect(isTerminalDialError(new Error("x"))).toBe(false);
  });
});
