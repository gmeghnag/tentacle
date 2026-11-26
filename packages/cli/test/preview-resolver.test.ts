/**
 * The serve's engine side of container previews
 * (docs/feat/container-apps-devices.md Design 1/4): the endpoint from its env,
 * a remote one refused before any request, every call a fresh inspect, 404 =
 * gone, anything else the engine said = transient. A fake engine client.
 */
import { describe, expect, test } from "bun:test";
import { type ContainerInspect, DockerApiError, type EngineEndpoint } from "@tentacle/docker";
import type { PreviewRow } from "@tentacle/protocol";
import { type PreviewEngineIO, enginePreviewResolver } from "../src/preview-resolver.ts";

const ID = "a".repeat(64);
const inspect: ContainerInspect = {
  Id: ID,
  Name: "/web",
  Image: "sha256:1",
  State: { Running: true },
  Config: { Image: "nginx" },
  HostConfig: { NetworkMode: "bridge", Privileged: false },
  NetworkSettings: { Ports: { "80/tcp": [{ HostIp: "127.0.0.1", HostPort: "8080" }] } },
};
const row: PreviewRow = {
  id: "p",
  containerId: ID,
  engine: "docker",
  name: "web",
  image: "nginx",
  containerPort: 80,
  createdAt: 0,
};

function rig(env: Record<string, string> = {}) {
  const calls: { endpoint: EngineEndpoint; id: string }[] = [];
  const state: { answer: ContainerInspect | Error } = { answer: inspect };
  const io: PreviewEngineIO = {
    env,
    platform: "linux",
    uid: 1000,
    tmpdir: "/nonexistent",
    homeDir: "/nonexistent",
    readFile: () => undefined,
    exists: () => false,
    listDir: () => [],
    inspect: async (endpoint, id) => {
      calls.push({ endpoint, id });
      if (state.answer instanceof Error) throw state.answer;
      return state.answer;
    },
  };
  return { resolver: enginePreviewResolver(io), calls, state };
}

const request = { container: "web", port: 80, engine: "docker" } as const;

describe("prepare", () => {
  test("the engine's facts, from the env's unix socket", async () => {
    const r = rig({ DOCKER_HOST: "unix:///run/me/docker.sock" });
    const prepared = await r.resolver.prepare(request);
    expect(prepared.ok && prepared.facts).toMatchObject({
      id: ID,
      name: "web",
      hostPort: 8080,
      endpointLabel: "unix:///run/me/docker.sock",
    });
    expect(r.calls.map((c) => c.id)).toEqual(["web"]);
  });

  test("podman resolves its own endpoint", async () => {
    const r = rig({ CONTAINER_HOST: "unix:///run/me/podman.sock" });
    const prepared = await r.resolver.prepare({ ...request, engine: "podman" });
    expect(prepared.ok && prepared.facts.endpointLabel).toBe("unix:///run/me/podman.sock");
    expect(prepared.ok && prepared.facts.engine).toBe("podman");
  });

  test("a remote engine is refused before any request", async () => {
    for (const DOCKER_HOST of ["tcp://10.0.0.1:2375", "ssh://me@host"]) {
      const r = rig({ DOCKER_HOST });
      const prepared = await r.resolver.prepare(request);
      expect(prepared.ok).toBe(false);
      expect(r.calls).toEqual([]);
    }
  });

  test("a name the engine could never have is refused, no request", async () => {
    const r = rig();
    for (const container of ["..", "a/b", "-x", "a?b", "a b"]) {
      expect((await r.resolver.prepare({ ...request, container })).ok).toBe(false);
    }
    expect(r.calls).toEqual([]);
  });

  test("the pure refusals apply", async () => {
    const r = rig();
    r.state.answer = { ...inspect, HostConfig: { Privileged: true } };
    const prepared = await r.resolver.prepare(request);
    expect(prepared.ok ? "" : prepared.reason).toContain("privileged");
  });
});

describe("resolve", () => {
  test("by the recorded full id and port, a fresh inspect every call", async () => {
    const r = rig();
    await r.resolver.resolve(row);
    r.state.answer = {
      ...inspect,
      NetworkSettings: { Ports: { "80/tcp": [{ HostIp: "127.0.0.1", HostPort: "9999" }] } },
    };
    const second = await r.resolver.resolve(row);
    expect(second.ok && second.facts.hostPort).toBe(9999);
    expect(r.calls.map((c) => c.id)).toEqual([ID, ID]);
  });

  test("404 → gone (not transient)", async () => {
    const r = rig();
    r.state.answer = new DockerApiError(404, "No such container", "");
    const resolved = await r.resolver.resolve(row);
    expect(resolved.ok).toBe(false);
    expect(resolved.ok ? undefined : resolved.transient).toBeUndefined();
  });

  test("unreachable or a server error → transient", async () => {
    for (const error of [new Error("ENOENT"), new DockerApiError(500, "boom", "")]) {
      const r = rig();
      r.state.answer = error;
      const resolved = await r.resolver.resolve(row);
      expect(resolved.ok ? undefined : resolved.transient).toBe(true);
    }
  });

  test("an endpoint that turned remote → refused", async () => {
    const r = rig({ DOCKER_HOST: "tcp://10.0.0.1:2375" });
    expect((await r.resolver.resolve(row)).ok).toBe(false);
    expect(r.calls).toEqual([]);
  });
});
