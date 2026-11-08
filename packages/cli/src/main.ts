#!/usr/bin/env bun
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
/**
 * CLI entry point (F1).
 *
 *   tentacle                 → interactive TUI (when stdin is a TTY)
 *   tentacle <prompt...>     → one-shot run
 *   tentacle run [opts]      → run the agent inside a Kubernetes pod (F4)
 *   tentacle attach <pod>      → attach the TUI to an existing pod (F4)
 *   tentacle --help          → usage
 *   tentacle --version       → print the version and exit
 *
 * Configuration is layered (env > ~/.config/tentacle/config.jsonc >
 * defaults); see `@tentacle/config`. The config dir + PROMPT.md are
 * scaffolded on first run.
 *
 * NOTE: F1 auto-approves tool calls; the interactive permission engine arrives
 * in F4. Until then, point the CLI at a trusted model and workspace.
 */
import { Session, recordFromSnapshot } from "@tentacle/agent";
import { webSocketChannelFactory } from "@tentacle/client";
import { type ChatMessage, PermissionBroker } from "@tentacle/core";
import { DELETE_CONTAINER_SUBCOMMAND, deleteContainerFromEnv } from "@tentacle/docker";
import { DELETE_POD_SUBCOMMAND, deletePodFromEnv, readKubeconfig } from "@tentacle/k8s";
import { McpStatusTracker, connectMcpServers } from "@tentacle/mcp";
import { type AutoAcceptFeed, type SessionController, pickSession, startTui } from "@tentacle/tui";
import { attachFailureNotice, unflushedExitsNotice } from "./attach-notice.ts";
import { type AttachPlan, plainResumeUid, planAttach } from "./attach-plan.ts";
import { type Joined, joinRun } from "./attach-run.ts";
import { parseConfigArgs } from "./config-args.ts";
import { runConfig } from "./config-run.ts";
import {
  CONFIG_FILENAME,
  type TentacleConfig,
  configDirFromEnv,
  loadConfig,
  longToolNameWarnings,
  titleConfigNotice,
  topLevelKeys,
} from "./config.ts";
import { connectTui } from "./connect.ts";
import { type EngineKind, WorkloadNotFoundError } from "./engine-host.ts";
import {
  armSharedExitNet,
  attachEngineRuntime,
  provisionWorkload,
  startEngineRuntime,
} from "./engine-runtime.ts";
import {
  attachCommand,
  buildEngineHost,
  chooseEngine,
  engineFlagProblem,
  engineNoun,
  hostOptionsFor,
  keptLocation,
  laptopWorkspaceInput,
  resolveRm,
  setupFailureLine,
} from "./engine-select.ts";
import {
  explain,
  explainErrorText,
  promptHint,
  renderExplainJson,
  renderExplainText,
} from "./explain.ts";
import {
  ARGS,
  type ParsedFlags,
  type ServeLimits,
  USAGE,
  cliMode,
  detachFlagProblem,
  extractSessionFlags,
  infoRequest,
  isPodDaemonLoad,
  parseArgs,
  parseServeLimits,
  resolveRunPrompt,
  resolveTls,
  resolveToken,
} from "./flags.ts";
import { readHiddenLine } from "./hidden-input.ts";
import { fileTrustStore, hooksTrustCommand, projectHooksWireProblem } from "./hooks-trust.ts";
import { type KeptDeps, psCommand, resolveKeptAttach, rmCommand } from "./kept-cmd.ts";
import {
  forgetKept,
  keptDir,
  keptFileName,
  keptSessionNotice,
  locationKey,
  readKept,
  recordKept,
  trackKeptSession,
} from "./kept-index.ts";
import {
  KEPT_SCHEMA_VERSION,
  type KeptEntry,
  ambiguousMessage,
  keptMetadata,
  placeText,
} from "./kept.ts";
import { startWorkerRuntime } from "./local-runtime.ts";
import { packagesCommand, spawnGit } from "./packages-cmd.ts";
import { POD_DAEMON_MODES, lockHolder, runResidentMode } from "./pod-resident.ts";
import { failedLine, notListedLine } from "./pod-stderr-log.ts";
import { launchRelay, relayMain, type spawnRelayProcess } from "./relay.ts";
import { AnswerSplit } from "./render.ts";
import { runModelPlan } from "./run-model.ts";
import {
  RELAY_SUBCOMMAND,
  RUN_STATE_VERSION,
  elsewhereMessage,
  laptopProc,
  readOwner,
  relayBlockingMessage,
  runDirFor,
  runStem,
} from "./run-state.ts";
import { localAutoAccept, styleInfo } from "./run-ui.ts";
import { startDaemon, startStdioDaemon } from "./serve.ts";
import { inProcessSessions } from "./session-jobs.ts";
import { NOT_A_TERMINAL, dimIf, termOf } from "./streams.ts";
import { startTerminal } from "./terminal.ts";
import {
  type TuiSessions,
  openTuiSessions,
  readSessionRecord,
  runSessionTui,
} from "./tui-sessions.ts";
import { untrustedText } from "./untrusted-text.ts";
import { runUpdate, spawnVersion } from "./update.ts";
import { APP_BUILD, APP_VERSION } from "./version.ts";
import { buildAgent, connectConfiguredMcp, inProcessAgents, loadUserAgentTypes } from "./wiring.ts";
import {
  type WorkspacePlan,
  apiKeyFileUnknown,
  hideList,
  isYes,
  mountGate,
  planWorkspace,
} from "./workspace-mount.ts";

