/**
 * The model's `context_reset` tool (docs/feat/context-reset.md): offered to
 * the model and asked like any `ask` tool, but RUN by the agent loop, which
 * replaces the history in place between rounds. Its `execute` is reached only
 * where no loop handles it (a registry without the agent's reset config).
 */
import type { Tool, ToolResult } from "@tentacle/core";
import { z } from "zod";

export const CONTEXT_RESET_TOOL_NAME = "context_reset";

const DESCRIPTION = `Renew your own context: everything in this conversation is discarded and you continue the SAME task from a fresh context holding only the system prompt (re-read from disk: identity, AGENTS.md, the skills catalog), the restart prompt you write here, the background jobs still running and the skills you have active. Use it when a new part of the work begins and a long context no longer helps (e.g. the next step of a written plan).

You will see NOTHING else from before, so the restart prompt must be self-sufficient:
- the goal, and where the plan lives (a file path rather than everything inline);
- what is done and what is verified;
- the next step;
- constraints, decisions taken, and anything the user asked during the work (their messages are discarded too).

Rules: it must be the only tool call of its message; call another tool between two resets; the user may be asked to approve it.`;

const inputSchema = z.object({
  prompt: z
    .string()
    .describe("The restart prompt: the self-sufficient text you continue from (see above)"),
});

export function createContextResetTool(): Tool<z.infer<typeof inputSchema>> {
  return {
    name: CONTEXT_RESET_TOOL_NAME,
    description: DESCRIPTION,
    inputSchema,
    permission: "ask",
    async execute(): Promise<ToolResult> {
      return {
        content: "context_reset is handled by the agent loop, which is not available here.",
        isError: true,
      };
    },
  };
}
