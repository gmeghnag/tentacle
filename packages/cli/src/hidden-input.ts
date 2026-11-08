/**
 * A no-echo line from the terminal: what `tentacle config model.apiKey` asks for
 * when no value is given and no piped stdin is available (docs/feat/config-set.md,
 * docs/eval/config-cli.md A4). The value is a credential or a secret-bearing
 * command, so it must not be echoed by the line editor and must not land in a
 * shell's history — which is why argv is refused for such a key.
 *
 * A thin, injectable seam: `main` passes the process's streams, a test passes a
 * fake stdin and a buffer to read the "screen" from. Nothing here knows about
 * config, keys or files.
 */
import { createInterface } from "node:readline";

export interface HiddenInput {
  /** Where the user types (usually `process.stdin`). */
  readonly input: NodeJS.ReadableStream;
  /** Where the prompt is written (usually `process.stderr`: stdout carries data). */
  readonly output: NodeJS.WritableStream;
  /** The line ends on Ctrl+C / EOF: `""` (the caller treats it as "nothing given"). */
  readonly onInterrupt?: () => void;
}

/** A `readline.Interface` with the one non-public field we mute. */
interface MuteableReadline {
  _writeToOutput?: (text: string) => void;
  close: () => void;
  on: (event: string, listener: () => void) => void;
  question: (query: string, callback: (answer: string) => void) => void;
}

/**
 * Ask `prompt`, echo nothing, resolve the typed line. The prompt itself IS
 * written (it names the key, not the value). Ctrl+C and EOF resolve `""`, so a
 * caller never has to distinguish "aborted" from "empty" — an empty value is
 * refused by the schema anyway.
 */
export function readHiddenLine(prompt: string, io: HiddenInput): Promise<string> {
  return new Promise((resolve) => {
    io.output.write(prompt);
    const rl = createInterface({
      input: io.input,
      output: io.output,
      terminal: true,
    }) as unknown as MuteableReadline;
    // The line editor's own echo: silenced. `_writeToOutput` is how readline
    // paints the typed characters; the interface has no public mute.
    rl._writeToOutput = () => undefined;
    let done = false;
    const finish = (answer: string): void => {
      if (done) {
        return;
      }
      done = true;
      rl.close();
      io.output.write("\n");
      resolve(answer);
    };
    rl.on("SIGINT", () => {
      io.onInterrupt?.();
      finish("");
    });
    rl.on("close", () => finish(""));
    rl.question("", finish);
  });
}
