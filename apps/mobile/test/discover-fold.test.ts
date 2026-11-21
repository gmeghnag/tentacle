/**
 * The `daemon/discover` fold into one project record (docs/feat/mobile-projects.md
 * §6 "Address refresh", §3, F2/F8).
 */
import { describe, expect, test } from "bun:test";
import type { DaemonDiscovery } from "@tentacle/protocol";
import { discoveryPatch } from "../src/discover-fold.ts";

const OLD = "ws://192.168.1.20:4000/s/AAAAAAAAAAAAAAAAAAAAAA/e2e";
const NEW = "ws://192.168.1.31:4007/s/AAAAAAAAAAAAAAAAAAAAAA/e2e";
const RELAY = "wss://relay.example/d/AAAAAAAAAAAAAAAAAAAAAA/e2e";
const self = (addresses: string[], cwd = "/u/tentacle"): DaemonDiscovery => ({
  rev: 1,
  daemons: [{ cwd, addresses, startedAt: 5, self: true }],
});
const P = { key: "tentacle-aaaaaaaaaaaa", cwd: "/u/tentacle", label: "tentacle" };

describe("discoveryPatch", () => {
  test("self's new address comes first and the known ones are kept (F2; mutation: keep the stored list → red)", () => {
    const patch = discoveryPatch({ addresses: [OLD, RELAY], project: P }, self([NEW, RELAY]), 1);
    expect(patch?.addresses).toEqual([NEW, RELAY, OLD]);
    expect(patch?.project).toBeUndefined();
  });

  test("nothing changed → undefined (one write per change, never per dial)", () => {
    expect(
      discoveryPatch({ addresses: [OLD, RELAY], project: P }, self([OLD, RELAY]), 1),
    ).toBeUndefined();
  });

  test("a legacy record (no project) is named from self.cwd once (§3)", () => {
    const patch = discoveryPatch({ addresses: [OLD] }, self([OLD]), 1);
    expect(patch).toEqual({ project: { cwd: "/u/tentacle", label: "tentacle" } });
  });

  test("an older daemon (MethodNotFound → undefined) changes nothing (F8)", () => {
    expect(discoveryPatch({ addresses: [OLD] }, undefined, 1)).toBeUndefined();
  });

  test("a self of ANOTHER project is never folded into this record", () => {
    expect(
      discoveryPatch({ addresses: [OLD], project: P }, self([NEW], "/u/assistant"), 1),
    ).toBeUndefined();
  });
});
