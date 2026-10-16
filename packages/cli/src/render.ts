/**
 * Pure renderer: turns an `AgentEvent` into the text to write to the terminal.
 * Kept side-effect-free so it is trivially testable; the main loop just writes
 * whatever it returns.
 */
import type { AgentEvent } from "@tentacle/agent";

export function render(event: AgentEvent): string {
  switch (event.type) {
    case "text":
      return event.delta;
    case "reasoning":
      // Hidden by default in F1; a verbose mode will surface it later.
      return "";
    case "tool_start":
      return `\n[tool] ${event.name} ${event.arguments}\n`;
    case "tool_result": {
      const details = event.result.details;
      if (details?.kind === "diff") {
        return `[diff] ${details.path} (+${details.added} -${details.removed})\n`;
      }
      return `[result:${event.result.isError ? "error" : "ok"}] ${firstLine(event.result.content)}\n`;
    }
    case "usage":
      return `\n(tokens ↑${event.usage.promptTokens} ↓${event.usage.completionTokens})\n`;
    case "subagent_start":
      return `  └─ ${event.agentType}: ${event.description}\n`;
    case "subagent_tool":
      return `     ${event.label}\n`;
    case "subagent_end":
      return `  └─ done (${event.toolUses} tool ${event.toolUses === 1 ? "use" : "uses"})\n`;
    case "background_exit": {
      const code = event.exitCode !== null ? ` (exit=${event.exitCode})` : "";
      return `\n[background] job ${event.jobId} ${event.status}${code}: ${event.command}\n`;
    }
    case "steer":
      return `\n› ${event.text}\n`;
    case "turn_end":
      return event.reason === "end_turn" ? "\n" : `\n[stopped: ${event.reason}]\n`;
  }
}

function firstLine(text: string): string {
  const newline = text.indexOf("\n");
  const line = newline === -1 ? text : text.slice(0, newline);
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}