const HELP = `tentacle — run an agent task

Usage:
  tentacle                 start the rich interactive TUI (when stdin is a TTY)
  tentacle -i              force the interactive TUI
  tentacle --plain         plain line-based REPL (for pipes / no TTY)
  tentacle --resume [uid]  resume a saved session of this folder (pick one if no uid)
  tentacle --continue      resume this folder's most recent session
  tentacle -i --in-process run the agent on the render thread (opt out of the worker)
  tentacle run --image <ref> [--engine kubernetes|docker|podman] [--rm[=true|false]] [--no-mount] [--confirm-mount] [-n|--namespace <ns>] [--bin-dir <dir>] [--resume [uid]|--continue] [--name <n>] [--auto-accept[=true|false]] ["<prompt>" | --prompt <text>]
                                run the agent inside a new Kubernetes pod or Docker/Podman
                                container (sandbox), local TUI (--name is its name; random
                                when omitted; "<prompt>" is sent at once as the first
                                message, raw text; not with --resume/--continue; --auto-accept starts the TUI with auto-accept on (Shift+Tab turns it off); sessions
                                persist on the laptop, so --resume works); kept on exit by
                                default (--rm removes it when the run ends)
  tentacle run -d|--detach ("<prompt>" | --prompt <text|->) [--auto-accept[=true|false]] --image <ref> [...] [--name <n>]
                                the same with no TUI (--prompt - reads the prompt from stdin,
                                only here): a background laptop process runs the
                                turn, serves the model and saves it, then leaves once the
                                session is idle. A tool that needs permission waits for
                                you unless --auto-accept (pod tool asks only, allow once,
                                logged; on for the terminals that attach, Shift+Tab in
                                any of them flips it for all on the session).
                                kill <pid> stops it; attach <name> takes it over, mid-turn.
                                --rm removes the workload when the run goes idle
                                or is stopped (a failed or interrupted run keeps it). On
                                macOS it stays awake during a turn (detach.keepAwake)
  tentacle attach <name> [--engine kubernetes|docker|podman] [-n|--namespace <ns>] [-c|--container <c>] [--bin-dir <dir>] [--resume [uid]|--continue]
                                attach the TUI to an EXISTING pod or container (tentacle is
                                injected if it is not there yet); --container is the
                                pod's container to exec into (default: its only one);
                                it is NOT deleted on exit — closing the TUI
                                detaches, it stays up. A kept one (see ps) needs
                                no --engine: its engine and location are looked up.
                                On a detached run it opens the run's session (from a
                                terminal, in the folder it ran in); more terminals
                                join it. /quit closes the session for every terminal
                                on it (y/N when others are attached), a running turn
                                stops; on a run made with --rm it removes the workload if
                                no other session is in use. Ctrl+C idle leaves alone
  tentacle ps [--engine <e>] [-q] [-v]
                                list the pods/containers run kept, checked against
                                their engine, with a detached run's state (-q names
                                only, -v details: pid, session, log)
  tentacle rm [--engine <e>] [-f] <name>
                                remove a kept pod/container (only one tentacle kept;
                                a running one asks y/N, -f skips the question). A
                                detached run is stopped first
  tentacle <prompt...>     run a single task and exit
  tentacle -- <prompt...>  the same, for a prompt that starts with '-' or
                           with a subcommand word (tentacle -- explain how
                           config works: the first bare word IS the subcommand)
  tentacle serve [opts]    host the remote-control daemon
  tentacle connect <url> [--resume [id]|--continue]
                           drive a remote daemon with the TUI; quitting
                           detaches (the session keeps running there)
  tentacle hooks trust --list | --revoke <folder>
                           list / revoke stored project-hooks trust decisions
  tentacle explain [key] [--all] [--json]
                           what a config.jsonc key means: no argument lists the
                           top-level keys, a section its sub-keys, a leaf the full
                           card (type, default, env, flag, carried, scope,
                           example); --all is every leaf; --json for scripts.
                           Reads no config file, so it works with a broken one
  tentacle config set <key> <value> | <key>=<value>
  tentacle config unset <key> [--yes] | get <key> [--json]
  tentacle config list [--json] | path
                           edit YOUR config.jsonc, keeping its comments, layout
                           and key order: the value is typed by the key (true/false,
                           a number, a listed value, JSON for an array or an
                           object); nothing is written unless the whole file still
                           validates. --profile <name> targets profiles.<name>.
                           A secret (model.apiKey, an MCP env/header) is refused
                           on the command line: use "-" for stdin or no value for
                           a hidden prompt. "path" prints the file's location
  tentacle package install <path|git-url>[#ref] | list | remove <name> | update [<name>]
                           manage packages (skills, agent types, MCP servers,
                           hooks) in <configDir>/packages; installing trusts
                           a package's hooks like your own
  tentacle install <path|git-url>[#ref]
                           alias of \`tentacle package install\`
  tentacle update [--check] [--version vX.Y.Z]
                           update tentacle and its Linux pod binaries (in
                           <configDir>/bin) from the GitHub release; --check
                           only reports (exit 10: an update is available)
  tentacle --help          show this help
  tentacle --version       print the version and exit
  --model <id> | --profile <name>
                           flags of the commands that start a session, written
                           AFTER the command: run, attach, serve, and the bare
                           session (tentacle --model X, -i --profile Y, --resume
                           --model X, --plain, tentacle --model X <prompt>).
                           --profile applies a profile from config.jsonc
                           ("profiles"); --model uses that model id on the
                           active profile's endpoint (beats TENTACLE_MODEL; the
                           context window stays the profile's). attach uses the
                           run's own model unless one is given. serve: the model
                           its connect clients use. Not before a command
                           (tentacle --model X run is an error), and not on
                           connect, ps, rm, update, hooks, package

Remote control:
  tentacle serve [--host 127.0.0.1] [--port 4000] [--token T|--token-command CMD]
                      [--tls-cert FILE --tls-key FILE]
                      [--session-ttl 24h|never] [--session-admin-cap DUR] [--max-sessions 64]
                      [--max-detached-sessions 16] [--ws-idle-timeout 60s]
  tentacle connect ws(s)://host:port [--token T|--token-command CMD]
                      [--ca-cert FILE | --insecure-skip-tls-verify]
                      [--resume [id] | --continue]
  connect: quitting detaches — the session (and a running turn) stays on the
  daemon; --resume picks one of its sessions (or names one), --continue takes
  the newest; in the TUI /sessions switches, /close ends one, /clear = close + new.
  A non-loopback --host requires a token (remote code execution risk).
  Token env fallback: TENTACLE_REMOTE_TOKEN.
  TLS trust: --ca-cert is the CA (or the self-signed cert) that signed the
  daemon's cert — the trust anchor, not the daemon's own --tls-cert.
  --insecure-skip-tls-verify skips verification (dev-only).

Options are checked: an unknown flag, a missing value or a stray argument is
an error. Flags may come before or after a command's arguments
(tentacle attach mypod -n dev = tentacle attach -n dev mypod).

Configuration (precedence: env > profile > config file > defaults):
  ~/.config/tentacle/config.jsonc   settings (scaffolded on first run)
  ~/.config/tentacle/PROMPT.md       default system prompt

Environment:
  TENTACLE_CONFIG_DIR       override the config directory
  TENTACLE_PROFILE          profile to apply (overridden by --profile)
  TENTACLE_PROVIDER         provider kind: openai (default) | anthropic
  TENTACLE_MODEL_BASE_URL   base URL incl. version (default: localhost:8080/v1,
                            or https://api.anthropic.com/v1 for anthropic)
  TENTACLE_MODEL            model id (overridden by --model)
  TENTACLE_MODEL_API_KEY    bearer token / Anthropic x-api-key (overrides
                            config apiKey/apiKeyCommand)
  TENTACLE_SYSTEM_PROMPT    inline system prompt (overrides PROMPT.md)
  TENTACLE_NO_AGENTS_MD     do not auto-load the repo's AGENTS.md into the prompt
  TENTACLE_MAX_ITERATIONS   max model/tool iterations per turn
  TENTACLE_MAX_TOKENS       max output tokens per model response
  TENTACLE_SUBAGENTS        enable/disable sub-agents (on/off, default on)

Engines (tentacle run / attach --engine kubernetes|docker|podman):
  The default engine is "kubernetes"; set another with "engine" in config.jsonc
  (or a profile) or TENTACLE_ENGINE. Precedence: --engine > TENTACLE_ENGINE >
  profile > config file > kubernetes. An unknown value is an error.
  docker   the engine the docker CLI would use: --context <ctx> > DOCKER_HOST >
           DOCKER_CONTEXT > the current context > /var/run/docker.sock (unix,
           tcp:// with TLS, ssh://). No docker CLI needed.
  podman   the local Podman socket, found automatically (podman machine on
           macOS, rootless/rootful on Linux) — no DOCKER_HOST needed; CONTAINER_HOST
           overrides it; DOCKER_HOST is ignored. --context <ctx> uses a docker context.
  --insecure-docker-tcp   allow a plaintext tcp:// engine (unauthenticated root on
                          that host; refused by default — use TLS or ssh://)
  --rm[=true|false] (run only)
                          DEFAULT false: the pod/container is NOT deleted on exit or
                          Ctrl+C; tentacle prints the "tentacle attach --engine …" to
                          resume. --rm (or --rm=true) deletes it when the run ends;
                          --rm=false overrides a configured "rm": true. Config: "rm:" (user
                          config or profile); flag > profile > user config > false
  -d, --detach (run only) run with no TUI (see "tentacle run -d|--detach" above)
  Workspace (docker/podman run): a local engine bind-mounts the cwd read-write
  at the same path (the agent works in it); secrets inside it are hidden
  (config "mount.hide"/"mount.hideExtra"; tentacle's config dir and the
  apiKeyCommand key file always). /, /usr, /usr/local[/bin], ~/.ssh and the
  config dir are never mounted. A remote engine mounts nothing (a warning says so).
  --no-mount              do not mount the cwd (the workspace is the image's)
  --confirm-mount         mount a dangerous folder (your home, a system dir, a
                          hidden one) without the y/N question (required with
                          no terminal)
  -n/--namespace and -c/--container are kubernetes-only; --context,
  --insecure-docker-tcp, --no-mount and --confirm-mount are docker/podman-only
  (anything else is an error).

Pod execution (tentacle run --image <ref> [-n|--namespace <ns>] [--name <n>] ["<prompt>"]):
  the image must be a Linux glibc image with sh+head (tentacle is injected
  into the pod; musl images cannot run it). --namespace defaults to the
  kubeconfig context's namespace; a MISSING namespace fails with a clear error
  (it is not created). Cluster auth resolves from ~/.kube/config (or $KUBECONFIG)
  by default — current context, with CA trust + bearer/client-cert/exec-plugin.
  TENTACLE_K8S_SERVER       API server URL override (e.g. behind a proxy); skips kubeconfig
  TENTACLE_K8S_TOKEN        bearer token, used with TENTACLE_K8S_SERVER
  TENTACLE_POD_NAMESPACE    namespace (overridden by --namespace; else the context's)
  TENTACLE_POD_IMAGE        default pod image (overridden by --image)
  TENTACLE_POD_BIN          use this prebuilt tentacle binary for the pod instead of
                           the cached/built one (path to a bun-linux-x64/arm64 binary)
  TENTACLE_POD_BIN_DIR      install dir inside the pod (overridden by --bin-dir; default
                           /usr/local/bin). Use a writable+exec dir (e.g. /tmp) for a
                           pod with a read-only root filesystem.

Pod attach (tentacle attach <pod> [-n|--namespace <ns>] [-c|--container <c>]):
  <pod> must already exist (kubectl get pods -n <ns>); --namespace defaults like
  run (context's namespace — pass it if the pod lives elsewhere). Multi-container
  pods need the target container: --container <c> (alias -c) — without it the
  pod's only container is used. The agent binary is injected only when the pod
  does not already have a working one (re-attaching to a used pod skips the
  transfer). The pod is left RUNNING on exit — delete it yourself when done.
  Read-only rootfs (a hardened pod)? --bin-dir <dir> installs to a writable+exec
  dir instead of /usr/local/bin (e.g. --bin-dir /tmp).
`;

/**
 * The CLI's output (docs/fix/cli-output-streams.md): `out` is STDOUT and carries
 * ONLY the data a command produces (tables, `-q` names, `--help`, `--version`, a
 * one-shot's answer, result lines); `err` is STDERR and carries everything else
 * outside Ink (progress, notes, warnings, errors, `usage:` after an error,
 * hints, the y/N prompt, logs). Each line picks one; there is no default sink.
 */
export interface CliIO {
  /** Test seam: STDOUT (data only). An injected sink is never a terminal. */
  out?: (text: string) => void;
  /** Test seam: STDERR (everything else). An injected sink is never a terminal. */
  err?: (text: string) => void;
  /** Test seam: the width `explain` fits its output to (default: stdout's). */
  columns?: number;
  /** Test seam: stdout is a terminal (`run --detach` prints its name only when not). Default: a real TTY stdout, `false` with an injected `out`. */
  outTty?: boolean;
  /** Test seam: replaces the `run` engine runtime (pins the flag/config → `resumeHint` wiring). */
  startEngineRuntime?: typeof startEngineRuntime;
  /** Test seam: `attach <name>` of a detached run's engine runtime (docs/feat/detached-handover.md). */
  attachEngineRuntime?: typeof attachEngineRuntime;
  /** Test seam: the plain (no run) `attach` of a workload — pins the config it gets. */
  attachPlainRuntime?: typeof attachEngineRuntime;
  /** Test seam: the TUI of an `attach` to a detached run (pins the single broker). */
  startTui?: typeof startTui;
  /**
   * Test seam: which of stdin / stdout are a terminal. Default: the process's own
   * `isTTY` (resolved once, at the top of `main`). A test that omits this seam DOES
   * read the runner's terminal: pass it (`{ stdin: false, stdout: false }`) to be hermetic.
   */
  terminal?: { stdin: boolean; stdout: boolean };
  /** Test seam: the stream the pre-Ink y/N question reads. Default: `process.stdin`. */
  stdin?: NodeJS.ReadableStream;
  /**
   * Test seam: the pre-mount `--resume` picker. Default: the real one, on a
   * terminal (stdin AND stdout); `null` = none (the newest session resumes).
   */
  pickSession?: typeof pickSession | null;
  /**
   * Test seam: grey/dim on the lines `err` writes (they are the only styled
   * ones). Default: stderr's own decision (`termOf`: a TTY and no `NO_COLOR`).
   */
  colour?: boolean;
  /** Test seam: `serve`'s WebSocket daemon (a misplaced flag must never start a real one). */
  startDaemon?: typeof startDaemon;
  /** Test seam: `run --detach`'s workload creation (pins that no daemon starts in the foreground). */
  provisionWorkload?: typeof provisionWorkload;
  /** Test seam: `run --detach`'s relay process. */
  spawnRelay?: typeof spawnRelayProcess;
  /** Test seam: `--prompt -`'s stdin. Default: all of it. */
  readStdin?: () => Promise<string>;
  /**
   * Test seam: `config <key>`'s hidden prompt, when stdin is a terminal and no
   * value is given (docs/feat/config-set.md, eval A4). Default:
   * {@link readHiddenLine} — the prompt on stderr, no echo.
   */
  readSecret?: (prompt: string) => Promise<string>;
  /**
   * Test seam: the pre-Ink y/N question (a dangerous mount source); present =
   * interactive. Default: a readline prompt, when stdin and STDERR (where it is
   * asked) are terminals.
   */
  ask?: (prompt: string) => Promise<string>;
}

