import { describe, expect, test } from "bun:test";
import type { ExecTarget, RunExecOptions, RunExecResult } from "@agent-harness/k8s";
import {
  POD_BIN_PATH,
  type PodBinaryDeps,
  type PodBinaryTarget,
  archToTarget,
  injectAgentBinary,
  mapUnameOutput,
  probePodArch,
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
    target: ExecTarget,
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
  } = {},
): PodBinaryDeps {
  return {
    kube,
    podName: "p1",
    container: "agent",
    // The arch probe is an injected seam: in production it is
    // `probePodArch(kube, …)` (tested directly below); here it is scripted.
    podArch: async () => opts.arch ?? "x64",
    resolveBinary: opts.resolveBinary ?? (async () => new Uint8Array([1, 2, 3])),
    log: opts.log ?? (() => {}),
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

describe("probePodArch", () => {
  test("reads uname -m stdout and maps it", async () => {
    const kube = new FakeKube([ok("aarch64\n")]);
    const arch = await probePodArch(kube, "p", "agent");
    expect(arch).toBe("arm64");
    expect(callAt(kube.calls, 0).command).toEqual(["uname", "-m"]);
  });
  test("a non-zero exit → x64 fallback", async () => {
    const kube = new FakeKube([fail("/bin/sh: uname: not found")]);
    const arch = await probePodArch(kube, "p", "agent");
    expect(arch).toBe("x64");
  });
  test("an unknown uname output → x64 fallback", async () => {
    const kube = new FakeKube([ok("riscv64\n")]);
    const arch = await probePodArch(kube, "p", "agent");
    expect(arch).toBe("x64");
  });
  test("an exec throw (timeout / close) → x64 fallback, never aborts", async () => {
    const kube = { runExec: () => Promise.reject(new Error("exec timed out")) };
    const arch = await probePodArch(kube, "p", "agent");
    expect(arch).toBe("x64");
  });
});

describe("injectAgentBinary", () => {
  test("runs the sequence: head -c N (with the exact bytes) → --version", async () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const logs: string[] = [];
    const kube = new FakeKube([
      ok(), // install: head -c N
      ok("agent-harness 1.2.3\n"), // version probe
    ]);
    const deps = depsFor(kube, {
      resolveBinary: async (target) => {
        expect(target).toBe("bun-linux-x64");
        return bytes;
      },
      log: (l) => logs.push(l),
    });

    await injectAgentBinary(deps);

    expect(kube.calls).toHaveLength(2);
    // 1) the raw transfer: sh -c head -c N > path && chmod, with the exact bytes
    const installCall = callAt(kube.calls, 0);
    expect(installCall.command[0]).toBe("sh");
    expect(installCall.command[1]).toBe("-c");
    const shellCmd = installCall.command[2];
    expect(shellCmd).toBe(`head -c ${bytes.length} > ${POD_BIN_PATH} && chmod 755 ${POD_BIN_PATH}`);
    expect(installCall.input).toBeDefined();
    expect(installCall.input).toEqual(bytes);
    // 2) the version probe (no input)
    const versionCall = callAt(kube.calls, 1);
    expect(versionCall.command).toEqual(["agent-harness", "--version"]);
    expect(versionCall.input).toBeUndefined();
    // logs mention the arch, the transfer, and the resolved version
    expect(logs.some((l) => l.includes("x64"))).toBe(true);
    expect(logs.some((l) => l.includes("injecting agent-harness"))).toBe(true);
    expect(logs.some((l) => l.includes("agent-harness 1.2.3"))).toBe(true);
  });

  test("picks the arm64 target for an arm64 pod", async () => {
    let seenTarget: PodBinaryTarget | undefined;
    const kube = new FakeKube([ok(), ok("agent-harness dev\n")]);
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
      fail("/bin/sh: can't create /usr/local/bin/agent-harness: Permission denied\n"),
      ok(), // not reached
    ]);
    await expect(injectAgentBinary(depsFor(kube))).rejects.toThrow(
      /failed to inject agent-harness.*Permission denied/,
    );
    // It stopped at the install (the --version probe never ran).
    expect(kube.calls).toHaveLength(1);
  });

  test("a failed --version probe (wrong arch) throws with the pod stderr", async () => {
    const kube = new FakeKube([
      ok(), // install ok
      fail("agent-harness: Exec format error\n"),
    ]);
    await expect(injectAgentBinary(depsFor(kube))).rejects.toThrow(
      /agent-harness --version failed.*Exec format error/,
    );
    // The version probe is what failed.
    expect(kube.calls).toHaveLength(2);
    expect(callAt(kube.calls, 1).command).toEqual(["agent-harness", "--version"]);
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
});
