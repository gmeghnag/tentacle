/**
 * Mount the `--resume` picker on the terminal, before the main TUI and before
 * the runtime starts (docs/feat/resume-picker.md). It runs on the MAIN screen
 * (not the alternate one), erases its frame when answered and unmounts, so the
 * main TUI's own `render()` then owns stdin alone.
 */
import { render } from "ink";
import { SessionPickerApp } from "./components/SessionPicker.tsx";
import type { SessionChoice } from "./session-picker.ts";

export interface PickSessionOptions {
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  /** For tests: the clock the ages are computed against. */
  readonly now?: number;
}

/** A size of 0 (some ptys) counts as unknown. Header + "↑ n more" + "↓ n more" + one spare line. */
const CHROME_ROWS = 4;

/** Let the user choose a session: its id, or null when cancelled (Esc / Ctrl+C). */
export async function pickSession(
  choices: readonly SessionChoice[],
  options: PickSessionOptions = {},
): Promise<string | null> {
  const stdout = options.stdout ?? process.stdout;
  const stdin = options.stdin ?? process.stdin;
  let answer: string | null = null;
  const instance = render(
    <SessionPickerApp
      choices={choices}
      now={options.now ?? Date.now()}
      height={Math.max(3, (stdout.rows || 24) - CHROME_ROWS)}
      columns={stdout.columns || 80}
      onDone={(id) => {
        answer = id;
      }}
    />,
    { stdin, stdout, exitOnCtrlC: false, patchConsole: false },
  );
  await instance.waitUntilExit();
  return answer;
}
