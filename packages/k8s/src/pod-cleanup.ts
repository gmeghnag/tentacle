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
 * The delete is done by a **detached, fire-and-forget child**:
 *   - it is `detached` + `unref`'d, so it never blocks the parent's exit;
 *   - it does a single `DELETE /pods/<name>` with a client-side timeout — the
 *     apiserver answers immediately (kubelet teardown happens *after* the 200),
 *     so a pod stuck in "Terminating" does not keep the child alive;
 *   - it self-terminates on the timeout if the HTTP call hangs.
 *
 * The child command adapts to how the parent is running (`podDeleteCommand`):
 *   - from a **compiled binary**, it re-executes THE SAME binary with the hidden
 *     `__delete-pod` subcommand (`deletePodFromEnv`) — no external `bun` needed,
 *     so a distributed standalone binary cleans up even on a host without Bun;
 *   - from **source** (`process.execPath` is `bun`), it runs `bun -e <script>`.
 *
 * Secrets (token / TLS material) are passed via env vars, never inlined in the
 * command line (which is visible in `ps`). Both paths read the same
 * `HARNESS_POD_DELETE_*` / `HARNESS_POD_TLS_*` env.
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
 * The runtime counterpart of `buildPodDeleteScript`: issue the single
 * best-effort `DELETE` from the current process, reading its configuration from
 * the same `HARNESS_POD_DELETE_*` / `HARNESS_POD_TLS_*` env vars. This is what
 * the compiled binary's hidden `__delete-pod` subcommand runs, so the deleter
 * child needs no external `bun`. Never throws; resolves once the call settles.
 */
export async function deletePodFromEnv(fetchImpl: typeof fetch = fetch): Promise<void> {
  const url = process.env.HARNESS_POD_DELETE_URL;
  if (!url) {
    return;
  }
  const headers: Record<string, string> = {};
  const token = process.env.HARNESS_POD_DELETE_TOKEN;
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  const tls: Record<string, string | boolean> = {};
  if (process.env.HARNESS_POD_TLS_CA) {
    tls.ca = process.env.HARNESS_POD_TLS_CA;
  }
  if (process.env.HARNESS_POD_TLS_CERT) {
    tls.cert = process.env.HARNESS_POD_TLS_CERT;
  }
  if (process.env.HARNESS_POD_TLS_KEY) {
    tls.key = process.env.HARNESS_POD_TLS_KEY;
  }
  if (process.env.HARNESS_POD_TLS_INSECURE === "1") {
    tls.rejectUnauthorized = false;
  }
  const init: RequestInit & { tls?: Record<string, string | boolean> } = {
    method: "DELETE",
    headers,
    signal: AbortSignal.timeout(5000),
  };
  if (Object.keys(tls).length > 0) {
    init.tls = tls;
  }
  try {
    await fetchImpl(url, init as RequestInit);
  } catch {
    // best-effort — a network error must never surface.
  }
}

/**
 * The command the detached deleter child runs, chosen by how THIS process is
 * running. From a compiled binary (`execPath` is not `bun`) → re-exec the same
 * binary with the hidden `__delete-pod` subcommand, so no external `bun` is
 * required. From source (`execPath` is `bun`) → `bun -e <script>`.
 */
export function podDeleteCommand(execPath: string): string[] {
  const base = execPath.replace(/\\/g, "/").split("/").pop() ?? "";
  const isBun = base === "bun" || base.startsWith("bun-");
  return isBun ? ["bun", "-e", buildPodDeleteScript()] : [execPath, "__delete-pod"];
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

    const child = spawn(podDeleteCommand(process.execPath), env, {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.unref();
  } catch {
    // best-effort — a spawn failure must never break the exit.
  }
}
