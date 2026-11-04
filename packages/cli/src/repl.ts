/**
 * Interactive REPL loop (transport-agnostic).
 *
 * Reads successive prompts from `io.prompts`, runs each as a turn against a
 * persistent `Session`, and writes the rendered stream. Slash-commands are
 * handled locally. The terminal driver (`startTerminal`) supplies a readline-backed
 * `prompts` iterable and wires Ctrl+C to cancel the running turn.
 */
import { type Agent, Session } from "@tentacle/agent";
import { atLineStartAfter, errorLine, render } from "./render.ts";

export interface ReplIO {
  /** Yields each user input line until the input ends. */
  readonly prompts: AsyncIterable<string>;
  readonly write: (text: string) => void;
  /** Optional per-turn cancellation signal. */
  readonly signal?: () => AbortSignal | undefined;
  readonly onTurnStart?: () => void;
  readonly onTurnEnd?: () => void;
}

const BANNER =
  "tentacle — interactive session\n" +
  "Type a task and press enter. /help for commands, /exit to quit.\n";

const HELP =
  "Commands:\n" +
  "  /help    show this help\n" +
  "  /exit    quit the session\n" +
  "  Ctrl+C   cancel the current turn\n";

export async function runRepl(agent: Agent, io: ReplIO): Promise<void> {
  const session = new Session(agent);
  io.write(BANNER);

  for await (const raw of io.prompts) {
    const input = raw.trim();
    if (input === "") {
      continue;
    }
    if (input === "/exit" || input === "/quit") {
      break;
    }
    if (input === "/help") {
      io.write(HELP);
      continue;
    }

    io.onTurnStart?.();
    const signal = io.signal?.();
    let atLineStart = true; // the user just pressed enter
    try {
      for await (const event of session.send(input, signal)) {
        const text = render(event);
        atLineStart = atLineStartAfter(atLineStart, text);
        io.write(text);
      }
    } catch (error) {
      io.write(errorLine(error, atLineStart));
    } finally {
      io.onTurnEnd?.();
    }
  }

  io.write("\n👋\n");
}
