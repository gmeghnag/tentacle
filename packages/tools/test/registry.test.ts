import { describe, expect, test } from "bun:test";
import type { ExecutionEnvironment, Tool, ToolContext } from "@tentacle/core";
import { z } from "zod";
import { ToolRegistry } from "../src/index.ts";

const throwingEnv: ExecutionEnvironment = {
  id: "none",
  exec() {
    throw new Error("not available");
  },
  readFile() {
    throw new Error("not available");
  },
  writeFile() {
    throw new Error("not available");
  },
};

function ctx(): ToolContext {
  return { sessionId: "s1", signal: new AbortController().signal, env: throwingEnv };
}

const echo: Tool<{ text: string }> = {
  name: "echo",
  description: "Echo the input text.",
  inputSchema: z.object({ text: z.string() }),
  permission: "none",
  async execute(input) {
    return { content: input.text };
  },
};

describe("ToolRegistry", () => {
  test("definitions expose name, description and a JSON schema", () => {
    const reg = new ToolRegistry().register(echo);
    const [def] = reg.definitions();
    expect(def?.name).toBe("echo");
    expect(def?.description).toBe("Echo the input text.");
    expect(def?.parameters).toMatchObject({ type: "object" });
  });

  test("executes a valid call", async () => {
    const reg = new ToolRegistry().register(echo);
    const result = await reg.execute("echo", JSON.stringify({ text: "hi" }), ctx());
    expect(result).toEqual({ content: "hi" });
  });

  test("empty arguments string is treated as {}", async () => {
    const noArgs: Tool<Record<string, never>> = {
      name: "ping",
      description: "ping",
      inputSchema: z.object({}),
      permission: "none",
      async execute() {
        return { content: "pong" };
      },
    };
    const reg = new ToolRegistry().register(noArgs);
    expect(await reg.execute("ping", "", ctx())).toEqual({ content: "pong" });
  });

  test("reports unknown tools, bad JSON and invalid args as errors", async () => {
    const reg = new ToolRegistry().register(echo);
    expect((await reg.execute("nope", "{}", ctx())).isError).toBe(true);
    expect((await reg.execute("echo", "{not json", ctx())).isError).toBe(true);
    expect((await reg.execute("echo", JSON.stringify({ text: 1 }), ctx())).isError).toBe(true);
  });

  test("captures a throwing handler as an error result", async () => {
    const boom: Tool<Record<string, never>> = {
      name: "boom",
      description: "throws",
      inputSchema: z.object({}),
      permission: "none",
      async execute() {
        throw new Error("kaboom");
      },
    };
    const reg = new ToolRegistry().register(boom);
    const result = await reg.execute("boom", "{}", ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("kaboom");
  });

  test("rejects duplicate registration", () => {
    const reg = new ToolRegistry().register(echo);
    expect(() => reg.register(echo)).toThrow(/already registered/);
  });

  describe("replace", () => {
    const named = (name: string, content: string): Tool<Record<string, never>> => ({
      name,
      description: content,
      inputSchema: z.object({}),
      permission: "none",
      async execute() {
        return { content };
      },
    });

    test("swaps one entry in place: the others and their order are kept", async () => {
      const reg = new ToolRegistry()
        .register(named("a", "a1"))
        .register(named("b", "b1"))
        .register(named("c", "c1"));
      reg.replace("b", named("b", "b2"));
      expect(reg.list().map((t) => t.name)).toEqual(["a", "b", "c"]);
      expect((await reg.execute("b", "{}", ctx())).content).toBe("b2");
      expect((await reg.execute("a", "{}", ctx())).content).toBe("a1");
    });

    test("removes the entry with undefined (and tolerates an absent one)", () => {
      const reg = new ToolRegistry().register(named("a", "a1")).register(named("b", "b1"));
      reg.replace("a", undefined);
      reg.replace("zzz", undefined);
      expect(reg.list().map((t) => t.name)).toEqual(["b"]);
      expect(reg.get("a")).toBeUndefined();
    });

    test("registers a name that was not there, at the end", () => {
      const reg = new ToolRegistry().register(named("a", "a1"));
      reg.replace("n", named("n", "n1"));
      expect(reg.list().map((t) => t.name)).toEqual(["a", "n"]);
    });

    test("throws on a name mismatch and changes nothing", () => {
      const reg = new ToolRegistry().register(named("a", "a1"));
      expect(() => reg.replace("a", named("other", "x"))).toThrow(/name mismatch/);
      expect(reg.get("a")?.description).toBe("a1");
      expect(reg.get("other")).toBeUndefined();
    });
  });
});