/**
 * One line from the terminal, BEFORE Ink mounts (the mount confirmation), asked
 * on STDERR (D4): `run … >out` still asks. Ctrl+C or EOF answers "" — the default No.
 */
function askLine(prompt: string, input: NodeJS.ReadableStream = process.stdin): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input, output: process.stderr });
    let done = false;
    const finish = (answer: string): void => {
      if (!done) {
        done = true;
        rl.close();
        resolve(answer);
      }
    };
    rl.on("SIGINT", () => {
      process.stderr.write("\n");
      finish("");
    });
    rl.on("close", () => finish(""));
    rl.question(prompt, finish);
  });
}

/**
 * The words `tentacle -- …` would send for this argv: everything after
 * `tentacle` as typed, minus the flags (a flag was asked for, not said).
 */
function promptWords(args: readonly string[]): readonly string[] {
  return args.filter((word) => !word.startsWith("-"));
}

/**
 * The way back to a prompt for a word `config` swallowed (owner Q-A, the same
 * trade-off `explain` settled): only when the first word after `config` could
 * not be a key — no `.` and no `=` in it, and not a top-level key — because then
 * it is a sentence, not a typo'd path (`model.foo=x` gets suggestions instead).
 */
function configPromptHint(positional: readonly string[], args: readonly string[]): string {
  const first = positional[0];
  if (first === undefined || first === "set" || first === "get" || first === "unset") {
    return "";
  }
  if (first.includes(".") || first.includes("=")) {
    return "";
  }
  if (topLevelKeys().includes(first)) {
    return "";
  }
  return `\n${promptHint(promptWords(args))}\n`;
}

