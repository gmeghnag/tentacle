import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARGS, type ArgSpec, parseArgs } from "../src/flags.ts";
import { main } from "../src/index.ts";

// Strict, position-independent CLI arguments (docs/fix/cli-strict-args.md).
// Each rule names the mutation that turns it red (AGENTS §9).

const UID = "025e6a9d-d332-4a45-9051-8a957fa31811";

function ok(args: string[], spec: ArgSpec) {
  const result = parseArgs(args, spec);
  if (!result.ok) throw new Error(result.error);
  return {
    flags: Object.fromEntries(result.flags),
    bools: [...result.bools].sort(),
    positional: result.positional,
  };
}
const error = (args: string[], spec: ArgSpec): string => {
  const result = parseArgs(args, spec);
  return result.ok ? "(parsed)" : result.error;
};

describe("parseArgs: run/attach accept -n/--namespace anywhere", () => {
  test("before or after the pod name, long or short, with or without =", () => {
    // Mutation: drop the short alias → `-n` is an unknown option.
    for (const args of [
      ["-n", "dev", "pod"],
      ["pod", "-n", "dev"],
      ["--namespace", "dev", "pod"],
      ["pod", "--namespace=dev"],
      ["-n=dev", "pod"],
    ]) {
      expect(ok(args, ARGS.attach)).toEqual({
        flags: { namespace: "dev" },
        bools: [],
        positional: ["pod"],
      });
    }
    expect(ok(["--image", "busybox", "mypod", "-n", "dev"], ARGS.run)).toEqual({
      flags: { image: "busybox", namespace: "dev" },
      bools: [],
      positional: ["mypod"],
    });
    expect(ok(["-n", "dev", "--image", "busybox"], ARGS.run).positional).toEqual([]);
  });

  test("-c is --container for attach, anywhere", () => {
    expect(ok(["-c", "app", "pod", "-n", "dev"], ARGS.attach).flags).toEqual({
      container: "app",
      namespace: "dev",
    });
  });
});

describe("parseArgs: nothing is silently ignored", () => {
  test("an unknown long or short option is an error naming it", () => {
    // Mutation: store unknown flags (the old parseFlags) → the typo is ignored.
    expect(error(["--image", "x", "--namspace", "dev"], ARGS.run)).toBe(
      "unknown option --namspace",
    );
    expect(error(["pod", "--contaner", "x"], ARGS.attach)).toBe("unknown option --contaner");
    expect(error(["pod", "-x"], ARGS.attach)).toBe("unknown option -x");
    expect(error(["--frobnicate"], ARGS.tui)).toBe("unknown option --frobnicate");
    expect(error(["--port", "1", "--prot", "2"], ARGS.serve)).toBe("unknown option --prot");
  });

  test("a value flag needs a value; a value starting with '-' needs the = form", () => {
    expect(error(["pod", "-n"], ARGS.attach)).toBe("-n needs a value");
    expect(error(["-n", "--image", "x"], ARGS.run)).toBe("-n needs a value");
    expect(error(["--max-sessions", "--port", "1"], ARGS.serve)).toBe(
      "--max-sessions needs a value",
    );
    expect(error(["pod", "--namespace="], ARGS.attach)).toBe("--namespace needs a value");
    expect(ok(["ws://h:1", "--token=-weird"], ARGS.connect).flags).toEqual({ token: "-weird" });
  });

  test("a flag given twice (any spelling) is an error", () => {
    expect(error(["pod", "-n", "a", "--namespace", "b"], ARGS.attach)).toBe(
      "--namespace given more than once",
    );
  });

  test("a bool takes no value", () => {
    expect(error(["--stdio=yes"], ARGS.serve)).toBe("--stdio takes no value");
  });

  test("positional counts are enforced", () => {
    expect(error([], ARGS.attach)).toBe("missing argument");
    expect(error(["a", "b"], ARGS.attach)).toBe('unexpected argument "b"');
    expect(error(["--image", "x", "a", "b"], ARGS.run)).toBe('unexpected argument "b"');
    expect(error(["extra"], ARGS.serve)).toBe('unexpected argument "extra"');
  });

  test("`--` ends the options", () => {
    expect(ok(["--", "-n"], ARGS.attach).positional).toEqual(["-n"]);
  });
});

describe("parseArgs: --resume [uid]", () => {
  test("takes the next word only when it is a session uid", () => {
    // Mutation: always take the next word → `attach --resume mypod` has no pod.
    expect(ok(["--resume", "mypod", "-n", "dev"], ARGS.attach)).toEqual({
      flags: { namespace: "dev" },
      bools: ["resume"],
      positional: ["mypod"],
    });
    expect(ok(["--resume", UID, "mypod"], ARGS.attach)).toEqual({
      flags: { resume: UID },
      bools: [],
      positional: ["mypod"],
    });
    expect(ok(["--resume=custom-id", "mypod"], ARGS.attach).flags).toEqual({ resume: "custom-id" });
    expect(ok(["--resume"], ARGS.tui)).toEqual({ flags: {}, bools: ["resume"], positional: [] });
  });

  test("the TUI takes no positional: a non-uid after --resume is an error, not a prompt", () => {
    expect(error(["--resume", "nope"], ARGS.tui)).toBe('unexpected argument "nope"');
  });
});

