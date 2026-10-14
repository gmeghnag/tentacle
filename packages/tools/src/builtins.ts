/**
 * Built-in host tools: read, write, edit (find/replace) a file, and run a shell
 * command.
 *
 * All side-effects go through `ctx.env` (the `ExecutionEnvironment`), so these
 * same tools run unchanged against a container environment later. Mutating file
 * tools attach a structured unified diff to their result (`details.kind: "diff"`)
 * so a rich frontend can render a git-style diff. Mutating tools default to
 * `permission: "ask"`.
 */
import type { ExecOptions, Tool, ToolResultDetail } from "@agent-harness/core";
import { createTwoFilesPatch } from "diff";
import { z } from "zod";
import { shellKillTool, shellOutputTool } from "./background.ts";

/** Build a unified-diff detail and count changed lines. */
function makeDiff(path: string, before: string, after: string): ToolResultDetail {
  const patch = createTwoFilesPatch(path, path, before, after, "", "");
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      added += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      removed += 1;
    }
  }
  return { kind: "diff", path, patch, added, removed };
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") {
    return 0;
  }
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

const fsReadInput = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      "File path (absolute or relative to cwd). May carry a line range as `path:start:end` (or `path:start` for start→end-of-file).",
    ),
  offset: z.number().int().positive().optional().describe("1-based first line to read."),
  limit: z.number().int().positive().optional().describe("Number of lines to read from offset."),
});

/** Parse a trailing `:start` / `:start:end` line range off a path (unix paths
 * rarely end in `:<digits>`, so this is safe). Returns the bare path + range. */
function parsePathRange(path: string): { path: string; offset?: number; limit?: number } {
  const match = /^(.*?):(\d+)(?::(\d+))?$/.exec(path);
  if (!match?.[1]) {
    return { path };
  }
  const start = Number(match[2]);
  const end = match[3] !== undefined ? Number(match[3]) : undefined;
  return {
    path: match[1],
    offset: start,
    ...(end !== undefined ? { limit: Math.max(1, end - start + 1) } : {}),
  };
}

export const fsReadTool: Tool<z.infer<typeof fsReadInput>> = {
  name: "fs_read",
  description:
    "Read a UTF-8 text file. By default returns the whole file; pass `offset`/`limit` (or a `path:start:end` range) to read only a slice — preferred for large files, then edit precisely. A ranged read is prefixed with a `[path lines A-B of N]` header.",
  inputSchema: fsReadInput,
  permission: "none",
  async execute(input, ctx) {
    // A range may come from explicit offset/limit, or a `path:start:end` suffix.
    const fromPath =
      input.offset === undefined && input.limit === undefined
        ? parsePathRange(input.path)
        : { path: input.path, offset: input.offset, limit: input.limit };
    const path = fromPath.path;
    const offset = fromPath.offset;
    const limit = fromPath.limit;

    const content = await ctx.env.readFile(path);
    if (offset === undefined && limit === undefined) {
      return { content };
    }
    const lines = content.split("\n");
    const start = Math.max(1, offset ?? 1);
    const count = limit ?? lines.length - (start - 1);
    const slice = lines.slice(start - 1, start - 1 + count);
    const endLine = start - 1 + slice.length;
    const header = `[${path} lines ${start}-${endLine} of ${lines.length}]`;
    return { content: `${header}\n${slice.join("\n")}` };
  },
};

const fsWriteInput = z.object({
  path: z.string().min(1).describe("Path to the file to write (created or overwritten)."),
  content: z.string().describe("Full UTF-8 contents to write."),
});

export const fsWriteTool: Tool<z.infer<typeof fsWriteInput>> = {
  name: "fs_write",
  description: "Write (creating or overwriting) a UTF-8 text file.",
  inputSchema: fsWriteInput,
  permission: "ask",
  async execute(input, ctx) {
    let before = "";
    try {
      before = await ctx.env.readFile(input.path);
    } catch {
      before = "";
    }
    await ctx.env.writeFile(input.path, input.content);
    const diff = makeDiff(input.path, before, input.content);
    return {
      content: `wrote ${input.content.length} bytes to ${input.path} (+${diff.added} -${diff.removed})`,
      details: diff,
    };
  },
};

const fsEditInput = z.object({
  path: z.string().min(1).describe("Path to the file to edit."),
  old_string: z
    .string()
    .min(1)
    .describe("Exact text to find. Must be unique unless replace_all is set."),
  new_string: z.string().describe("Replacement text."),
  replace_all: z
    .boolean()
    .optional()
    .describe("Replace every occurrence instead of requiring uniqueness."),
});

interface EditSpec {
  readonly old_string: string;
  readonly new_string: string;
  readonly replace_all?: boolean;
}

/** Apply one find/replace to `content`, or return why it could not be applied. */
function applyOneEdit(
  content: string,
  edit: EditSpec,
):
  | { ok: true; content: string }
  | {
      ok: false;
      reason: string;
    } {
  const matches = countOccurrences(content, edit.old_string);
  if (matches === 0) {
    return { ok: false, reason: "old_string not found" };
  }
  if (matches > 1 && !edit.replace_all) {
    return {
      ok: false,
      reason: `old_string is not unique (${matches} matches); add context or set replace_all`,
    };
  }
  // Use a function replacer for the single replace so `$&`, `$$`, `` $` ``, `$'`
  // in new_string are inserted literally (a string replacement would treat them
  // as special patterns and corrupt the edit). The replace_all path already
  // joins literally.
  const next = edit.replace_all
    ? content.split(edit.old_string).join(edit.new_string)
    : content.replace(edit.old_string, () => edit.new_string);
  return { ok: true, content: next };
}

