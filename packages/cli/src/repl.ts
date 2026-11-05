/**
 * Interactive REPL loop (transport-agnostic).
 *
 * Reads successive prompts from `io.prompts`, runs each as a turn against a
 * persistent `Session`, and writes the rendered stream. Slash-commands are
 * handled locally. The terminal driver (`startTerminal`) supplies a readline-backed
 * `prompts` iterable and wires Ctrl+C to cancel the running turn.
 */
import { type Agent, Session } from "@tentacle/agent";
import { AnswerSplit } from "./render.ts";

export interface ReplIO {
  /** Yields each user input line until the input ends. */
  readonly prompts: AsyncIterable<string>;
  /** The answer text (stdout): data only (docs/fix/cli-output-streams.md D5). */
  readonly out: (text: string) => void;
  /** Everything else (stderr): the banner, `/help`, the trace, errors, the goodbye. */
  readonly err: (text: string) => void;
  /** stdout and stderr are one terminal: the answer moves the trace's cursor. */
  readonly shared?: boolean;
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
  io.err(BANNER);

  for await (const raw of io.prompts) {
    const input = raw.trim();
    if (input === "") {
      continue;
    }
    if (input === "/exit" || input === "/quit") {
      break;
    }
    if (input === "/help") {
      io.err(HELP);
      continue;
    }

    io.onTurnStart?.();
    const signal = io.signal?.();
    const split = new AnswerSplit(io.shared === true); // the user just pressed enter: at a line start
    try {
      for await (const event of session.send(input, signal)) {
        const { out, err } = split.push(event);
        if (out !== "") io.out(out);
        if (err !== "") io.err(err);
      }
    } catch (error) {
      io.err(split.error(error));
    } finally {
      io.onTurnEnd?.();
    }
  }

  io.err("\n👋\n");
}
