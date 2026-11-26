/**
 * docs/feat/container-apps-devices.md OD3/OD4: which container may be shown to
 * the paired devices, and which host port is dialled. Pure.
 * Mutations: drop the privileged check, the host-network check, the socket-mount
 * check or the HostIp filter → its case fails.
 */
import { describe, expect, test } from "bun:test";
import type { EngineEndpoint } from "../src/engine-endpoint.ts";
import { previewTargetOf } from "../src/preview-target.ts";
import type { ContainerInspect } from "../src/types.ts";

const UNIX: EngineEndpoint = {
  kind: "unix",
  path: "/Users/me/.docker/run/engine.sock",
  local: true,
  source: "test",
};
const ID = "a".repeat(64);

function inspect(over: Partial<ContainerInspect> = {}): ContainerInspect {
  return {
    Id: ID,
    Name: "/web",
    Image: `sha256:${"b".repeat(64)}`,
    State: { Running: true },
    Config: { Image: "nginx:latest" },
    HostConfig: { NetworkMode: "bridge", Privileged: false },
    NetworkSettings: { Ports: { "80/tcp": [{ HostIp: "127.0.0.1", HostPort: "8080" }] } },
    Mounts: [],
    ...over,
  };
}

const ports = (bindings: unknown): Partial<ContainerInspect> => ({
  NetworkSettings: { Ports: bindings as never },
});

const run = (i: ContainerInspect, port = 80, endpoint: EngineEndpoint = UNIX) =>
  previewTargetOf({ inspect: i, port, engine: "docker", endpoint });

function reasonOf(r: ReturnType<typeof run>): string {
  return r.ok ? "" : r.reason;
}

describe("accepted", () => {
  for (const hostIp of ["127.0.0.1", "0.0.0.0", ""]) {
    test(`HostIp ${JSON.stringify(hostIp)}: the engine's facts, dialling its host port`, () => {
      const r = run(inspect(ports({ "80/tcp": [{ HostIp: hostIp, HostPort: "8080" }] })));
      expect(r).toEqual({
        ok: true,
        facts: {
          engine: "docker",
          endpointLabel: "unix:///Users/me/.docker/run/engine.sock",
          id: ID,
          name: "web",
          image: "nginx:latest",
          imageId: `sha256:${"b".repeat(64)}`,
          containerPort: 80,
          hostPort: 8080,
          hostIp,
        },
      });
    });
  }

  test("a wildcard binding is reported even when a loopback one comes first", () => {
    const r = run(
      inspect(
        ports({
          "80/tcp": [
            { HostIp: "::", HostPort: "1111" },
            { HostIp: "127.0.0.1", HostPort: "2222" },
            { HostIp: "0.0.0.0", HostPort: "3333" },
          ],
        }),
      ),
    );
    expect(r.ok && r.facts.hostIp).toBe("0.0.0.0");
    expect(r.ok && r.facts.hostPort).toBe(3333);
  });
});

