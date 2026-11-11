import { describe, expect, test } from "bun:test";
import {
  containerDecision,
  expectedContainerBuild,
  expectedContainerVersion,
  parseBuildFromVersionProbe,
  parseVersionLine,
  replacedNotice,
  staleBuildBusyLine,
} from "../src/container-version.ts";

describe("parseVersionLine (the container's `tentacle --version`)", () => {
  test("`tentacle <version>` → the version, cut at `+` (the build is judged separately)", () => {
    expect(parseVersionLine("tentacle 0.2.0\n")).toBe("0.2.0");
    // A dev build answers `0.3.0+<id>`; `expected` is a PLAIN marker, so the
    // comparison is at the release version (docs/fix/dev-build-version-skew.md).
    expect(parseVersionLine("  tentacle 1.0.0-rc.1+abc  ")).toBe("1.0.0-rc.1");
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

  test("a dev build's own `+<id>` answer against the plain expected version → reuse", () => {
    // docs/fix/dev-build-version-skew.md, fix round 1 (the review's finding 3):
    // the container answers `tentacle 0.3.0+<id>` (it runs a dev build, the one
    // `TENTACLE_POD_BIN` / this laptop injected), while `expected` is the file's
    // PLAIN marker. Compared whole, every re-attach replaced its own build with
    // itself — and `StaleBuildError` guards only `reason: "build"`, so a busy
    // resident was killed. The build difference stays the build rule's job.
    expect(containerDecision(ok("tentacle 0.3.0+1a2b3c4d5e6f\n"), "0.3.0")).toEqual({
      kind: "reuse",
    });
    // …and a DIFFERENT version still differs, `+` or not.
    expect(containerDecision(ok("tentacle 0.3.0+1a2b3c4d5e6f\n"), "0.4.0")).toEqual({
      kind: "replace",
      had: "0.3.0",
      reason: "version",
    });
    // The build rule still replaces an older build of the SAME release version.
    expect(
      containerDecision(ok("tentacle 0.3.0+1a2b3c4d5e6f\n"), "0.3.0", {
        expected: "1a2b3c4d5e6f",
        found: "ba9876543210",
      }),
    ).toEqual({ kind: "replace", had: "0.3.0", reason: "build" });
  });

  test("another version, older OR newer, or an unreadable one → replace", () => {
    expect(containerDecision(ok("tentacle 0.2.0\n"), "0.3.0")).toEqual({
      kind: "replace",
      had: "0.2.0",
      reason: "version",
    });
    expect(containerDecision(ok("tentacle 0.4.0\n"), "0.3.0")).toEqual({
      kind: "replace",
      had: "0.4.0",
      reason: "version",
    });
    expect(containerDecision(ok("something else\n"), "0.3.0")).toEqual({
      kind: "replace",
      had: undefined,
      reason: "version",
    });
  });

  describe("the build rule (docs/fix/stale-pod-binary.md)", () => {
    const B = "0123456789ab";
    test("same version, same build → reuse", () => {
      expect(containerDecision(ok("tentacle 0.3.0\n"), "0.3.0", { expected: B, found: B })).toEqual(
        { kind: "reuse" },
      );
    });

    test("same version, a DIFFERENT build → replace (reason build)", () => {
      expect(
        containerDecision(ok("tentacle 0.3.0\n"), "0.3.0", { expected: B, found: "ba9876543210" }),
      ).toEqual({ kind: "replace", had: "0.3.0", reason: "build" });
    });

    test("same version, a MISSING build id (every older binary) → replace", () => {
      expect(
        containerDecision(ok("tentacle 0.3.0\n"), "0.3.0", { expected: B, found: undefined }),
      ).toEqual({ kind: "replace", had: "0.3.0", reason: "build" });
    });

    test("a different version stays a version replace, whatever the build", () => {
      expect(containerDecision(ok("tentacle 0.2.0\n"), "0.3.0", { expected: B, found: B })).toEqual(
        { kind: "replace", had: "0.2.0", reason: "version" },
      );
    });

    test("no expected build (from source, Q3) → today's rule: reuse", () => {
      expect(
        containerDecision(ok("tentacle 0.3.0\n"), "0.3.0", {
          expected: undefined,
          found: undefined,
        }),
      ).toEqual({ kind: "reuse" });
    });

    test("no working tentacle → inject, the build is not asked", () => {
      expect(
        containerDecision({ exitCode: 127, stdout: "" }, "0.3.0", { expected: B, found: B }),
      ).toEqual({ kind: "inject" });
    });
  });
});

describe("parseBuildFromVersionProbe (the container's `tentacle --version --build-id`)", () => {
  test("exit 0 and a second line of 12 hex → the id", () => {
    expect(
      parseBuildFromVersionProbe({ exitCode: 0, stdout: "tentacle 0.3.0\n0123456789ab\n" }),
    ).toBe("0123456789ab");
  });

  test("an older binary ignores the extra argument: ONE line → no build id", () => {
    expect(parseBuildFromVersionProbe({ exitCode: 0, stdout: "tentacle 0.3.0\n" })).toBeUndefined();
  });

  test("a failure, `dev`, junk, extra lines or no answer → none", () => {
    for (const run of [
      { exitCode: 1, stdout: "tentacle 0.3.0\n0123456789ab\n" },
      { exitCode: 0, stdout: "tentacle 0.3.0\ndev\n" },
      { exitCode: 0, stdout: "tentacle 0.3.0\n0123456789ab\u001b[2J\n" },
      { exitCode: 0, stdout: "tentacle 0.3.0\nx\n0123456789ab\n" },
      { exitCode: null, stdout: "tentacle 0.3.0\n0123456789ab\n" },
      null,
    ]) {
      expect(parseBuildFromVersionProbe(run)).toBeUndefined();
    }
  });

  test("parseVersionLine reads the first line only", () => {
    expect(parseVersionLine("tentacle 0.3.0\n0123456789ab\n")).toBe("0.3.0");
  });
});

describe("expectedContainerBuild (the build of the binary this laptop INJECTS)", () => {
  const never = async () => {
    throw new Error("must not read a file");
  };
  const B = "0123456789ab";
  const by = (map: Record<string, string | undefined>) => async (path: string) => map[path];

  test("release: the config-dir binaries' build when they agree", async () => {
    expect(
      await expectedContainerBuild({
        appVersion: "0.3.0",
        binaries: ["/x64", "/arm64"],
        readBuild: by({ "/x64": B, "/arm64": B }),
      }),
    ).toBe(B);
    // Only the arch the user installed exists (the caller passes existing paths).
    expect(
      await expectedContainerBuild({
        appVersion: "0.3.0",
        binaries: ["/arm64"],
        readBuild: by({ "/arm64": B }),
      }),
    ).toBe(B);
  });

  test("release: none readable, ONE without an id, or two builds → no build rule", async () => {
    for (const map of [{}, { "/arm64": B }, { "/x64": B, "/arm64": "ba9876543210" }]) {
      expect(
        await expectedContainerBuild({
          appVersion: "0.3.0",
          binaries: ["/x64", "/arm64"],
          readBuild: by(map),
        }),
      ).toBeUndefined();
    }
  });

  test("from source (dev) with no override → no build rule (Q3), nothing read", async () => {
    expect(
      await expectedContainerBuild({ appVersion: "dev", binaries: ["/x64"], readBuild: never }),
    ).toBeUndefined();
  });

  test("TENTACLE_POD_BIN → that file's build, in either mode; unreadable or without one → none", async () => {
    const readBuild = by({ "/x": "aaaaaaaaaaaa" });
    for (const appVersion of ["dev", "0.3.0"]) {
      expect(
        await expectedContainerBuild({ appVersion, podBinOverride: "/x", binaries: [], readBuild }),
      ).toBe("aaaaaaaaaaaa");
      expect(
        await expectedContainerBuild({ appVersion, podBinOverride: "/y", binaries: [], readBuild }),
      ).toBeUndefined();
      expect(
        await expectedContainerBuild({
          appVersion,
          podBinOverride: "/z",
          binaries: [],
          readBuild: never,
        }),
      ).toBeUndefined();
    }
  });
});

describe("the stale-build wording", () => {
  test("the busy refusal is one fixed sentence naming the way out", () => {
    expect(staleBuildBusyLine("ciao")).toBe(
      "ciao runs an older tentacle build than this one · tentacle rm ciao, then run again",
    );
    expect(staleBuildBusyLine("a\u001b[2Jb")).not.toContain("\u001b");
  });

  test("the replace notice says it was an older build when the version agreed", () => {
    expect(replacedNotice({ had: "0.3.0", expected: "0.3.0", reason: "build" })).toBe(
      "the container had tentacle 0.3.0 (an older build); replaced with 0.3.0 (this laptop's)",
    );
    expect(replacedNotice({ had: "0.2.0", expected: "0.3.0", reason: "version" })).toBe(
      "the container had tentacle 0.2.0; replaced with 0.3.0 (this laptop's)",
    );
  });
});