// End to end through `main`: the same fake k8s API server as the repro logs the
// first pod request and refuses it, so nothing is created anywhere.
describe("tentacle run/attach (end to end, fake API server)", () => {
  let k8s: ReturnType<typeof Bun.serve>;
  let model: ReturnType<typeof Bun.serve>;
  let dir: string;
  const seen: string[] = [];
  const KEYS = [
    "TENTACLE_CONFIG_DIR",
    "TENTACLE_K8S_SERVER",
    "TENTACLE_K8S_TOKEN",
    "TENTACLE_POD_BIN",
    "TENTACLE_POD_NAMESPACE",
    "TENTACLE_MODEL_BASE_URL",
    "TENTACLE_CWD",
    "TENTACLE_NO_AGENTS_MD",
  ];
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "tentacle-args-"));
    k8s = Bun.serve({
      port: 0,
      fetch(req) {
        seen.push(`${req.method} ${new URL(req.url).pathname}`);
        return new Response(JSON.stringify({ kind: "Status", code: 403, message: "refused" }), {
          status: 403,
        });
      },
    });
    model = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { messages: Array<{ content: unknown }> };
        seen.push(`MODEL ${JSON.stringify(body.messages.at(-1)?.content)}`);
        return new Response("no", { status: 500 });
      },
    });
    for (const key of KEYS) saved[key] = process.env[key];
    process.env.TENTACLE_CONFIG_DIR = join(dir, "config");
    process.env.TENTACLE_K8S_SERVER = `http://127.0.0.1:${k8s.port}`;
    process.env.TENTACLE_K8S_TOKEN = "t";
    process.env.TENTACLE_POD_BIN = "/bin/sh";
    const podNamespace = "TENTACLE_POD_NAMESPACE";
    delete process.env[podNamespace];
    process.env.TENTACLE_MODEL_BASE_URL = `http://127.0.0.1:${model.port}/v1`;
    process.env.TENTACLE_CWD = dir;
    process.env.TENTACLE_NO_AGENTS_MD = "1";
  });

  afterAll(async () => {
    k8s.stop(true);
    model.stop(true);
    for (const key of KEYS) {
      const value = saved[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(dir, { recursive: true, force: true });
  });

  const firstRequest = async (
    args: string[],
  ): Promise<{ code: number; seen?: string; out: string }> => {
    seen.length = 0;
    const out: string[] = [];
    const code = await main(["bun", "tentacle", ...args], { write: (t) => out.push(t) });
    return { code, ...(seen[0] ? { seen: seen[0] } : {}), out: out.join("") };
  };

  test("-n before or after the name reaches the API as the namespace", async () => {
    expect((await firstRequest(["attach", "-n", "dev", "mypod"])).seen).toBe(
      "GET /api/v1/namespaces/dev/pods/mypod",
    );
    expect((await firstRequest(["attach", "mypod", "-n", "dev"])).seen).toBe(
      "GET /api/v1/namespaces/dev/pods/mypod",
    );
    expect((await firstRequest(["attach", "--resume", "mypod", "-n", "dev"])).seen).toBe(
      "GET /api/v1/namespaces/dev/pods/mypod",
    );
    expect((await firstRequest(["run", "-n", "dev", "--image", "busybox", "mypod"])).seen).toBe(
      "POST /api/v1/namespaces/dev/pods",
    );
    expect((await firstRequest(["run", "--image", "busybox", "mypod", "-n", "dev"])).seen).toBe(
      "POST /api/v1/namespaces/dev/pods",
    );
  });

  test("a typo is refused before any cluster or model call", async () => {
    for (const args of [
      ["run", "--image", "busybox", "--namspace", "dev"],
      ["attach", "mypod", "--contaner", "x"],
      ["--frobnicate", "say", "hi"],
    ]) {
      const result = await firstRequest(args);
      expect(result.code).toBe(1);
      expect(result.seen).toBeUndefined();
      expect(result.out).toContain("unknown option");
    }
  });

  test("a one-shot prompt keeps its words verbatim; `--` starts one that begins with '-'", async () => {
    // The fake model refuses: what matters is that the prompt reached it.
    const inside = await firstRequest(["fix", "the", "--resume", "docs"]);
    expect(inside.seen).toBe('MODEL "fix the --resume docs"');
    const dashed = await firstRequest(["--", "-x", "is", "broken"]);
    expect(dashed.seen).toBe('MODEL "-x is broken"');
  });
});
