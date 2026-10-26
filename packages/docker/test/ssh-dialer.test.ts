import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/**
 * `sshDialer` — the third `Dialer` of the same code path as `socketDialer`.
 * Hermetic: a fake `ssh` (a script on a temp PATH that bridges stdio to a
 * `Bun.listen` unix fake engine, `test/fake-engine.ts`) plus a `spawner` seam
 * that records the exact argv / env / options (like `PodDeleteSpawner`,
 * `k8s/pod-cleanup.ts:155`) so the argv `--` guard, the env scrub +
 * `SSH_AUTH_SOCK` re-add, the stderr capture, and the process-group kill are
 * each pinned without a real `ssh`. T3 proves the client only ever sees a
 * `Dialer` by running a REAL request + an exec hijack through the REAL dialer.
 *
 * The live path (a real `ssh://` engine) is opt-in via `TENTACLE_DOCKER_SSH_HOST`
 * (see `integration.live.test.ts`) and is skipped here.
 */
import type { Subprocess } from "bun";
import type { ByteDuplex } from "../src/byte-duplex.ts";
import { DockerClient } from "../src/client.ts";
import { endpointLabel } from "../src/engine-endpoint.ts";
import { execStartRequest } from "../src/exec-channel.ts";
import { runExec } from "../src/exec-run.ts";
import {
  DEFAULT_SSH_SPAWNER,
  SSH_STDERR_CAP,
  type SshEndpoint,
  type SshSpawner,
  classifySshExit,
  decodeStderr,
  pushStderr,
  sshDialer,
  sshEnv,
  sshSpawnError,
} from "../src/ssh-dialer.ts";

// A short-lived dir; macOS caps a unix socket path at 104 bytes.
const dir = mkdtempSync(join(tmpdir(), "tdk-ssh-"));
const socketPath = join(dir, "engine.sock");
const fakeEngine = join(import.meta.dir, "fake-engine.ts");

type Seen = { argv: string[]; env: Record<string, string>; options: Record<string, unknown> };

const EP: SshEndpoint = {
  kind: "ssh",
  host: "remote.example",
  user: "deploy",
  port: 2222,
  local: false,
  source: 'context "remote"',
};
const EP_NOOPT: SshEndpoint = {
  kind: "ssh",
  host: "plain.example",
  local: false,
  source: "DOCKER_HOST",
};
const LABEL = endpointLabel(EP);

let engine: Subprocess | undefined;
beforeAll(async () => {
  engine = Bun.spawn([process.execPath, fakeEngine], {
    env: { ...process.env, FAKE_ENGINE_SOCKET: socketPath },
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      const s = await Bun.connect({
        unix: socketPath,
        socket: { data() {}, end() {}, close() {} },
      } as unknown as Parameters<typeof Bun.connect>[0]);
      s.end?.();
      return;
    } catch {
      await Bun.sleep(20);
    }
  }
  throw new Error("fake engine did not start");
});
afterAll(() => {
  engine?.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});

/** The bridge: forward the fake engine's socket to the child's stdio (what
 * `ssh <host> docker system dial-stdio` does). One process per connection. */
const BRIDGE = `
const s = await Bun.connect({ unix: process.env.FAKE_ENGINE_SOCKET, socket: {
  data(_s, c) { process.stdout.write(c); },
  close() { process.stdout.end(); },
} });
process.stdin.on("data", (c) => s.write(c));
process.stdin.on("end", () => s.end());
`;

/**
 * Write a fake `ssh` (a bun script) to the temp dir and return a dialer whose
 * spawner records each spawn into `records` (a FRESH array, so tests are
 * isolated) before spawning it for real (so the stdio is live). `baseEnv` is
 * the env the dialer scrubs (defaults to `process.env`; a synthetic one lets
 * the env test assert the scrub + `SSH_AUTH_SOCK` re-add without touching the
 * test process's own env).
 */
