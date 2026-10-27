/**
 * The I/O half of kubeconfig resolution (F4.a.2): read the file, materialise
 * file-path and exec-plugin credentials, and assemble `KubeClientOptions` whose
 * `fetch` and `makeWebSocket` carry the cluster TLS material (CA + optional
 * client cert/key) via Bun's per-call `tls` option — so the client trusts a
 * self-signed cluster CA and does mTLS without any global state or `kubectl`.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { KubeClientOptions } from "./client.ts";
import type { WebSocketLike } from "./exec-channel.ts";
import {
  type KubeExecConfig,
  type PemSource,
  type ResolveOptions,
  parseKubeconfig,
  resolveContext,
} from "./kubeconfig.ts";

/** Bun extends fetch/WebSocket with a `tls` option; typed locally. */
interface BunTls {
  ca?: string;
  cert?: string;
  key?: string;
  rejectUnauthorized?: boolean;
}
type BunFetchInit = RequestInit & { tls?: BunTls };
type BunWebSocketCtor = new (
  url: string,
  options: { protocols?: string[]; tls?: BunTls },
) => WebSocketLike;

export interface LoadKubeOptions extends ResolveOptions {
  /** Explicit kubeconfig path (else `$KUBECONFIG`, else `~/.kube/config`). */
  readonly path?: string;
}

/** Read a PEM source: inline data, or the contents of its file. */
function readPem(source: PemSource | undefined): string | undefined {
  if (source?.data !== undefined) {
    return source.data;
  }
  if (source?.file !== undefined) {
    return readFileSync(source.file, "utf8");
  }
  return undefined;
}

/** The subset of a kubectl `ExecCredential` status we consume. */
interface ExecCredentialStatus {
  token?: string;
  clientCertificateData?: string;
  clientKeyData?: string;
}

/** Run an exec credential plugin and return the token / client cert it yields. */
function runExecPlugin(exec: KubeExecConfig): ExecCredentialStatus {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const entry of exec.env ?? []) {
    env[entry.name] = entry.value;
  }
  const proc = Bun.spawnSync([exec.command, ...(exec.args ?? [])], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!proc.success) {
    const stderr = proc.stderr.toString("utf8").trim();
    throw new Error(`exec credential plugin "${exec.command}" failed: ${stderr || "(no stderr)"}`);
  }
  const parsed = JSON.parse(proc.stdout.toString("utf8")) as { status?: ExecCredentialStatus };
  return parsed.status ?? {};
}

function defaultKubeconfigPath(): string {
  const fromEnv = process.env.KUBECONFIG;
  if (fromEnv && fromEnv.length > 0) {
    // KUBECONFIG may be a path list; the first entry wins for our purposes.
    return fromEnv.split(":")[0] as string;
  }
  return join(homedir(), ".kube", "config");
}

/**
 * The kubeconfig's `current-context` name (`tentacle ps` records WHICH context a
 * kept pod was created through); `undefined` when there is none or the file
 * cannot be read or parsed.
 */
export function currentKubeContext(path: string = defaultKubeconfigPath()): string | undefined {
  try {
    return parseKubeconfig(readFileSync(path, "utf8"))["current-context"] || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve `KubeClientOptions` from a kubeconfig. Supports CA trust, bearer
 * tokens (inline/file), client-cert mTLS, and exec credential plugins. Throws a
 * clear error for anything missing or unreadable.
 */
export function loadKubeClientOptions(options: LoadKubeOptions = {}): KubeClientOptions {
  const path = options.path ?? defaultKubeconfigPath();
  const resolveOpts: ResolveOptions = {
    ...(options.context ? { context: options.context } : {}),
    ...(options.namespace ? { namespace: options.namespace } : {}),
  };
  const ctx = resolveContext(parseKubeconfig(readFileSync(path, "utf8")), resolveOpts);

  const ca = readPem(ctx.ca);
  let cert = readPem(ctx.clientCert);
  let key = readPem(ctx.clientKey);
  let token = ctx.token ? readPem(ctx.token)?.trim() : undefined;

  if (ctx.exec) {
    const status = runExecPlugin(ctx.exec);
    if (status.token) {
      token = status.token;
    }
    if (status.clientCertificateData) {
      cert = Buffer.from(status.clientCertificateData, "base64").toString("utf8");
    }
    if (status.clientKeyData) {
      key = Buffer.from(status.clientKeyData, "base64").toString("utf8");
    }
  }

  const tls: BunTls = {};
  if (ca) {
    tls.ca = ca;
  }
  if (cert) {
    tls.cert = cert;
  }
  if (key) {
    tls.key = key;
  }
  if (ctx.insecureSkipTlsVerify) {
    tls.rejectUnauthorized = false;
  }
  const hasTls = Object.keys(tls).length > 0;

  const doFetch: typeof fetch = (input, init) => {
    const merged: BunFetchInit = { ...init, ...(hasTls ? { tls } : {}) };
    return fetch(input as string, merged);
  };
  const WS = WebSocket as unknown as BunWebSocketCtor;
  const makeWebSocket = (url: string, protocols: string[]): WebSocketLike =>
    new WS(url, { protocols, ...(hasTls ? { tls } : {}) });

  return {
    server: ctx.server,
    namespace: ctx.namespace,
    ...(token ? { token } : {}),
    // The delete-on-exit child process needs the TLS material explicitly (the
    // async `fetch` below already bakes it in, but the child does its own call).
    ...(hasTls ? { tls } : {}),
    fetch: doFetch,
    makeWebSocket,
  };
}