export const fsEditTool: Tool<z.infer<typeof fsEditInput>> = {
  name: "fs_edit",
  description:
    "Edit a file by replacing an exact string. Fails if the string is missing, or not unique unless replace_all is set.",
  inputSchema: fsEditInput,
  permission: "ask",
  async execute(input, ctx) {
    const before = await ctx.env.readFile(input.path);
    const result = applyOneEdit(before, input);
    if (!result.ok) {
      return { content: `${result.reason} in ${input.path}`, isError: true };
    }
    await ctx.env.writeFile(input.path, result.content);
    const diff = makeDiff(input.path, before, result.content);
    return { content: `edited ${input.path} (+${diff.added} -${diff.removed})`, details: diff };
  },
};

const fsMultiEditInput = z.object({
  path: z.string().min(1).describe("Path to the file to edit."),
  edits: z
    .array(
      z.object({
        old_string: z.string().min(1).describe("Exact text to find."),
        new_string: z.string().describe("Replacement text."),
        replace_all: z.boolean().optional().describe("Replace every occurrence."),
      }),
    )
    .min(1)
    .describe(
      "Find/replace edits applied IN ORDER, each operating on the previous edit's result. Atomic: if any edit fails (string missing, or not unique without replace_all), the file is left unchanged.",
    ),
});

export const fsMultiEditTool: Tool<z.infer<typeof fsMultiEditInput>> = {
  name: "fs_multi_edit",
  description:
    "Apply several exact-string edits to one file in a single call, in order. Each edit sees the result of the previous one. Atomic: if any edit can't be applied, nothing is written. Prefer this over multiple fs_edit calls when changing the same file in several places.",
  inputSchema: fsMultiEditInput,
  permission: "ask",
  async execute(input, ctx) {
    const before = await ctx.env.readFile(input.path);
    let current = before;
    for (let i = 0; i < input.edits.length; i++) {
      const edit = input.edits[i];
      if (!edit) {
        continue;
      }
      const result = applyOneEdit(current, edit);
      if (!result.ok) {
        return {
          content: `edit #${i + 1} of ${input.edits.length} failed: ${result.reason} in ${input.path} (no changes written)`,
          isError: true,
        };
      }
      current = result.content;
    }
    await ctx.env.writeFile(input.path, current);
    const diff = makeDiff(input.path, before, current);
    return {
      content: `edited ${input.path} with ${input.edits.length} edits (+${diff.added} -${diff.removed})`,
      details: diff,
    };
  },
};

/** Default seconds a shell command may run before it is killed. */
const DEFAULT_SHELL_TIMEOUT_S = 120;
/** Exit code HostExecution reports for a killed (timed-out/aborted) process. */
const KILLED_EXIT_CODE = 124;

const shellInput = z.object({
  command: z.string().min(1).describe("Shell command to run via /bin/sh -c."),
  cwd: z.string().optional().describe("Working directory; defaults to the environment's cwd."),
  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`Max seconds before the command is killed (default ${DEFAULT_SHELL_TIMEOUT_S}).`),
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      "Start the command in the background and return a job id immediately instead of waiting. Use this for a long-running process (a dev server, a watcher, `tail -f`). Read its output later with `shell_output` and stop it with `shell_kill`.",
    ),
});

export const shellTool: Tool<z.infer<typeof shellInput>> = {
  name: "shell",
  description:
    "Run a shell command and capture stdout, stderr and the exit code. By default the command runs in the FOREGROUND and BLOCKS until it exits, so a long-running process (a server, a watcher, `tail -f`) would hang the turn and be killed at the timeout. For those, set `run_in_background: true` — it returns a job id at once and keeps running; read its output with `shell_output` and stop it with `shell_kill`.",
  inputSchema: shellInput,
  permission: "ask",
  async execute(input, ctx) {
    if (input.run_in_background) {
      if (!ctx.jobs) {
        return { content: "background execution is not available here", isError: true };
      }
      const options: ExecOptions = { ...(input.cwd ? { cwd: input.cwd } : {}) };
      const job = ctx.jobs.start(input.command, options);
      const pid = job.pid !== undefined ? ` (pid ${job.pid})` : "";
      return {
        content: `started background job ${job.id}${pid}: \`${input.command}\`\nRead output with shell_output({ job_id: "${job.id}" }); stop it with shell_kill({ job_id: "${job.id}" }).`,
        isError: false,
      };
    }
    const timeoutMs = (input.timeout ?? DEFAULT_SHELL_TIMEOUT_S) * 1000;
    const options: ExecOptions = {
      signal: ctx.signal,
      timeoutMs,
      ...(input.cwd ? { cwd: input.cwd } : {}),
    };
    const result = await ctx.env.exec(input.command, options);
    const body = [result.stdout, result.stderr]
      .filter((part) => part.length > 0)
      .join("\n")
      .trim();
    const killed = result.exitCode === KILLED_EXIT_CODE;
    const note = killed
      ? `\n[killed — timed out after ${input.timeout ?? DEFAULT_SHELL_TIMEOUT_S}s or was interrupted; for a long-running process pass run_in_background: true]`
      : "";
    return { content: `exit=${result.exitCode}\n${body}${note}`, isError: result.exitCode !== 0 };
  },
};

/** The default host tool-set. */
export const builtinTools: readonly Tool[] = [
  fsReadTool as unknown as Tool,
  fsWriteTool as unknown as Tool,
  fsEditTool as unknown as Tool,
  fsMultiEditTool as unknown as Tool,
  shellTool as unknown as Tool,
  shellOutputTool as unknown as Tool,
  shellKillTool as unknown as Tool,
];