function withFakeSsh(
  ep: SshEndpoint,
  script: string,
  baseEnv: Readonly<Record<string, string | undefined>> = process.env,
): { dial: () => Promise<ByteDuplex>; records: Seen[] } {
  const records: Seen[] = [];
  const sshPath = join(dir, `ssh-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(sshPath, script);
  const spawner: SshSpawner = (cmd, env, options) => {
    records.push({ argv: [...cmd], env: { ...env }, options: { ...options } });
    return Bun.spawn([process.execPath, sshPath, ...cmd.slice(1)], {
      env,
      ...options,
      ...({ detached: true } as object),
    }) as Subprocess<"pipe", "pipe", "pipe">;
  };
  const dialer = sshDialer(ep, {
    spawner,
    env: baseEnv,
    envOverride: { PATH: dir, FAKE_ENGINE_SOCKET: socketPath },
  });
  return { dial: () => dialer(), records };
}

describe("sshDialer: the exact argv (the `--` guard)", () => {
  test("argv is exactly the §9 spec, `--` immediately before the host", async () => {
    const { dial, records } = withFakeSsh(EP, BRIDGE);
    await dial();
    const argv = records[0]?.argv;
    expect(records.length).toBe(1);
    expect(argv).toEqual([
      "ssh",
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "-l",
      "deploy",
      "-p",
      "2222",
      "--",
      "remote.example",
      "docker",
      "system",
      "dial-stdio",
    ]);
    // The `--` must immediately precede the host: a `-…` host could not be an option.
    const dd = (argv ?? []).indexOf("--");
    expect(dd).toBeGreaterThan(-1);
    expect(argv?.[dd + 1]).toBe("remote.example");
    // `-l`/`-p` come before `--`, so a user-supplied value is never parsed as an option.
    expect((argv ?? []).indexOf("-l")).toBeLessThan(dd);
    expect((argv ?? []).indexOf("-p")).toBeLessThan(dd);
  });

  test("user/port are omitted when the endpoint has none", async () => {
    const { dial, records } = withFakeSsh(EP_NOOPT, BRIDGE);
    await dial();
    const argv = records[0]?.argv;
    expect(records.length).toBe(1);
    expect(argv?.includes("-l")).toBe(false);
    expect(argv?.includes("-p")).toBe(false);
    expect(argv?.slice(-5)).toEqual(["--", "plain.example", "docker", "system", "dial-stdio"]);
  });

  test("the child is spawned `detached` with all stdio piped (never inherited)", async () => {
    const { dial, records } = withFakeSsh(EP, BRIDGE);
    await dial();
    const options = records[0]?.options;
    expect(options?.stdin).toBe("pipe");
    expect(options?.stdout).toBe("pipe");
    // stderr must be piped, never inherited (a failing ssh must not scribble on the TUI).
    expect(options?.stderr).toBe("pipe");
  });
});

describe("sshDialer: env = scrubbed + SSH_AUTH_SOCK re-added", () => {
  test("secrets are scrubbed, SSH_AUTH_SOCK is kept", async () => {
    // A synthetic base env: a secret-looking var + the agent socket. The dialer
    // must scrub the secret and re-add SSH_AUTH_SOCK (scrubSensitiveEnv drops
    // it via /AUTH/), leaving what the child actually receives.
    const { dial, records } = withFakeSsh(EP, BRIDGE, {
      PATH: "/usr/bin",
      HOME: "/home/u",
      TENTACLE_TEST_SECRET_XYZ: "leak-me",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
    });
    await dial();
    const env = records[0]?.env;
    expect(env).toBeDefined();
    // the secret is scrubbed out of the child's env
    expect("TENTACLE_TEST_SECRET_XYZ" in (env ?? {})).toBe(false);
    // the agent socket survives (re-added after scrub dropped it)
    expect(env?.SSH_AUTH_SOCK).toBe("/tmp/agent.sock");
  });

  test("sshEnv re-adds SSH_AUTH_SOCK and scrubs secrets (pure)", () => {
    const built = sshEnv({ SSH_AUTH_SOCK: "/a", SOME_API_KEY: "x", PATH: "/p", HOME: "/h" });
    expect("SOME_API_KEY" in built).toBe(false);
    expect(built.PATH).toBe("/p");
    expect(built.HOME).toBe("/h");
    expect(built.SSH_AUTH_SOCK).toBe("/a");
    // an override wins (tests inject a fake-ssh PATH + socket)
    const overlaid = sshEnv({ SSH_AUTH_SOCK: "/a" }, { PATH: "/override" });
    expect(overlaid.PATH).toBe("/override");
    expect(overlaid.SSH_AUTH_SOCK).toBe("/a");
  });
});

describe("sshDialer: stderr is piped + captured, never inherited", () => {
  test("a failing ssh's stderr is captured into the onEnd error", async () => {
    const { dial } = withFakeSsh(
      EP,
      `process.stderr.write("ssh: connect to host remote.example port 22: Connection refused\\n"); process.exit(255);`,
    );
    const duplex = await dial();
    const ended = new Promise<Error | undefined>((resolve) => duplex.setOnEnd((e) => resolve(e)));
    duplex.write(
      new TextEncoder().encode("GET /_ping HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n\r\n"),
    );
    const error = await ended;
    expect(error).toBeDefined();
    expect(error?.message).toContain("Connection refused");
    expect(error?.message).toContain(LABEL);
  });

  test("the stderr cap is enforced at 8 KiB (pure pushStderr/decodeStderr)", () => {
    const state = { chunks: [] as Uint8Array[], bytes: 0 };
    pushStderr(state, new Uint8Array(SSH_STDERR_CAP + 5000).fill(0x41), SSH_STDERR_CAP);
    expect(state.bytes).toBe(SSH_STDERR_CAP);
    expect(decodeStderr(state).length).toBe(SSH_STDERR_CAP);
    pushStderr(state, new TextEncoder().encode("MORE"), SSH_STDERR_CAP);
    expect(state.bytes).toBe(SSH_STDERR_CAP); // capped: more is dropped
  });
});

describe("sshDialer: the client only ever sees a Dialer (real request + exec hijack)", () => {
  test("ping + container verbs + an exec hijack round-trip through the ssh dialer", async () => {
    const { dial } = withFakeSsh(EP, BRIDGE);
    const docker = new DockerClient({
      dial: async () => await dial(),
      endpointLabel: `${EP.source} (${LABEL})`,
    });

    // A real request over the ssh transport (the client learns nothing about it).
    const ping = await docker.ping();
    expect(ping.apiVersion).toBe("1.52");
    expect(await docker.apiPath()).toBe("/v1.52");

    const { id } = await docker.createContainer("n", { Image: "busybox" });
    expect(id).toBe("c1");
    await docker.startContainer("n");

    // An exec hijack: the fake engine's cat echoes the two frames sent before 101.
    const channel = docker.openExec({ container: "n", command: ["cat"] });
    const got: string[] = [];
    const both = new Promise<void>((resolve) =>
      channel.setOnMessage((m) => {
        got.push(m);
        if (got.length === 2) resolve();
      }),
    );
    const closed = new Promise<void>((resolve) => channel.setOnClose(() => resolve()));
    channel.send('{"id":1}');
    channel.send('{"id":2}');
    await both;
    expect(got).toEqual(['{"id":1}', '{"id":2}']);
    channel.close();
    await closed; // the engine ends the stream (stdin EOF) → the channel closes
  }, 20_000);
});

describe("sshDialer: process-group kill on close", () => {
  // The non-vacuous property: `close()` kills the ssh's WHOLE process group, so
  // a child the ssh spawned (a grandchild from tentacle's view) is reached — not
  // just the ssh leader. If close() only proc.kill()ed the leader, the grandchild
  // (same group, different pid) would survive and this would fail. Non-vacuous:
  // a bare bun process dies on the group's SIGTERM (verified in
  // .tentacle/tmp/docker-ssh-dialer/probe-sig.ts), and proc.kill() alone would not
  // reach the grandchild (a different pid).
  test("close() kills a child the ssh spawned (killGroup, not proc.kill)", async () => {
    const grandchild = join(dir, `gc-${Math.random().toString(36).slice(2)}.ts`);
    const pidFile = join(dir, `gc-${Math.random().toString(36).slice(2)}.pid`);
    writeFileSync(
      grandchild,
      `await Bun.write(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000); // long-lived\n`,
    );
    // The fake ssh spawns the grandchild (which INHERITS the ssh's process group —
    // not detached), then stays alive, so the group has two members (ssh +
    // grandchild) and only a GROUP kill reaches the grandchild.
    const { dial } = withFakeSsh(
      EP,
      `Bun.spawn(["${process.execPath}", ${JSON.stringify(grandchild)}], { env: { PATH: process.env.PATH ?? "" }, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
setInterval(() => {}, 1000);`,
    );
    const duplex = await dial();
    // Wait for the grandchild to record its pid and be running.
    let childPid = 0;
    for (let i = 0; i < 50 && childPid === 0; i++) {
      await Bun.sleep(20);
      try {
        childPid = Number(await Bun.file(pidFile).text());
      } catch {
        // not written yet
      }
    }
    expect(childPid).toBeGreaterThan(0);
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive(childPid)).toBe(true); // the grandchild is running before close()
    duplex.close();
    // SIGTERM → SIGKILL (KILL_GRACE_MS = 2000). Poll until the grandchild is gone.
    const deadline = Date.now() + 5000;
    let stillAlive = true;
    for (;;) {
      await Bun.sleep(100);
      stillAlive = alive(childPid);
      if (!stillAlive) break;
      if (Date.now() > deadline) break;
    }
    expect(stillAlive).toBe(false); // the group kill reached the grandchild
  }, 10_000);
});

