/**
 * Stdio transport for MCP: spawn the server as a subprocess and exchange
 * newline-delimited JSON-RPC messages over its stdin/stdout (the framing MCP's
 * stdio transport uses — one JSON message per line, no embedded newlines).
 *
 * `createStdioTransport` is the host-backed implementation; the `McpTransport`
 * contract lets the client run against an in-memory pair in tests.
 */
import { scrubSensitiveEnv } from "@agent-harness/core";
import type { McpStdioServerSpec, McpTransport } from "./types.ts";

export interface StdioTransportOptions {
  /** Receives each line the server writes to stderr; omitted → stderr is dropped. */
  readonly onStderr?: (line: string) => void;
}

/** Split a growing buffer into complete lines, returning the trailing partial. */
function takeLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts, rest };
}

export function createStdioTransport(
  spec: McpStdioServerSpec,
  options: StdioTransportOptions = {},
): McpTransport {
  // Never hand the child our secrets (API keys/tokens); the user's explicit
  // `spec.env` is still honoured (they opted in). stderr is captured, not
  // inherited, so a chatty server can't scribble over the TUI's alt-screen.
  const baseEnv = scrubSensitiveEnv(process.env);
  const proc = Bun.spawn([spec.command, ...(spec.args ?? [])], {
    cwd: spec.cwd,
    env: spec.env ? { ...baseEnv, ...spec.env } : baseEnv,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const messageListeners = new Set<(message: unknown) => void>();
  const closeListeners = new Set<() => void>();
  let closed = false;
  const encoder = new TextEncoder();

  const emitClose = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    for (const listener of closeListeners) {
      listener();
    }
  };

  // Drain stdout, parsing each complete line as a JSON-RPC message.
  void (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const { lines, rest } = takeLines(buffer);
        buffer = rest;
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed === "") {
            continue;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(trimmed);
          } catch {
            continue; // ignore non-JSON noise on stdout
          }
          for (const listener of messageListeners) {
            listener(parsed);
          }
        }
      }
    } catch {
      // reader torn down
    } finally {
      emitClose();
    }
  })();

  // Drain stderr so the pipe never backs up; route lines to `onStderr`, or drop.
  void (async () => {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const { lines, rest } = takeLines(buffer);
        buffer = rest;
        if (options.onStderr) {
          for (const line of lines) {
            options.onStderr(line);
          }
        }
      }
    } catch {
      // reader torn down
    }
  })();

  void proc.exited.then(emitClose);

  return {
    send(message: unknown): void {
      if (closed) {
        return;
      }
      proc.stdin.write(encoder.encode(`${JSON.stringify(message)}\n`));
      proc.stdin.flush();
    },
    onMessage(listener): void {
      messageListeners.add(listener);
    },
    onClose(listener): void {
      closeListeners.add(listener);
    },
    close(): void {
      emitClose();
      try {
        proc.stdin.end();
      } catch {
        // already closed
      }
      proc.kill();
    },
  };
}
