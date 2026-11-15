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
  hostOptionsFor,
  keptLocation,
  kubeNamespace,
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
  test("the resume hint of a kept run names the engine and its scope", () => {
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

// feat/session-hop-ux OD2: ONE namespace rule for `run`, `attach` and every hop —
// explicit > TENTACLE_POD_NAMESPACE > (server ? default : the context's) — and its
// provenance, so a live test can answer "why that namespace".
describe("kubeNamespace", () => {
  const kc = (ns?: string) => `apiVersion: v1
current-context: c
contexts:
- name: c
  context: {cluster: k, user: u${ns ? `, namespace: ${ns}` : ""}}
clusters:
- name: k
  cluster: {server: "https://127.0.0.1:1"}
users:
- name: u
  user: {token: t}
`;
  const io = (env: Record<string, string | undefined>, file: string | undefined): EngineHostIO => ({
    env,
    platform: "linux",
    uid: 1000,
    tmpdir: "/tmp",
    homeDir: "/home/u",
    readFile: (path) => (path === "/home/u/.kube/config" ? file : undefined),
    exists: () => false,
    listDir: () => [],
    kubeClient: () => ({}) as PodCluster,
    dockerClient: () => ({}) as DockerClientLike,
  });

  test("explicit > env > server ⇒ default > context > default, with its source", () => {
    // Mutation: drop the env step ⇒ the `env` row resolves to the context's ns.
    expect(
      kubeNamespace({ namespace: "n1" }, io({ TENTACLE_POD_NAMESPACE: "n2" }, kc("n3"))),
    ).toEqual({ namespace: "n1", source: "explicit" });
    expect(kubeNamespace({}, io({ TENTACLE_POD_NAMESPACE: "n2" }, kc("n3")))).toEqual({
      namespace: "n2",
      source: "env",
    });
    expect(
      kubeNamespace(
        {},
        io({ TENTACLE_K8S_SERVER: "https://x", TENTACLE_POD_NAMESPACE: "n2" }, kc("n3")),
      ).namespace,
    ).toBe("n2");
    expect(kubeNamespace({}, io({ TENTACLE_K8S_SERVER: "https://x" }, kc("n3")))).toEqual({
      namespace: "default",
      source: "server",
    });
    expect(kubeNamespace({}, io({}, kc("n3")))).toEqual({
      namespace: "n3",
      source: "context",
      kubeconfig: "/home/u/.kube/config",
      context: "c",
    });
    expect(kubeNamespace({}, io({}, kc()))).toEqual({
      namespace: "default",
      source: "default",
      kubeconfig: "/home/u/.kube/config",
      context: "c",
    });
  });

  test("no current-context (absent, unreadable or none requested) is an error, not a guess", () => {
    expect(() => kubeNamespace({}, io({}, undefined))).toThrow(/no current-context/);
    expect(() => kubeNamespace({}, io({}, "not: [a kubeconfig"))).toThrow(/Flow sequence/);
    expect(() => kubeNamespace({}, io({}, "apiVersion: v1\n"))).toThrow(/no current-context/);
    // An explicit namespace needs no kubeconfig at all.
    expect(kubeNamespace({ namespace: "n1" }, io({}, undefined)).namespace).toBe("n1");
  });

  test("a named context is the one consulted (a kept entry's re-dial)", () => {
    const named = `apiVersion: v1
current-context: c
contexts:
- name: c
  context: {cluster: k, user: u, namespace: fromcurrent}
- name: other
  context: {cluster: k, user: u, namespace: fromother}
clusters:
- name: k
  cluster: {server: "https://127.0.0.1:1"}
users:
- name: u
  user: {token: t}
`;
    expect(kubeNamespace({ kubeContext: "other" }, io({}, named))).toMatchObject({
      namespace: "fromother",
      source: "context",
      context: "other",
    });
  });

  test("buildEngineHost resolves through it: the env reaches a hop's `{}` options", () => {
    // The hop's own call (`hopEngineHost`, `buildEngineHost(engine, {})`) must see
    // TENTACLE_POD_NAMESPACE — the CLI's own `engineHost` used to be its only reader.
    // (`TENTACLE_K8S_SERVER` here, so the auth path needs no kubeconfig file: what
    // this asserts is the NAMESPACE the env decided, which is the hop's gap.)
    const env = io(
      { TENTACLE_K8S_SERVER: "https://k:6443", TENTACLE_POD_NAMESPACE: "openshift-etcd" },
      kc(),
    );
    const built = buildEngineHost("kubernetes", {}, env);
    expect(built.namespace).toBe("openshift-etcd");
    expect(built.host.where).toBe("namespace openshift-etcd");
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

  // Slice E: a kept entry's locator re-dials WHERE it was created, whatever
  // DOCKER_HOST / TENTACLE_K8S_SERVER say now.
  test("kept locator: recorded from the built host, re-dialled to the SAME place", () => {
    const run = io({ DOCKER_HOST: "ssh://me@box:2222" });
    const built = buildEngineHost("docker", {}, run.value);
    const where = keptLocation("docker", built, {});
    expect(where).toEqual({ endpoint: "ssh://me@box:2222" });
    // later, from a shell with another DOCKER_HOST:
    const later = io({ DOCKER_HOST: "unix:///other.sock" });
    buildEngineHost("docker", hostOptionsFor({ engine: "docker", ...where }), later.value);
    expect(later.dockerCalls[0]).toMatchObject({
      kind: "ssh",
      host: "box",
      user: "me",
      port: 2222,
    });

    const plain = buildEngineHost(
      "docker",
      { allowInsecureTcp: true },
      io({ DOCKER_HOST: "tcp://h:2375" }).value,
    );
    const tcp = keptLocation("docker", plain, { insecureTcp: true });
    expect(tcp).toEqual({ endpoint: "tcp://h:2375", insecureTcp: true });
    expect(hostOptionsFor({ engine: "docker", ...tcp })).toEqual({
      host: "tcp://h:2375",
      allowInsecureTcp: true,
    });
    expect(hostOptionsFor({ engine: "podman", endpoint: "unix:///p.sock", context: "c" })).toEqual({
      context: "c",
    });
  });

  test("kept locator (k8s): the server override is recorded and wins over today's env", () => {
    const run = io({ TENTACLE_K8S_SERVER: "https://k:6443", TENTACLE_K8S_TOKEN: "t" });
    const built = buildEngineHost("kubernetes", { namespace: "dev" }, run.value);
    const where = keptLocation("kubernetes", built, {});
    expect(where).toEqual({ namespace: "dev", server: "https://k:6443" });
    const later = io({ TENTACLE_K8S_SERVER: "https://elsewhere:1", TENTACLE_K8S_TOKEN: "t2" });
    buildEngineHost("kubernetes", hostOptionsFor({ engine: "kubernetes", ...where }), later.value);
    expect(later.kubeCalls).toEqual([
      { server: "https://k:6443", namespace: "dev", token: "t2" } as KubeClientOptions,
    ]);
    expect(hostOptionsFor({ engine: "kubernetes", namespace: "ns", context: "prod" })).toEqual({
      namespace: "ns",
      kubeContext: "prod",
    });
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
