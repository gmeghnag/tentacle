/**
 * `tentacle pair`, in-process, for the harness and the tests
 * (docs/feat/mobile-pairing-screen.md 11b.1 P6: a pipe has no TTY, so `pair`
 * must be CALLED with an injected `ask` — spawning `tentacle pair` on a pipe
 * declines every claim, F-H1).
 *
 * Why a loader instead of an import statement: `apps/mobile`'s tsconfig is its
 * own project (`tsc -p apps/mobile`), and `packages/cli` pulls `@tentacle/tui`
 * into that compilation — whose graph (Redis-only deps, a JS-only
 * `marked-terminal`) is not part of this project, so a static import makes the
 * app's own typecheck fail on code this task does not own. A COMPUTED specifier
 * keeps `tsc` out of that graph while Bun resolves the very same module at
 * runtime, so the tests and the harness drive the real command, and the app
 * ships none of it (nothing under `src/` imports this file).
 */

/** The `<configDir>`-rooted options this harness uses (a subset of `PairOptions`). */
export interface PairCommandOptions {
  readonly configDir: string;
  readonly extraAddresses?: readonly string[];
  readonly interfaces?: readonly unknown[];
  readonly qr?: boolean;
  readonly ttlMs?: number;
  readonly pollMs?: number;
  readonly hostname?: string;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly ask?: (prompt: string) => Promise<string>;
}

type PairCommand = (options: PairCommandOptions) => Promise<number>;

/** `<repo>/packages/cli/src/pair.ts`, from this file's own location. */
const PAIR_MODULE = new URL("../../../packages/cli/src/pair.ts", import.meta.url).href;

let loaded: Promise<PairCommand> | undefined;

/** The real `pairCommand` (loaded once). */
export function loadPairCommand(): Promise<PairCommand> {
  loaded ??= import(PAIR_MODULE).then((module: { pairCommand: PairCommand }) => module.pairCommand);
  return loaded;
}

/** `tentacle devices revoke <name>` / `devices reset`, same reason as above. */
export interface DevicesDeps {
  readonly configDir: string;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly now: () => number;
  readonly hostname?: string;
  readonly name?: string;
  readonly ask?: (prompt: string) => Promise<string>;
}

const DEVICES_MODULE = new URL("../../../packages/cli/src/devices-cmd.ts", import.meta.url).href;

export interface DeviceCommands {
  readonly revokeCommand: (word: string, deps: DevicesDeps) => number;
  readonly resetCommand: (deps: DevicesDeps & { readonly yes?: boolean }) => Promise<number>;
}

/** The real `revokeCommand` / `resetCommand`. */
export function loadDeviceCommands(): Promise<DeviceCommands> {
  return import(DEVICES_MODULE).then((module: DeviceCommands) => module);
}
