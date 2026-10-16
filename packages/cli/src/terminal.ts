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
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
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
      process.stdout.write("\n› ");
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
      write: (text) => void process.stdout.write(text),
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
