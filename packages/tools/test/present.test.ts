import { describe, expect, test } from "bun:test";
/**
 * The model's `present` tool (docs/feat/model-artifacts.md D2, T3.2 / T3.6): it
 * reads through the env's CONFINED `readBytes` (never `readFile`), classifies,
 * hands the store a snapshot keyed to its own call, and fails loudly and
 * actionably — including where no store exists (a sub-agent, a one-shot).
 */
import type {
  ArtifactPresentInput,
  ArtifactSink,
  ExecutionEnvironment,
  ToolContext,
} from "@tentacle/core";
import { MAX_ARTIFACT_BYTES } from "@tentacle/core";
import { PRESENT_TOOL_NAME, ToolRegistry, presentTool } from "../src/index.ts";

const PNG_1x1 = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==",
    "base64",
  ),
);

class SpySink implements ArtifactSink {
  readonly calls: ArtifactPresentInput[] = [];
  fail: Error | null = null;
  async present(input: ArtifactPresentInput) {
    if (this.fail) throw this.fail;
    this.calls.push(input);
    return {
      artifactId: input.id ?? "a1",
      version: 1,
      sha256: "0".repeat(64),
      size: input.bytes.length,
      mimeType: input.mimeType,
      kind: input.kind,
      title: input.title,
      callId: input.callId,
      createdAt: 0,
    };
  }
}

interface EnvSpy {
  env: ExecutionEnvironment;
  reads: { path: string; maxBytes: number }[];
  textReads: string[];
}

function envWith(files: Record<string, Uint8Array | Error>, binary = true): EnvSpy {
  const reads: { path: string; maxBytes: number }[] = [];
  const textReads: string[] = [];
  const env: ExecutionEnvironment = {
    id: "e",
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    readFile: async (p) => {
      textReads.push(p);
      return "";
    },
    writeFile: async () => {},
    ...(binary
      ? {
          readConfinedBytes: async (path: string, { maxBytes }: { maxBytes: number }) => {
            reads.push({ path, maxBytes });
            const f = files[path];
            if (f === undefined) throw new Error(`no such file: ${path}`);
            if (f instanceof Error) throw f;
            return { bytes: f, realPath: `/ws/${path}` };
          },
        }
      : {}),
  };
  return { env, reads, textReads };
}

function ctx(env: ExecutionEnvironment, artifacts?: ArtifactSink): ToolContext {
  return {
    sessionId: "s1",
    signal: new AbortController().signal,
    env,
    toolCallId: "call-7",
    ...(artifacts ? { artifacts } : {}),
  };
}

const run = (input: Record<string, unknown>, c: ToolContext) =>
  new ToolRegistry().register(presentTool).execute(PRESENT_TOOL_NAME, JSON.stringify(input), c);

describe("present — happy paths (T3.1 via the tool)", () => {
  test("a workspace file: confined readBytes at the 20 MiB cap, classified, nested detail", async () => {
    const sink = new SpySink();
    const spy = envWith({ "out/dot.png": PNG_1x1 });
    const r = await run({ title: "Dot", path: "out/dot.png", id: "dot" }, ctx(spy.env, sink));
    expect(r.isError).toBeFalsy();
    expect(spy.reads).toEqual([{ path: "out/dot.png", maxBytes: MAX_ARTIFACT_BYTES }]);
    expect(spy.textReads).toEqual([]);
    expect(sink.calls[0]).toMatchObject({
      title: "Dot",
      kind: "image",
      mimeType: "image/png",
      width: 1,
      height: 1,
      callId: "call-7",
      source: "out/dot.png",
      id: "dot",
    });
    expect(r.details?.kind).toBe("artifact");
    if (r.details?.kind === "artifact") {
      expect(r.details.artifact.kind).toBe("image");
      expect(r.details.artifact.artifactId).toBe("dot");
    }
    expect(r.content).toContain('Presented "Dot"');
    expect(r.content).toContain("dot v1");
  });

  test("generated content: UTF-8 bytes, the kind hint wins for text, no file read", async () => {
    const sink = new SpySink();
    const spy = envWith({});
    const r = await run(
      { title: "Notes", content: "# Hi\n\nàè", kind: "markdown" },
      ctx(spy.env, sink),
    );
    expect(r.isError).toBeFalsy();
    expect(spy.reads).toEqual([]);
    const call = sink.calls[0];
    expect(call?.kind).toBe("markdown");
    expect(new TextDecoder().decode(call?.bytes)).toBe("# Hi\n\nàè");
    expect(call?.source).toBeUndefined();
  });
});

