/**
 * `tentacle voice setup|status` (docs/feat/voice-dictation.md §6).
 *
 * Both run OUTSIDE Ink, so plain printing and inherited stdio are allowed here —
 * the AGENTS §7 rule ("never write raw to the terminal while Ink owns it") is
 * about the alt-screen, and no TUI is mounted in this path.
 *
 * The work itself is the helper's: `setup` downloads the models (Parakeet only —
 * Apple's engine needs no download for the Mac's own language), `status` prints
 * what is installed. This module owns the dispatch, the not-found notice and the
 * usage errors, and nothing else; the deciding lives in `voice-cmd.ts`'s helpers
 * so it is testable without a child process.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { helperPathCandidates } from "@tentacle/tui";
import type { VoiceConfig } from "@tentacle/tui";

/** What `setup`/`status` need from the outside world (injectable for a test). */
export interface VoiceCmdDeps {
  readonly configDir: string;
  readonly execPath: string;
  readonly config: VoiceConfig;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  /** Run the helper with inherited stdio and return its exit code. */
  readonly runHelper: (path: string, args: readonly string[]) => Promise<number>;
  /** Does this path exist? (`existsSync` in production.) */
  readonly exists?: (path: string) => boolean;
  /** Is this a Mac at all? Voice is a macOS feature. */
  readonly platform?: string;
  /**
   * `--yes` as the PARSER saw it. `ARGS.voice` declares it a bool, so it never
   * reaches `positional`; without this the flag was silently dropped and
   * `setup` prompted anyway (Review round 1, MEDIUM 7).
   */
  readonly yes?: boolean;
}

/** The usage line, so `main` and the tests agree on one string. */
export const VOICE_USAGE = "tentacle voice setup [--yes] | status";

/** The notice a missing helper earns: what the user can DO, never a silent exit. */
export function helperMissingNotice(searched: readonly string[]): string {
  return [
    "[error] the voice helper (tentacle-voice) was not found",
    `searched: ${searched.join(", ")}`,
    "install it with: curl -fsSL tentacle.so/install | sh   (from source: bun run voice:build; or set voice.helperPath)",
  ].join("\n");
}

/**
 * Dispatch `tentacle voice <verb>`. Returns the process exit code.
 *
 * Unknown or missing verb → usage on stderr and 1, like every other subcommand
 * (`tentacle devices`' `unknown argument`, `main.ts:238-266`).
 */
export async function voiceCommand(
  positional: readonly string[],
  deps: VoiceCmdDeps,
): Promise<number> {
  const [verb, ...rest] = positional;
  if (verb !== "setup" && verb !== "status") {
    deps.err(
      verb === undefined
        ? `[error] missing argument\nusage: ${VOICE_USAGE}\n`
        : `[error] unknown argument ${JSON.stringify(verb)}\nusage: ${VOICE_USAGE}\n`,
    );
    return 1;
  }
  // A stray word after the verb is an error, not something to guess at.
  if (verb === "status" && rest.length > 0) {
    deps.err(`[error] unexpected argument ${JSON.stringify(rest[0])}\nusage: ${VOICE_USAGE}\n`);
    return 1;
  }
  if (verb === "setup" && rest.some((word) => word !== "--yes" && word !== "-y")) {
    const bad = rest.find((word) => word !== "--yes" && word !== "-y");
    deps.err(`[error] unexpected argument ${JSON.stringify(bad)}\nusage: ${VOICE_USAGE}\n`);
    return 1;
  }
  // The confirmation, from EITHER the parser's bools or a literal word: `main`
  // passes `--yes` through `bools`, a direct caller may still type it.
  const yes = deps.yes === true || rest.includes("--yes") || rest.includes("-y");

  if ((deps.platform ?? process.platform) !== "darwin") {
    // Not an error: the setting exists, the platform cannot honour it.
    deps.err("voice dictation is a macOS feature (the helper captures the Mac's microphone)\n");
    return 1;
  }

  const candidates = helperPathCandidates({
    execPath: deps.execPath,
    configDir: deps.configDir,
    config: deps.config,
  });
  // The switch itself, before the helper's own report: voice ships OFF
  // (feat/voice-off-by-default), so `status` — the command a user runs when it
  // is not working — is where they learn the key to turn it on.
  if (verb === "status") {
    deps.out(
      deps.config.enabled
        ? "voice: enabled\n"
        : 'voice: disabled — set "voice": { "enabled": true } in the config\n',
    );
  }
  const exists = deps.exists ?? existsSync;
  const helper = candidates.find((path) => exists(path));
  if (helper === undefined) {
    deps.err(`${helperMissingNotice(candidates)}\n`);
    return 1;
  }

  const args =
    verb === "setup"
      ? [
          "setup",
          ...(yes ? ["--yes"] : []),
          ...(deps.config.modelsDir === undefined ? [] : ["--models-dir", deps.config.modelsDir]),
        ]
      : [
          "status",
          ...(deps.config.modelsDir === undefined ? [] : ["--models-dir", deps.config.modelsDir]),
          "--engine",
          deps.config.engine,
        ];
  return deps.runHelper(helper, args);
}

/** The helper's real runner: inherited stdio, no Ink mounted (safe, see header). */
export async function runHelperInherited(path: string, args: readonly string[]): Promise<number> {
  const proc = Bun.spawn([path, ...args], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return proc.exited;
}

/** Where `voice setup`'s models land, for the size line it prints first. */
export function modelsDirFor(configDir: string, config: VoiceConfig): string {
  return config.modelsDir ?? resolve(configDir, "voice", "models");
}