describe("refused", () => {
  const refused = (r: ReturnType<typeof run>, word: RegExp) => {
    expect(r.ok).toBe(false);
    expect(reasonOf(r)).toMatch(word);
    expect(r.ok ? undefined : r.transient).toBeUndefined();
  };

  test("IPv6-only (::1, ::) with the publish hint", () => {
    for (const hostIp of ["::1", "::"]) {
      refused(
        run(inspect(ports({ "80/tcp": [{ HostIp: hostIp, HostPort: "8080" }] }))),
        /-p 127\.0\.0\.1:<host>:80/,
      );
    }
  });

  test("another address", () => {
    refused(
      run(inspect(ports({ "80/tcp": [{ HostIp: "192.168.1.5", HostPort: "8080" }] }))),
      /not published/,
    );
  });

  test("udp only", () => {
    refused(
      run(inspect(ports({ "80/udp": [{ HostIp: "127.0.0.1", HostPort: "8080" }] }))),
      /not published/,
    );
  });

  test("unpublished (null, empty, absent, no NetworkSettings)", () => {
    refused(run(inspect(ports({ "80/tcp": null }))), /not published/);
    refused(run(inspect(ports({ "80/tcp": [] }))), /not published/);
    refused(run(inspect(ports({}))), /not published/);
    refused(run(inspect({ NetworkSettings: undefined })), /not published/);
  });

  test("a different container port", () => {
    refused(run(inspect(), 81), /not published/);
  });

  test("an unreadable host port", () => {
    for (const HostPort of ["", "0", "70000", "80x"]) {
      refused(
        run(inspect(ports({ "80/tcp": [{ HostIp: "127.0.0.1", HostPort }] }))),
        /not published/,
      );
    }
  });

  test("not running (stopped, or no State)", () => {
    refused(run(inspect({ State: { Running: false } })), /not running/);
    refused(run(inspect({ State: undefined })), /not running/);
  });

  test("host network", () => {
    refused(run(inspect({ HostConfig: { NetworkMode: "host" } })), /host network/);
  });

  test("privileged", () => {
    refused(
      run(inspect({ HostConfig: { NetworkMode: "bridge", Privileged: true } })),
      /privileged/,
    );
  });

  test("no HostConfig to check: fail closed", () => {
    refused(run(inspect({ HostConfig: undefined })), /cannot be checked/);
  });

  test("an engine socket mounted: source, destination, or the endpoint's own path", () => {
    for (const mount of [
      { Source: "/var/run/docker.sock", Destination: "/x" },
      { Source: "/x", Destination: "/var/run/docker.sock" },
      { Source: "/run/podman/podman.sock", Destination: "/y" },
      { Source: "/x", Destination: "/tmp/podman.sock" },
      { Source: UNIX.kind === "unix" ? UNIX.path : "", Destination: "/z" },
      { Source: "/z", Destination: UNIX.kind === "unix" ? UNIX.path : "" },
    ]) {
      refused(
        run(inspect({ Mounts: [{ Source: "/data", Destination: "/data" }, mount] })),
        /socket/,
      );
    }
  });

  describe("a mounted parent directory of an engine socket", () => {
    const at = (path: string): EngineEndpoint => ({
      kind: "unix",
      path,
      local: true,
      source: "test",
    });
    const mounting = (Source: string, endpoint: EngineEndpoint = UNIX, runtimeDir?: string) =>
      previewTargetOf({
        inspect: inspect({ Mounts: [{ Source, Destination: "/host" }] }),
        port: 80,
        engine: "docker",
        endpoint,
        ...(runtimeDir === undefined ? {} : { runtimeDir }),
      });

    for (const source of ["/var/run", "/", "/run"]) {
      test(`${source}, the endpoint being /var/run/docker.sock`, () => {
        refused(mounting(source, at("/var/run/docker.sock")), /socket/);
      });
    }

    test("of the endpoint's own socket, any depth, however it is spelled", () => {
      for (const source of [
        "/Users",
        "/Users/me",
        "/Users/me/.docker/run",
        "/Users/me/.docker/run/",
        "//Users/./me",
        "/Users/me/project/..",
      ]) {
        refused(mounting(source), /socket/);
      }
    });

    test("of a well-known socket, whatever the endpoint is", () => {
      for (const source of ["/var", "/var/run", "/run", "/run/podman", "/var/run/podman"]) {
        refused(mounting(source), /socket/);
      }
    });

    test("of a rootless socket under XDG_RUNTIME_DIR", () => {
      for (const source of ["/xdg", "/xdg/user", "/xdg/user/docker", "/xdg/user/podman"]) {
        refused(mounting(source, UNIX, "/xdg/user/"), /socket/);
      }
    });

    test("a sibling, a child or a name prefix is still accepted", () => {
      for (const source of [
        "",
        "/data",
        "/var/runner",
        "/var/lib/docker/volumes/v/_data",
        "/run/secrets",
        "/Users/me/project",
        "/Users/me/.docker/ru",
      ]) {
        expect(mounting(source).ok).toBe(true);
      }
      for (const source of ["/xdg/user/app", "/xdg/use"]) {
        expect(mounting(source, UNIX, "/xdg/user").ok).toBe(true);
      }
      // An empty runtime dir protects nothing extra (never `/docker`).
      expect(mounting("/docker", UNIX, "").ok).toBe(true);
    });
  });

  test("a non-local engine (tcp, ssh)", () => {
    const remotes: EngineEndpoint[] = [
      { kind: "tcp", host: "h", port: 2375, local: false, source: "test" },
      { kind: "ssh", host: "h", local: false, source: "test" },
    ];
    for (const endpoint of remotes) {
      refused(run(inspect(), 80, endpoint), /remote/);
    }
  });

  test("a container port outside 1..65535", () => {
    refused(run(inspect(), 0), /port/);
    refused(run(inspect(), 65536), /port/);
  });
});
