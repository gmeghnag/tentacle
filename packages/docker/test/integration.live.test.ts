import { afterAll, describe, expect, test } from "bun:test";
/**
 * Opt-in LIVE integration test against real Docker/Podman engines. Skipped
 * unless `TENTACLE_DOCKER_TESTS=1`, so the normal suite never needs an engine.
 *
 * Per endpoint: ping/version; a `busybox` container (`sleep 300`); the exec
 * channel with frames sent before the 101 (`cat` echoes them); `close()` ends
 * `cat` with exit 0 (half-close = stdin EOF); `runExec` of 8 MiB through stdin;
 * a real exit code + stderr; a missing binary; exec into a stopped container;
 * and exec-injection into a read-only rootfs with an `exec` tmpfs `/tmp` (and a
 * PRINT, not an assert, of whether a default tmpfs allows exec).
 *
 * Every container is labelled `tentacle.test=docker-engine-client` and removed
 * in `afterAll`; check with
 * `docker ps -a --filter label=tentacle.test=docker-engine-client` (empty).
 *
 * Run it:
 *
 *   TENTACLE_DOCKER_TESTS=1 bun test packages/docker/test/integration.live.test.ts
 *
 *   # Podman (stopped by default — this test starts nothing):
 *   podman machine start
 *   TENTACLE_DOCKER_TESTS=1 TENTACLE_DOCKER_CONTEXTS=desktop-linux,podman \
 *     bun test packages/docker/test/integration.live.test.ts
 *   podman machine stop
 *
 *   # A remote TLS engine, resolved from the usual env:
 *   TENTACLE_DOCKER_TESTS=1 TENTACLE_DOCKER_TCP_HOST=tcp://h:2376 DOCKER_TLS_VERIFY=1 \
 *     DOCKER_CERT_PATH=~/.docker/h bun test packages/docker/test/integration.live.test.ts
 *
 *   # A remote engine over ssh (`ssh <host> docker system dial-stdio`): the
 *   host must be reachable with key-based auth (batch mode) and have the docker CLI.
 *   TENTACLE_DOCKER_TESTS=1 TENTACLE_DOCKER_SSH_HOST=user@host \
 *     bun test packages/docker/test/integration.live.test.ts
 *
 * Image: `TENTACLE_DOCKER_IMAGE` ?? `busybox:latest` (pulled through `pullImage`).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { socketDialer } from "../src/byte-duplex.ts";
import { DockerClient } from "../src/client.ts";
import {
  type EngineEndpoint,
  endpointLabel,
  resolveEngineEndpoint,
} from "../src/engine-endpoint.ts";
import { sshDialer } from "../src/ssh-dialer.ts";

const ENABLED = process.env.TENTACLE_DOCKER_TESTS === "1";
const IMAGE = process.env.TENTACLE_DOCKER_IMAGE ?? "busybox:latest";
const LABEL = { "tentacle.test": "docker-engine-client" };

const readFile = (p: string): string | undefined => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
};

interface Target {
  readonly name: string;
  readonly endpoint: () => EngineEndpoint;
}

function targets(): Target[] {
  const env = { ...process.env, HOME: process.env.HOME ?? homedir() };
  const contexts = (process.env.TENTACLE_DOCKER_CONTEXTS ?? "").split(",").filter((c) => c !== "");
  const out: Target[] = contexts.length
    ? contexts.map((context) => ({
        name: `context ${context}`,
        endpoint: () => resolveEngineEndpoint({ env, context, readFile }),
      }))
    : [{ name: "current context", endpoint: () => resolveEngineEndpoint({ env, readFile }) }];
  const tcp = process.env.TENTACLE_DOCKER_TCP_HOST;
  if (tcp) {
    out.push({
      name: tcp,
      endpoint: () => resolveEngineEndpoint({ env: { ...env, DOCKER_HOST: tcp }, readFile }),
    });
  }
  const ssh = process.env.TENTACLE_DOCKER_SSH_HOST;
  if (ssh) {
    out.push({
      name: `ssh://${ssh}`,
      endpoint: () =>
        resolveEngineEndpoint({ env: { ...env, DOCKER_HOST: `ssh://${ssh}` }, readFile }),
    });
  }
  return out;
}

// Each removal is bounded by `removeContainer` itself (kill + delete, 30 s); they
// run in parallel, so the hook needs at most one bound plus slack — not bun's
// default 5 s, which Podman's sequential stop-then-remove used to blow.
const CLEANUP_HOOK_TIMEOUT_MS = 45_000;
// `@types/bun` 1.1 omits the hook timeout argument; Bun ≥1.4 honours it (probed).
const afterAllWithTimeout = afterAll as unknown as (
  fn: () => Promise<void>,
  timeoutMs: number,
) => void;
const cleanups: Array<() => Promise<void>> = [];
afterAllWithTimeout(async () => {
  const started = Date.now();
  const results = await Promise.allSettled(cleanups.map((c) => c()));
  const failed = results.filter((r) => r.status === "rejected");
  if (cleanups.length > 0) {
    console.log(
      `[live] cleanup: ${cleanups.length} container(s) removed in ${Date.now() - started}ms`,
    );
  }
  if (failed.length > 0) {
    throw new Error(
      `[live] ${failed.length} container(s) NOT removed: ${failed.map((f) => String((f as PromiseRejectedResult).reason)).join("; ")}`,
    );
  }
}, CLEANUP_HOOK_TIMEOUT_MS);

const enc = new TextEncoder();

for (const target of ENABLED
  ? targets()
  : [{ name: "(disabled)", endpoint: () => ({}) as EngineEndpoint }]) {
  describe(`live docker engine: ${target.name} (opt-in: TENTACLE_DOCKER_TESTS=1)`, () => {
    test.skipIf(!ENABLED)(
      "lifecycle + exec channel + runExec + read-only rootfs",
      async () => {
        const ep = target.endpoint();
        // unix/tcp over `Bun.connect`; ssh over `ssh … docker system dial-stdio`
        // (the third `Dialer` of the same code path, slice A2).
        const dial = ep.kind === "ssh" ? sshDialer(ep) : socketDialer(ep);
        const docker = new DockerClient({
          dial: dial,
          endpointLabel: `${ep.source} (${endpointLabel(ep)})`,
        });
        const ping = await docker.ping();
        const version = await docker.version();
        console.log(
          `[live] ${target.name}: ${endpointLabel(ep)} engine ${version.Version} API ${ping.apiVersion} → ${await docker.apiPath()}`,
        );

        await docker.pullImage(IMAGE);
        const stamp = Date.now().toString(36);
        const make = async (
          suffix: string,
          hostConfig: Record<string, unknown> = {},
        ): Promise<string> => {
          const { id } = await docker.createContainer(`tentacle-live-${suffix}-${stamp}`, {
            Image: IMAGE,
            Cmd: ["sleep", "300"],
            Labels: LABEL,
            HostConfig: hostConfig,
          });
          cleanups.push(() => docker.removeContainer(id));
          await docker.startContainer(id);
          await docker.waitForRunning(id, { timeoutMs: 30_000 });
          return id;
        };
        const id = await make("main");

        // Exec channel: two frames before the 101, echoed by cat; close() ends cat (stdin EOF).
        const stderr: string[] = [];
        const channel = docker.openExec(
          { container: id, command: ["cat"] },
          { onStderr: (t) => stderr.push(t) },
        );
        const got: string[] = [];
        const both = new Promise<void>((resolve) =>
          channel.setOnMessage((m) => {
            got.push(m);
            if (got.length === 2) {
              resolve();
            }
          }),
        );
        channel.send('{"id":1}');
        channel.send('{"id":2}');
        await both;
        expect(got).toEqual(['{"id":1}', '{"id":2}']);
        expect(stderr).toEqual([]);
        channel.close();
        // The cat process must have exited 0 on stdin EOF: no `cat` left running.
        let ps = await docker.runExec({
          container: id,
          command: ["sh", "-c", "ps -o comm | grep -c '^cat$' || true"],
        });
        for (let i = 0; i < 20 && ps.stdout.trim() !== "0"; i++) {
          await Bun.sleep(50);
          ps = await docker.runExec({
            container: id,
            command: ["sh", "-c", "ps -o comm | grep -c '^cat$' || true"],
          });
        }
        expect(ps.stdout.trim()).toBe("0");

        // runExec: 8 MiB through stdin, half-close = EOF, wc counts it.
        const big = new Uint8Array(8 * 1024 * 1024).fill(0x61);
        const sent = await docker.runExec(
          { container: id, command: ["sh", "-c", "cat > /tmp/b; wc -c < /tmp/b"] },
          big,
          { timeoutMs: 60_000 },
        );
        expect(sent.exitCode).toBe(0);
        expect(sent.stdout.trim()).toBe("8388608");

        // A real exit code and stderr.
        const seven = await docker.runExec({
          container: id,
          command: ["sh", "-c", "echo e >&2; exit 7"],
        });
        expect(seven.exitCode).toBe(7);
        expect(seven.stderr).toBe("e\n");

        // A binary that is not in the image → a plain message, not an obscure one.
        const missing = await docker.runExec({ container: id, command: ["no-such-binary-here"] });
        console.log(`[live] missing binary → exit ${missing.exitCode}, status: ${missing.status}`);
        expect(missing.exitCode === 126 || missing.exitCode === 127).toBe(true);
        expect(missing.status).toContain('command "no-such-binary-here" could not be started');

        // Read-only rootfs + an exec tmpfs /tmp: injection into /tmp works, the rootfs refuses writes.
        const ro = await make("ro", { ReadonlyRootfs: true, Tmpfs: { "/tmp": "rw,exec" } });
        const rofs = await docker.runExec({
          container: ro,
          command: ["sh", "-c", "echo x > /bin/x"],
        });
        expect(rofs.exitCode).not.toBe(0);
        expect(rofs.stderr).toContain("Read-only");
        const inject = await docker.runExec(
          { container: ro, command: ["sh", "-c", "cat > /tmp/x && chmod +x /tmp/x && /tmp/x"] },
          enc.encode("#!/bin/sh\necho injected-ok\n"),
        );
        expect(inject.stdout.trim()).toBe("injected-ok");
        expect(inject.exitCode).toBe(0);

        // Informational: does a default tmpfs allow exec? (input for slice C's --bin-dir guidance)
        const def = await make("tmpfs-default", { ReadonlyRootfs: true, Tmpfs: { "/tmp": "" } });
        const defExec = await docker.runExec(
          {
            container: def,
            command: [
              "sh",
              "-c",
              "cat > /tmp/x && chmod +x /tmp/x && /tmp/x; grep ' /tmp ' /proc/mounts",
            ],
          },
          enc.encode("#!/bin/sh\necho default-tmpfs-exec-ok\n"),
        );
        console.log(
          `[live] default Tmpfs /tmp → exit ${defExec.exitCode}; ${defExec.stdout.trim()} ${defExec.stderr.trim()}`,
        );

        // Exec into a stopped container → actionable "not running".
        await docker.stopContainer(id, 0);
        await expect(docker.runExec({ container: id, command: ["true"] })).rejects.toThrow(
          /is not running/,
        );
      },
      180_000,
    );
  });
}