describe("present — loud, model-actionable errors (T3.2)", () => {
  test("the env's refusal (too large, outside, secret) is the model's error text", async () => {
    const sink = new SpySink();
    const spy = envWith({
      "big.bin": new Error("file too large (31.2 MiB > 20 MiB): big.bin"),
      "../x.png": new Error("outside the workspace (/ws) — copy it into the workspace first"),
    });
    const big = await run({ title: "Big", path: "big.bin" }, ctx(spy.env, sink));
    expect(big.isError).toBe(true);
    expect(big.content).toContain("file too large (31.2 MiB > 20 MiB)");
    const out = await run({ title: "Out", path: "../x.png" }, ctx(spy.env, sink));
    expect(out.isError).toBe(true);
    expect(out.content).toContain("copy it into the workspace first");
    expect(sink.calls).toEqual([]);
  });

  test("content over 2 MiB chars is refused by the schema", async () => {
    const sink = new SpySink();
    const r = await run(
      { title: "Huge", content: "x".repeat(2 * 1024 * 1024 + 1) },
      ctx(envWith({}).env, sink),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("invalid arguments");
    expect(sink.calls).toEqual([]);
  });

  test("both or neither of path | content → an error naming the rule", async () => {
    const sink = new SpySink();
    const c = ctx(envWith({ "a.md": new Uint8Array([65]) }).env, sink);
    const both = await run({ title: "T", path: "a.md", content: "x" }, c);
    const neither = await run({ title: "T" }, c);
    for (const r of [both, neither]) {
      expect(r.isError).toBe(true);
      expect(r.content).toContain("exactly one of `path` or `content`");
    }
    expect(sink.calls).toEqual([]);
  });

  test("a title with a control character or an invalid id is refused by the schema", async () => {
    const sink = new SpySink();
    const c = ctx(envWith({}).env, sink);
    expect((await run({ title: "a\nb", content: "x" }, c)).isError).toBe(true);
    expect((await run({ title: "ok", content: "x", id: "../x" }, c)).isError).toBe(true);
    expect(sink.calls).toEqual([]);
  });

  test("an empty file is refused (the wire refuses size 0)", async () => {
    const sink = new SpySink();
    const c = ctx(envWith({ "e.txt": new Uint8Array(0) }).env, sink);
    const r = await run({ title: "E", path: "e.txt" }, c);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("empty");
    expect(sink.calls).toEqual([]);
  });

  test("the store's refusal (full) is the model's error text", async () => {
    const sink = new SpySink();
    sink.fail = new Error("artifact store full — present fewer or smaller files");
    const r = await run({ title: "T", content: "x" }, ctx(envWith({}).env, sink));
    expect(r.isError).toBe(true);
    expect(r.content).toContain("artifact store full");
  });

  test("an env without readBytes cannot present a file (content still works)", async () => {
    const sink = new SpySink();
    const spy = envWith({}, false);
    const file = await run({ title: "T", path: "a.png" }, ctx(spy.env, sink));
    expect(file.isError).toBe(true);
    expect(file.content).toContain("cannot read binary files here");
    expect(spy.textReads).toEqual([]);
    const text = await run({ title: "T", content: "x" }, ctx(spy.env, sink));
    expect(text.isError).toBeFalsy();
  });
});

describe("present — no sink, no present (T3.6)", () => {
  test("a context without an artifact store (sub-agent, one-shot) → error, nothing read", async () => {
    const spy = envWith({ "a.png": PNG_1x1 });
    const r = await run({ title: "T", path: "a.png" }, ctx(spy.env));
    expect(r.isError).toBe(true);
    expect(r.content).toContain("present is not available here");
    expect(spy.reads).toEqual([]);
  });
});

describe("present — tool shape", () => {
  test("permission none; keys: read on the path, write on the session's artifacts", () => {
    expect(presentTool.permission).toBe("none");
    const keys = presentTool.concurrency;
    expect(typeof keys).toBe("function");
    if (typeof keys !== "function") return;
    const withPath = keys({ title: "T", path: "out/a.png" });
    expect(withPath).toContainEqual({ mode: "write", resource: "artifacts" });
    expect(withPath).toContainEqual({ mode: "read", resource: "path:a.png" });
    expect(keys({ title: "T", content: "x" })).toEqual([{ mode: "write", resource: "artifacts" }]);
    expect(keys(null)).toBe("exclusive");
  });
});