describe("sshDialer: early-exit classification", () => {
  test("host-key failure → 'verify the host key once'", () => {
    const m = classifySshExit({
      host: "remote.example",
      endpointLabel: LABEL,
      stderr: "Host key verification failed.",
      exitCode: 255,
    });
    expect(m).toContain("verify it once with");
    expect(m).toContain("ssh remote.example");
  });
  test("the host-key hint carries the user and port (the known_hosts entry is [host]:port)", () => {
    const m = classifySshExit({
      host: "remote.example",
      user: "deploy",
      port: 2222,
      endpointLabel: LABEL,
      stderr: "Host key verification failed.",
      exitCode: 255,
    });
    expect(m).toContain("`ssh -p 2222 deploy@remote.example`");
  });
  test("permission denied → 'load a key in ssh-agent / IdentityFile'", () => {
    const m = classifySshExit({
      host: "remote.example",
      endpointLabel: LABEL,
      stderr: "deploy@remote.example: Permission denied (publickey).",
      exitCode: 255,
    });
    expect(m).toMatch(/permission denied/i);
    expect(m).toContain("ssh-agent");
  });
  test("exit 127 / docker not found → 'need the docker CLI on the server'", () => {
    const m = classifySshExit({
      host: "remote.example",
      endpointLabel: LABEL,
      stderr: "bash: docker: command not found",
      exitCode: 127,
    });
    expect(m).toContain("docker CLI on the server");
  });
  test("generic failure names the endpoint and is a network message", () => {
    const m = classifySshExit({
      host: "remote.example",
      endpointLabel: LABEL,
      stderr: "ssh: connect to host remote.example port 22: No route to host",
      exitCode: 255,
    });
    expect(m).toContain(LABEL);
    expect(m).toMatch(/reachable|engine listening/);
  });
  test("spawn ENOENT → 'ssh not found on PATH' (the child never ran)", () => {
    const err = sshSpawnError(EP, Object.assign(new Error("nope"), { code: "ENOENT" }));
    expect(err.message).toContain("ssh not found on PATH");
    expect(err.message).toContain(LABEL);
  });
  test("a dying ssh before any data → the request's onEnd carries the classified error", async () => {
    const { dial } = withFakeSsh(
      EP,
      `process.stderr.write("deploy@remote.example: Permission denied (publickey).\\n"); process.exit(255);`,
    );
    const duplex = await dial();
    const ended = new Promise<Error | undefined>((resolve) => duplex.setOnEnd((e) => resolve(e)));
    duplex.write(
      new TextEncoder().encode("GET /_ping HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n\r\n"),
    );
    const error = await ended;
    expect(error?.message).toMatch(/permission denied/i);
    expect(error?.message).toContain("ssh-agent");
  });
});

