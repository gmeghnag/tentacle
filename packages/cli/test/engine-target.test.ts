import { describe, expect, test } from "bun:test";
import { engineTarget } from "../src/engine-target.ts";

describe("engineTarget: the TUI badge's facts, from the laptop's side", () => {
  test("docker / podman: engine + workload name, never a container", () => {
    expect(engineTarget({ kind: "docker" }, "tentacle-ba89d072")).toEqual({
      engine: "docker",
      name: "tentacle-ba89d072",
    });
    expect(engineTarget({ kind: "podman" }, "t-1", "ignored", 3)).toEqual({
      engine: "podman",
      name: "t-1",
    });
  });

  test("kubernetes, one container: `pod <name>` only — even when --container named it", () => {
    expect(engineTarget({ kind: "kubernetes" }, "dev", "app", 1)).toEqual({
      engine: "kubernetes",
      name: "dev",
    });
    expect(engineTarget({ kind: "kubernetes" }, "dev")).toEqual({
      engine: "kubernetes",
      name: "dev",
    });
  });

  test("kubernetes, several containers: the one in use is named", () => {
    expect(engineTarget({ kind: "kubernetes" }, "dev", "sidecar", 2)).toEqual({
      engine: "kubernetes",
      name: "dev",
      container: "sidecar",
    });
  });

  test("kubernetes, several containers but none resolved: no container part (nothing to show)", () => {
    expect(engineTarget({ kind: "kubernetes" }, "dev", undefined, 2)).toEqual({
      engine: "kubernetes",
      name: "dev",
    });
  });

  test("a name carrying terminal control bytes is sanitised before it can reach the screen", () => {
    expect(engineTarget({ kind: "docker" }, "a\u001b[2Jb").name).toBe("a [2Jb");
  });
});
