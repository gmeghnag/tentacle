import { describe, expect, test } from "bun:test";
import {
  containerDecision,
  expectedContainerVersion,
  parseVersionLine,
} from "../src/container-version.ts";

describe("parseVersionLine (the container's `tentacle --version`)", () => {
  test("`tentacle <version>` → the version", () => {
    expect(parseVersionLine("tentacle 0.2.0\n")).toBe("0.2.0");
    expect(parseVersionLine("  tentacle 1.0.0-rc.1+abc  ")).toBe("1.0.0-rc.1+abc");
  });

  test("anything else is unknown", () => {
    for (const out of [
      "",
      "tentacle",
      "tentacle dev extra",
      "foo 0.2.0",
      "tentacle 0.1.0\u001b[2J",
      "0.2.0",
    ]) {
      expect(parseVersionLine(out)).toBeUndefined();
    }
  });
});

describe("expectedContainerVersion (what this laptop would inject)", () => {
  const never = async () => {
    throw new Error("must not read a marker");
  };

  test("a release build without an override → its own version (the release resolver's only choice)", async () => {
    expect(await expectedContainerVersion({ appVersion: "0.3.0", readMarker: never })).toBe(
      "0.3.0",
    );
  });

  test("TENTACLE_POD_BIN → that binary's marker, release or dev", async () => {
    const read = async (path: string) => (path === "/bins/t" ? "0.4.0" : undefined);
    expect(
      await expectedContainerVersion({
        appVersion: "0.3.0",
        podBinOverride: "/bins/t",
        readMarker: read,
      }),
    ).toBe("0.4.0");
    expect(
      await expectedContainerVersion({
        appVersion: "dev",
        podBinOverride: "/bins/t",
        readMarker: read,
      }),
    ).toBe("0.4.0");
  });

  test("an override without a marker, or an unreadable one → unknown", async () => {
    expect(
      await expectedContainerVersion({
        appVersion: "0.3.0",
        podBinOverride: "/x",
        readMarker: async () => undefined,
      }),
    ).toBeUndefined();
    expect(
      await expectedContainerVersion({
        appVersion: "0.3.0",
        podBinOverride: "/x",
        readMarker: async () => {
          throw new Error("ENOENT");
        },
      }),
    ).toBeUndefined();
  });

  test("from source without an override → unknown (Q3: reuse as today)", async () => {
    expect(
      await expectedContainerVersion({ appVersion: "dev", readMarker: never }),
    ).toBeUndefined();
  });
});

describe("containerDecision", () => {
  const ok = (stdout: string) => ({ exitCode: 0, stdout });

  test("no working tentacle → inject (today)", () => {
    expect(containerDecision({ exitCode: 127, stdout: "" }, "0.3.0")).toEqual({ kind: "inject" });
    expect(containerDecision({ exitCode: 1, stdout: "tentacle 0.3.0" }, undefined)).toEqual({
      kind: "inject",
    });
  });

  test("the laptop's exact version, or no expectation → reuse (today)", () => {
    expect(containerDecision(ok("tentacle 0.3.0\n"), "0.3.0")).toEqual({ kind: "reuse" });
    expect(containerDecision(ok("tentacle 0.1.0\n"), undefined)).toEqual({ kind: "reuse" });
  });

  test("another version, older OR newer, or an unreadable one → replace", () => {
    expect(containerDecision(ok("tentacle 0.2.0\n"), "0.3.0")).toEqual({
      kind: "replace",
      had: "0.2.0",
    });
    expect(containerDecision(ok("tentacle 0.4.0\n"), "0.3.0")).toEqual({
      kind: "replace",
      had: "0.4.0",
    });
    expect(containerDecision(ok("something else\n"), "0.3.0")).toEqual({
      kind: "replace",
      had: undefined,
    });
  });
});
