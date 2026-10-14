#!/usr/bin/env bun
import { join } from "node:path";
/**
 * CLI entry point (F1).
 *
 *   agent-harness                 → interactive TUI (when stdin is a TTY)
 *   agent-harness <prompt...>     → one-shot run
 *   agent-harness --help          → usage
 *
 * Configuration is layered (env > ~/.config/agent-harness/config.jsonc >
 * defaults); see `@agent-harness/config`. The config dir + PROMPT.md are
 * scaffolded on first run.
 *
 * NOTE: F1 auto-approves tool calls; the interactive permission engine arrives
 * in F4. Until then, point the CLI at a trusted model and workspace.
 */
import {
  JsonSessionStore,
  Session,
  type SessionRecord,
  recordFromSnapshot,
} from "@agent-harness/agent";
import { type ChatMessage, PermissionBroker } from "@agent-harness/core";
import { type SessionController, startTui } from "@agent-harness/tui";
import { type HarnessConfig, loadConfig } from "./config.ts";
import { connectTui } from "./connect.ts";
import { parseFlags, resolveToken } from "./flags.ts";
import { startWorkerRuntime } from "./local-runtime.ts";
import { render } from "./render.ts";
import { startDaemon } from "./serve.ts";
import { startTerminal } from "./terminal.ts";
import { buildAgent, connectConfiguredMcp } from "./wiring.ts";

const HELP = `agent-harness — run an agent task

Usage:
  agent-harness                 start the rich interactive TUI (when stdin is a TTY)
  agent-harness -i              force the interactive TUI
  agent-harness --plain         plain line-based REPL (for pipes / no TTY)
  agent-harness --resume [uid]  resume a saved session (latest if no uid) in the TUI
  agent-harness -i --in-process run the agent on the render thread (opt out of the worker)
  agent-harness <prompt...>     run a single task and exit
  agent-harness serve [opts]    host the remote-control daemon
  agent-harness connect <url>   drive a remote daemon with the TUI
  agent-harness --help          show this help

Remote control:
  agent-harness serve [--host 127.0.0.1] [--port 4000] [--token T|--token-command CMD]
                      [--tls-cert FILE --tls-key FILE]
  agent-harness connect ws(s)://host:port [--token T|--token-command CMD]
  A non-loopback --host requires a token (remote code execution risk).
  Token env fallback: HARNESS_REMOTE_TOKEN.

Configuration (precedence: env > config file > defaults):
  ~/.config/agent-harness/config.jsonc   settings (scaffolded on first run)
  ~/.config/agent-harness/PROMPT.md       default system prompt

Environment:
  HARNESS_CONFIG_DIR       override the config directory
  HARNESS_MODEL_BASE_URL   OpenAI-compatible base URL
  HARNESS_MODEL            model id
  HARNESS_MODEL_API_KEY    bearer token (overrides config apiKey/apiKeyCommand)
  HARNESS_SYSTEM_PROMPT    inline system prompt (overrides PROMPT.md)
  HARNESS_MAX_ITERATIONS   max model/tool iterations per turn
  HARNESS_CWD              working directory for tools
  HARNESS_SUBAGENTS        enable/disable sub-agents (on/off, default on)
`;

export interface CliIO {
  write?: (text: string) => void;
}

export async function main(argv: readonly string[], io: CliIO = {}): Promise<number> {
  const write = io.write ?? ((text: string) => void process.stdout.write(text));

  const args = argv.slice(2);
  if (args[0] === "--help" || args[0] === "-h") {
    write(HELP);
    return 0;
  }

  // `connect` drives a remote daemon; it needs no local model configuration.
  if (args[0] === "connect") {
    const { positional, flags } = parseFlags(args.slice(1));
    const url = positional[0];
    if (!url) {
      write("\n[error] usage: agent-harness connect ws(s)://host:port [--token T]\n");
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
  let config: HarnessConfig;
  try {
    config = await loadConfig({ cwd: process.cwd() });
  } catch (error) {
    write(`\n[config error] ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  // Host the remote-control daemon and run until interrupted.
  if (args[0] === "serve") {
    const { flags } = parseFlags(args.slice(1));
    let token: string | undefined;
    try {
      token = await resolveToken(flags);
    } catch (error) {
      write(`\n[serve error] ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    const host = flags.get("host") ?? process.env.HARNESS_REMOTE_HOST ?? "127.0.0.1";
    const port = Number(flags.get("port") ?? process.env.HARNESS_REMOTE_PORT ?? "4000");
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
