/**
 * Terminal driver for the interactive REPL.
 *
 * Reads lines via readline's async iterator (robust for both a live TTY and
 * piped input), printing a prompt before each. Ctrl+C cancels the running turn;
 * at the prompt it closes the session.
 */
import * as readline from "node:readline";
import type { Agent } from "@tentacle/agent";
import { runRepl } from "./repl.ts";

export async function startTerminal(agent: Agent): Promise<number> {
  // Only the answer is data (stdout); the prompt, the echo of the typed line
  // and the rest of the session go to stderr (docs/fix/cli-output-streams.md D5).
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: process.stdin.isTTY ?? false,
  });

  let running = false;
  let controller = new AbortController();
  const onSignal = (): void => {
    if (running) {
      controller.abort();
    } else {
      rl.close();
    }
  };
  process.on("SIGINT", onSignal);

  const lines = rl[Symbol.asyncIterator]();
  async function* prompts(): AsyncGenerator<string> {
    while (true) {
      process.stderr.write("\n› ");
      const next = await lines.next();
      if (next.done) {
        return;
      }
      yield next.value;
    }
  }

  try {
    await runRepl(agent, {
      prompts: prompts(),
      out: (text) => void process.stdout.write(text),
      err: (text) => void process.stderr.write(text),
      shared: process.stdout.isTTY === true && process.stderr.isTTY === true,
      signal: () => {
        controller = new AbortController();
        return controller.signal;
      },
      onTurnStart: () => {
        running = true;
      },
      onTurnEnd: () => {
        running = false;
      },
    });
    return 0;
  } finally {
    process.off("SIGINT", onSignal);
    rl.close();
  }
}
