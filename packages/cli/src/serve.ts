/**
 * `agent-harness serve` — host the daemon. Reuses `loadConfig()` for the model,
 * confined cwd and system prompt, and builds a fresh confined agent per session.
 * Binding is loopback-safe by default (a non-loopback bind requires a token).
 */
import type { HarnessConfig } from "@agent-harness/config";
import { type RunningServer, SessionHost, startWsServer } from "@agent-harness/daemon";
import { buildAgent } from "./wiring.ts";

export interface ServeOptions {
  readonly host: string;
  readonly port: number;
  readonly token?: string;
  readonly tls?: { readonly cert: string; readonly key: string };
  readonly onAudit?: (line: string) => void;
  readonly onError?: (error: Error) => void;
}

export function startDaemon(config: HarnessConfig, options: ServeOptions): RunningServer {
  const sessionHost = new SessionHost({
    defaultCwd: config.cwd,
    // Each session gets its own agent, confined to the daemon's cwd.
    createAgent: (cwd) => buildAgent({ ...config, cwd }),
  });
  return startWsServer({
    host: options.host,
    port: options.port,
    sessionHost,
    ...(options.token ? { token: options.token } : {}),
    ...(options.tls ? { tls: options.tls } : {}),
    ...(options.onAudit ? { onAudit: options.onAudit } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
  });
}
