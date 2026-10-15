/**
 * Best-effort pod deletion that survives `process.exit` — the Ctrl+C / SIGTERM
 * safety net for the pod-execution runtime.
 *
 * The problem: closing the TUI with Ctrl+C makes `terminal.ts` call
 * `process.exit(130)` *before* `startTui` resolves, so the normal teardown
 * (`runtime.dispose()` → async `deletePod`) never runs and the pod is orphaned.
 * `process.exit` still fires `process` `exit` handlers, on **every** exit path
 * (SIGINT / SIGTERM / normal / crash) — so we register one that deletes the pod.
 *
 * The delete is done by a **detached, fire-and-forget child** (`bun -e`):
 *   - it is `detached` + `unref`'d, so it never blocks the parent's exit;
 *   - it does a single `DELETE /pods/<name>` with a client-side timeout — the
 *     apiserver answers immediately (kubelet teardown happens *after* the 200),
 *     so a pod stuck in "Terminating" does not keep the child alive;
 *   - it self-terminates on the timeout if the HTTP call hangs.
 *
 * Secrets (token / TLS material) are passed via env vars, not inlined in the
 * `-e` script string (which is otherwise visible in `ps`). The script itself is
 * static. The child must be the real `bun` on PATH — a compiled `agent-harness`
 * binary cannot re-execute itself as a script runtime, and the `run` flow
 * already requires `bun` to be available on the laptop (it is what builds the
 * injected pod binary).
 */

/** TLS material for the delete call (mirrors Bun's fetch/WebSocket `tls`). */
export interface PodTls {
  readonly ca?: string;
  readonly cert?: string;
  readonly key?: string;
  readonly rejectUnauthorized?: boolean;
}

/** Everything the deleter child needs to issue one `DELETE /pods/<name>`. */
export interface PodDeleteOptions {
  readonly server: string;
  readonly namespace: string;
  readonly podName: string;
  readonly token?: string;
  readonly tls?: PodTls;
}

/** The options object handed to `Bun.spawn` (kept narrow for testability). */
export interface PodDeleteSpawnOptions {
  readonly detached: true;
  readonly stdio: ["ignore", "ignore", "ignore"];
}

/** A spawned child we only need to `unref`. */
export interface PodDeleteChild {
  unref(): void;
}

/**
 * Injectable spawner so tests can assert on the exact command / env / options
 * without launching a real child. Defaults to `Bun.spawn`.
 */
export type PodDeleteSpawner = (
  cmd: string[],
  env: Record<string, string>,
  options: PodDeleteSpawnOptions,
) => PodDeleteChild;

/**
 * Build the static `bun -e` script the deleter child runs. It reads its
 * configuration from `HARNESS_POD_DELETE_*` / `HARNESS_POD_TLS_*` env vars and
 * performs a single best-effort `DELETE`, swallowing all errors and exiting.
 * No secrets are embedded in the string.
 */
export function buildPodDeleteScript(): string {
  return `
    const url = process.env.HARNESS_POD_DELETE_URL;
    if (!url) process.exit(0);
    const headers = {};
    const token = process.env.HARNESS_POD_DELETE_TOKEN;
    if (token) headers.authorization = "Bearer " + token;
    const tls = {};
    if (process.env.HARNESS_POD_TLS_CA) tls.ca = process.env.HARNESS_POD_TLS_CA;
    if (process.env.HARNESS_POD_TLS_CERT) tls.cert = process.env.HARNESS_POD_TLS_CERT;
    if (process.env.HARNESS_POD_TLS_KEY) tls.key = process.env.HARNESS_POD_TLS_KEY;
    if (process.env.HARNESS_POD_TLS_INSECURE === "1") tls.rejectUnauthorized = false;
    const init = { method: "DELETE", headers };
    if (Object.keys(tls).length > 0) init.tls = tls;
    init.signal = AbortSignal.timeout(5000);
    fetch(url, init).catch(() => {}).finally(() => process.exit(0));
  `.trim();
}

/**
 * Spawn the detached deleter child. Never throws: a failure to spawn (e.g. no
 * `bun` on PATH) is swallowed — the safety net must not break the exit.
 */
export function spawnPodDelete(
  options: PodDeleteOptions,
  spawn: PodDeleteSpawner = (cmd, env, spawnOptions) => Bun.spawn(cmd, { env, ...spawnOptions }),
): void {
  try {
    const server = options.server.replace(/\/+$/, "");
    const url =
      `${server}/api/v1/namespaces/${encodeURIComponent(options.namespace)}` +
      `/pods/${encodeURIComponent(options.podName)}`;

    // Carry the parent's full environment (PATH etc.) plus the delete config.
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
    env.HARNESS_POD_DELETE_URL = url;
    if (options.token) {
      env.HARNESS_POD_DELETE_TOKEN = options.token;
    }
    const tls = options.tls;
    if (tls?.ca) {
      env.HARNESS_POD_TLS_CA = tls.ca;
    }
    if (tls?.cert) {
      env.HARNESS_POD_TLS_CERT = tls.cert;
    }
    if (tls?.key) {
      env.HARNESS_POD_TLS_KEY = tls.key;
    }
    if (tls?.rejectUnauthorized === false) {
      env.HARNESS_POD_TLS_INSECURE = "1";
    }

    const child = spawn(["bun", "-e", buildPodDeleteScript()], env, {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.unref();
  } catch {
    // best-effort — a spawn failure must never break the exit.
  }
}
