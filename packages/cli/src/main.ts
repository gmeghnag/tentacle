#!/usr/bin/env bun
import { join } from "node:path";
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
import { DELETE_POD_SUBCOMMAND, deletePodFromEnv } from "@tentacle/k8s";
import { McpStatusTracker, connectMcpServers } from "@tentacle/mcp";
import { type SessionController, pickSession, startTui } from "@tentacle/tui";
import {
  type TentacleConfig,
  configDirFromEnv,
  loadConfig,
  longToolNameWarnings,
  titleConfigNotice,
} from "./config.ts";
import { connectTui } from "./connect.ts";
import type { EngineKind } from "./engine-host.ts";
import { attachEngineRuntime, startEngineRuntime } from "./engine-runtime.ts";
import {
  attachCommand,
  buildEngineHost,
  chooseEngine,
  engineFlagProblem,
  engineNoun,
  resolveKeep,
  setupFailureLine,
} from "./engine-select.ts";
import {
  ARGS,
  type ParsedFlags,
  type ServeLimits,
  USAGE,
  cliMode,
  extractGlobalOptions,
  parseArgs,
  parseContextWindowFlag,
  parseServeLimits,
  resolveTls,
  resolveToken,
} from "./flags.ts";
import { fileTrustStore, hooksTrustCommand, projectHooksWireProblem } from "./hooks-trust.ts";
import { startWorkerRuntime } from "./local-runtime.ts";
import { packagesCommand, spawnGit } from "./packages-cmd.ts";
import { render } from "./render.ts";
import { startDaemon, startStdioDaemon } from "./serve.ts";
import { inProcessSessions } from "./session-jobs.ts";
import { startTerminal } from "./terminal.ts";
import { type TuiSessions, openTuiSessions, runSessionTui } from "./tui-sessions.ts";
import { untrustedText } from "./untrusted-text.ts";
import { runUpdate, spawnVersion } from "./update.ts";
import { APP_VERSION } from "./version.ts";
import { buildAgent, connectConfiguredMcp, inProcessAgents, loadUserAgentTypes } from "./wiring.ts";

