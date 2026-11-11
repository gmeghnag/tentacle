/**
 * What a build calls itself (docs/fix/dev-build-version-skew.md).
 *
 * A RELEASED binary reports its plain version: the release is cut from a clean
 * tagged `main`, and both `scripts/release.ts` and build.yml refuse a tag that
 * does not equal `packages/cli/package.json` — so a published binary's version
 * IS a package.json version, with no `+`. Every other build (the `compile`
 * script without `TENTACLE_RELEASE=1`, the pod-binary cache) adds `+<build id>`,
 * because otherwise two builds of one version are indistinguishable in a
 * `VersionMismatch` — the live case: `client 21 (tentacle 0.3.0), daemon 16
 * (tentacle 0.3.0)`, one a `main` checkout and one release v0.3.0.
 */
import { describe, expect, test } from "bun:test";
import { buildIdFor } from "../src/pod-binary-build.ts";
import { APP_VERSION, MARKER_VERSION_RE, devBuildVersion } from "../src/version.ts";

const B = "1a2b3c4d5e6f";

describe("devBuildVersion (a dev build names its build)", () => {
  test("a dev build's version carries its build id", () => {
    expect(devBuildVersion("0.3.0", B)).toBe(`0.3.0+${B}`);
  });

  test("a release build keeps the plain version — nothing else adds a suffix", () => {
    // No build id: a release. The version must stay EXACTLY the package.json
    // version, which `update` compares against a release and build.yml against a tag.
    expect(devBuildVersion("0.3.0", undefined)).toBe("0.3.0");
  });

  test("an id that is not a build id never becomes part of a version", () => {
    for (const bad of ["", "xyz", "1a2b3c4d5e6", `${B}\n`, "1a2b3c4d5e6f0"]) {
      expect(devBuildVersion("0.3.0", bad)).toBe("0.3.0");
    }
  });

  test("the result is a version every carrier accepts (binary marker, clientInfo)", () => {
    // MARKER_VERSION_RE guards the compiled-in marker and ClientInfoSchema.version.
    expect(MARKER_VERSION_RE.test(devBuildVersion("0.3.0", B))).toBe(true);
    // ...and `update` ignores the metadata (so equality checks still mean equality).
    expect(devBuildVersion("0.3.0", B).split("+")[0]).toBe("0.3.0");
  });

  test("the running build is not a release: from source APP_VERSION says so", () => {
    // From source there is no compiled-in marker: APP_VERSION is "dev", and its
    // build id is not compiled in either — a source run is not a release build.
    expect(APP_VERSION).toBe("dev");
  });
});

describe("buildIdFor (which build calls itself a release)", () => {
  const B = "1a2b3c4d5e6f";

  test("a release build carries no build id, so its version stays plain", () => {
    expect(buildIdFor({ TENTACLE_RELEASE: "1" }, B)).toBeUndefined();
    expect(devBuildVersion("0.3.0", buildIdFor({ TENTACLE_RELEASE: "1" }, B))).toBe("0.3.0");
  });

  test("every other build carries one — a checkout, a local build, the pod cache", () => {
    for (const env of [
      {},
      { TENTACLE_RELEASE: "" },
      { TENTACLE_RELEASE: "0" },
      { TENTACLE_RELEASE: "true" },
    ]) {
      expect(buildIdFor(env, B)).toBe(B);
      expect(devBuildVersion("0.3.0", buildIdFor(env, B))).toBe(`0.3.0+${B}`);
    }
  });
});
