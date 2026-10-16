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
import { JsonSessionStore, Session, type SessionRecord, recordFromSnapshot } from "@tentacle/agent";
import { type ChatMessage, PermissionBroker } from "@tentacle/core";
import {
  KubeClient,
  type KubeClientOptions,
  deletePodFromEnv,
  loadKubeClientOptions,
} from "@tentacle/k8s";
import { type SessionController, startTui } from "@tentacle/tui";
import { type TentacleConfig, loadConfig } from "./config.ts";
import { connectTui } from "./connect.ts";
import { parseFlags, resolveToken } from "./flags.ts";
import { startWorkerRuntime } from "./local-runtime.ts";
import { startAttachRuntime, startPodRuntime } from "./pod-runtime.ts";
import { render } from "./render.ts";
import { startDaemon, startStdioDaemon } from "./serve.ts";
import { startTerminal } from "./terminal.ts";
import { buildAgent, connectConfiguredMcp } from "./wiring.ts";

/**
 * The app version: a literal injected at compile time (`define` in
 * `scripts/build.ts`), or `"dev"` when running from source.
 */
const APP_VERSION = process.env.TENTACLE_APP_VERSION ?? "dev";

const HELP = `tentacle — run an agent task

Usage:
  tentacle                 start the rich interactive TUI (when stdin is a TTY)
  tentacle -i              force the interactive TUI
  tentacle --plain         plain line-based REPL (for pipes / no TTY)
  tentacle --resume [uid]  resume a saved session (latest if no uid) in the TUI
  tentacle -i --in-process run the agent on the render thread (opt out of the worker)
  tentacle run --image <ref> [--namespace <ns>] [--bin-dir <dir>] [--resume [uid]] [<name>]
                                run the agent inside a Kubernetes pod (sandbox), local TUI
                                (<name> is the pod name; random when omitted; sessions
                                persist on the laptop, so --resume works)
  tentacle attach <pod> [--namespace <ns>] [--container <c>|-c <c>] [--bin-dir <dir>] [--resume [uid]]
                                attach the TUI to an EXISTING pod (tentacle is
                                injected if it is not there yet); --container is the
                                container to exec into (default: the pod's only one);
                                the pod is NOT deleted on exit — closing the TUI
                                detaches, the pod stays up
  tentacle <prompt...>     run a single task and exit
  tentacle serve [opts]    host the remote-control daemon
  tentacle connect <url>   drive a remote daemon with the TUI
  tentacle --help          show this help
  tentacle --version       print the version and exit

Remote control:
  tentacle serve [--host 127.0.0.1] [--port 4000] [--token T|--token-command CMD]
                      [--tls-cert FILE --tls-key FILE]
  tentacle connect ws(s)://host:port [--token T|--token-command CMD]
  A non-loopback --host requires a token (remote code execution risk).
  Token env fallback: TENTACLE_REMOTE_TOKEN.

Configuration (precedence: env > config file > defaults):
  ~/.config/tentacle/config.jsonc   settings (scaffolded on first run)
  ~/.config/tentacle/PROMPT.md       default system prompt

Environment:
  TENTACLE_CONFIG_DIR       override the config directory
  TENTACLE_MODEL_BASE_URL   OpenAI-compatible base URL
  TENTACLE_MODEL            model id
  TENTACLE_MODEL_API_KEY    bearer token (overrides config apiKey/apiKeyCommand)
  TENTACLE_SYSTEM_PROMPT    inline system prompt (overrides PROMPT.md)
  TENTACLE_MAX_ITERATIONS   max model/tool iterations per turn
  TENTACLE_CWD              working directory for tools
  TENTACLE_SUBAGENTS        enable/disable sub-agents (on/off, default on)

Pod execution (tentacle run --image <ref> [--namespace <ns>] [<name>]):
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

Pod attach (tentacle attach <pod> [--namespace <ns>] [--container <c>|-c <c>]):
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
}

export async function main(argv: readonly string[], io: CliIO = {}): Promise<number> {
  const write = io.write ?? ((text: string) => void process.stdout.write(text));

  const args = argv.slice(2);

  // Hidden subcommand: the detached pod-delete child when THIS process is a
  // compiled binary (so the delete-on-exit safety net needs no external `bun`).
  // It reads TENTACLE_POD_DELETE_* / TENTACLE_POD_TLS_* from the env and issues a
  // single best-effort DELETE, then exits — no config, no TTY, no model setup.
  if (args[0] === "__delete-pod") {
    await deletePodFromEnv();
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

  // `connect` drives a remote daemon; it needs no local model configuration.
  if (args[0] === "connect") {
    const { positional, flags } = parseFlags(args.slice(1));
    const url = positional[0];
    if (!url) {
      write("\n[error] usage: tentacle connect ws(s)://host:port [--token T]\n");
      return 1;
    }
    try {
      const token = await resolveToken(flags);
      await connectTui({ url, ...(token ? { token } : {}) });
      return 0;
    } catch (error) {
      write(`\n[connect error] ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  // Everything below needs configuration; load it once (scaffolds on first run).
  let config: TentacleConfig;
  try {
    config = await loadConfig({ cwd: process.cwd() });
  } catch (error) {
    write(`\n[config error] ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  // Host the remote-control daemon and run until interrupted.
  if (args[0] === "serve") {
    const { flags, bools } = parseFlags(args.slice(1));
    // `--stdio`: run the daemon over stdin/stdout instead of a WebSocket (used
    // inside a pod, driven over the k8s exec channel — F4). stdout IS the RPC
    // channel here, so every log line must go to stderr.
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
    try {
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
      const server = startDaemon(config, {
        host,
        port,
        ...(token ? { token } : {}),
        ...(tls ? { tls } : {}),
        onAudit: (line) => write(`[daemon] ${line}\n`),
        onError: (error) => write(`[daemon] error: ${error.message}\n`),
      });
      write(`daemon listening on ${server.url}\n`);
      await new Promise<void>((resolve) => {
        process.on("SIGINT", () => {
          server.stop();
          resolve();
        });
      });
      return 0;
    } catch (error) {
      write(`\n[serve error] ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  // `run` / `attach` shared setup: cluster auth (kubeconfig current context, or
  // TENTACLE_K8S_SERVER/_TOKEN override) and session resume. Sessions persist as
  // JSON under <configDir>/sessions; the pod is stateless, so resuming seeds
  // the pod daemon with the saved session (uid + history), same as the TUI.
  const loadPodAuth = async (namespace: string | undefined, prefix: string) => {
    try {
      const envServer = process.env.TENTACLE_K8S_SERVER;
      if (envServer) {
        const token = process.env.TENTACLE_K8S_TOKEN;
        return {
          options: {
            server: envServer,
            namespace: namespace ?? "default",
            ...(token ? { token } : {}),
          } as KubeClientOptions,
        };
      }
      return { options: loadKubeClientOptions({ ...(namespace ? { namespace } : {}) }) };
    } catch (error) {
      write(
        `[${prefix}] cluster auth failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return { error: true } as const;
    }
  };
  const loadPodResume = async (flags: Map<string, string>, bools: Set<string>) => {
    const store = new JsonSessionStore(join(config.configDir, "sessions"));
    const wantsResume = bools.has("resume") || flags.has("resume");
    let resumeRecord: SessionRecord | null = null;
    if (wantsResume) {
      const uid = flags.get("resume");
      resumeRecord = uid ? await store.load(uid) : await store.latest();
      if (!resumeRecord) {
        write(
          uid
            ? `[resume] no session "${uid}"; starting fresh\n`
            : "[resume] no saved sessions yet; starting fresh\n",
        );
      } else {
        write(`[resume] ${resumeRecord.id} — ${resumeRecord.title}\n`);
      }
    }
    return { store, resume: resumeRecord };
  };
  // `run` and `attach` both end in the same local TUI over the pod runtime. The
  // `permissions` broker MUST be the SAME instance handed to the runtime AND the
  // TUI: the pod daemon routes its `session/request_permission` to the runtime's
  // `RemoteClient` (which resolves it through that broker), while the TUI's
  // prompt installs its interactive requester on the broker it is given. Two
  // brokers would silently decouple the two — the daemon's broker (default
  // `allowAll`) auto-approves everything and the TUI prompt is never reached.
  const runPodTui = async (
    runtime: Awaited<ReturnType<typeof startPodRuntime>>,
    permissions: PermissionBroker,
    resumeRecord: SessionRecord | null,
  ): Promise<number> => {
    try {
      await startTui(null, {
        model: config.model,
        cwd: config.cwd,
        contextWindow: config.contextWindow,
        permissions,
        jobs: runtime.jobs,
        autoWakeOnJobExit: config.autoWake,
        createSession: runtime.createSession,
        ...(resumeRecord ? { resumeMessages: resumeRecord.messages } : {}),
      });
    } finally {
      runtime.dispose();
    }
    return 0;
  };

  // `run`: run the agent daemon inside a Kubernetes pod (the sandbox), driven
  // from this local TUI (F4). The image need NOT contain `tentacle` — it
  // is injected over the exec channel at startup (F4.e); it must be a Linux
  // glibc image with `sh` + `head` (musl images cannot run the injected glibc
  // binary). `--namespace` defaults to the kubeconfig context's namespace; a
  // missing namespace fails with a clear error (it is NOT created). `--resume`
  // works because sessions persist on the laptop (the pod is stateless).
  // Cluster auth resolves from the local kubeconfig (current context), or from
  // TENTACLE_K8S_SERVER/_TOKEN as an explicit override (e.g. behind a proxy).
  // No in-process fallback.
  if (args[0] === "run") {
    const { flags: runFlags, bools: runBools, positional: runPos } = parseFlags(args.slice(1));
    const namespace = runFlags.get("namespace") ?? process.env.TENTACLE_POD_NAMESPACE;
    const image = runFlags.get("image") ?? process.env.TENTACLE_POD_IMAGE;
    const binDir = runFlags.get("bin-dir") ?? process.env.TENTACLE_POD_BIN_DIR;
    if (!image) {
      write(
        "[pod] --image <ref> is required (any Linux glibc image with sh+head; tentacle is injected)\n",
      );
      return 1;
    }
    const name = runPos[0];
    const { store, resume: resumeRecord } = await loadPodResume(runFlags, runBools);
    const auth = await loadPodAuth(namespace, "pod");
    if ("error" in auth) {
      return 1;
    }
    const kube = new KubeClient(auth.options);
    // ONE broker shared by the pod runtime and the TUI (see `runPodTui`).
    const permissions = new PermissionBroker();
    let runtime: Awaited<ReturnType<typeof startPodRuntime>>;
    try {
      runtime = await startPodRuntime(config, {
        kube,
        namespace: auth.options.namespace,
        image,
        ...(binDir ? { binDir } : {}),
        ...(name ? { name } : {}),
        permissions,
        store,
        resume: resumeRecord,
        log: write,
      });
    } catch (error) {
      write(`[pod] failed: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    return await runPodTui(runtime, permissions, resumeRecord);
  }

  // `attach`: attach the local TUI to an EXISTING pod (F4, the `run` flow minus
  // the lifecycle): the pod is user-owned, so nothing is created — and
  // NOTHING is deleted on exit (closing the TUI detaches; the pod stays up for
  // reuse). The agent binary is injected only when the pod lacks a working
  // one (a preflight `--version` probe skips the transfer on re-attach); the
  // same image constraints as `run` apply to the injected binary. See
  // `startAttachRuntime` and `docs/pod-exec-attach.md`.
  if (args[0] === "attach") {
    // `-c` is a short alias for `--container` (`parseFlags` only understands
    // long `--` flags), so extract it first: `-c <name>` and `-c=<name>`.
    const rest = args.slice(1);
    let shortContainer: string | undefined;
    const filtered: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === undefined) {
        continue;
      }
      if (arg === "-c") {
        const value = rest[++i];
        if (value === undefined) {
          write("\n[error] -c needs a container name (alias for --container <c>)\n");
          return 1;
        }
        shortContainer = value;
      } else if (arg.startsWith("-c=")) {
        shortContainer = arg.slice(3);
      } else {
        filtered.push(arg);
      }
    }
    const { flags: attachFlags, bools: attachBools, positional: attachPos } = parseFlags(filtered);
    const podName = attachPos[0];
    if (!podName) {
      write(
        "\n[error] usage: tentacle attach <pod> [--namespace <ns>] [--container <c>|-c <c>] [--resume [uid]]\n",
      );
      return 1;
    }
    const namespace = attachFlags.get("namespace") ?? process.env.TENTACLE_POD_NAMESPACE;
    const container = attachFlags.get("container") ?? shortContainer;
    const binDir = attachFlags.get("bin-dir") ?? process.env.TENTACLE_POD_BIN_DIR;
    const { store, resume: resumeRecord } = await loadPodResume(attachFlags, attachBools);
    const auth = await loadPodAuth(namespace, "pod");
    if ("error" in auth) {
      return 1;
    }
    const kube = new KubeClient(auth.options);
    // ONE broker shared by the pod runtime and the TUI (see `runPodTui`).
    const permissions = new PermissionBroker();
    let runtime: Awaited<ReturnType<typeof startAttachRuntime>>;
    try {
      runtime = await startAttachRuntime(config, {
        kube,
        namespace: auth.options.namespace,
        podName,
        ...(container ? { container } : {}),
        ...(binDir ? { binDir } : {}),
        permissions,
        store,
        resume: resumeRecord,
        log: write,
      });
    } catch (error) {
      write(`[pod] failed: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    return await runPodTui(runtime, permissions, resumeRecord);
  }

  // Plain line-based REPL (scripting / no-TTY fallback). No interactive
  // permission prompt here, so the broker stays headless (approves all).
  if (args[0] === "--plain") {
    return await startTerminal(buildAgent(config).agent);
  }

  // Rich interactive TUI. `--resume [uid]` also enters it (resuming a session).
  const { flags: topFlags, bools: topBools } = parseFlags(args);
  const wantsResume = topBools.has("resume") || topFlags.has("resume");
  if (
    args[0] === "-i" ||
    args[0] === "--interactive" ||
    wantsResume ||
    (args.length === 0 && process.stdin.isTTY)
  ) {
    // Sessions persist as JSON under <configDir>/sessions; `--resume` loads one.
    const store = new JsonSessionStore(join(config.configDir, "sessions"));
    let resumeRecord: SessionRecord | null = null;
    if (wantsResume) {
      const uid = topFlags.get("resume");
      resumeRecord = uid ? await store.load(uid) : await store.latest();
      if (!resumeRecord) {
        write(
          uid
            ? `[resume] no session "${uid}"; starting fresh\n`
            : "[resume] no saved sessions yet; starting fresh\n",
        );
      } else {
        write(`[resume] ${resumeRecord.id} — ${resumeRecord.title}\n`);
      }
    }

    // By default the agent runs in a worker thread, off the render thread, so
    // tool execution never janks the UI (MCP tools and live background-job exits
    // work over the RPC boundary too). Opt out with `--in-process` (or
    // `--no-worker`); any worker failure also falls back to in-process.
    const useWorker = !topBools.has("in-process") && !topBools.has("no-worker");
    if (useWorker) {
      const permissions = new PermissionBroker();
      const runtime = await startWorkerRuntime(
        config,
        { permissions, store, resume: resumeRecord },
        write,
      );
      if (runtime) {
        try {
          await startTui(null, {
            model: config.model,
            cwd: config.cwd,
            contextWindow: config.contextWindow,
            permissions,
            jobs: runtime.jobs,
            autoWakeOnJobExit: config.autoWake,
            createSession: runtime.createSession,
            ...(resumeRecord ? { resumeMessages: resumeRecord.messages } : {}),
          });
        } finally {
          runtime.dispose();
        }
        return 0;
      }
      // worker unavailable → fall through to the in-process path below
    }

    const { agent, permissions, jobs, tools } = buildAgent(config);
    const mcp = await connectConfiguredMcp(config, tools);
    for (const [name, message] of Object.entries(mcp.errors)) {
      write(`[mcp] server "${name}" failed to connect: ${message}\n`);
    }

    // A session factory that persists after every turn. The first call resumes
    // (when asked); later ones (e.g. after /clear) start a fresh, new-uid session.
    let seed = resumeRecord;
    const createSession = (): SessionController => {
      const record = seed;
      seed = null;
      const createdAt = record?.createdAt;
      return new Session(agent, record?.id, {
        ...(record ? { messages: record.messages } : {}),
        onPersist: (snapshot) =>
          void store.save(
            recordFromSnapshot(snapshot, {
              cwd: config.cwd,
              model: config.model,
              ...(createdAt !== undefined ? { createdAt } : {}),
            }),
          ),
      });
    };

    try {
      await startTui(agent, {
        model: config.model,
        cwd: config.cwd,
        contextWindow: config.contextWindow,
        permissions,
        jobs,
        autoWakeOnJobExit: config.autoWake,
        createSession,
        ...(resumeRecord ? { resumeMessages: resumeRecord.messages } : {}),
      });
    } finally {
      mcp.dispose();
    }
    return 0;
  }

  if (args.length === 0) {
    write(HELP);
    return 1;
  }

  const { agent, tools } = buildAgent(config);
  const mcp = await connectConfiguredMcp(config, tools);
  for (const [name, message] of Object.entries(mcp.errors)) {
    write(`[mcp] server "${name}" failed to connect: ${message}\n`);
  }
  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.on("SIGINT", onSignal);

  const userMessage: ChatMessage = { role: "user", content: args.join(" ") };
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
