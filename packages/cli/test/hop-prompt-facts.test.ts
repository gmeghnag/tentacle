/**
 * docs/feat/session-hop.md D9 / review M6 (H5 review findings 2 and 3): the facts
 * the owner reads before approving a PROPOSED move must be the facts the build
 * will really use — never a second, hand-made plan.
 *
 * Two silent failures are pinned here:
 *   2. The mount gate's `ask` was never merged into the proposal's prompt, so the
 *      owner answered the proposal blind and then got a SECOND prompt at build
 *      time (or, worse, approved a mount nobody warned them about).
 *   3. `hopPromptFacts` built its plan with `kind: "docker"`, `noMount: false` and
 *      no `endpoint`, while `containerTarget` passes the real engine, the real
 *      endpoint and `deps.mount === false`. A remote `tcp://` engine or
 *      `mount: false` therefore showed "mount: <cwd> (read-write)" for a mount
 *      that never happens.
 *
 * The property is asserted at the ONE seam: `hopPromptFacts` → `hopPromptDetail`
 * (the exact text the owner is shown), against the same deps `containerTarget`
 * receives.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineEndpoint } from "@tentacle/docker";
import type { TentacleConfig } from "../src/config.ts";
import type { EngineHost, EngineKind } from "../src/engine-host.ts";
import type { HopPlace } from "../src/hop-plan.ts";
import { hopPromptDetail } from "../src/hop-proposal.ts";
import { type HopEngineHost, hopPromptFacts } from "../src/hop-targets.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hop-prompt-facts-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const UNIX = {
  kind: "unix",
  path: "/run/docker.sock",
  local: true,
  source: "default",
} as unknown as EngineEndpoint;

const REMOTE = {
  kind: "tcp",
  url: "tcp://10.0.0.9:2376",
  local: false,
  source: "default",
} as unknown as EngineEndpoint;

/** The config a hop builds with (only the keys these rows read). */
function config(cwd: string, over: Partial<TentacleConfig> = {}): TentacleConfig {
  return {
    cwd,
    configDir: join(dir, "config"),
    model: "qwen3",
    engine: "docker",
    ...over,
  } as unknown as TentacleConfig;
}

/** The `HopTargetDeps` a container hop really hands `hopPromptFacts`. */
function deps(
  conf: TentacleConfig,
  endpoint: EngineEndpoint | undefined,
  opts: { mount?: boolean } = {},
): { config: TentacleConfig; host: (engine: EngineKind) => HopEngineHost; mount?: boolean } {
  return {
    config: conf,
    ...(opts.mount === false ? { mount: false } : {}),
    host: (): HopEngineHost => ({
      host: {} as EngineHost,
      ...(endpoint === undefined ? {} : { endpoint }),
      locators: {},
    }),
  };
}

const LOCAL: HopPlace = { kind: "local" };
const CONTAINER = { target: "container", keep: true } as const;

describe("H5 review 3: the prompt's mount is the mount the BUILD would use", () => {
  test("a `mount: false` deps shows NO read-write mount (it will not mount)", () => {
    const conf = config(dir);
    // The real deps shape: `containerTarget` passes `noMount: deps.mount === false`.
    const facts = hopPromptFacts({ ...deps(conf, UNIX, { mount: false }) }, CONTAINER, LOCAL);
    const text = hopPromptDetail(CONTAINER, facts);
    // Mutation: the pre-fix hard-coded `noMount: false` → this says "read-write".
    expect(text).not.toContain("read-write");
  });

  test("a remote `tcp://` endpoint shows NO read-write mount (the folder is not shared)", () => {
    const conf = config(dir);
    const facts = hopPromptFacts({ ...deps(conf, REMOTE) }, CONTAINER, LOCAL);
    const text = hopPromptDetail(CONTAINER, facts);
    expect(text).not.toContain("read-write");
  });

  test("a local unix endpoint DOES show the real host path, read-write", () => {
    // Non-vacuity: the same seam still says the mount when there really is one.
    const conf = config(dir);
    const facts = hopPromptFacts({ ...deps(conf, UNIX) }, CONTAINER, LOCAL);
    const text = hopPromptDetail(CONTAINER, facts);
    expect(text).toContain("read-write");
    expect(text).toContain(dir);
  });

  test("the engine the prompt names is the one the build would use (podman)", () => {
    // Mutation: hard-coded `kind: "docker"` → the prompt misnames a podman build.
    const conf = config(dir, { engine: "podman" } as Partial<TentacleConfig>);
    const facts = hopPromptFacts({ ...deps(conf, UNIX) }, CONTAINER, LOCAL);
    expect(facts.engine).toBe("podman");
    expect(hopPromptDetail(CONTAINER, facts)).toContain("podman");
  });
});

describe("H5 review 2: the mount gate's `ask` MERGES into the proposal's ONE prompt", () => {
  test("a dangerous cwd puts the gate's warning into the SAME detail the owner approves", () => {
    // A SYSTEM cwd (`/etc`) is the `danger` that makes the gate ask at build time
    // (`session-hop-targets.test.ts`'s rig). The proposal's prompt must carry it,
    // or the owner approves blind and is asked twice.
    const conf = config("/etc");
    const facts = hopPromptFacts({ ...deps(conf, UNIX) }, CONTAINER, LOCAL);
    // Mutation: `gate` never set → absent, and the build raises a second prompt.
    expect(facts.gate).toBeDefined();
    expect(facts.gate ?? "").toContain("/etc");
    const text = hopPromptDetail(CONTAINER, facts);
    expect(text).toContain("/etc");
    // Still ONE text: the gate's line is a paragraph of the proposal's detail.
    expect(typeof text).toBe("string");
  });

  test("a safe cwd merges NO gate line (there is nothing to warn about)", () => {
    const conf = config(dir);
    const facts = hopPromptFacts({ ...deps(conf, UNIX) }, CONTAINER, LOCAL);
    expect(facts.gate).toBeUndefined();
  });
});