const HELP = `tentacle — run an agent task

Usage:
  tentacle                 start the rich interactive TUI (when stdin is a TTY)
  tentacle -i              force the interactive TUI
  tentacle --plain         plain line-based REPL (for pipes / no TTY)
  tentacle --resume [uid]  resume a saved session of this folder (pick one if no uid)
  tentacle --continue      resume this folder's most recent session
  tentacle -i --in-process run the agent on the render thread (opt out of the worker)
  tentacle run --image <ref> [--engine kubernetes|docker|podman] [--keep[=true|false]] [-n|--namespace <ns>] [--bin-dir <dir>] [--resume [uid]|--continue] [<name>]
                                run the agent inside a new Kubernetes pod or Docker/Podman
                                container (sandbox), local TUI (<name> is its name; random
                                when omitted; sessions persist on the laptop, so --resume
                                works); kept on exit by default (--keep=false deletes)
  tentacle attach <name> [--engine kubernetes|docker|podman] [-n|--namespace <ns>] [-c|--container <c>] [--bin-dir <dir>] [--resume [uid]|--continue]
                                attach the TUI to an EXISTING pod or container (tentacle is
                                injected if it is not there yet); --container is the
                                pod's container to exec into (default: its only one);
                                it is NOT deleted on exit — closing the TUI
                                detaches, it stays up
  tentacle <prompt...>     run a single task and exit
  tentacle -- <prompt...>  the same, for a prompt that starts with '-'
  tentacle serve [opts]    host the remote-control daemon
  tentacle connect <url> [--resume [id]|--continue]
                           drive a remote daemon with the TUI; quitting
                           detaches (the session keeps running there)
  tentacle hooks trust --list | --revoke <folder>
                           list / revoke stored project-hooks trust decisions
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
  tentacle --profile <name> ...
                           apply a profile from config.jsonc ("profiles"); a
                           leading option, before the command or the prompt

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
  TENTACLE_MODEL            model id
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
  --keep[=true|false] (run only)
                          DEFAULT true: the pod/container is NOT deleted on exit or
                          Ctrl+C; tentacle prints the "tentacle attach --engine …" to
                          resume. --keep=false deletes it. Config: "keep:" (user config
                          or profile); flag > profile > user config > true
  -n/--namespace and -c/--container are kubernetes-only; --context and
  --insecure-docker-tcp are docker/podman-only (anything else is an error).

Pod execution (tentacle run --image <ref> [-n|--namespace <ns>] [<name>]):
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

export interface CliIO {
  write?: (text: string) => void;
  /** Diagnostics (default stderr: never mixed into a one-shot's stdout or `serve --stdio`'s RPC). */
  writeErr?: (text: string) => void;
  /** Test seam: replaces the `run` engine runtime (pins the flag/config → `keepHint` wiring). */
  startEngineRuntime?: typeof startEngineRuntime;
}

export async function main(argv: readonly string[], io: CliIO = {}): Promise<number> {
  const write = io.write ?? ((text: string) => void process.stdout.write(text));
  const writeErr = io.writeErr ?? ((text: string) => void process.stderr.write(text));

  // Leading global options (`--profile`) come off argv BEFORE the dispatch on
  // args[0], so they never reach a one-shot prompt (docs/feat/config-profiles.md).
  const globals = extractGlobalOptions(argv.slice(2));
  if (!globals.ok) {
    write(`\n[error] ${globals.error}\n`);
    return 1;
  }
  const args = globals.rest;

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

  if (args[0] === "--help" || args[0] === "-h") {
    write(HELP);
    return 0;
  }

  // `--version` exits before config loading, model setup, or TTY handling —
  // it doubles as the post-injection health probe in a pod.
  if (args[0] === "--version") {
    write(`tentacle ${APP_VERSION}\n`);
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
      write(`\n[error] ${result.error}\nusage: ${USAGE[mode]}\n`);
      return 1;
    }
    parsed = result;
  }

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
          ...(token ? { token } : {}),
          ...(tls ? { tls } : {}),
          ...(resume ? { resume } : {}),
        },
        write,
        {
          dial: webSocketChannelFactory,
          startTui,
          // The pre-mount picker, on a terminal only (as the local `--resume`).
          ...(process.stdin.isTTY && process.stdout.isTTY
            ? { pick: (choices: Parameters<typeof pickSession>[0]) => pickSession(choices) }
            : {}),
        },
      );
      return 0;
    } catch (error) {
      write(
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
        write,
      },
    );
  }

  // Everything below needs configuration; load it once (scaffolds on first run).
  // EXCEPT the pod daemon (`serve --stdio`): it runs in a possibly read-only
  // container with no writable HOME and needs NOTHING from the config dir (the
  // model is proxied over the wire, persistence is on the laptop). Scaffolding
  // there does `mkdir ~/.config` → EROFS → the daemon dies and the client sees
  // "connection closed". So the stdio daemon never scaffolds; missing config
  // files fall back to defaults.
  const isStdioDaemon = mode === "serve" && parsed.bools.has("stdio");
  let config: TentacleConfig;
  try {
    config = await loadConfig({
      cwd: process.cwd(),
      scaffold: !isStdioDaemon,
      ...(globals.profile !== undefined ? { profile: globals.profile } : {}),
    });
  } catch (error) {
    write(`\n[config error] ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  // `tentacle package …` (docs/feat/packages.md): no TUI, plain output.
  if (mode === "package") {
    return packagesCommand(parsed.positional, {
      configDir: config.configDir,
      enabled: config.packagesEnabled,
      git: spawnGit,
      write,
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
      write,
    );
  }

  // Skill discovery problems, once, before any Ink mount (AGENTS §7: no raw
  // write while Ink owns the terminal). Only where THIS config builds the
  // agent: `run`/`attach` sessions use the pod's own skills, discovered (and
  // reported) by the pod daemon.
  if (mode !== "run" && mode !== "attach") {
    for (const line of config.skillDiagnostics) {
      writeErr(`[skills] ${line}\n`);
    }
    for (const line of config.projectHooksDiagnostics) {
      writeErr(`[hooks] ${line}\n`);
    }
    const wireProblem = config.projectHooks && projectHooksWireProblem(config.projectHooks);
    if (wireProblem) {
      writeErr(`[hooks] ${wireProblem}\n`);
    }
    const agentTypes = loadUserAgentTypes(config.configDir, config.packageAgentDirs);
    for (const line of config.packageDiagnostics) {
      writeErr(`[packages] ${line}\n`);
    }
    for (const line of agentTypes.diagnostics) {
      writeErr(`[agents] ${line}\n`);
    }
  } else if (config.packages.length > 0) {
    // D11: laptop packages are not shipped to the pod in v1.
    writeErr(
      `[packages] ${config.packages.length} installed package(s) are not loaded in a pod session (the pod uses its own config)\n`,
    );
  }

  // Host the remote-control daemon and run until interrupted.
  if (mode === "serve") {
    const { flags, bools } = parsed;
    // `--stdio`: run the daemon over stdin/stdout instead of a WebSocket (used
    // inside a pod, driven over the k8s exec channel — F4). stdout IS the RPC
    // channel here, so every log line must go to stderr.
    if (bools.has("stdio")) {
      try {
        const contextWindow = parseContextWindowFlag(parsed);
        await startStdioDaemon(config, (line) => process.stderr.write(`[daemon] ${line}\n`), {
          modelProxy: bools.has("model-proxy"),
          // The laptop that launched us decides (`podDaemonCommand`).
          autoTitle: bools.has("auto-title"),
          ...(contextWindow !== undefined ? { contextWindow } : {}),
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
      write(`\n[serve error] ${error instanceof Error ? error.message : String(error)}\n`);
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
      const server = await startDaemon(config, {
        ...limits,
        host,
        port,
        ...(token ? { token } : {}),
        ...(tls ? { tls } : {}),
        onAudit: (line) => write(`[daemon] ${line}\n`),
        onError: (error) => write(`[daemon] error: ${error.message}\n`),
        onNotice: (line) => write(`[daemon] ${line}\n`),
      });
      write(`daemon listening on ${server.url}\n`);
      // `serve`'s own config decides its titles; no Ink here, so its log line.
      const titleNotice = titleConfigNotice(config);
      if (titleNotice) {
        write(`[daemon] ${titleNotice}\n`);
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
      write(`\n[serve error] ${error instanceof Error ? error.message : String(error)}\n`);
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
        })
      : choice.error;
    if (!choice.ok || problem) {
      write(`\n[error] ${problem}\nusage: ${USAGE[m]}\n`);
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
      write(setupFailureLine(kind, error));
      return null;
    }
  };
  // Sessions persist as JSON under <configDir>/sessions/<projectKey(cwd)>/ (store
  // + saver + notice hub, `--resume`/`--continue` resolved pre-mount, only among
  // THIS folder's sessions). `{ exit }` = don't start (reason written). The
  // picker (docs/feat/resume-picker.md) runs only on a terminal, before any
  // runtime or pod starts, so the chosen session seeds it like `--resume <uid>`.
  const openSessions = (flags: Map<string, string>, bools: Set<string>) =>
    openTuiSessions(
      { root: join(config.configDir, "sessions"), cwd: config.cwd },
      {
        wanted: bools.has("resume") || flags.has("resume") || bools.has("continue"),
        uid: flags.get("resume"),
        latest: bools.has("continue"),
      },
      write,
      process.stdin.isTTY && process.stdout.isTTY ? (choices) => pickSession(choices) : undefined,
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
  const runEngineTui = async (
    runtime: Awaited<ReturnType<typeof startEngineRuntime>>,
    permissions: PermissionBroker,
    sessions: TuiSessions,
  ): Promise<number> => {
    await runSessionTui(sessions, {
      start: (sessionOptions) =>
        startTui(null, {
          model: config.model,
          cwd: config.cwd,
          contextWindow: config.contextWindow,
          permissions,
          jobs: runtime.jobs,
          autoWakeOnJobExit: config.autoWake,
          createSession: runtime.createSession,
          link: runtime.link,
          mcpStatus: runtime.mcpStatus,
          // A fact of the runtime this laptop started, never guessed: a
          // spilled result's file lives in the pod (docs/feat/tui-spill-note.md).
          daemonInPod: true,
          ...sessionOptions,
        }),
      teardown: () => runtime.dispose(),
      write,
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
  // persist on the laptop (the workload is stateless). `--keep` leaves the
  // workload up on exit (and Ctrl+C) and prints how to re-attach. ONE runtime
  // for every engine (`startEngineRuntime`); no in-process fallback.
  if (mode === "run") {
    const { flags: runFlags, bools: runBools, positional: runPos } = parsed;
    const engine = selectEngine("run", runFlags, runBools);
    if (engine === null) {
      return 1;
    }
    const noun = engineNoun(engine);
    const image = runFlags.get("image") ?? process.env.TENTACLE_POD_IMAGE;
    const binDir = runFlags.get("bin-dir") ?? process.env.TENTACLE_POD_BIN_DIR;
    if (!image) {
      write(
        `[${noun}] --image <ref> is required (any Linux glibc image with sh+head; tentacle is injected)\n`,
      );
      return 1;
    }
    const name = runPos[0];
    const sessions = await openSessions(runFlags, runBools);
    if ("exit" in sessions) {
      return sessions.exit;
    }
    const built = engineHost(engine, runFlags, runBools);
    if (built === null) {
      return 1;
    }
    const context = runFlags.get("context");
    const kept = resolveKeep({
      bare: runBools.has("keep"),
      value: runFlags.get("keep"),
      configured: config.keep,
    });
    if (!kept.ok) {
      write(`[${noun}] ${kept.error}\n`);
      return 1;
    }
    // ONE broker shared by the engine runtime and the TUI (see `runEngineTui`).
    const permissions = new PermissionBroker(undefined, { holdUntilSet: true });
    let runtime: Awaited<ReturnType<typeof startEngineRuntime>>;
    try {
      runtime = await (io.startEngineRuntime ?? startEngineRuntime)(config, {
        host: built.host,
        image,
        ...(binDir ? { binDir } : {}),
        ...(name ? { name } : {}),
        ...(kept.keep
          ? {
              keepHint: (name: string) =>
                attachCommand(engine, name, {
                  namespace: built.namespace,
                  context,
                  insecureTcp: runBools.has("insecure-docker-tcp"),
                  binDir,
                }),
            }
          : {}),
        permissions,
        saver: sessions.saver,
        resume: sessions.resume,
        log: write,
        notify: (text) => sessions.notices.notify(text),
      });
    } catch (error) {
      write(
        `[${noun}] failed: ${untrustedText(error instanceof Error ? error.message : String(error))}\n`,
      );
      return 1;
    }
    return await runEngineTui(runtime, permissions, sessions);
  }

  // `attach`: attach the local TUI to an EXISTING pod or container (F4, the
  // `run` flow minus the lifecycle): it is user-owned, so nothing is created —
  // and NOTHING is deleted on exit (closing the TUI detaches; it stays up for
  // reuse). The agent binary is injected only when it lacks a working one (a
  // preflight `--version` probe skips the transfer on re-attach); the same
  // image constraints as `run` apply to the injected binary. See
  // `attachEngineRuntime` and `docs/feat/pod-exec-attach.md`.
  if (mode === "attach") {
    const { flags: attachFlags, bools: attachBools, positional: attachPos } = parsed;
    const engine = selectEngine("attach", attachFlags, attachBools);
    if (engine === null) {
      return 1;
    }
    const noun = engineNoun(engine);
    const name = attachPos[0] ?? "";
    const container = attachFlags.get("container");
    const binDir = attachFlags.get("bin-dir") ?? process.env.TENTACLE_POD_BIN_DIR;
    const sessions = await openSessions(attachFlags, attachBools);
    if ("exit" in sessions) {
      return sessions.exit;
    }
    const built = engineHost(engine, attachFlags, attachBools);
    if (built === null) {
      return 1;
    }
    // ONE broker shared by the engine runtime and the TUI (see `runEngineTui`).
    const permissions = new PermissionBroker(undefined, { holdUntilSet: true });
    let runtime: Awaited<ReturnType<typeof attachEngineRuntime>>;
    try {
      runtime = await attachEngineRuntime(config, {
        host: built.host,
        name,
        ...(container ? { container } : {}),
        ...(binDir ? { binDir } : {}),
        permissions,
        saver: sessions.saver,
        resume: sessions.resume,
        log: write,
        notify: (text) => sessions.notices.notify(text),
      });
    } catch (error) {
      write(
        `[${noun}] failed: ${untrustedText(error instanceof Error ? error.message : String(error))}\n`,
      );
      return 1;
    }
    return await runEngineTui(runtime, permissions, sessions);
  }

  // Plain line-based REPL (scripting / no-TTY fallback). No interactive
  // permission prompt here, so the broker stays headless (approves all).
  if (mode === "plain") {
    // Ink is not mounted here: an ignored hook failure goes to stderr.
    return await startTerminal(
      buildAgent(config, {
        log: (l) => process.stderr.write(`[hook] ${l}\n`),
        notice: (l) => process.stderr.write(`[context] ${l}\n`),
      }).agent,
    );
  }

  // Rich interactive TUI. `--resume [uid]` also enters it (resuming a session).
  const { flags: topFlags, bools: topBools } = parsed;
  if (mode === "tui" || (mode === "empty" && process.stdin.isTTY)) {
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
        write,
      );
      if (runtime) {
        await runSessionTui(sessions, {
          start: (sessionOptions) =>
            startTui(null, {
              model: config.model,
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
          write,
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
      write(`[mcp] server "${name}" failed to connect: ${message}\n`);
    }
    for (const line of longToolNameWarnings(mcp.tools.map((t) => t.name))) {
      write(`[mcp] ${line}\n`);
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
      write,
    });
    return 0;
  }

  // A one-shot prompt: its words verbatim (`--` lets one start with '-').
  const prompt = args[0] === "--" ? args.slice(1) : args;
  if (prompt.length === 0) {
    write(HELP);
    return 1;
  }

  // One-shot, no Ink: an ignored hook failure goes to stderr.
  const { agent, tools } = buildAgent(config, {
    log: (l) => process.stderr.write(`[hook] ${l}\n`),
    notice: (l) => process.stderr.write(`[context] ${l}\n`),
  });
  const mcp = await connectConfiguredMcp(config, tools);
  for (const [name, message] of Object.entries(mcp.errors)) {
    write(`[mcp] server "${name}" failed to connect: ${message}\n`);
  }
  for (const line of longToolNameWarnings(mcp.tools.map((t) => t.name))) {
    write(`[mcp] ${line}\n`);
  }
  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.on("SIGINT", onSignal);

  const userMessage: ChatMessage = { role: "user", content: prompt.join(" ") };
  try {
    for await (const event of agent.run(crypto.randomUUID(), [userMessage], controller.signal)) {
      write(render(event));
    }
    return 0;
  } catch (error) {
    write(`\n[error] ${String(error)}\n`);
    return 1;
  } finally {
    process.off("SIGINT", onSignal);
    mcp.dispose();
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv));
}