export async function main(argv: readonly string[], io: CliIO = {}): Promise<number> {
  // Two sinks (docs/fix/cli-output-streams.md): `out` = data only (stdout),
  // `err` = everything else (stderr). Every styled line is an `err` line, so
  // colour, the y/N gate and the startup spinner follow STDERR's terminal.
  const out = io.out ?? ((text: string) => void process.stdout.write(text));
  const err = io.err ?? ((text: string) => void process.stderr.write(text));
  const errTerm = io.err ? NOT_A_TERMINAL : termOf(process.stderr);
  const outTty = io.outTty ?? (!io.out && process.stdout.isTTY === true);
  // Informational `[pod]`/`[container]` lines go through `info`: grey on a
  // stderr that takes colour. Grey is by explicit marking — a plain `err`
  // (errors, refusals, warnings) is never styled; `out` (data) never is.
  const colour = io.colour ?? errTerm.colour;
  const info = (text: string): void => err(styleInfo(text, colour));
  // The y/N question (D4): stdin answers it, stderr shows it.
  const terminal = io.terminal ?? {
    stdin: process.stdin.isTTY === true,
    stdout: process.stdout.isTTY === true,
  };
  const canAsk = terminal.stdin && errTerm.tty;
  const pick: typeof pickSession | undefined =
    io.pickSession !== undefined
      ? (io.pickSession ?? undefined)
      : terminal.stdin && terminal.stdout
        ? pickSession
        : undefined;
  const askStdin = (prompt: string) => askLine(prompt, io.stdin);

  // `--model` / `--profile` are flags of the session commands (parsed below with
  // the rest of each command's flags). Here only what a spec cannot hold: a
  // one-shot prompt's options, the misplaced ones, `connect`'s refusal
  // (docs/fix/detach-live-followups.md F5).
  const session = extractSessionFlags(argv.slice(2));
  if (!session.ok) {
    err(`[error] ${session.error}\n`);
    return 1;
  }
  const args = session.rest;

  // Hidden subcommand: the detached pod-delete child when THIS process is a
  // compiled binary (so the delete-on-exit safety net needs no external `bun`).
  // It reads TENTACLE_POD_DELETE_* / TENTACLE_POD_TLS_* from the env and issues a
  // single best-effort DELETE, then exits — no config, no TTY, no model setup.
  // The name is ONE constant shared with the command builder (`podDeleteCommand`).
  if (args[0] === DELETE_POD_SUBCOMMAND) {
    await deletePodFromEnv();
    return 0;
  }
  // Its Docker/Podman twin: TENTACLE_CONTAINER_DELETE_ID + TENTACLE_DOCKER_ENDPOINT
  // (env only) → one bounded, owner-label-guarded remove, then exit.
  if (args[0] === DELETE_CONTAINER_SUBCOMMAND) {
    await deleteContainerFromEnv();
    return 0;
  }
  // The relay of a detached run (`relay.ts`): its spec comes through the env.
  if (args[0] === RELAY_SUBCOMMAND) {
    return relayMain(process.env, err);
  }

  // An explicit `--help` is the command's data (stdout); the help after an
  // error (an empty prompt, below) is stderr's.
  if (args[0] === "--help" || args[0] === "-h") {
    out(HELP);
    return 0;
  }

  // `--version` exits before config loading, model setup, or TTY handling —
  // it doubles as the post-injection health probe in a pod.
  // `--version --build-id` (docs/fix/stale-pod-binary.md) adds the compiled-in
  // build id on a second line (`dev` from source): what `attach` asks a
  // container's tentacle in the SAME exec. An older binary ignores the extra
  // argument and prints one line, which reads as "no build id".
  if (args[0] === "--version") {
    out(`tentacle ${APP_VERSION}\n${args[1] === "--build-id" ? `${APP_BUILD ?? "dev"}\n` : ""}`);
    return 0;
  }

  // Every command's arguments are validated HERE, before config, cluster or
  // model: an unknown flag, a missing value or a stray word is an error, never
  // ignored or sent as a prompt (docs/fix/cli-strict-args.md).
  const mode = cliMode(args);
  let parsed: ParsedFlags = { positional: [], flags: new Map(), bools: new Set() };
  if (mode !== "prompt" && mode !== "empty") {
    const own = mode === "tui" || mode === "plain" ? args : args.slice(1);
    const result = parseArgs(own, ARGS[mode]);
    if (!result.ok) {
      // `--help` / `--version` after other options (`--model X --version`).
      const info = infoRequest(result.error);
      if (info !== undefined) {
        out(info === "help" ? HELP : `tentacle ${APP_VERSION}\n`);
        return 0;
      }
      // `tentacle explain how config works`: `explain` is now a subcommand, so
      // the words are not sent as a prompt — say exactly how to send them
      // (docs/feat/config-explain.md, review O1). The words are the WHOLE argv
      // after `tentacle` as typed, flags aside (a flag was asked for, not said).
      // `config` joins it for the same reason: `tentacle config how do I …` now
      // means the command, and the way back is one line, not a guess.
      const promptLine =
        (mode === "explain" || mode === "config") && result.error.startsWith("unexpected argument")
          ? `\n${promptHint(promptWords(args))}`
          : "";
      err(`[error] ${result.error}${promptLine}\nusage: ${USAGE[mode]}\n`);
      return 1;
    }
    parsed = result;
  }
  // The model and profile this command names (a prompt's came off argv above).
  const profileFlag = session.profile ?? parsed.flags.get("profile");
  const modelFlag = session.model ?? parsed.flags.get("model");

  // `connect` drives a remote daemon; it needs no local model configuration.
  if (mode === "connect") {
    const { positional, flags, bools } = parsed;
    const url = positional[0] ?? "";
    try {
      const token = await resolveToken(flags);
      const tls = await resolveTls(url, flags, bools);
      const id = flags.get("resume");
      const resume =
        id !== undefined || bools.has("resume") || bools.has("continue")
          ? {
              ...(id !== undefined ? { id } : {}),
              resume: bools.has("resume"),
              latest: bools.has("continue"),
            }
          : undefined;
      await connectTui(
        {
          url,
          configDir: configDirFromEnv(),
          ...(token ? { token } : {}),
          ...(tls ? { tls } : {}),
          ...(resume ? { resume } : {}),
        },
        err,
        {
          dial: webSocketChannelFactory,
          startTui,
          // The pre-mount picker, on a terminal only (as the local `--resume`).
          // The PALETTE is not passed here: `connect` loads no config, so
          // `connectTui` hands its `connectTheme` result to this picker (HIGH 2
          // — reading `config` here was a use before its `let`, a ReferenceError
          // at the first multi-session `--resume`).
          ...(pick ? { pick } : {}),
        },
      );
      return 0;
    } catch (error) {
      err(
        `\n[connect error] ${untrustedText(error instanceof Error ? error.message : String(error))}\n`,
      );
      return 1;
    }
  }

  // `tentacle update` needs only the config DIR (for <configDir>/bin), never
  // the model config: it must work even when config.jsonc is broken.
  if (mode === "update") {
    const version = parsed.flags.get("version");
    return runUpdate(
      { check: parsed.bools.has("check"), ...(version !== undefined ? { version } : {}) },
      {
        appVersion: APP_VERSION,
        execPath: process.execPath,
        configDir: configDirFromEnv(),
        platform: process.platform,
        arch: process.arch,
        fetch,
        runVersion: spawnVersion,
        out,
        err,
      },
    );
  }

  // `tentacle explain [key] [--all] [--json]` (docs/feat/config-explain.md): the
  // key registry and nothing else, so — like `update` — it runs BEFORE
  // `loadConfig`: it must work with a broken or missing config.jsonc, offline
  // and in CI (eval Q8 = (a): the effective value is `config show`'s job).
  if (mode === "explain") {
    const result = explain(parsed.positional[0], { all: parsed.bools.has("all") });
    if (!result.ok) {
      // A quoted sentence (`tentacle explain "how does X work"`) reaches here as
      // one argument, so `parseArgs` saw nothing wrong; the way back is the
      // same line, built from the argv the old build would have sent.
      err(
        explainErrorText(result, {
          hint: result.prompt === true ? promptHint(promptWords(args)) : undefined,
        }),
      );
      return 1;
    }
    out(
      parsed.bools.has("json")
        ? renderExplainJson(result)
        : renderExplainText(result, { width: io.columns ?? process.stdout.columns }),
    );
    return 0;
  }

  // `tentacle config set/unset/get/list/path` (docs/feat/config-set.md): like
  // `explain`, BEFORE `loadConfig` — it must work on a BROKEN file (that is one
  // of the things it helps fix), it never rescaffolds, and it edits the laptop's
  // user file only. All the deciding is in `config-args.ts` / `config-run.ts`.
  if (mode === "config") {
    const parsedConfig = parseConfigArgs(parsed.positional, parsed.flags, parsed.bools);
    if (!parsedConfig.ok) {
      // Q-A: `tentacle config my nginx` is a SENTENCE the old build sent as a
      // prompt, now read as a command. A first word with no `.`/`=` cannot be a
      // key path, so say the way back (the same line `explain` prints).
      err(
        `[error] ${parsedConfig.error}${configPromptHint(parsed.positional, args)}\nusage: ${USAGE.config}\n`,
      );
      return 1;
    }
    const result = await runConfig({
      op: parsedConfig.op,
      configPath: join(configDirFromEnv(), CONFIG_FILENAME),
      json: parsedConfig.json,
      yes: parsedConfig.yes,
      ...(parsedConfig.profile !== undefined ? { profile: parsedConfig.profile } : {}),
      isStdinTerminal: terminal.stdin,
      ...(io.readStdin !== undefined
        ? { readStdin: io.readStdin }
        : { readStdin: () => Bun.stdin.text() }),
      ...(io.ask !== undefined ? { ask: io.ask } : canAsk ? { ask: askStdin } : {}),
      // A hidden prompt only on a terminal: a pipe is a VALUE (a non-terminal
      // stdin already sends the value down that road), and the prompt must never
      // echo — it may be a key.
      ...(io.readSecret !== undefined
        ? { readSecret: io.readSecret }
        : terminal.stdin
          ? {
              readSecret: (prompt: string) =>
                readHiddenLine(prompt, {
                  input: io.stdin ?? process.stdin,
                  output: process.stderr,
                }),
            }
          : {}),
    });
    // Q-A: an unknown key whose first word could not be a key path is a SENTENCE
    // (the old build sent it to the model) — say the way back.
    const unknownHint = result.err.includes('unknown config key "')
      ? configPromptHint(parsed.positional, args)
      : "";
    if (result.out !== "") out(result.out);
    if (result.err !== "") err(`${result.err}${unknownHint}`);
    return result.code;
  }

  // Everything below needs configuration; load it once (scaffolds on first run).
  // EXCEPT the pod daemon (`serve --stdio`, and the resident modes
  // `--bridge`/`--resident`/`--resident-status`/`--resident-stop`): it runs in a possibly read-only
  // container with no writable HOME and needs NOTHING from the config dir (the
  // model is proxied over the wire, persistence is on the laptop). Scaffolding
  // there does `mkdir ~/.config` → EROFS → the daemon dies and the client sees
  // "connection closed". So the stdio daemon never scaffolds; missing config
  // files fall back to defaults.
  const isStdioDaemon = mode === "serve" && POD_DAEMON_MODES.some((flag) => parsed.bools.has(flag));
  let config: TentacleConfig;
  try {
    config = await loadConfig({
      cwd: process.cwd(),
      scaffold: !isStdioDaemon,
      ...(mode === "serve" && isPodDaemonLoad(parsed.bools) ? { podDaemon: true } : {}),
      ...(profileFlag !== undefined ? { profile: profileFlag } : {}),
      ...(modelFlag !== undefined ? { model: modelFlag } : {}),
    });
  } catch (error) {
    err(`\n[config error] ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  // `tentacle package …` (docs/feat/packages.md): no TUI, plain output.
  if (mode === "package") {
    return packagesCommand(parsed.positional, {
      configDir: config.configDir,
      enabled: config.packagesEnabled,
      git: spawnGit,
      out,
      err,
    });
  }

  // `tentacle hooks trust --list | --revoke <folder>` (P3): no TUI, plain output.
  if (mode === "hooks") {
    const revoke = parsed.flags.get("revoke");
    return hooksTrustCommand(
      fileTrustStore(config.configDir),
      {
        positional: parsed.positional,
        list: parsed.bools.has("list"),
        ...(revoke !== undefined ? { revoke } : {}),
      },
      { out, err },
    );
  }

  // `tentacle ps` / `rm <name>` (docs/feat/engine-ps-rm.md): the laptop's kept
  // index, verified against each engine. No TUI, plain output, no model.
  if (mode === "ps" || mode === "rm") {
    const engineFlag = parsed.flags.get("engine");
    let engine: EngineKind | undefined;
    if (engineFlag !== undefined) {
      const choice = chooseEngine({ flag: engineFlag });
      if (!choice.ok) {
        err(`[error] ${choice.error}\nusage: ${USAGE[mode]}\n`);
        return 1;
      }
      engine = choice.kind;
    }
    const ask = io.ask ?? (canAsk ? askStdin : undefined);
    const deps: KeptDeps = {
      dir: keptDir(config.configDir),
      hostFor: (entry) => buildEngineHost(entry.engine, hostOptionsFor(entry)).host,
      out,
      err,
      now: Date.now,
      home: homedir(),
      // The dim lines are `err`'s: stderr's colour decision (the same as `info`).
      dim: (text) => dimIf(text, colour),
      ...(ask ? { ask } : {}),
    };
    return mode === "ps"
      ? psCommand(
          {
            engine,
            quiet: parsed.bools.has("quiet"),
            verbose: parsed.bools.has("verbose"),
            all: parsed.bools.has("all"),
          },
          deps,
        )
      : rmCommand(parsed.positional, { engine, force: parsed.bools.has("force") }, deps);
  }

  // Skill discovery problems, once, before any Ink mount (AGENTS §7: no raw
  // write while Ink owns the terminal). Only where THIS config builds the
  // agent: `run`/`attach` sessions use the pod's own skills, discovered (and
  // reported) by the pod daemon.
  if (mode !== "run" && mode !== "attach") {
    for (const line of config.skillDiagnostics) {
      err(`[skills] ${line}\n`);
    }
    for (const line of config.projectHooksDiagnostics) {
      err(`[hooks] ${line}\n`);
    }
    const wireProblem = config.projectHooks && projectHooksWireProblem(config.projectHooks);
    if (wireProblem) {
      err(`[hooks] ${wireProblem}\n`);
    }
    const agentTypes = loadUserAgentTypes(config.configDir, config.packageAgentDirs);
    for (const line of config.packageDiagnostics) {
      err(`[packages] ${line}\n`);
    }
    for (const line of agentTypes.diagnostics) {
      err(`[agents] ${line}\n`);
    }
  } else if (config.packages.length > 0) {
    // D11: laptop packages are not shipped to the pod in v1.
    err(
      `[packages] ${config.packages.length} installed package(s) are not loaded in a pod session (the pod uses its own config)\n`,
    );
  }

  // Host the remote-control daemon and run until interrupted.
  if (mode === "serve") {
    const { flags, bools } = parsed;
    // `--stdio`: run the daemon over stdin/stdout instead of a WebSocket (used
    // inside a pod, driven over the k8s exec channel — F4). stdout IS the RPC
    // channel here, so every log line must go to stderr.
    if (POD_DAEMON_MODES.some((flag) => flag !== "stdio" && bools.has(flag))) {
      return runResidentMode(config, parsed);
    }
    if (bools.has("stdio")) {
      try {
        await startStdioDaemon(config, (line) => process.stderr.write(`[daemon] ${line}\n`), {
          modelProxy: bools.has("model-proxy"),
        });
        return 0;
      } catch (error) {
        process.stderr.write(
          `[daemon] stdio error: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        return 1;
      }
    }
    let token: string | undefined;
    let limits: ServeLimits;
    try {
      limits = parseServeLimits({ flags, bools });
      token = await resolveToken(flags);
    } catch (error) {
      err(`\n[serve error] ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    const host = flags.get("host") ?? process.env.TENTACLE_REMOTE_HOST ?? "127.0.0.1";
    const port = Number(flags.get("port") ?? process.env.TENTACLE_REMOTE_PORT ?? "4000");
    const certPath = flags.get("tls-cert");
    const keyPath = flags.get("tls-key");
    const tls =
      certPath && keyPath
        ? { cert: await Bun.file(certPath).text(), key: await Bun.file(keyPath).text() }
        : undefined;
    try {
      const server = await (io.startDaemon ?? startDaemon)(config, {
        ...limits,
        host,
        port,
        ...(token ? { token } : {}),
        ...(tls ? { tls } : {}),
        onAudit: (line) => err(`[daemon] ${line}\n`),
        onError: (error) => err(`[daemon] error: ${error.message}\n`),
        onNotice: (line) => err(`[daemon] ${line}\n`),
      });
      err(`daemon listening on ${server.url}\n`);
      // `serve`'s own config decides its titles; no Ink here, so its log line.
      const titleNotice = titleConfigNotice(config);
      if (titleNotice) {
        err(`[daemon] ${titleNotice}\n`);
      }
      // First Ctrl+C: stop, let the session writes land, release the store
      // lock. A second one exits at once (a hung disk must not trap the user).
      await new Promise<void>((resolve) => {
        let interrupted = false;
        process.on("SIGINT", () => {
          if (interrupted) {
            process.exit(130);
          }
          interrupted = true;
          void server.stop().then(resolve, resolve);
        });
      });
      return 0;
    } catch (error) {
      err(`\n[serve error] ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  // `run` / `attach` shared setup: the engine (docs/feat/docker-engine-cli.md:
  // `--engine` > TENTACLE_ENGINE > profile > config `engine:` > kubernetes) and
  // its host — kubernetes: cluster auth (kubeconfig current context, or
  // TENTACLE_K8S_SERVER/_TOKEN override); docker: the docker CLI's endpoint
  // precedence; podman: socket discovery — and session resume. Sessions persist
  // as JSON under <configDir>/sessions; the workload is stateless, so resuming
  // seeds its daemon with the saved session (uid + history), same as the TUI.
  // A wrong engine value or an engine-specific flag on the wrong engine is a
  // usage error, before sessions or any engine is touched.
  const selectEngine = (
    m: "run" | "attach",
    flags: Map<string, string>,
    bools: Set<string>,
  ): EngineKind | null => {
    const choice = chooseEngine({
      flag: flags.get("engine"),
      env: process.env.TENTACLE_ENGINE,
      configured: config.engine,
    });
    const problem = choice.ok
      ? engineFlagProblem(choice.kind, {
          namespace: flags.has("namespace"),
          container: flags.has("container"),
          context: flags.has("context"),
          insecureTcp: bools.has("insecure-docker-tcp"),
          noMount: bools.has("no-mount"),
          confirmMount: bools.has("confirm-mount"),
        })
      : choice.error;
    if (!choice.ok || problem) {
      err(`[error] ${problem}\nusage: ${USAGE[m]}\n`);
      return null;
    }
    return choice.kind;
  };
  const engineHost = (kind: EngineKind, flags: Map<string, string>, bools: Set<string>) => {
    const context = flags.get("context");
    try {
      return buildEngineHost(kind, {
        ...(kind === "kubernetes"
          ? { namespace: flags.get("namespace") ?? process.env.TENTACLE_POD_NAMESPACE }
          : {}),
        ...(context !== undefined ? { context } : {}),
        allowInsecureTcp: bools.has("insecure-docker-tcp"),
      });
    } catch (error) {
      err(setupFailureLine(kind, error));
      return null;
    }
  };
  // Sessions persist as `<uid>.jsonl` logs under <configDir>/sessions/<projectKey(cwd)>/ (store
  // + saver + notice hub, `--resume`/`--continue` resolved pre-mount, only among
  // THIS folder's sessions). `{ exit }` = don't start (reason written). The
  // picker (docs/feat/resume-picker.md) runs only on a terminal, before any
  // runtime or pod starts, so the chosen session seeds it like `--resume <uid>`.
  const openSessions = (flags: Map<string, string>, bools: Set<string>) =>
    openTuiSessions(
      {
        root: join(config.configDir, "sessions"),
        cwd: config.cwd,
        keepSuperseded: config.sessions?.keepSuperseded === true,
      },
      {
        wanted: bools.has("resume") || flags.has("resume") || bools.has("continue"),
        uid: flags.get("resume"),
        latest: bools.has("continue"),
      },
      err,
      pick ? (choices) => pick(choices, { theme: config.tui?.theme ?? "auto" }) : undefined,
      // This laptop's config decides titles in every TUI runtime (worker, pod
      // `run`/`attach`): a `titleModel` that does nothing is said once, in the TUI.
      [titleConfigNotice(config)].filter((text): text is string => text !== null),
    );
  // `run` and `attach` both end in the same local TUI over the pod runtime. The
  // `permissions` broker MUST be the SAME instance handed to the runtime AND the
  // TUI: the pod daemon streams its `permission_request` to the runtime's
  // `RemoteClient` (which prompts through that broker and answers with
  // `session/resolve_permission`), while the TUI's prompt installs its
  // interactive requester on the broker it is given. Two brokers would silently
  // decouple the two — a second broker's default `allowAll` approves everything
  // and the TUI prompt is never reached. Built with `holdUntilSet`, so a request
  // that arrives before the TUI mounts waits for its prompt instead.
  // `run`: a detached run's TUI (`attach-run.ts`): its `finish` is the quit
  // instead of `dispose`, told whether Ink ran (a TUI that never mounted quit
  // nothing); its `runQuit` and `createSession` go to the TUI.
  const runEngineTui = async (
    runtime: Awaited<ReturnType<typeof startEngineRuntime>>,
    permissions: PermissionBroker,
    sessions: TuiSessions,
    run?: Pick<Joined, "finish" | "runQuit" | "createSession" | "autoAccept" | "wakePending">,
    // `run "<prompt>"`: the TUI sends it once, as its first message, raw text.
    initialPrompt?: string,
    // `run --auto-accept`: the TUI's auto-accept state, started ON.
    localAutoAcceptFeed?: AutoAcceptFeed,
  ): Promise<number> => {
    let inkRan = false;
    const finish = run?.finish;
    // What the open reported, once: told with `autoWake` on or off (buffered until
    // Ink mounts; the count only, never pod text).
    const unflushed = runtime.unflushedExits();
    const awayNotice = unflushedExitsNotice(unflushed);
    if (awayNotice !== null) {
      sessions.notices.notify(awayNotice);
    }
    await runSessionTui(sessions, {
      start: async (sessionOptions) => {
        try {
          // Setup all succeeded: NOW say `still running · tentacle attach …` (on the
          // main screen, under the alt-screen; it survives a signal exit).
          runtime.announce?.();
          await (io.startTui ?? startTui)(null, {
            model: config.model,
            // The palette (`tui.theme`): a LAPTOP-ONLY display setting.
            theme: config.tui?.theme ?? "auto",
            cwd: config.cwd,
            contextWindow: config.contextWindow,
            // The status bar's badge: from this laptop's engine host, never the pod.
            ...(runtime.target ? { target: runtime.target } : {}),
            permissions,
            jobs: runtime.jobs,
            autoWakeOnJobExit: config.autoWake,
            // A detached run's TUI: its presence follows `/clear`, its `/quit`
            // closes the session for all (docs/fix/detach-live.md A2/A4).
            createSession: run?.createSession ?? runtime.createSession,
            ...(localAutoAcceptFeed ? { autoAccept: localAutoAcceptFeed } : {}),
            ...(run ? { runQuit: run.runQuit, autoAccept: run.autoAccept } : {}),
            // A job's exit its relay handed over, or one the session's open
            // reported no turn has flushed (docs/fix/attach-unflushed-exits.md);
            // ONE boolean (never two wakes). The TUI decides by its `autoWake`.
            // `wakePending` seeds the wake; only the relay's (`wakeHanded`) is
            // retried when it loses the slot — a count-seeded one may be served by
            // another TUI attaching at once (exactly one wake).
            ...(run?.wakePending || unflushed > 0 ? { wakePending: true } : {}),
            ...(run?.wakePending ? { wakeHanded: true } : {}),
            ...(initialPrompt !== undefined ? { initialPrompt } : {}),
            link: runtime.link,
            mcpStatus: runtime.mcpStatus,
            // A fact of the runtime this laptop started, never guessed: a
            // spilled result's file lives in the pod (docs/feat/tui-spill-note.md).
            daemonInPod: true,
            ...sessionOptions,
          });
          inkRan = true;
        } catch (error) {
          // The TUI itself failed: the runtime's teardown then prints the one
          // failure line naming the daemon log (docs/feat/run-prompt.md round 4).
          runtime.markFault?.();
          throw error;
        }
      },
      teardown: () => (finish ? finish(inkRan) : runtime.dispose()),
      write: err,
    });
    return 0;
  };

  // `run`: run the agent daemon inside a new workload — a Kubernetes pod or a
  // Docker/Podman container (`--engine`) — driven from this local TUI (F4). The
  // image need NOT contain `tentacle` — it is injected over the exec channel at
  // startup (F4.e); it must be a Linux glibc image with `sh` + `head` (musl
  // images cannot run the injected glibc binary). kubernetes: `--namespace`
  // defaults to the kubeconfig context's namespace; a missing namespace fails
  // with a clear error (it is NOT created). `--resume` works because sessions
  // persist on the laptop (the workload is stateless). Without `--rm` the run keeps the
  // workload up on exit (and Ctrl+C) and prints how to re-attach. ONE runtime
  // for every engine (`startEngineRuntime`); no in-process fallback.
  if (mode === "run") {
    const { flags: runFlags, bools: runBools, positional: runPos } = parsed;
    const engine = selectEngine("run", runFlags, runBools);
    if (engine === null) {
      return 1;
    }
    const noun = engineNoun(engine);
    const rm = resolveRm({
      bare: runBools.has("rm"),
      value: runFlags.get("rm"),
      configured: config.rm,
    });
    if (!rm.ok) {
      err(`[${noun}] ${rm.error}\n`);
      return 1;
    }
    // `run --detach --prompt` (docs/feat/detached-relay.md): no TUI, its session
    // in a relay. Refused here, before anything exists; `-` is stdin, read once.
    // The positional is the FIRST PROMPT (docs/feat/run-prompt.md); the workload's
    // name is `--name`. The TUI sends the prompt at once; a detached run takes it
    // as its turn. `--prompt -` (stdin) is `--detach`-only.
    const detach = runBools.has("detach");
    const chosen = resolveRunPrompt({
      positional: runPos[0],
      promptFlag: runFlags.get("prompt"),
      detach,
    });
    if (!chosen.ok) {
      err(`[error] ${chosen.error}\nusage: ${USAGE.run}\n`);
      return 1;
    }
    if (chosen.stdin && !io.readStdin && terminal.stdin) {
      err(`[error] --prompt -: stdin is a terminal\nusage: ${USAGE.run}\n`);
      return 1;
    }
    const prompt = chosen.stdin
      ? await (io.readStdin ?? (() => Bun.stdin.text()))()
      : chosen.prompt;
    const detachProblem = detachFlagProblem({
      detach,
      prompt,
      resume: runBools.has("resume") || runFlags.has("resume") || runBools.has("continue"),
    });
    if (detachProblem) {
      err(`[error] ${detachProblem}\nusage: ${USAGE.run}\n`);
      return 1;
    }
    const image = runFlags.get("image") ?? process.env.TENTACLE_POD_IMAGE;
    const binDir = runFlags.get("bin-dir") ?? process.env.TENTACLE_POD_BIN_DIR;
    if (!image) {
      err(
        `[${noun}] --image <ref> is required (any Linux glibc image with sh+head; tentacle is injected)\n`,
      );
      return 1;
    }
    const name = runFlags.get("name");
    const sessions = await openSessions(runFlags, runBools);
    if ("exit" in sessions) {
      return sessions.exit;
    }
    const built = engineHost(engine, runFlags, runBools);
    if (built === null) {
      return 1;
    }
    const context = runFlags.get("context");
    // docker/podman (slice D, docs/feat/docker-workspace-mount.md): plan the cwd
    // mount and gate a dangerous source HERE — before anything is created and
    // before Ink owns the terminal (the y/N prompt is a plain line).
    const wsPlan: WorkspacePlan =
      engine === "kubernetes"
        ? { kind: "none" } // a pod never mounts a laptop folder
        : planWorkspace(
            laptopWorkspaceInput({
              kind: engine,
              endpoint: built.endpoint,
              noMount: runBools.has("no-mount"),
              cwd: config.cwd,
              configDir: config.configDir,
              binDir: binDir ?? "/usr/local/bin",
              hide: hideList(config.mount, config.apiKeyCommand),
              keyFileUnknown: apiKeyFileUnknown(config.apiKeyCommand),
            }),
          );
    if (wsPlan.kind === "refuse") {
      err(`[${noun}] ${wsPlan.message}\n`);
      return 1;
    }
    if (wsPlan.kind === "none" && wsPlan.warning) {
      err(`[${noun}] warning: ${wsPlan.warning}\n`);
    }
    if (wsPlan.kind === "mount") {
      for (const warning of wsPlan.warnings ?? []) {
        // Pattern text comes from a project file: sanitised like any untrusted text.
        err(`[${noun}] warning: ${untrustedText(warning)}\n`);
      }
    }
    const ask = io.ask ?? (canAsk ? askStdin : undefined);
    const gate = mountGate(wsPlan, {
      interactive: ask !== undefined,
      confirmed: runBools.has("confirm-mount"),
    });
    if (gate.action === "refuse") {
      err(`[${noun}] ${gate.message}\n`);
      return 1;
    }
    if (gate.action === "ask" && !(ask && isYes(await ask(gate.prompt)))) {
      err(`[${noun}] not confirmed — nothing was created\n`);
      return 1;
    }
    if (gate.action === "proceed") {
      for (const warning of gate.warnings ?? []) {
        err(`[${noun}] warning: ${warning}\n`);
      }
    }
    // Slice E: a kept workload carries its metadata and goes in the laptop
    // index (`tentacle ps`) at the location it was really created on. So does a
    // detached run, with or without `--rm`: `ps`, `rm` and `attach` reach it while
    // it lives, and with `--rm` its relay removes it, under those labels.
    const created = new Date().toISOString();
    const listed = !rm.rm || detach;
    const keptMeta = listed ? keptMetadata({ engine, model: config.model, created }) : undefined;
    const insecureTcp = runBools.has("insecure-docker-tcp");
    const keptEntryFor = (keptName: string): KeptEntry => ({
      schemaVersion: KEPT_SCHEMA_VERSION,
      name: keptName,
      engine,
      ...keptLocation(engine, built, { context, insecureTcp }),
      ...(binDir ? { binDir } : {}),
      ...(wsPlan.kind === "mount" ? { mount: wsPlan.mount.target } : {}),
      // The launch folder, every engine: where `attach` files the session when nothing is mounted.
      cwd: config.cwd,
      model: config.model,
      ...(config.profile !== undefined ? { profile: config.profile } : {}),
      created,
    });
    // Names whose index entry exists: only those have a run dir for the log (a
    // setup that failed before the record must not leave a run dir behind).
    const recordedNames = new Set<string>();
    const recordKeptEntry = (keptName: string): (() => void) => {
      const file = recordKept(keptDir(config.configDir), keptEntryFor(keptName));
      recordedNames.add(keptName);
      return () => forgetKept(file);
    };
    const workloadDeps = {
      host: built.host,
      image,
      ...(binDir ? { binDir } : {}),
      ...(name ? { name } : {}),
      ...(wsPlan.kind === "mount" ? { workspace: wsPlan.mount } : {}),
      ...(listed
        ? {
            resumeHint: (name: string) =>
              attachCommand(engine, name, {
                namespace: built.namespace,
                context,
                insecureTcp,
                binDir,
              }),
          }
        : {}),
      ...(keptMeta ? { labels: keptMeta.labels, annotations: keptMeta.annotations } : {}),
      log: err,
      logTerm: errTerm,
      info,
      // The pod daemon's stderr never reaches the terminal: a file in the run's
      // state dir (a recorded run has one), else under <configDir>/logs/<name>/.
      daemonLogPath: (workload: string) =>
        listed && recordedNames.has(workload)
          ? join(runDirFor(config.configDir, keptEntryFor(workload)), "daemon.log")
          : join(config.configDir, "logs", workload, "daemon.log"),
    };
    // The relay redials from the kept entry, so a detached run needs one: a
    // failed write, only a warning for `run`, stops it here.
    if (detach && prompt !== undefined) {
      const sessionId = crypto.randomUUID();
      let recorded = null as KeptEntry | null;
      let workload: Awaited<ReturnType<typeof provisionWorkload>>;
      try {
        workload = await (io.provisionWorkload ?? provisionWorkload)(config, {
          ...workloadDeps,
          ...(rm.rm ? { removedAtEnd: true } : {}),
          recordKept: (keptName) => {
            const undo = recordKeptEntry(keptName);
            recorded = keptEntryFor(keptName);
            return undo;
          },
        });
      } catch (error) {
        err(failedLine(noun, error));
        return 1;
      }
      if (recorded === null) {
        err(`[${noun}] failed: a detached run needs its kept index entry; nothing started\n`);
        return 1;
      }
      const launched = await launchRelay(
        runDirFor(config.configDir, recorded),
        {
          schemaVersion: RUN_STATE_VERSION,
          mode: "start",
          stem: runStem(recorded),
          sessionId,
          prompt,
          autoAccept: runBools.has("auto-accept") || runFlags.get("auto-accept") === "true",
          rm: rm.rm,
          cwd: config.cwd,
          ...(profileFlag !== undefined ? { profile: profileFlag } : {}),
        },
        {
          write: err,
          noun,
          name: workload.name,
          attachHint: workloadDeps.resumeHint?.(workload.name) ?? "",
          ...(io.spawnRelay ? { spawnRelay: io.spawnRelay } : {}),
        },
      );
      // D1 (docs/fix/cli-output-streams.md): the workload's NAME is the data of
      // a launched run — on stdout only when it is not a terminal
      // (`name=$(tentacle run --detach …)`); a terminal has the `still running` line.
      if (launched === 0 && !outTty) {
        out(`${workload.name}\n`);
      }
      return launched;
    }
    // ONE broker shared by the engine runtime and the TUI (see `runEngineTui`).
    const permissions = new PermissionBroker(undefined, { holdUntilSet: true });
    let runtime: Awaited<ReturnType<typeof startEngineRuntime>>;
    try {
      runtime = await (io.startEngineRuntime ?? startEngineRuntime)(config, {
        ...workloadDeps,
        ...(keptMeta
          ? {
              recordKept: (keptName: string) => {
                const undo = recordKeptEntry(keptName);
                // The run's latest saved session goes in the entry (laptop-written):
                // a plain `attach` reopens it (docs/fix/attach-plain-resume.md).
                trackKeptSession(
                  sessions.saver,
                  keptDir(config.configDir),
                  keptEntryFor(keptName),
                  (message) => sessions.notices.notify(keptSessionNotice(message)),
                );
                return undo;
              },
            }
          : {}),
        permissions,
        saver: sessions.saver,
        resume: sessions.resume,
        notify: (text, hint) => sessions.notices.notify(text, hint),
      });
    } catch (error) {
      err(failedLine(noun, error));
      return 1;
    }
    // `--auto-accept[=true]` without `--detach`: the TUI's own auto-accept, ON
    // from the start (Shift+Tab turns it off); `=false` changes nothing.
    const autoAcceptOn = runBools.has("auto-accept") || runFlags.get("auto-accept") === "true";
    return await runEngineTui(
      runtime,
      permissions,
      sessions,
      undefined,
      prompt,
      autoAcceptOn ? localAutoAccept(true) : undefined,
    );
  }

  /**
   * The kept entry named `name` that is a detached run: its run dir has a record
   * or a live lock. `at`: the place explicit flags name, compared with the
   * entry's, because a run's quit may delete its workload: another place's run
   * is never this attach's. Only what `at` cannot rule out comes back as
   * `elsewhere`: a live relay of that name, S2's refusal (nothing is dialled, so
   * one workload reached by two addresses cannot be told from two workloads).
   */
  const detachedRunOf = (
    name: string,
    engine: EngineKind | undefined,
    at?: () => string | null,
  ) => {
    type Run = {
      entry: KeptEntry;
      dir: string;
      holder: ReturnType<typeof lockHolder>;
      owner: ReturnType<typeof readOwner>;
    };
    let elsewhere: Run | null = null;
    for (const { entry } of readKept(keptDir(config.configDir)).entries) {
      if (entry.name !== name || (engine !== undefined && entry.engine !== engine)) {
        continue;
      }
      const dir = runDirFor(config.configDir, entry);
      const holder = lockHolder(dir, laptopProc);
      const owner = readOwner(dir);
      if (holder === null && owner.kind === "none") {
        continue;
      }
      if (at === undefined || at() === locationKey(entry)) {
        return { entry, dir, holder, owner, elsewhere: false };
      }
      if (holder !== null) {
        elsewhere ??= { entry, dir, holder, owner };
      }
    }
    return elsewhere === null ? null : { ...(elsewhere as Run), elsewhere: true };
  };
  /** Why `attach` stops on a detached run (`planAttach`'s refusals). */
  const attachRefusal = (
    name: string,
    plan: AttachPlan,
    run: NonNullable<ReturnType<typeof detachedRunOf>>,
    noun: string,
  ): string => {
    const shown = untrustedText(name);
    if (plan.kind === "refuse" && plan.why === "tty") {
      return `${shown}: attaching to a detached run needs a terminal (its quit ends the run)`;
    }
    // A live relay owns the session, and no hand-over can happen.
    return relayBlockingMessage(name, { pid: run.holder?.pid ?? 0, owner: run.owner, noun });
  };

  // `attach`: attach the local TUI to an EXISTING pod or container (F4, the
  // `run` flow minus the lifecycle): it is user-owned, so nothing is created —
  // and NOTHING is deleted on exit (closing the TUI detaches; it stays up for
  // reuse). The agent binary is injected only when it lacks a working one (a
  // preflight `--version` probe skips the transfer on re-attach); the same
  // image constraints as `run` apply to the injected binary. See
  // `attachEngineRuntime` and `docs/feat/pod-exec-attach.md`.
  if (mode === "attach") {
    const { flags: attachFlags, bools: attachBools, positional: attachPos } = parsed;
    const name = attachPos[0] ?? "";
    // Slice E: with no engine/location flag, a KEPT workload's engine and
    // location come from the laptop index (never from a label). It only picks
    // the host: the attach stays user-owned (no create, no delete). Explicit
    // flags win, so a user's own pod/container still attaches as before; a
    // detached run is reached through them only at the place they name.
    const explicit = ["engine", "namespace", "context", "container"].some((f) =>
      attachFlags.has(f),
    );
    const asked = explicit ? selectEngine("attach", attachFlags, attachBools) : undefined;
    if (asked === null) {
      return 1;
    }
    let askedBuilt: ReturnType<typeof engineHost> | undefined;
    const askedHost = (kind: EngineKind): ReturnType<typeof engineHost> => {
      if (askedBuilt === undefined) {
        askedBuilt = engineHost(kind, attachFlags, attachBools);
      }
      return askedBuilt;
    };
    /** Where the flags point (nothing is dialled); `null`: they do not resolve, said once. */
    const askedWhere = (
      kind: EngineKind,
    ): Pick<KeptEntry, "engine" | "endpoint" | "context" | "server" | "namespace"> | null => {
      const built = askedHost(kind);
      return (
        built && {
          engine: kind,
          ...keptLocation(kind, built, {
            context: attachFlags.get("context"),
            insecureTcp: attachBools.has("insecure-docker-tcp"),
          }),
        }
      );
    };
    const askedAt = (kind: EngineKind): string | null => {
      const at = askedWhere(kind);
      return at === null ? null : locationKey(at);
    };
    /**
     * Owner A (docs/fix/detach-live.md round 10): a kept workload's attach talks
     * to the run's model, shown in the status bar, unless this command named
     * one. `false`: the run's profile no longer loads (said).
     */
    let runModelOf: string | null = null;
    const useRunModel = async (entry: KeptEntry): Promise<boolean> => {
      if (runModelOf === entry.created) {
        return true;
      }
      runModelOf = entry.created;
      const plan = runModelPlan(entry, config, {
        profile: profileFlag !== undefined || Boolean(process.env.TENTACLE_PROFILE),
        model: modelFlag !== undefined || Boolean(process.env.TENTACLE_MODEL),
      });
      if (plan.kind === "as-is") {
        return true;
      }
      try {
        const loaded =
          plan.profile === config.profile
            ? config
            : await loadConfig({
                cwd: config.cwd,
                scaffold: false,
                ...(plan.profile !== undefined ? { profile: plan.profile } : {}),
              });
        config = loaded.model === plan.model ? loaded : { ...loaded, model: plan.model };
        return true;
      } catch (error) {
        err(
          `[config error] ${untrustedText(name)} was started with profile ${untrustedText(plan.profile ?? "(none)")}: ${error instanceof Error ? error.message : String(error)} — pass --profile to choose one\n`,
        );
        return false;
      }
    };
    /**
     * attach-any-folder (docs/fix/attach-any-folder.md): the attach behaves as
     * if launched from the workload's own folder, which only this laptop
     * recorded (`owner.json`, the kept index entry's `mount`) — never a label.
     * Everything derived from the cwd (project config, the sessions filing)
     * is re-derived from it. The folder need not exist any more. `false`: the
     * project config there does not load (said).
     */
    const moveTo = async (folder: string | undefined): Promise<boolean> => {
      if (folder === undefined || folder === config.cwd) {
        return true;
      }
      // The folder need not exist any more (attach-plain-resume round 3): it only
      // keys the laptop session store (`sessions/<projectKey(path)>/`), so the
      // session is filed under the ORIGINAL path string. Never a refusal.
      try {
        config = await loadConfig({
          cwd: folder,
          scaffold: false,
          ...(config.profile !== undefined ? { profile: config.profile } : {}),
          ...(modelFlag !== undefined ? { model: modelFlag } : {}),
        });
      } catch (error) {
        err(`[config error] ${error instanceof Error ? error.message : String(error)}\n`);
        return false;
      }
      // The reload dropped the run's model: let `useRunModel` apply it again.
      runModelOf = null;
      return true;
    };
    const lookup = explicit ? undefined : resolveKeptAttach(name, keptDir(config.configDir));
    for (const problem of lookup?.problems ?? []) {
      err(`kept index: ${untrustedText(problem)} — left untouched\n`);
    }
    if (lookup?.resolved.kind === "ambiguous") {
      err(
        `[error] ${ambiguousMessage(
          name,
          lookup.resolved.candidates.map((c) => c.entry),
          readKubeconfig(),
        )}\nusage: ${USAGE.attach}\n`,
      );
      return 1;
    }
    // A detached run (docs/feat/detached-handover.md): `attach` opens ITS
    // session as one more client, a stale owner, an ended run and a join alike;
    // its quit ends the run when it is the last client. With no `owner.json`
    // (a user's own pod, Q4) it is today's attach. Nothing is dialled first.
    for (let attempt = 0; ; attempt++) {
      const run = detachedRunOf(name, asked, asked ? () => askedAt(asked) : undefined);
      if (run === null) {
        break;
      }
      if (run.elsewhere) {
        // R1: NOT S2's text. `kill` would stop the run and, on an `--rm` run,
        // remove a workload in ANOTHER place than the flags name. The run is
        // elsewhere by definition here, so `askedWhere` is not null.
        const at = askedWhere(run.entry.engine);
        const kube = readKubeconfig();
        const places = {
          run: placeText(run.entry, kube),
          asked: at === null ? null : placeText(at, kube),
        };
        const pid = run.holder?.pid ?? 0;
        err(`[error] ${elsewhereMessage(name, { pid, owner: run.owner }, places)}\n`);
        return 1;
      }
      const plan = planAttach({
        owner: run.owner,
        relayAlive: run.holder !== null,
        entryCreated: run.entry.created,
        ...(attachFlags.has("resume") ? { resumeUid: attachFlags.get("resume") } : {}),
        tty: terminal.stdin && terminal.stdout,
      });
      const runNoun = engineNoun(run.entry.engine);
      if (plan.kind === "refuse") {
        err(`[error] ${attachRefusal(name, plan, run, runNoun)}\n`);
        return 1;
      }
      if (plan.kind === "run" && !(await moveTo(plan.cwd))) {
        return 1;
      }
      if (!(await useRunModel(run.entry))) {
        return 1;
      }
      if (plan.kind === "plain") {
        break;
      }
      if (run.owner.kind !== "owner") {
        break; // `planAttach` gives `run` only on a record
      }
      const joined = await joinRun({
        name,
        noun: runNoun,
        entry: run.entry,
        keptFile: join(keptDir(config.configDir), keptFileName(run.entry)),
        dir: run.dir,
        plan,
        owner: run.owner.owner,
        cwd: config.cwd,
        write: err,
        info,
        procOf: laptopProc,
        openSessions: () =>
          openTuiSessions(
            {
              root: join(config.configDir, "sessions"),
              cwd: config.cwd,
              keepSuperseded: config.sessions?.keepSuperseded === true,
            },
            { wanted: true, uid: plan.sessionId, live: true },
            err,
            undefined,
            [titleConfigNotice(config)].filter((text): text is string => text !== null),
          ),
        readRecord: () =>
          readSessionRecord(
            { root: join(config.configDir, "sessions"), cwd: config.cwd },
            plan.sessionId,
          ),
        host: () => {
          try {
            return buildEngineHost(run.entry.engine, hostOptionsFor(run.entry)).host;
          } catch (error) {
            err(setupFailureLine(run.entry.engine, error));
            return null;
          }
        },
        attach: (host, sessions, permissions) => {
          const container = attachFlags.get("container");
          const binDir =
            attachFlags.get("bin-dir") ?? process.env.TENTACLE_POD_BIN_DIR ?? run.entry.binDir;
          return (io.attachEngineRuntime ?? attachEngineRuntime)(config, {
            host,
            name,
            ...(container ? { container } : {}),
            ...(binDir ? { binDir } : {}),
            permissions,
            saver: sessions.saver,
            resume: sessions.resume,
            sessionId: plan.sessionId,
            shared: true,
            log: err,
            logTerm: errTerm,
            info,
            daemonLogPath: () => join(run.dir, "daemon.log"),
            notify: (text, hint) => sessions.notices.notify(text, hint),
          });
        },
        armNet: (host, othersAlive, saved, onKept) =>
          armSharedExitNet(host, name, othersAlive, saved, onKept),
        // No hand-over can happen (no socket, skew, another session): S2's refusal.
        relayRefusal: () => attachRefusal(name, { kind: "refuse", why: "relay" }, run, runNoun),
      });
      if (joined.kind === "exit") {
        return joined.code;
      }
      if (joined.kind === "closing") {
        if (attempt === 0) {
          continue; // planned again, once: an `--rm` run now meets the ordinary "gone"
        }
        err(`[error] ${untrustedText(name)}: the run is still closing; retry in a moment\n`);
        return 1;
      }
      // The session's `history` activity draws an attached screen, not the record.
      const sessions = joined.attached ? { ...joined.sessions, resume: null } : joined.sessions;
      return await runEngineTui(joined.runtime, joined.permissions, sessions, joined);
    }
    const keptEntry = lookup?.resolved.kind === "one" ? lookup.resolved.match.entry : undefined;
    // A plain kept container (no owner record): the folder its index entry
    // mounts, else the folder `run` was launched from (every engine records it).
    // None (an older entry, or explicit flags, which skip the index): the
    // launch folder, as before.
    if (keptEntry && !(await moveTo(keptEntry.mount ?? keptEntry.cwd))) {
      return 1;
    }
    if (keptEntry && !(await useRunModel(keptEntry))) {
      return 1;
    }
    const engine = keptEntry
      ? keptEntry.engine
      : (asked ?? selectEngine("attach", attachFlags, attachBools));
    if (engine === null) {
      return 1;
    }
    const noun = engineNoun(engine);
    const container = attachFlags.get("container");
    const binDir =
      attachFlags.get("bin-dir") ?? process.env.TENTACLE_POD_BIN_DIR ?? keptEntry?.binDir;
    // docs/fix/attach-plain-resume.md: the conversation its run last saved
    // (the kept entry's `sessionId`, written by this laptop) is reopened from the
    // laptop record, unless `--resume`/`--continue` chose. The user did not ask for
    // THAT uid, so a record that is gone, unreadable or of another folder is a
    // fresh session and one note — never `openSessions`' fatal.
    const reopenUid = plainResumeUid(keptEntry, {
      resume: attachBools.has("resume") || attachFlags.has("resume"),
      continue: attachBools.has("continue"),
    });
    let reopenNote: string | undefined;
    let reopen: string | undefined;
    if (reopenUid !== undefined) {
      try {
        const found = await readSessionRecord(
          { root: join(config.configDir, "sessions"), cwd: config.cwd },
          reopenUid,
        );
        reopen = found === null ? undefined : reopenUid;
        if (found === null) {
          reopenNote = `The conversation of this container (session ${reopenUid.slice(0, 8)}) is not among the saved sessions of ${untrustedText(config.cwd)}: starting a new one.`;
        }
      } catch (error) {
        reopenNote = `The conversation of this container (session ${reopenUid.slice(0, 8)}) could not be read (${untrustedText(error instanceof Error ? error.message : String(error))}): starting a new one.`;
      }
    }
    const sessions = await openSessions(
      reopen === undefined ? attachFlags : new Map([...attachFlags, ["resume", reopen]]),
      attachBools,
    );
    if ("exit" in sessions) {
      return sessions.exit;
    }
    if (reopenNote !== undefined) {
      sessions.notices.notify(reopenNote);
    }
    if (keptEntry) {
      // An attach is a session too (`/clear`, `/resume`): the entry follows the latest.
      trackKeptSession(sessions.saver, keptDir(config.configDir), keptEntry, (message) =>
        sessions.notices.notify(keptSessionNotice(message)),
      );
    }
    let built: ReturnType<typeof engineHost>;
    if (keptEntry) {
      try {
        built = buildEngineHost(engine, hostOptionsFor(keptEntry));
      } catch (error) {
        err(setupFailureLine(engine, error));
        built = null;
      }
    } else {
      built = askedHost(engine);
    }
    if (built === null) {
      return 1;
    }
    // ONE broker shared by the engine runtime and the TUI (see `runEngineTui`).
    const permissions = new PermissionBroker(undefined, { holdUntilSet: true });
    let runtime: Awaited<ReturnType<typeof attachEngineRuntime>>;
    try {
      runtime = await (io.attachPlainRuntime ?? attachEngineRuntime)(config, {
        host: built.host,
        name,
        ...(container ? { container } : {}),
        ...(binDir ? { binDir } : {}),
        permissions,
        saver: sessions.saver,
        resume: sessions.resume,
        log: err,
        logTerm: errTerm,
        info,
        daemonLogPath: (workload: string) =>
          keptEntry
            ? join(runDirFor(config.configDir, keptEntry), "daemon.log")
            : join(config.configDir, "logs", workload, "daemon.log"),
        notify: (text, hint) => sessions.notices.notify(text, hint),
      });
    } catch (error) {
      // A name that is neither in `ps` nor on the engine: one plain line.
      err(
        !keptEntry && error instanceof WorkloadNotFoundError
          ? notListedLine(name, error)
          : failedLine(noun, error),
      );
      return 1;
    }
    // A session still live on the daemon is attached now, not at the first prompt:
    // its report says what it keeps (the settings notice), and its `history`
    // activity draws the screen. Not there, or any failure: lazy, from the record;
    // the first send reports a link that is really down. The attach is bounded
    // (ATTACH_TIMEOUT_MS): that failure is told, buffered until Ink mounts
    // (docs/feat/session-settings-apply.md S3).
    const live =
      sessions.resume !== null &&
      (await runtime.attachTo(sessions.resume.id, sessions.resume).catch((error: unknown) => {
        const notice = attachFailureNotice(error);
        if (notice !== null) {
          sessions.notices.notify(notice);
        }
        return false;
      }));
    return await runEngineTui(
      runtime,
      permissions,
      live ? { ...sessions, resume: null } : sessions,
    );
  }

  // Plain line-based REPL (scripting / no-TTY fallback). No interactive
  // permission prompt here, so the broker stays headless (approves all).
  if (mode === "plain") {
    // Ink is not mounted here: an ignored hook failure goes to stderr.
    return await startTerminal(
      buildAgent(config, {
        log: (l) => process.stderr.write(`[hook] ${l}\n`),
        notice: (l) => process.stderr.write(`[context] ${l}\n`),
        agentsNotice: (l) => process.stderr.write(`[agents] ${l}\n`),
      }).agent,
    );
  }

  // Rich interactive TUI. `--resume [uid]` also enters it (resuming a session).
  const { flags: topFlags, bools: topBools } = parsed;
  if (mode === "tui" || (mode === "empty" && terminal.stdin)) {
    const sessions = await openSessions(topFlags, topBools);
    if ("exit" in sessions) {
      return sessions.exit;
    }
    const { saver, resume: resumeRecord } = sessions;

    // By default the agent runs in a worker thread, off the render thread, so
    // tool execution never janks the UI (MCP tools and live background-job exits
    // work over the RPC boundary too). Opt out with `--in-process` (or
    // `--no-worker`); any worker failure also falls back to in-process.
    const useWorker = !topBools.has("in-process") && !topBools.has("no-worker");
    if (useWorker) {
      // RPC path: hold a daemon's request until the TUI's prompt is mounted.
      const permissions = new PermissionBroker(undefined, { holdUntilSet: true });
      const runtime = await startWorkerRuntime(
        config,
        { permissions, saver, resume: resumeRecord },
        err,
      );
      if (runtime) {
        await runSessionTui(sessions, {
          start: (sessionOptions) =>
            startTui(null, {
              model: config.model,
              theme: config.tui?.theme ?? "auto",
              cwd: config.cwd,
              contextWindow: config.contextWindow,
              permissions,
              jobs: runtime.jobs,
              autoWakeOnJobExit: config.autoWake,
              createSession: runtime.createSession,
              link: runtime.link,
              mcpStatus: runtime.mcpStatus,
              ...sessionOptions,
            }),
          teardown: () => runtime.dispose(),
          write: err,
        });
        return 0;
      }
      // worker unavailable → fall through to the in-process path below
    }

    // One agent per session (one `BackgroundJobs` each, so `/clear` ends the
    // old session's jobs, as on every RPC runtime — decision D3), all on ONE
    // broker: the one the TUI installs its prompt on (AGENTS §7).
    const { permissions, build } = inProcessAgents(config);
    const mcp = await connectMcpServers(config.mcpServers);
    for (const [name, message] of Object.entries(mcp.errors)) {
      err(`[mcp] server "${name}" failed to connect: ${message}\n`);
    }
    for (const line of longToolNameWarnings(mcp.tools.map((t) => t.name))) {
      err(`[mcp] ${line}\n`);
    }
    const mcpTracker = new McpStatusTracker(Object.keys(config.mcpServers));
    mcpTracker.settle(mcp);
    const { createSession, jobs } = inProcessSessions({
      build,
      mcpTools: mcp.tools,
      resume: resumeRecord,
      persist: (snapshot, createdAt, title) =>
        saver.save(
          recordFromSnapshot(snapshot, {
            cwd: config.cwd,
            model: config.model,
            title,
            ...(createdAt !== undefined ? { createdAt } : {}),
          }),
        ),
    });

    await runSessionTui(sessions, {
      start: (sessionOptions) =>
        startTui(null, {
          model: config.model,
          theme: config.tui?.theme ?? "auto",
          cwd: config.cwd,
          contextWindow: config.contextWindow,
          permissions,
          jobs,
          autoWakeOnJobExit: config.autoWake,
          createSession,
          mcpStatus: () => mcpTracker.probe(),
          ...sessionOptions,
        }),
      teardown: () => mcp.dispose(),
      write: err,
    });
    return 0;
  }

  // A one-shot prompt: its words verbatim (`--` lets one start with '-').
  const prompt = args[0] === "--" ? args.slice(1) : args;
  if (prompt.length === 0) {
    // No prompt is an error (exit 1): its help is stderr's (D6).
    err(HELP);
    return 1;
  }

  // One-shot, no Ink: an ignored hook failure goes to stderr.
  const { agent, tools } = buildAgent(config, {
    log: (l) => err(`[hook] ${l}\n`),
    notice: (l) => err(`[context] ${l}\n`),
    agentsNotice: (l) => err(`[agents] ${l}\n`),
  });
  const mcp = await connectConfiguredMcp(config, tools);
  for (const [name, message] of Object.entries(mcp.errors)) {
    err(`[mcp] server "${name}" failed to connect: ${message}\n`);
  }
  for (const line of longToolNameWarnings(mcp.tools.map((t) => t.name))) {
    err(`[mcp] ${line}\n`);
  }
  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.on("SIGINT", onSignal);

  const userMessage: ChatMessage = { role: "user", content: prompt.join(" ") };
  // D5: the answer alone on stdout; the trace (and an error) on stderr.
  const split = new AnswerSplit(outTty && errTerm.tty);
  try {
    for await (const event of agent.run(crypto.randomUUID(), [userMessage], controller.signal)) {
      const chunk = split.push(event);
      if (chunk.out !== "") {
        out(chunk.out);
      }
      if (chunk.err !== "") {
        err(chunk.err);
      }
    }
    return 0;
  } catch (error) {
    err(split.error(error));
    return 1;
  } finally {
    process.off("SIGINT", onSignal);
    mcp.dispose();
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv));
}
