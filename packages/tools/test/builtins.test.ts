import { describe, expect, test } from "bun:test";
import type {
  BackgroundJob,
  ExecResult,
  ExecutionEnvironment,
  JobController,
  JobOutput,
  ToolContext,
} from "@tentacle/core";
import {
  fsEditTool,
  fsMultiEditTool,
  fsReadTool,
  fsWriteTool,
  shellKillTool,
  shellOutputTool,
  shellTool,
} from "../src/index.ts";

interface FakeEnv extends ExecutionEnvironment {
  readonly files: Record<string, string>;
}

function fakeEnv(
  files: Record<string, string> = {},
  exec: (command: string) => ExecResult = (command) => ({
    stdout: `ran: ${command}`,
    stderr: "",
    exitCode: 0,
  }),
): FakeEnv {
  return {
    id: "fake",
    files,
    async exec(command) {
      return exec(command);
    },
    async readFile(path) {
      const value = files[path];
      if (value === undefined) {
        throw new Error(`no such file: ${path}`);
      }
      return value;
    },
    async writeFile(path, contents) {
      files[path] = contents;
    },
  };
}

function ctx(env: ExecutionEnvironment, jobs?: JobController): ToolContext {
  return { sessionId: "s1", signal: new AbortController().signal, env, ...(jobs ? { jobs } : {}) };
}

/** A minimal in-memory JobController recording calls, for the shell tools. */
function fakeJobs(): JobController & {
  readonly starts: string[];
  readonly kills: string[];
  setOutput(id: string, out: JobOutput): void;
} {
  const starts: string[] = [];
  const kills: string[] = [];
  const outputs = new Map<string, JobOutput>();
  let seq = 0;
  return {
    starts,
    kills,
    setOutput(id, out) {
      outputs.set(id, out);
    },
    start(command) {
      starts.push(command);
      const job: BackgroundJob = {
        id: `bg-${++seq}`,
        command,
        pid: 100 + seq,
        startedAt: 0,
        status: "running",
        exitCode: null,
      };
      return job;
    },
    read(id) {
      return outputs.get(id);
    },
    kill(id) {
      kills.push(id);
      return true;
    },
    list() {
      return [];
    },
    onExit() {
      return () => {};
    },
    dispose() {},
  };
}

