import { describe, expect, test } from "bun:test";
import type { RunExecOptions, RunExecResult } from "@tentacle/k8s";
import type { EngineExecTarget } from "../src/engine-host.ts";
import {
  POD_BIN_PATH,
  type PodBinaryDeps,
  type PodBinaryTarget,
  type PodProbe,
  archToTarget,
  classifyImage,
  injectAgentBinary,
  libcMismatchHint,
  mapUnameOutput,
  parseProbe,
  probePod,
} from "../src/pod-binary.ts";

/** A recorded one-shot exec call. */
interface ExecCall {
  readonly command: readonly string[];
  readonly input: Uint8Array | undefined;
  readonly timeoutMs?: number;
}

/** Strict index access (no `!`): fetch a recorded call or throw. */
function callAt(calls: readonly ExecCall[], index: number): ExecCall {
  const call = calls[index];
  if (!call) {
    throw new Error(`no exec call at index ${index} (got ${calls.length})`);
  }
  return call;
}

/**
 * A fake cluster that records `runExec` calls and returns a scripted result
 * per call (shifted from the script, in order). Lets the tests assert the
 * exact sequence and inspect the bytes sent.
 */
class FakeKube {
  readonly calls: ExecCall[] = [];
  private readonly script: RunExecResult[];
  constructor(script: RunExecResult[]) {
    this.script = script;
  }
  runExec(
    target: EngineExecTarget,
    input?: Uint8Array,
    options?: RunExecOptions,
  ): Promise<RunExecResult> {
    this.calls.push({
      command: target.command,
      input,
      ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    });
    // Mirror the real chunked transfer: fire onProgress once per 256 KB chunk,
    // so the ~10% bucketing in `injectAgentBinary` is actually exercised.
    if (input && options?.onProgress) {
      const chunk = 256 * 1024;
      for (let written = chunk; written <= input.length; written += chunk) {
        options.onProgress(Math.min(written, input.length));
      }
    }
    const result = this.script.shift();
    if (!result) {
      return Promise.reject(new Error("FakeKube: no scripted result for this call"));
    }
    return Promise.resolve(result);
  }
}

const ok = (stdout = ""): RunExecResult => ({ exitCode: 0, stdout, stderr: "" });
const fail = (stderr: string, status?: string): RunExecResult => ({
  exitCode: 1,
  stdout: "",
  stderr,
  ...(status ? { status } : {}),
});

function depsFor(
  kube: FakeKube,
  opts: {
    arch?: "x64" | "arm64";
    resolveBinary?: (target: PodBinaryTarget) => Promise<Uint8Array>;
    log?: (line: string) => void;
    onStatus?: (text: string) => void;
    binPath?: string;
    probeStatus?: PodProbe["status"];
  } = {},
): PodBinaryDeps {
  return {
    host: kube,
    name: "p1",
    container: "agent",
    ...(opts.binPath ? { binPath: opts.binPath } : {}),
    // The image probe is an injected seam: in production it is
    // `probePod(kube, …)` (tested directly below); here it is scripted.
    probe: async () => ({ arch: opts.arch ?? "x64", status: opts.probeStatus ?? "ok" }),
    resolveBinary: opts.resolveBinary ?? (async () => new Uint8Array([1, 2, 3])),
    log: opts.log ?? (() => {}),
    ...(opts.onStatus ? { onStatus: opts.onStatus } : {}),
  };
}

describe("mapUnameOutput", () => {
  test("maps known arch strings", () => {
    expect(mapUnameOutput("x86_64")).toBe("x64");
    expect(mapUnameOutput("AMD64")).toBe("x64");
    expect(mapUnameOutput("aarch64")).toBe("arm64");
    expect(mapUnameOutput("arm64")).toBe("arm64");
  });
  test("unknown / empty → x64 fallback (never throws)", () => {
    expect(mapUnameOutput("")).toBe("x64");
    expect(mapUnameOutput("riscv64")).toBe("x64");
    expect(mapUnameOutput("\n")).toBe("x64");
  });
});

describe("archToTarget", () => {
  test("maps arch to a Bun Linux target", () => {
    expect(archToTarget("x64")).toBe("bun-linux-x64");
    expect(archToTarget("arm64")).toBe("bun-linux-arm64");
  });
});