/** A bridge like BRIDGE, but exiting 0 once the engine closes (what a real `docker system dial-stdio` does). */
const BRIDGE_EXIT0 = `
// node:net, not Bun.connect: Bun's socket.end() also drops the read side, and
// dial-stdio half-closes (stdin EOF) while still relaying the engine's tail.
import net from "node:net";
const s = net.connect(process.env.FAKE_ENGINE_SOCKET);
s.on("data", (c) => process.stdout.write(c));
s.on("close", () => process.stdout.end(() => process.exit(0)));
process.stdin.on("data", (c) => s.write(c));
process.stdin.on("end", () => s.end());
`;

describe("sshDialer: how the stream ends (exit 0 after the response = a normal close)", () => {
  async function endOf(script: string): Promise<{ error: Error | undefined; got: number }> {
    const { dial } = withFakeSsh(EP, script);
    const duplex = await dial();
    let got = 0;
    duplex.setOnData((b) => {
      got += b.length;
    });
    const error = await new Promise<Error | undefined>((resolve) => duplex.setOnEnd(resolve));
    return { error, got };
  }

  test("exit 0 after the engine answered → onEnd without an error", async () => {
    const { error, got } = await endOf(
      `process.stdout.write("HTTP/1.1 200 OK\\r\\n\\r\\n"); process.exit(0);`,
    );
    expect(got).toBeGreaterThan(0);
    expect(error).toBeUndefined();
  });

  test("a non-zero exit after the engine answered → an error naming the exit code", async () => {
    const { error, got } = await endOf(`process.stdout.write("partial"); process.exit(3);`);
    expect(got).toBeGreaterThan(0);
    expect(error?.message).toContain("exit 3");
  });

  test("exit 0 BEFORE any response is still an error (the session never became live)", async () => {
    const { error, got } = await endOf("process.exit(0);");
    expect(got).toBe(0);
    expect(error).toBeDefined();
  });

  test("runExec through a bridge that exits 0 when the engine closes resolves (no error)", async () => {
    const { dial } = withFakeSsh(EP, BRIDGE_EXIT0);
    const result = await runExec(
      { dial: async () => await dial(), apiPath: async () => "/v1.52" },
      { container: "n", command: ["cat"] },
      new TextEncoder().encode("hello"),
      { timeoutMs: 8000 },
    );
    expect(result.stdout).toBe("hello");
    expect(result.exitCode).toBe(0);
  }, 15_000);
});

