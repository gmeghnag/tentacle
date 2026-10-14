/**
 * Self-contained kubeconfig parsing (F4.a.2) — no `kubectl`/`oc`.
 *
 * `parseKubeconfig` turns the YAML into a typed object; `resolveContext` reduces
 * it to the current (or named) context's connection: server URL, namespace, the
 * cluster CA, and the user's credential (bearer token, client cert/key, or an
 * exec credential plugin to run). Both are **pure** — base64 `-data` fields are
 * decoded here, but file-path fields (`certificate-authority`, `tokenFile`, …)
 * and exec plugins are left for the I/O layer (`kube-auth.ts`) to materialise.
 */
import { parse as parseYaml } from "yaml";

export interface KubeNamedCluster {
  name: string;
  cluster?: {
    server?: string;
    "certificate-authority"?: string;
    "certificate-authority-data"?: string;
    "insecure-skip-tls-verify"?: boolean;
  };
}
export interface KubeExecConfig {
  command: string;
  args?: string[];
  env?: Array<{ name: string; value: string }>;
  apiVersion?: string;
}
export interface KubeNamedUser {
  name: string;
  user?: {
    token?: string;
    tokenFile?: string;
    "client-certificate"?: string;
    "client-certificate-data"?: string;
    "client-key"?: string;
    "client-key-data"?: string;
    exec?: KubeExecConfig;
  };
}
export interface KubeNamedContext {
  name: string;
  context?: { cluster?: string; user?: string; namespace?: string };
}
export interface Kubeconfig {
  clusters?: KubeNamedCluster[];
  users?: KubeNamedUser[];
  contexts?: KubeNamedContext[];
  "current-context"?: string;
}

/** A PEM blob either inline (`data`) or at a file path (`file`), not yet read. */
export interface PemSource {
  data?: string;
  file?: string;
}

/** The connection a resolved context describes, before any file/exec I/O. */
export interface ResolvedContext {
  server: string;
  namespace: string;
  insecureSkipTlsVerify: boolean;
  ca?: PemSource;
  /** Bearer token, inline or in a file. */
  token?: PemSource;
  clientCert?: PemSource;
  clientKey?: PemSource;
  exec?: KubeExecConfig;
}

export interface ResolveOptions {
  /** Use this context instead of `current-context`. */
  readonly context?: string;
  /** Override the context's namespace. */
  readonly namespace?: string;
}

export function parseKubeconfig(text: string): Kubeconfig {
  const value = parseYaml(text);
  if (value === null || typeof value !== "object") {
    throw new Error("kubeconfig is empty or not a mapping");
  }
  return value as Kubeconfig;
}

/** base64 `-data` → PEM string, or a file path → `{ file }`; undefined if neither. */
function pem(data: string | undefined, file: string | undefined): PemSource | undefined {
  if (data !== undefined) {
    return { data: Buffer.from(data, "base64").toString("utf8") };
  }
  if (file !== undefined) {
    return { file };
  }
  return undefined;
}

/**
 * Reduce a kubeconfig to a single context's connection. Throws a clear error if
 * the context / cluster / user is missing or the server URL is absent.
 */
export function resolveContext(config: Kubeconfig, options: ResolveOptions = {}): ResolvedContext {
  const contextName = options.context ?? config["current-context"];
  if (!contextName) {
    throw new Error("kubeconfig has no current-context and none was requested");
  }
  const context = config.contexts?.find((c) => c.name === contextName)?.context;
  if (!context) {
    throw new Error(`kubeconfig has no context "${contextName}"`);
  }
  const cluster = config.clusters?.find((c) => c.name === context.cluster)?.cluster;
  if (!cluster?.server) {
    throw new Error(`kubeconfig cluster "${context.cluster ?? "?"}" has no server`);
  }
  const user = config.users?.find((u) => u.name === context.user)?.user ?? {};

  const token = user.token
    ? { data: user.token }
    : user.tokenFile
      ? { file: user.tokenFile }
      : undefined;

  const resolved: ResolvedContext = {
    server: cluster.server.replace(/\/+$/, ""),
    namespace: options.namespace ?? context.namespace ?? "default",
    insecureSkipTlsVerify: cluster["insecure-skip-tls-verify"] === true,
  };
  const ca = pem(cluster["certificate-authority-data"], cluster["certificate-authority"]);
  const clientCert = pem(user["client-certificate-data"], user["client-certificate"]);
  const clientKey = pem(user["client-key-data"], user["client-key"]);
  if (ca) {
    resolved.ca = ca;
  }
  if (token) {
    resolved.token = token;
  }
  if (clientCert) {
    resolved.clientCert = clientCert;
  }
  if (clientKey) {
    resolved.clientKey = clientKey;
  }
  if (user.exec) {
    resolved.exec = user.exec;
  }
  return resolved;
}
