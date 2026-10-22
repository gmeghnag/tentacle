import { describe, expect, test } from "bun:test";
import {
  compareVersions,
  laptopAsset,
  normalizeTag,
  planUpdate,
  tagFromLatestLocation,
} from "../src/update-plan.ts";

describe("compareVersions (semver precedence)", () => {
  test("orders core, pre-release and identifiers", () => {
    const ordered = [
      "0.1.0-alpha",
      "0.1.0-alpha.1",
      "0.1.0-alpha.beta",
      "0.1.0-beta.1",
      "0.1.0-beta.2",
      "0.1.0-beta.11",
      "0.1.0-rc.1",
      "0.1.0",
      "0.1.1",
      "0.2.0",
      "0.10.0",
      "1.0.0",
    ];
    for (let i = 0; i < ordered.length; i++) {
      for (let j = 0; j < ordered.length; j++) {
        expect(compareVersions(ordered[i] as string, ordered[j] as string)).toBe(Math.sign(i - j));
      }
    }
    expect(compareVersions("1.0.0+build.1", "1.0.0")).toBe(0);
  });
});

describe("tags and assets", () => {
  test("normalizeTag accepts v-prefixed or bare versions, rejects junk", () => {
    expect(normalizeTag("v0.4.0")).toEqual({ tag: "v0.4.0", version: "0.4.0" });
    expect(normalizeTag("0.1.0-beta.1")).toEqual({ tag: "v0.1.0-beta.1", version: "0.1.0-beta.1" });
    for (const bad of ["latest", "v1", "v1.2", "", "v1.2.3 4", "bun-v1.4.4"]) {
      expect(() => normalizeTag(bad)).toThrow(/not a release version/);
    }
  });

  test("tagFromLatestLocation reads the /releases/tag/<tag> redirect", () => {
    expect(tagFromLatestLocation("https://github.com/gmeghnag/tentacle/releases/tag/v0.4.0")).toBe(
      "v0.4.0",
    );
    expect(tagFromLatestLocation("https://github.com/x/y/releases")).toBeUndefined();
    expect(tagFromLatestLocation(null)).toBeUndefined();
  });

  test("laptopAsset names this machine's release file", () => {
    expect(laptopAsset("darwin", "arm64")).toBe("tentacle-bun-darwin-arm64");
    expect(laptopAsset("linux", "x64")).toBe("tentacle-bun-linux-x64");
    expect(() => laptopAsset("win32", "x64")).toThrow(/no tentacle release for win32\/x64/);
    expect(() => laptopAsset("linux", "ia32")).toThrow(/no tentacle release/);
  });
});

describe("planUpdate", () => {
  const pods = (x64: string | undefined, arm64: string | undefined) => ({
    "bun-linux-x64": x64,
    "bun-linux-arm64": arm64,
  });

  test("everything at the latest → current, nothing to do", () => {
    expect(
      planUpdate({
        current: "0.3.0",
        target: "0.3.0",
        explicit: false,
        pods: pods("0.3.0", "0.3.0"),
      }),
    ).toEqual({ self: null, podVersion: "0.3.0", podTargets: [], status: "current" });
  });

  test("a newer latest moves the CLI and both pods to it", () => {
    expect(
      planUpdate({
        current: "0.3.0",
        target: "0.4.0",
        explicit: false,
        pods: pods("0.3.0", "0.3.0"),
      }),
    ).toEqual({
      self: "0.4.0",
      podVersion: "0.4.0",
      podTargets: ["bun-linux-x64", "bun-linux-arm64"],
      status: "update",
    });
  });

  test("CLI current: missing, unknown or stale pods are filled in at the CLI's version (D1)", () => {
    expect(
      planUpdate({
        current: "0.3.0",
        target: "0.3.0",
        explicit: false,
        pods: pods(undefined, "0.2.0"),
      }),
    ).toEqual({
      self: null,
      podVersion: "0.3.0",
      podTargets: ["bun-linux-x64", "bun-linux-arm64"],
      status: "update",
    });
  });

  test("an older latest never downgrades implicitly (ahead); --version does", () => {
    expect(
      planUpdate({
        current: "0.5.0",
        target: "0.4.0",
        explicit: false,
        pods: pods("0.5.0", "0.5.0"),
      }),
    ).toEqual({ self: null, podVersion: "0.5.0", podTargets: [], status: "ahead" });
    expect(
      planUpdate({
        current: "0.5.0",
        target: "0.4.0",
        explicit: true,
        pods: pods("0.5.0", "0.5.0"),
      }),
    ).toEqual({
      self: "0.4.0",
      podVersion: "0.4.0",
      podTargets: ["bun-linux-x64", "bun-linux-arm64"],
      status: "update",
    });
  });

  test("ahead: stale pods are NOT fetched at the CLI's (possibly unreleased) version", () => {
    const plan = planUpdate({
      current: "0.5.0",
      target: "0.4.0",
      explicit: false,
      pods: pods("0.5.0", "0.4.0"),
    });
    expect(plan).toEqual({ self: null, podVersion: "0.5.0", podTargets: [], status: "ahead" });
  });
});