describe("sshDialer: a broken pipe", () => {
  test("writes to a dead child: no unhandled rejection, the channel errors once", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => {
      unhandled.push(e);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const { dial } = withFakeSsh(EP, "await Bun.sleep(150); process.exit(0);");
      const duplex = await dial();
      let ends = 0;
      duplex.setOnEnd(() => {
        ends++;
      });
      const mib = new Uint8Array(1024 * 1024).fill(7);
      for (let i = 0; i < 16; i++) {
        duplex.write(mib);
      }
      await Bun.sleep(1000);
      expect(unhandled).toEqual([]);
      expect(ends).toBe(1);
      expect(duplex.buffered).toBe(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  }, 10_000);
});

describe("sshDialer: backpressure (the FileSink Promise is the drain signal)", () => {
  test("an 8 MiB write to a slow reader is buffered, then drains, and every byte round-trips", async () => {
    const { dial } = withFakeSsh(
      EP,
      `await Bun.sleep(400); process.stdin.on("data", (c) => process.stdout.write(c)); process.stdin.on("end", () => process.exit(0));`,
    );
    const duplex = await dial();
    let got = 0;
    duplex.setOnData((b) => {
      got += b.length;
    });
    let drains = 0;
    duplex.setOnDrain(() => {
      drains++;
    });
    const total = 8 * 1024 * 1024;
    duplex.write(new Uint8Array(total).fill(1));
    expect(duplex.buffered).toBeGreaterThan(0); // the reader is asleep: the write is pending
    const ended = new Promise<Error | undefined>((resolve) => duplex.setOnEnd(resolve));
    for (let i = 0; i < 100 && drains === 0; i++) {
      await Bun.sleep(50);
    }
    expect(drains).toBeGreaterThan(0);
    expect(duplex.buffered).toBe(0);
    duplex.end();
    expect(await ended).toBeUndefined();
    expect(got).toBe(total);
  }, 20_000);
});

describe("sshDialer: the real spawner", () => {
  test("DEFAULT_SSH_SPAWNER makes the child its own process-group leader (pgid = pid)", () => {
    const proc = DEFAULT_SSH_SPAWNER(
      ["sleep", "30"],
      { PATH: process.env.PATH ?? "" },
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    try {
      const ps = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(proc.pid)]);
      expect(Number(ps.stdout.toString().trim())).toBe(proc.pid);
    } finally {
      proc.kill("SIGKILL");
    }
  });
});

describe("sshDialer: half-close (end() = the child's stdin EOF; reading continues)", () => {
  test("after end() the engine's echo and its EOF-triggered close still arrive, with no close()", async () => {
    const { dial } = withFakeSsh(EP, BRIDGE_EXIT0);
    const duplex = await dial();
    const chunks: string[] = [];
    duplex.setOnData((b) => chunks.push(new TextDecoder().decode(b)));
    const ended = new Promise<Error | undefined>((resolve) => duplex.setOnEnd(resolve));
    duplex.write(
      new TextEncoder().encode(
        "POST /v1.52/exec/e1/start HTTP/1.1\r\nHost: docker\r\nContent-Length: 2\r\n\r\n{}",
      ),
    );
    for (let i = 0; i < 100 && !chunks.join("").includes("101"); i++) {
      await Bun.sleep(20);
    }
    duplex.write(new TextEncoder().encode("ping"));
    duplex.end();
    expect(await ended).toBeUndefined();
    expect(chunks.join("")).toContain("ping");
  }, 10_000);
});
