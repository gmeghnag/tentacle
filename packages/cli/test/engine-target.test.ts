import { describe, expect, test } from "bun:test";
import { engineTarget } from "../src/engine-target.ts";

describe("engineTarget: the TUI badge's facts, from the laptop's side", () => {
  test("docker / podman: engine + workload name, never a container", () => {
    expect(engineTarget({ kind: "docker" }, "tentacle-ba89d072")).toEqual({
      engine: "docker",
      name: "tentacle-ba89d072",
    });
    expect(engineTarget({ kind: "podman" }, "t-1", "ignored")).toEqual({
      engine: "podman",
      name: "t-1",
    });
  });

  test("kubernetes ALWAYS names the container in use — also for a one-container pod", () => {
    expect(engineTarget({ kind: "kubernetes" }, "dev", "app")).toEqual({
      engine: "kubernetes",
      name: "dev",
      container: "app",
    });
    expect(engineTarget({ kind: "kubernetes" }, "dev", "sidecar")).toEqual({
      engine: "kubernetes",
      name: "dev",
      container: "sidecar",
    });
  });

  test("kubernetes with no container resolved: no container part (nothing to show)", () => {
    expect(engineTarget({ kind: "kubernetes" }, "dev")).toEqual({
      engine: "kubernetes",
      name: "dev",
    });
  });

  test("a name carrying terminal control bytes is sanitised before it can reach the screen", () => {
    expect(engineTarget({ kind: "docker" }, "a\u001b[2Jb").name).toBe("a [2Jb");
    expect(engineTarget({ kind: "kubernetes" }, "p", "c\u001b[2Jd").container).toBe("c [2Jd");
  });
});