describe("built-in tools", () => {
  test("fs_read returns file contents via the environment", async () => {
    const env = fakeEnv({ "a.txt": "hello" });
    expect(await fsReadTool.execute({ path: "a.txt" }, ctx(env))).toEqual({ content: "hello" });
  });

  test("fs_read returns a line range via offset/limit with a header", async () => {
    const env = fakeEnv({ "big.txt": "l1\nl2\nl3\nl4\nl5" });
    const result = await fsReadTool.execute({ path: "big.txt", offset: 2, limit: 2 }, ctx(env));
    expect(result.content).toBe("[big.txt lines 2-3 of 5]\nl2\nl3");
  });

  test("fs_read parses a path:start:end range", async () => {
    const env = fakeEnv({ "big.txt": "l1\nl2\nl3\nl4\nl5" });
    const result = await fsReadTool.execute({ path: "big.txt:3:4" }, ctx(env));
    expect(result.content).toBe("[big.txt lines 3-4 of 5]\nl3\nl4");
  });

  test("fs_read with path:start reads to end of file", async () => {
    const env = fakeEnv({ "big.txt": "l1\nl2\nl3" });
    const result = await fsReadTool.execute({ path: "big.txt:2" }, ctx(env));
    expect(result.content).toBe("[big.txt lines 2-3 of 3]\nl2\nl3");
  });

  test("fs_write writes through the environment", async () => {
    const env = fakeEnv();
    const result = await fsWriteTool.execute({ path: "b.txt", content: "data" }, ctx(env));
    expect(env.files["b.txt"]).toBe("data");
    expect(result.content).toContain("b.txt");
  });

  test("fs_write attaches a diff for a new file", async () => {
    const env = fakeEnv();
    const result = await fsWriteTool.execute(
      { path: "n.txt", content: "line1\nline2\n" },
      ctx(env),
    );
    expect(result.details?.kind).toBe("diff");
    if (result.details?.kind === "diff") {
      expect(result.details.added).toBeGreaterThan(0);
      expect(result.details.removed).toBe(0);
      expect(result.details.patch).toContain("line1");
    }
  });

  test("fs_edit replaces a unique string and reports a diff", async () => {
    const env = fakeEnv({ "c.txt": "hello world\n" });
    const result = await fsEditTool.execute(
      { path: "c.txt", old_string: "world", new_string: "there" },
      ctx(env),
    );
    expect(env.files["c.txt"]).toBe("hello there\n");
    expect(result.isError).toBeUndefined();
    expect(result.details?.kind).toBe("diff");
  });

  test("fs_edit inserts `$` patterns in new_string literally", async () => {
    const env = fakeEnv({ "c.txt": "echo HERE\n" });
    const result = await fsEditTool.execute(
      // new_string carries every String.replace special pattern: $&, $$, $`, $'
      { path: "c.txt", old_string: "HERE", new_string: "a$&b$$c$`d$'e" },
      ctx(env),
    );
    expect(result.isError).toBeUndefined();
    expect(env.files["c.txt"]).toBe("echo a$&b$$c$`d$'e\n");
  });

  test("fs_edit fails when the string is missing", async () => {
    const env = fakeEnv({ "c.txt": "hello\n" });
    const result = await fsEditTool.execute(
      { path: "c.txt", old_string: "absent", new_string: "x" },
      ctx(env),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });

  test("fs_edit refuses a non-unique string unless replace_all", async () => {
    const env = fakeEnv({ "c.txt": "a a a" });
    const ambiguous = await fsEditTool.execute(
      { path: "c.txt", old_string: "a", new_string: "b" },
      ctx(env),
    );
    expect(ambiguous.isError).toBe(true);

    const all = await fsEditTool.execute(
      { path: "c.txt", old_string: "a", new_string: "b", replace_all: true },
      ctx(env),
    );
    expect(all.isError).toBeUndefined();
    expect(env.files["c.txt"]).toBe("b b b");
  });

  test("fs_multi_edit applies edits in order and writes once", async () => {
    const env = fakeEnv({ "f.ts": "const a = 1;\nconst b = 2;\n" });
    const result = await fsMultiEditTool.execute(
      {
        path: "f.ts",
        edits: [
          { old_string: "a = 1", new_string: "a = 10" },
          { old_string: "b = 2", new_string: "b = 20" },
        ],
      },
      ctx(env),
    );
    expect(result.isError).toBeUndefined();
    expect(env.files["f.ts"]).toBe("const a = 10;\nconst b = 20;\n");
    expect(result.details?.kind).toBe("diff");
    expect(result.content).toContain("2 edits");
  });

  test("fs_multi_edit sees the previous edit's result (sequential)", async () => {
    const env = fakeEnv({ "f.txt": "foo" });
    await fsMultiEditTool.execute(
      {
        path: "f.txt",
        edits: [
          { old_string: "foo", new_string: "bar" },
          { old_string: "bar", new_string: "baz" },
        ],
      },
      ctx(env),
    );
    expect(env.files["f.txt"]).toBe("baz");
  });

  test("fs_multi_edit is atomic: a failing edit writes nothing", async () => {
    const env = fakeEnv({ "f.txt": "hello world" });
    const result = await fsMultiEditTool.execute(
      {
        path: "f.txt",
        edits: [
          { old_string: "hello", new_string: "hi" },
          { old_string: "absent", new_string: "x" },
        ],
      },
      ctx(env),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("edit #2");
    expect(result.content).toContain("no changes written");
    expect(env.files["f.txt"]).toBe("hello world"); // untouched
  });

  test("fs_multi_edit rejects a non-unique string unless replace_all", async () => {
    const env = fakeEnv({ "f.txt": "x x x" });
    const ambiguous = await fsMultiEditTool.execute(
      { path: "f.txt", edits: [{ old_string: "x", new_string: "y" }] },
      ctx(env),
    );
    expect(ambiguous.isError).toBe(true);
    expect(env.files["f.txt"]).toBe("x x x");

    const all = await fsMultiEditTool.execute(
      { path: "f.txt", edits: [{ old_string: "x", new_string: "y", replace_all: true }] },
      ctx(env),
    );
    expect(all.isError).toBeUndefined();
    expect(env.files["f.txt"]).toBe("y y y");
  });

  test("shell reports stdout and success", async () => {
    const env = fakeEnv();
    const result = await shellTool.execute({ command: "ls" }, ctx(env));
    expect(result.content).toBe("exit=0\nran: ls");
    expect(result.isError).toBe(false);
  });

  test("shell flags a non-zero exit as an error", async () => {
    const env = fakeEnv({}, () => ({ stdout: "", stderr: "nope", exitCode: 2 }));
    const result = await shellTool.execute({ command: "bad" }, ctx(env));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("exit=2");
    expect(result.content).toContain("nope");
  });

  test("shell passes a default timeout and flags a killed command", async () => {
    let seenTimeout: number | undefined;
    const env: ExecutionEnvironment = {
      id: "rec",
      async exec(_command, options) {
        seenTimeout = options?.timeoutMs;
        return { stdout: "", stderr: "", exitCode: 124 }; // killed
      },
      async readFile() {
        return "";
      },
      async writeFile() {},
    };
    const result = await shellTool.execute({ command: "python3 -m http.server" }, ctx(env));
    expect(seenTimeout).toBe(120000); // default 120s
    expect(result.isError).toBe(true);
    expect(result.content).toContain("killed");
    expect(result.content).toContain("run_in_background");
  });

  test("shell honours an explicit timeout", async () => {
    let seenTimeout: number | undefined;
    const env: ExecutionEnvironment = {
      id: "rec",
      async exec(_command, options) {
        seenTimeout = options?.timeoutMs;
        return { stdout: "ok", stderr: "", exitCode: 0 };
      },
      async readFile() {
        return "";
      },
      async writeFile() {},
    };
    await shellTool.execute({ command: "sleep 1", timeout: 5 }, ctx(env));
    expect(seenTimeout).toBe(5000);
  });

  test("shell run_in_background starts a job and returns its id", async () => {
    const env = fakeEnv();
    const jobs = fakeJobs();
    let execRan = false;
    env.exec = async (c) => {
      execRan = true;
      return { stdout: `ran: ${c}`, stderr: "", exitCode: 0 };
    };
    const result = await shellTool.execute(
      { command: "python3 -m http.server", run_in_background: true },
      ctx(env, jobs),
    );
    expect(execRan).toBe(false); // did not block on exec
    expect(jobs.starts).toEqual(["python3 -m http.server"]);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("bg-1");
    expect(result.content).toContain("shell_output");
  });

  test("shell run_in_background errors when no job controller is wired", async () => {
    const env = fakeEnv();
    const result = await shellTool.execute({ command: "serve", run_in_background: true }, ctx(env));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not available");
  });

  test("shell_output returns new output and status", async () => {
    const env = fakeEnv();
    const jobs = fakeJobs();
    jobs.setOutput("bg-1", {
      job: { id: "bg-1", command: "serve", startedAt: 0, status: "exited", exitCode: 0 },
      stdout: "listening\n",
      stderr: "",
    });
    const result = await shellOutputTool.execute({ job_id: "bg-1" }, ctx(env, jobs));
    expect(result.isError).toBe(false);
    expect(result.content).toContain("exited (exit=0)");
    expect(result.content).toContain("listening");
  });

  test("shell_output flags an unknown job", async () => {
    const result = await shellOutputTool.execute({ job_id: "ghost" }, ctx(fakeEnv(), fakeJobs()));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("no such background job");
  });

  test("shell_kill terminates a job", async () => {
    const jobs = fakeJobs();
    const result = await shellKillTool.execute({ job_id: "bg-1" }, ctx(fakeEnv(), jobs));
    expect(jobs.kills).toEqual(["bg-1"]);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("killed background job bg-1");
  });
});
