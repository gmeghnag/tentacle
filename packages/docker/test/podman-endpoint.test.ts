import { describe, expect, test } from "bun:test";
import { contextStoreKey } from "../src/engine-endpoint.ts";
import {
  type PodmanEndpointInput,
  podmanSocketCandidates,
  resolvePodmanEndpoint,
} from "../src/podman-endpoint.ts";

// Podman socket discovery (docs/feat/docker-engine-cli.md, owner decision:
// `--engine podman` needs no DOCKER_HOST). The filesystem is injected.
const MAC_TMP = "/var/folders/gf/x/T/";
const MAC_SOCK = "/var/folders/gf/x/T/podman/podman-machine-default-api.sock";

function input(
  over: Partial<PodmanEndpointInput> & {
    files?: readonly string[];
    dirs?: Record<string, string[]>;
  },
): PodmanEndpointInput {
  const files = new Set(over.files ?? []);
  return {
    env: {},
    platform: "linux",
    tmpdir: "/tmp",
    homeDir: "/home/u",
    exists: (path) => files.has(path),
    listDir: (dir) => over.dirs?.[dir] ?? [],
    readFile: () => undefined,
    ...over,
  };
}

describe("podmanSocketCandidates", () => {
  test("macOS: the podman 5 machine socket in TMPDIR first, then other machines, then podman 4 paths", () => {
    const list = podmanSocketCandidates(
      input({
        platform: "darwin",
        env: { TMPDIR: MAC_TMP, HOME: "/Users/u" },
        dirs: { "/var/folders/gf/x/T/podman": ["other-api.sock", "gvproxy.sock"] },
      }),
    );
    expect(list).toEqual([
      MAC_SOCK,
      "/var/folders/gf/x/T/podman/other-api.sock",
      "/Users/u/.local/share/containers/podman/machine/podman.sock",
      "/Users/u/.local/share/containers/podman/machine/qemu/podman.sock",
    ]);
  });

  test("Linux: rootless XDG_RUNTIME_DIR, then /run/user/<uid>, then rootful", () => {
    expect(
      podmanSocketCandidates(input({ env: { XDG_RUNTIME_DIR: "/run/user/1000" }, uid: 1000 })),
    ).toEqual(["/run/user/1000/podman/podman.sock", "/run/podman/podman.sock"]);
    expect(podmanSocketCandidates(input({ env: { XDG_RUNTIME_DIR: "/xdg" }, uid: 1000 }))).toEqual([
      "/xdg/podman/podman.sock",
      "/run/user/1000/podman/podman.sock",
      "/run/podman/podman.sock",
    ]);
  });
});

describe("resolvePodmanEndpoint", () => {
  test("macOS: the discovered machine socket, labelled as discovered", () => {
    const ep = resolvePodmanEndpoint(
      input({ platform: "darwin", env: { TMPDIR: MAC_TMP }, files: [MAC_SOCK] }),
    );
    expect(ep).toEqual({
      kind: "unix",
      path: MAC_SOCK,
      local: true,
      source: "podman socket (auto-discovered)",
    });
  });

  test("the first existing candidate wins (rootless before rootful)", () => {
    const ep = resolvePodmanEndpoint(
      input({
        env: { XDG_RUNTIME_DIR: "/run/user/1000" },
        uid: 1000,
        files: ["/run/user/1000/podman/podman.sock", "/run/podman/podman.sock"],
      }),
    );
    expect(ep).toMatchObject({ kind: "unix", path: "/run/user/1000/podman/podman.sock" });
  });

  test("DOCKER_HOST / DOCKER_CONTEXT are IGNORED: they name Docker's engine, not podman's", () => {
    const ep = resolvePodmanEndpoint(
      input({
        env: { DOCKER_HOST: "unix:///var/run/docker.sock", DOCKER_CONTEXT: "desktop-linux" },
        files: ["/run/podman/podman.sock"],
      }),
    );
    expect(ep).toMatchObject({ kind: "unix", path: "/run/podman/podman.sock" });
  });

  test("CONTAINER_HOST (podman's own override) wins over discovery", () => {
    const ep = resolvePodmanEndpoint(
      input({
        env: { CONTAINER_HOST: "unix:///custom/podman.sock" },
        files: ["/run/podman/podman.sock"],
      }),
    );
    expect(ep).toEqual({
      kind: "unix",
      path: "/custom/podman.sock",
      local: true,
      source: "CONTAINER_HOST",
    });
  });

  test("CONTAINER_HOST plaintext tcp is refused unless --insecure-docker-tcp", () => {
    const env = { CONTAINER_HOST: "tcp://box:8888" };
    expect(() => resolvePodmanEndpoint(input({ env }))).toThrow(
      /refusing plaintext tcp:\/\/box:8888 \(CONTAINER_HOST\).*--insecure-docker-tcp/,
    );
    expect(resolvePodmanEndpoint(input({ env, allowInsecureTcp: true }))).toMatchObject({
      kind: "tcp",
      host: "box",
      port: 8888,
      insecure: true,
    });
  });

  test("CONTAINER_HOST ssh:// is an actionable error, never a silent fallback to a local socket", () => {
    expect(() =>
      resolvePodmanEndpoint(
        input({
          env: { CONTAINER_HOST: "ssh://core@127.0.0.1:50123/run/user/501/podman/podman.sock" },
          files: ["/run/podman/podman.sock"],
        }),
      ),
    ).toThrow(/CONTAINER_HOST=ssh:\/\/ is not supported for --engine podman/);
  });

  test("an explicit --context (a docker context) wins over everything", () => {
    const key = contextStoreKey("podman");
    const ep = resolvePodmanEndpoint(
      input({
        context: "podman",
        env: { HOME: "/home/u", CONTAINER_HOST: "unix:///ignored.sock" },
        readFile: (path) =>
          path === `/home/u/.docker/contexts/meta/${key}/meta.json`
            ? JSON.stringify({ Endpoints: { docker: { Host: "unix:///ctx/podman.sock" } } })
            : undefined,
      }),
    );
    expect(ep).toMatchObject({
      kind: "unix",
      path: "/ctx/podman.sock",
      source: 'context "podman"',
    });
  });

  test("no socket anywhere → the exact actionable error, listing where it looked", () => {
    expect(() => resolvePodmanEndpoint(input({ uid: 1000 }))).toThrow(
      "no Podman socket found (looked in: /run/user/1000/podman/podman.sock, /run/podman/podman.sock) — start it with `podman machine start` (macOS) or `systemctl --user enable --now podman.socket` (Linux), or set CONTAINER_HOST",
    );
  });
});
