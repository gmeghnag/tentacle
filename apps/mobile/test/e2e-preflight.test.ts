/** The harness preflight parser (docs/feat/mobile-app-shell.md "Tests"). */
import { describe, expect, test } from "bun:test";
import {
  type PreflightInput,
  availableIosMajors,
  missingText,
  parseRuntimes,
  preflight,
} from "../e2e/preflight.ts";
import { firstDevice, parseArgs } from "../e2e/run.ts";

/** Today's machine: Maestro + Xcode + CocoaPods present, only the iOS 26 runtime. */
const TODAY = JSON.stringify({
  runtimes: [
    {
      identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
      name: "iOS 26.5",
      version: "26.5",
      isAvailable: true,
    },
    {
      identifier: "com.apple.CoreSimulator.SimRuntime.watchOS-26-0",
      name: "watchOS 26.0",
      version: "26.0",
      isAvailable: true,
    },
  ],
});

const BOTH = JSON.stringify({
  runtimes: [
    {
      identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
      name: "iOS 26.5",
      version: "26.5",
      isAvailable: true,
    },
    {
      identifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-6",
      name: "iOS 18.6",
      version: "18.6",
      isAvailable: true,
    },
  ],
});

const COMPLETE: PreflightInput = {
  platform: "darwin",
  runtimes: parseRuntimes(BOTH),
  xcode: "Xcode 27.1",
  cocoapods: "1.17.0",
  maestro: "2.12.1",
};

describe("parseRuntimes", () => {
  test("keeps iOS identity + version, marks availability, drops junk", () => {
    const runtimes = parseRuntimes(TODAY);
    expect(runtimes.map((r) => r.identifier)).toEqual([
      "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
      "com.apple.CoreSimulator.SimRuntime.watchOS-26-0",
    ]);
    expect(runtimes[0]?.version).toBe("26.5");
    expect(runtimes[0]?.available).toBe(true);
  });

  test("unreadable JSON → [] (the caller reports a missing runtime, never a crash)", () => {
    expect(parseRuntimes("not json")).toEqual([]);
    expect(parseRuntimes("{}")).toEqual([]);
    expect(parseRuntimes('{"runtimes":"nope"}')).toEqual([]);
  });

  test("an unavailable runtime does not count", () => {
    const json = JSON.stringify({
      runtimes: [
        {
          identifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-6",
          name: "iOS 18.6",
          version: "18.6",
          isAvailable: false,
        },
      ],
    });
    expect(availableIosMajors(parseRuntimes(json))).toEqual([]);
  });
});

describe("availableIosMajors", () => {
  test("both from today's listing plus 18; only the required majors", () => {
    expect(availableIosMajors(parseRuntimes(TODAY))).toEqual([26]);
    expect(availableIosMajors(parseRuntimes(BOTH))).toEqual([18, 26]);
  });
});

describe("preflight", () => {
  test("a complete machine has nothing missing", () => {
    expect(preflight(COMPLETE)).toEqual([]);
    expect(missingText([])).toContain("e2e:mobile");
  });

  test("only 26.5 (today's machine) → names the iOS 18 runtime and its install command", () => {
    const missing = preflight({ ...COMPLETE, runtimes: parseRuntimes(TODAY) });
    expect(missing).toHaveLength(1);
    expect(missing[0]?.tool).toContain("iOS 18");
    expect(missing[0]?.install).toContain("xcodebuild -downloadPlatform iOS");
  });

  test("no iOS runtime at all → both are named", () => {
    const missing = preflight({ ...COMPLETE, runtimes: [] });
    expect(missing.map((m) => m.tool)).toEqual([
      "the iOS 18.x simulator runtime",
      "the iOS 26.x simulator runtime",
    ]);
  });

  test("--ios 26 narrows the requirement to that one runtime", () => {
    const missing = preflight({ ...COMPLETE, runtimes: parseRuntimes(TODAY) }, 26);
    expect(missing).toEqual([]);
    const only18 = preflight({ ...COMPLETE, runtimes: parseRuntimes(TODAY) }, 18);
    expect(only18).toHaveLength(1);
    expect(only18[0]?.tool).toContain("iOS 18");
  });

  test("Maestro absent → named with its install command (never a silent skip)", () => {
    const missing = preflight({ ...COMPLETE, maestro: undefined });
    expect(missing.map((m) => m.tool)).toEqual(["Maestro"]);
    expect(missing[0]?.install).toContain("mobile-dev-inc/tap/maestro");
    expect(missingText(missing)).toContain("Maestro is missing");
  });

  test("not macOS → says so first, and still lists the rest", () => {
    const missing = preflight({ ...COMPLETE, platform: "linux" });
    expect(missing[0]?.tool).toContain("macOS");
    expect(missing).toHaveLength(1);
  });

  test("Xcode and CocoaPods are named too", () => {
    const missing = preflight({ ...COMPLETE, xcode: undefined, cocoapods: undefined });
    expect(missing.map((m) => m.tool)).toEqual(["Xcode", "CocoaPods"]);
  });
});

describe("parseArgs (--ios)", () => {
  test("no flag → both majors; a named major → just it; anything else throws", () => {
    expect(parseArgs([])).toEqual({});
    expect(parseArgs(["--ios", "26"])).toEqual({ only: 26 });
    expect(parseArgs(["--ios", "18"])).toEqual({ only: 18 });
    expect(() => parseArgs(["--ios", "17"])).toThrow();
    expect(() => parseArgs(["--ios"])).toThrow();
  });
});

describe("firstDevice", () => {
  test("picks an available device of the wanted major, ignoring other runtimes", () => {
    const json = JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [{ udid: "iphone-26", isAvailable: true }],
        "com.apple.CoreSimulator.SimRuntime.iOS-18-6": [{ udid: "iphone-18", isAvailable: true }],
        "com.apple.CoreSimulator.SimRuntime.watchOS-26-0": [{ udid: "watch", isAvailable: true }],
      },
    });
    expect(firstDevice(json, 26)).toBe("iphone-26");
    expect(firstDevice(json, 18)).toBe("iphone-18");
    expect(firstDevice(json, 26)).not.toBe("watch");
    expect(firstDevice("not json", 26)).toBeUndefined();
  });

  test("an unavailable device is skipped", () => {
    const json = JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
          { udid: "gone", isAvailable: false },
          { udid: "usable", isAvailable: true },
        ],
      },
    });
    expect(firstDevice(json, 26)).toBe("usable");
  });
});

describe("firstDevice against the real simctl shapes", () => {
  test("`-j runtimes` has no `devices` key, so it yields nothing (the bug this pins)", () => {
    expect(firstDevice(TODAY, 26)).toBeUndefined();
  });

  test("`-j devices` gives the simulator", () => {
    const json = JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
          {
            dataPath: "/Users/x/Library/Developer/CoreSimulator/Devices/ABC/data",
            udid: "0FA4B51F-A0E3-421B-BE66-CE29EF45213D",
            isAvailable: true,
            state: "Booted",
          },
        ],
      },
    });
    expect(firstDevice(json, 26)).toBe("0FA4B51F-A0E3-421B-BE66-CE29EF45213D");
  });
});