describe("libcMismatchHint", () => {
  test("matches the classic musl-image loader failure (the real busybox error)", () => {
    expect(
      libcMismatchHint(
        "tentacle: error while loading shared libraries: libdl.so.2: cannot open shared object file: No such file or directory",
      ),
    ).toBe(
      " — this image appears to lack glibc (Alpine/busybox use musl); tentacle is a glibc binary, use a glibc-based image (e.g. UBI9, Debian, RHEL)",
    );
  });
  test("matches each pattern, case-insensitively", () => {
    expect(libcMismatchHint("ERROR WHILE LOADING SHARED LIBRARIES: libc.so.6")).toBeDefined();
    expect(
      libcMismatchHint(
        "/lib/ld-musl-x86_64.so.1: cannot open shared object file: No such file or directory",
      ),
    ).toBeDefined();
  });
  test("undefined for any other failure (the raw error stays the primary signal)", () => {
    expect(libcMismatchHint("tentacle: Exec format error\n")).toBeUndefined();
    expect(libcMismatchHint("/bin/sh: tentacle: not found\n")).toBeUndefined();
    expect(libcMismatchHint("")).toBeUndefined();
  });
});

// What the probe script prints (sentinel, `uname -m`, then one line per loader found).
const GLIBC_X64 = "tentacle-probe\nx86_64\nglibc /lib64/ld-linux-x86-64.so.2\n";
const GLIBC_ARM64 = "tentacle-probe\naarch64\nglibc /lib/ld-linux-aarch64.so.1\n";
const ALPINE_X64 = "tentacle-probe\nx86_64\nmusl /lib/ld-musl-x86_64.so.1\n";
const NO_LOADER = "tentacle-probe\nx86_64\n";

describe("parseProbe / classifyImage", () => {
  test("a glibc image → ok, for both arches", () => {
    expect(classifyImage(parseProbe(GLIBC_X64))).toEqual({ arch: "x64", status: "ok" });
    expect(classifyImage(parseProbe(GLIBC_ARM64))).toEqual({ arch: "arm64", status: "ok" });
  });
  test("an Alpine image (musl loader, no glibc interpreter) → musl", () => {
    expect(classifyImage(parseProbe(ALPINE_X64))).toEqual({ arch: "x64", status: "musl" });
  });
  test("musl compat installed beside glibc → ok (the glibc interpreter wins)", () => {
    const raw = `${GLIBC_X64}musl /lib/ld-musl-x86_64.so.1\n`;
    expect(classifyImage(parseProbe(raw)).status).toBe("ok");
  });
  test("the shell ran but no loader at all (scratch + static busybox) → no-glibc", () => {
    expect(classifyImage(parseProbe(NO_LOADER))).toEqual({ arch: "x64", status: "no-glibc" });
  });
  test("checks the loader of the arch we inject (x64 box with only the arm64 interpreter)", () => {
    const raw = "tentacle-probe\nx86_64\nglibc /lib/ld-linux-aarch64.so.1\n";
    expect(classifyImage(parseProbe(raw)).status).toBe("no-glibc");
  });
  test("review: an arch we do not build (ppc64le) → unsupported-arch with the machine name, not no-glibc", () => {
    const raw = "tentacle-probe\nppc64le\nglibc /lib64/ld64.so.2\n";
    expect(classifyImage(parseProbe(raw))).toEqual({
      arch: "x64",
      status: "unsupported-arch",
      machine: "ppc64le",
    });
  });
  test("review: the shell ran but printed no uname → unknown (never blocks), not no-glibc", () => {
    expect(classifyImage(parseProbe("tentacle-probe\n\n")).status).toBe("unknown");
  });
  test("inconclusive output (empty / no sentinel) → unknown, x64, never a false positive", () => {
    expect(classifyImage(parseProbe(""))).toEqual({ arch: "x64", status: "unknown" });
    expect(classifyImage(parseProbe("x86_64\n"))).toEqual({ arch: "x64", status: "unknown" });
    expect(classifyImage(parseProbe("garbage"))).toEqual({ arch: "x64", status: "unknown" });
  });
});

