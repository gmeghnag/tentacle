import { describe, expect, test } from "bun:test";
import { type EngineEndpoint, contextStoreKey } from "@tentacle/docker";
import type { KubeClientOptions } from "@tentacle/k8s";
import type { DockerClientLike } from "../src/engine-docker.ts";
import type { PodCluster } from "../src/engine-k8s.ts";
import {
  type EngineHostIO,
  attachCommand,
  buildEngineHost,
  chooseEngine,
  engineFlagProblem,
  setupFailureLine,
} from "../src/engine-select.ts";

// Engine selection (docs/feat/docker-engine-cli.md): the owner's precedence
// flag > TENTACLE_ENGINE > profile/user config > kubernetes, loud on an unknown
// value, and the host each engine builds.
describe("chooseEngine", () => {
  test("flag > env > configured > kubernetes", () => {
    expect(chooseEngine({})).toEqual({ ok: true, kind: "kubernetes" });
    expect(chooseEngine({ configured: "podman" })).toEqual({ ok: true, kind: "podman" });
    expect(chooseEngine({ env: "docker", configured: "podman" })).toEqual({
      ok: true,
      kind: "docker",
    });
    expect(chooseEngine({ flag: "kubernetes", env: "docker", configured: "podman" })).toEqual({
      ok: true,
      kind: "kubernetes",
    });
    // An empty env var is unset, not an error.
    expect(chooseEngine({ env: "", configured: "docker" })).toEqual({ ok: true, kind: "docker" });
  });

  test("an unknown value names its source; it never falls back to another engine", () => {
    expect(chooseEngine({ flag: "dokcer", configured: "docker" })).toEqual({
      ok: false,
      error: 'unknown engine "dokcer" (--engine): use kubernetes, docker or podman',
    });
    expect(chooseEngine({ env: "k8s" })).toEqual({
      ok: false,
      error: 'unknown engine "k8s" (TENTACLE_ENGINE): use kubernetes, docker or podman',
    });
  });
});

describe("engineFlagProblem", () => {
  test("k8s-only flags on docker/podman, docker-only flags on kubernetes", () => {
    expect(engineFlagProblem("kubernetes", { namespace: true, container: true })).toBeNull();
    expect(engineFlagProblem("docker", { context: true, insecureTcp: true })).toBeNull();
    expect(engineFlagProblem("kubernetes", { context: true })).toContain("--context is for");
    expect(engineFlagProblem("kubernetes", { insecureTcp: true })).toContain(
      "--insecure-docker-tcp is for",
    );
    expect(engineFlagProblem("docker", { namespace: true })).toContain("--namespace is for");
    expect(engineFlagProblem("podman", { container: true })).toContain("--container is for");
  });
});

describe("attachCommand / setupFailureLine", () => {
  test("the --keep resume hint names the engine and its scope", () => {
    expect(attachCommand("kubernetes", "p1", { namespace: "dev" })).toBe(
      "tentacle attach --engine kubernetes -n dev p1",
    );
    expect(attachCommand("docker", "c1", { context: "remote" })).toBe(
      "tentacle attach --engine docker --context remote c1",
    );
    expect(attachCommand("podman", "c2")).toBe("tentacle attach --engine podman c2");
  });

  test("k8s keeps its historical auth-failure line; docker/podman say failed", () => {
    expect(setupFailureLine("kubernetes", new Error("no kubeconfig"))).toBe(
      "[pod] cluster auth failed: no kubeconfig\n",
    );
    expect(setupFailureLine("podman", new Error("no Podman socket found"))).toBe(
      "[container] failed: no Podman socket found\n",
    );
  });
});

describe("buildEngineHost", () => {
  const io = (env: Record<string, string | undefined>, over: Partial<EngineHostIO> = {}) => {
    const kubeCalls: KubeClientOptions[] = [];
    const dockerCalls: EngineEndpoint[] = [];
    const value: EngineHostIO = {
      env,
      platform: "linux",
      uid: 1000,
      tmpdir: "/tmp",
      homeDir: "/home/u",
      readFile: () => undefined,
      exists: () => false,
      listDir: () => [],
      kubeClient: (options) => {
        kubeCalls.push(options);
        return {} as PodCluster;
      },
      dockerClient: (endpoint) => {
        dockerCalls.push(endpoint);
        return {} as DockerClientLike;
      },
      ...over,
    };
    return { value, kubeCalls, dockerCalls };
  };

  test("kubernetes: the TENTACLE_K8S_SERVER override, namespace passed through", () => {
    const { value, kubeCalls, dockerCalls } = io({
      TENTACLE_K8S_SERVER: "https://k:6443",
      TENTACLE_K8S_TOKEN: "t",
    });
    const built = buildEngineHost("kubernetes", { namespace: "dev" }, value);
    expect(built.host.kind).toBe("kubernetes");
    expect(built.host.where).toBe("namespace dev");
    expect(built.namespace).toBe("dev");
    expect(kubeCalls).toEqual([
      { server: "https://k:6443", namespace: "dev", token: "t" } as KubeClientOptions,
    ]);
    expect(dockerCalls).toEqual([]);
  });

  test("docker: DOCKER_HOST honoured; the client is built for that endpoint", () => {
    const { value, kubeCalls, dockerCalls } = io({ DOCKER_HOST: "unix:///d.sock" });
    const built = buildEngineHost("docker", {}, value);
    expect(built.host.kind).toBe("docker");
    expect(built.host.noun).toBe("container");
    expect(dockerCalls).toEqual([
      { kind: "unix", path: "/d.sock", local: true, source: "DOCKER_HOST" },
    ]);
    expect(kubeCalls).toEqual([]);
  });

  test("docker: --context and --insecure-docker-tcp reach the resolver", () => {
    const key = contextStoreKey("lab");
    const { value, dockerCalls } = io(
      { HOME: "/home/u" },
      {
        readFile: (path) =>
          path === `/home/u/.docker/contexts/meta/${key}/meta.json`
            ? JSON.stringify({ Endpoints: { docker: { Host: "tcp://lab:2375" } } })
            : undefined,
      },
    );
    expect(() => buildEngineHost("docker", { context: "lab" }, value)).toThrow(
      /refusing plaintext/,
    );
    buildEngineHost("docker", { context: "lab", allowInsecureTcp: true }, value);
    expect(dockerCalls).toEqual([
      {
        kind: "tcp",
        host: "lab",
        port: 2375,
        insecure: true,
        local: false,
        source: 'context "lab"',
      },
    ]);
  });

  test("podman: the discovered socket, kind podman; DOCKER_HOST is ignored", () => {
    const { value, dockerCalls } = io(
      { DOCKER_HOST: "unix:///var/run/docker.sock", XDG_RUNTIME_DIR: "/run/user/1000" },
      { exists: (path) => path === "/run/user/1000/podman/podman.sock" },
    );
    const built = buildEngineHost("podman", {}, value);
    expect(built.host.kind).toBe("podman");
    expect(dockerCalls.map((ep) => (ep.kind === "unix" ? ep.path : ep.kind))).toEqual([
      "/run/user/1000/podman/podman.sock",
    ]);
  });
});