describe("probePod", () => {
  test("one sh -c exec: arch + loader facts (zero extra round-trip)", async () => {
    const kube = new FakeKube([ok(GLIBC_ARM64)]);
    const probe = await probePod(kube, "p", "agent");
    expect(probe).toEqual({ arch: "arm64", status: "ok" });
    expect(kube.calls).toHaveLength(1);
    const call = callAt(kube.calls, 0);
    expect(call.command.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(call.command[2]).toContain("uname -m");
    expect(call.command[2]).toContain("/lib/ld-musl-");
  });
  test("an Alpine reply → musl", async () => {
    const kube = new FakeKube([ok(ALPINE_X64)]);
    expect((await probePod(kube, "p", "agent")).status).toBe("musl");
  });
  test("a non-zero exit → probe-failed, x64 fallback (never aborts)", async () => {
    const kube = new FakeKube([fail("exec: sh: executable file not found in $PATH")]);
    expect(await probePod(kube, "p", "agent")).toEqual({ arch: "x64", status: "probe-failed" });
  });
  test("an exec throw (timeout / close) → probe-failed, never rejects", async () => {
    const kube = { runExec: () => Promise.reject(new Error("exec timed out")) };
    expect(await probePod(kube, "p", "agent")).toEqual({ arch: "x64", status: "probe-failed" });
  });
});

describe("injectAgentBinary", () => {
  test("runs the sequence: head -c N (with the exact bytes) → --version", async () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const logs: string[] = [];
    const kube = new FakeKube([
      ok(), // install: head -c N
      ok("tentacle 1.2.3\n"), // version probe
    ]);
    const deps = depsFor(kube, {
      resolveBinary: async (target) => {
        expect(target).toBe("bun-linux-x64");
        return bytes;
      },
      log: (l) => logs.push(l),
    });

    const result = await injectAgentBinary(deps);

    expect(kube.calls).toHaveLength(2);
    // 1) the raw transfer: sh -c mkdir -p dir && head -c N > path.new && chmod
    //    && mv over path (a rename, never a write into a running binary:
    //    ETXTBSY), with the exact bytes
    const installCall = callAt(kube.calls, 0);
    expect(installCall.command[0]).toBe("sh");
    expect(installCall.command[1]).toBe("-c");
    const shellCmd = installCall.command[2];
    expect(shellCmd).toBe(
      `mkdir -p /usr/local/bin && head -c ${bytes.length} > ${POD_BIN_PATH}.new && chmod 755 ${POD_BIN_PATH}.new && mv -f ${POD_BIN_PATH}.new ${POD_BIN_PATH}`,
    );
    expect(installCall.input).toBeDefined();
    expect(installCall.input).toEqual(bytes);
    // 2) the version probe (no input)
    const versionCall = callAt(kube.calls, 1);
    expect(versionCall.command).toEqual([POD_BIN_PATH, "--version"]);
    expect(versionCall.input).toBeUndefined();
    // logs mention the arch and the transfer; the version is returned (the
    // caller folds it into its final line — it is not logged here anymore).
    expect(logs.some((l) => l.includes("x64"))).toBe(true);
    expect(logs.some((l) => l.includes("injecting tentacle"))).toBe(true);
    expect(result).toBe("tentacle 1.2.3");
  });

  test("--bin-dir: installs to and verifies the custom absolute path (read-only rootfs)", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const kube = new FakeKube([ok(), ok("tentacle dev\n")]);
    const deps = depsFor(kube, { binPath: "/tmp/tentacle", resolveBinary: async () => bytes });
    await injectAgentBinary(deps);
    // Install writes under /tmp (mkdir -p /tmp), not /usr/local/bin.
    expect(callAt(kube.calls, 0).command[2]).toBe(
      `mkdir -p /tmp && head -c ${bytes.length} > /tmp/tentacle.new && chmod 755 /tmp/tentacle.new && mv -f /tmp/tentacle.new /tmp/tentacle`,
    );
    // Verify execs the injected binary by its absolute path (the dir may be off PATH).
    expect(callAt(kube.calls, 1).command).toEqual(["/tmp/tentacle", "--version"]);
  });

  test("picks the arm64 target for an arm64 pod", async () => {
    let seenTarget: PodBinaryTarget | undefined;
    const kube = new FakeKube([ok(), ok("tentacle dev\n")]);
    const deps = depsFor(kube, {
      arch: "arm64",
      resolveBinary: async (t) => {
        seenTarget = t;
        return new Uint8Array([1]);
      },
    });
    await injectAgentBinary(deps);
    expect(seenTarget).toBe("bun-linux-arm64");
  });

  test("a failed install (head / chmod) throws with the pod stderr", async () => {
    const kube = new FakeKube([
      fail("/bin/sh: can't create /usr/local/bin/tentacle: Permission denied\n"),
      ok(), // not reached
    ]);
    await expect(injectAgentBinary(depsFor(kube))).rejects.toThrow(
      /failed to inject tentacle.*Permission denied/,
    );
    // It stopped at the install (the --version probe never ran).
    expect(kube.calls).toHaveLength(1);
  });

  test("a failed --version probe (wrong arch) throws with the pod stderr", async () => {
    const kube = new FakeKube([
      ok(), // install ok
      fail("tentacle: Exec format error\n"),
    ]);
    await expect(injectAgentBinary(depsFor(kube))).rejects.toThrow(
      /tentacle --version failed.*Exec format error/,
    );
    // The version probe is what failed.
    expect(kube.calls).toHaveLength(2);
    expect(callAt(kube.calls, 1).command).toEqual([POD_BIN_PATH, "--version"]);
  });

  test("a failed --version probe (musl image) appends the glibc hint to the error", async () => {
    const kube = new FakeKube([
      ok(), // install ok
      fail(
        "tentacle: error while loading shared libraries: libdl.so.2: cannot open shared object file: No such file or directory\n",
      ),
    ]);
    await expect(injectAgentBinary(depsFor(kube))).rejects.toThrow(
      /tentacle --version failed.*libdl\.so\.2.*appears to lack glibc.*UBI9, Debian, RHEL/,
    );
  });

  test("a musl image fails BEFORE resolving/transferring the binary", async () => {
    const kube = new FakeKube([]);
    let resolved = false;
    const deps = depsFor(kube, {
      probeStatus: "musl",
      resolveBinary: async () => {
        resolved = true;
        return new Uint8Array([1]);
      },
    });
    await expect(injectAgentBinary(deps)).rejects.toThrow(
      /this image uses musl \(Alpine\): use a glibc-based image.*UBI9, Debian, RHEL/,
    );
    expect(resolved).toBe(false);
    expect(kube.calls).toHaveLength(0);
  });

  test("review: the musl message gives the advice ONCE", async () => {
    const deps = depsFor(new FakeKube([]), { probeStatus: "musl" });
    const message = await injectAgentBinary(deps).then(
      () => "",
      (e: unknown) => String(e),
    );
    expect(message.match(/glibc-based image/g)?.length).toBe(1);
  });

  test("review: an unsupported arch fails BEFORE the transfer, naming it", async () => {
    const kube = new FakeKube([]);
    const deps: PodBinaryDeps = {
      ...depsFor(kube),
      probe: async () => ({ arch: "x64", status: "unsupported-arch", machine: "s390x" }),
    };
    await expect(injectAgentBinary(deps)).rejects.toThrow(
      /unsupported architecture: s390x \(tentacle ships linux x64 and arm64 builds\)/,
    );
    expect(kube.calls).toHaveLength(0);
  });

  test("a shell image with no glibc loader gets its own message (names the interpreter)", async () => {
    const kube = new FakeKube([]);
    const deps = depsFor(kube, { probeStatus: "no-glibc", arch: "arm64" });
    await expect(injectAgentBinary(deps)).rejects.toThrow(
      /no glibc loader \(\/lib\/ld-linux-aarch64\.so\.1 not found\).*glibc-based image/,
    );
    expect(kube.calls).toHaveLength(0);
  });

  test("no shell (probe failed, then the sh -c install fails) → a clear no-shell error", async () => {
    const kube = new FakeKube([
      fail("", '{"status":"Failure","message":"sh: executable file not found"}'),
    ]);
    const deps = depsFor(kube, { probeStatus: "probe-failed" });
    await expect(injectAgentBinary(deps)).rejects.toThrow(
      /failed to inject tentacle.*no shell \(sh\).*distroless/s,
    );
    expect(kube.calls).toHaveLength(1);
  });

  test("an inconclusive probe (unknown) proceeds exactly as before", async () => {
    const kube = new FakeKube([ok(), ok("tentacle 1.2.3\n")]);
    const result = await injectAgentBinary(depsFor(kube, { probeStatus: "unknown" }));
    expect(result).toBe("tentacle 1.2.3");
    expect(kube.calls).toHaveLength(2);
  });

  test("a --version failure reported only on the status channel still gets the glibc hint", async () => {
    // k8s delivers a runtime-level exec failure as a Status (stderr stays empty).
    const status =
      '{"status":"Failure","message":"exec: \\"/usr/local/bin/tentacle\\": no such file or directory"}';
    const kube = new FakeKube([ok(), fail("", status)]);
    await expect(injectAgentBinary(depsFor(kube))).rejects.toThrow(
      /tentacle --version failed.*no such file or directory.*appears to lack glibc/s,
    );
  });

  test("a --version 'Exec format error' (wrong arch) gets no glibc hint", async () => {
    const kube = new FakeKube([ok(), fail("tentacle: Exec format error\n")]);
    const err = await injectAgentBinary(depsFor(kube)).catch((e: Error) => e);
    expect(err instanceof Error && err.message.includes("appears to lack glibc")).toBe(false);
  });

  test("the install call passes a size-scaled timeout", async () => {
    const kube = new FakeKube([ok(), ok("v\n")]);
    await injectAgentBinary(
      depsFor(kube, { resolveBinary: async () => new Uint8Array(20_000_000) }),
    );
    const installCall = callAt(kube.calls, 0);
    expect(installCall.timeoutMs).toBeDefined();
    // 20 MB → 15s + 20*5s = 115s, well above the 30s default.
    expect((installCall.timeoutMs as number) > 60_000).toBe(true);
  });

  test("progress is logged in ~10% buckets", async () => {
    const logs: string[] = [];
    const kube = new FakeKube([ok(), ok("v\n")]);
    // Exactly 4 × 256 KB so the transfer ends on a chunk boundary (as a real
    // one does) and the final progress call reports the full size → 100%.
    await injectAgentBinary(
      depsFor(kube, {
        resolveBinary: async () => new Uint8Array(4 * 256 * 1024),
        log: (l) => logs.push(l),
      }),
    );
    const progressLines = logs.filter((l) => l.includes("transfer "));
    // onProgress fires once per 256 KB chunk: 20%, 50%, 70%, 100%.
    expect(progressLines).toHaveLength(4);
    expect(logs.some((l) => l.includes("100%"))).toBe(true);
  });

  test("interactive mode: phases drive onStatus (single line) and the version is returned", async () => {
    const statuses: string[] = [];
    const logs: string[] = [];
    const kube = new FakeKube([ok(), ok("tentacle 1.2.3\n")]);
    const total = 4 * 256 * 1024;
    const result = await injectAgentBinary(
      depsFor(kube, {
        resolveBinary: async () => new Uint8Array(total),
        log: (l) => logs.push(l),
        onStatus: (text) => statuses.push(text),
      }),
    );
    // Every phase update goes to the shared status line — nothing is logged
    // (the single-line invariant), except the version is returned for the
    // caller's final line.
    expect(logs).toHaveLength(0);
    expect(result).toBe("tentacle 1.2.3");
    // The phase sequence: resolve → transfer (with the bar) → verify. The
    // transfer line is repainted per chunk (25/50/75/100%); the LAST one is 100%.
    expect(statuses[0]).toContain("resolving bun-linux-x64 binary…");
    const transfers = statuses.filter((s) => s.includes("injecting tentacle ▓"));
    expect(transfers.length).toBeGreaterThan(1);
    const last = transfers[transfers.length - 1];
    if (last === undefined) {
      throw new Error("no transfer status line");
    }
    expect(last).toContain("100%");
    expect(last).toContain(`${(total / 1048576).toFixed(1)} MB`);
    expect(statuses.at(-1)).toContain("verifying…");
  });
});
