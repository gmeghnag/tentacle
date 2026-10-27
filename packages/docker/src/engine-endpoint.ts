/**
 * Pure resolution of WHICH Docker/Podman engine to talk to, mirroring the
 * docker CLI's precedence: an explicit context > `DOCKER_HOST` >
 * `DOCKER_CONTEXT` > `currentContext` in `<configDir>/config.json` > the
 * `default` context. The filesystem is injected (`readFile`), so every rule is
 * unit-testable without a real `~/.docker`.
 *
 * Security rules (docs/eval/docker-runtime.md, owner answer 6): a plaintext
 * `tcp://` API — or TLS that does not verify the server (`SkipTLSVerify`) — is
 * unauthenticated root on that server, so it is refused unless the caller opts
 * in (`allowInsecureTcp`, the `--insecure-docker-tcp` flag of slice C).
 */
import { createHash } from "node:crypto";

/** TLS material (PEM contents, not paths) plus the directory it came from (for errors). */
export interface EngineTls {
  readonly ca?: string;
  readonly cert?: string;
  readonly key?: string;
  readonly dir: string;
}

export type EngineEndpoint =
  | { readonly kind: "unix"; readonly path: string; readonly local: true; readonly source: string }
  | {
      readonly kind: "tcp";
      readonly host: string;
      readonly port: number;
      readonly tls?: EngineTls;
      /** Opted-in: plaintext, or TLS without server verification. */
      readonly insecure?: true;
      readonly local: false;
      readonly source: string;
    }
  | {
      readonly kind: "ssh";
      readonly host: string;
      readonly user?: string;
      readonly port?: number;
      readonly local: false;
      readonly source: string;
    };

export interface ResolveEndpointInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** An explicit context name (`--context`, slice C). Wins over everything. */
  readonly context?: string;
  /** Accept plaintext tcp / SkipTLSVerify (`--insecure-docker-tcp`). */
  readonly allowInsecureTcp?: boolean;
  /** Override the docker config dir (else `DOCKER_CONFIG` ?? `<home>/.docker`). */
  readonly configDir?: string;
  /** Home directory fallback when `env.HOME` is unset. */
  readonly homeDir?: string;
  /** Read a file's text; `undefined` when it does not exist. */
  readonly readFile: (path: string) => string | undefined;
}

export const DEFAULT_UNIX_SOCKET = "/var/run/docker.sock";

/** `<configDir>/contexts/{meta,tls}/<sha256hex(name)>` — the docker CLI's context store key. */
export function contextStoreKey(name: string): string {
  return createHash("sha256").update(name).digest("hex");
}

function join(dir: string, ...parts: string[]): string {
  return [dir.replace(/\/+$/, ""), ...parts].join("/");
}

/** Resolve the engine endpoint, or throw an actionable `Error`. */
export function resolveEngineEndpoint(input: ResolveEndpointInput): EngineEndpoint {
  const { env } = input;
  const home = env.HOME ?? input.homeDir ?? "";
  const configDir = input.configDir ?? nonEmpty(env.DOCKER_CONFIG) ?? join(home, ".docker");

  const named = (name: string, source: string): EngineEndpoint =>
    name === "default"
      ? defaultContext(input, configDir)
      : contextEndpoint(input, configDir, name, source);

  if (input.context !== undefined) {
    return named(input.context, `context "${input.context}"`);
  }
  const host = nonEmpty(env.DOCKER_HOST);
  if (host !== undefined) {
    return hostEndpoint(input, host, "DOCKER_HOST", envTls(input, configDir));
  }
  const envContext = nonEmpty(env.DOCKER_CONTEXT);
  if (envContext !== undefined) {
    return named(envContext, `context "${envContext}" (DOCKER_CONTEXT)`);
  }
  const current = readCurrentContext(input, configDir);
  if (current !== undefined) {
    return named(current, `context "${current}"`);
  }
  return defaultContext(input, configDir);
}

/**
 * One host URL (`unix://`, `tcp://`, `ssh://`) → an endpoint, with the same
 * rules as `DOCKER_HOST` but no TLS material: podman's `CONTAINER_HOST`
 * (`podman-endpoint.ts`). `source` names it in errors.
 */
export function resolveHostEndpoint(
  host: string,
  source: string,
  options: { readonly allowInsecureTcp?: boolean } = {},
): EngineEndpoint {
  const input: ResolveEndpointInput = {
    env: {},
    readFile: () => undefined,
    ...(options.allowInsecureTcp !== undefined
      ? { allowInsecureTcp: options.allowInsecureTcp }
      : {}),
  };
  return hostEndpoint(input, host, source, { tls: undefined, skipVerify: false });
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

/** The `default` context: `DOCKER_HOST`, else the standard unix socket. */
function defaultContext(input: ResolveEndpointInput, configDir: string): EngineEndpoint {
  const host = nonEmpty(input.env.DOCKER_HOST);
  if (host !== undefined) {
    return hostEndpoint(input, host, "DOCKER_HOST", envTls(input, configDir));
  }
  return { kind: "unix", path: DEFAULT_UNIX_SOCKET, local: true, source: 'context "default"' };
}

function readCurrentContext(input: ResolveEndpointInput, configDir: string): string | undefined {
  const path = join(configDir, "config.json");
  const text = input.readFile(path);
  if (text === undefined) {
    return undefined;
  }
  let parsed: { currentContext?: unknown };
  try {
    parsed = JSON.parse(text) as { currentContext?: unknown };
  } catch {
    throw new Error(`cannot parse ${path}: not valid JSON`);
  }
  return typeof parsed.currentContext === "string" ? nonEmpty(parsed.currentContext) : undefined;
}

type TlsChoice = { readonly tls: EngineTls | undefined; readonly skipVerify: boolean };

/** `DOCKER_TLS_VERIFY` (non-empty) ⇒ TLS with material from `DOCKER_CERT_PATH` ?? configDir. */
function envTls(input: ResolveEndpointInput, configDir: string): TlsChoice {
  if (nonEmpty(input.env.DOCKER_TLS_VERIFY) === undefined) {
    return { tls: undefined, skipVerify: false };
  }
  const dir = nonEmpty(input.env.DOCKER_CERT_PATH) ?? configDir;
  return { tls: loadTls(input, dir, "DOCKER_TLS_VERIFY", true), skipVerify: false };
}

/**
 * Read `ca.pem`/`cert.pem`/`key.pem` from `dir`. `required`: TLS was asked for,
 * so a dir with none of them is a misconfiguration (named in the error). A lone
 * `ca.pem` (server auth only) is fine; a cert without its key (or vice versa) is not.
 */
function loadTls(
  input: ResolveEndpointInput,
  dir: string,
  source: string,
  required: boolean,
): EngineTls | undefined {
  const ca = input.readFile(join(dir, "ca.pem"));
  const cert = input.readFile(join(dir, "cert.pem"));
  const key = input.readFile(join(dir, "key.pem"));
  if (ca === undefined && cert === undefined && key === undefined) {
    if (required) {
      throw new Error(
        `TLS is enabled (${source}) but ${dir} has none of ca.pem, cert.pem, key.pem — set DOCKER_CERT_PATH to the directory holding them`,
      );
    }
    return undefined;
  }
  if ((cert === undefined) !== (key === undefined)) {
    throw new Error(
      `TLS client certificate in ${dir} is incomplete: ${cert === undefined ? "cert.pem" : "key.pem"} is missing`,
    );
  }
  return {
    dir,
    ...(ca !== undefined ? { ca } : {}),
    ...(cert !== undefined ? { cert } : {}),
    ...(key !== undefined ? { key } : {}),
  };
}

function contextEndpoint(
  input: ResolveEndpointInput,
  configDir: string,
  name: string,
  source: string,
): EngineEndpoint {
  const keyDir = contextStoreKey(name);
  const metaPath = join(configDir, "contexts", "meta", keyDir, "meta.json");
  const text = input.readFile(metaPath);
  if (text === undefined) {
    throw new Error(
      `docker context "${name}" not found (looked in ${join(configDir, "contexts", "meta")}) — list them with \`docker context ls\``,
    );
  }
  let meta: { Endpoints?: { docker?: { Host?: unknown; SkipTLSVerify?: unknown } } };
  try {
    meta = JSON.parse(text) as typeof meta;
  } catch {
    throw new Error(`cannot parse ${metaPath}: not valid JSON`);
  }
  const docker = meta.Endpoints?.docker;
  if (typeof docker?.Host !== "string" || docker.Host === "") {
    throw new Error(`docker context "${name}" has no docker endpoint (${metaPath})`);
  }
  const tlsDir = join(configDir, "contexts", "tls", keyDir, "docker");
  const tls = loadTls(input, tlsDir, source, false);
  return hostEndpoint(input, docker.Host, source, {
    tls,
    skipVerify: docker.SkipTLSVerify === true,
  });
}

function hostEndpoint(
  input: ResolveEndpointInput,
  host: string,
  source: string,
  tlsChoice: TlsChoice,
): EngineEndpoint {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(host)?.[1]?.toLowerCase();
  switch (scheme) {
    case "unix": {
      const path = host.slice("unix://".length);
      if (!path.startsWith("/")) {
        throw new Error(
          `invalid Docker host ${host} (${source}): a unix socket path must be absolute`,
        );
      }
      return { kind: "unix", path, local: true, source };
    }
    case "tcp":
      return tcpEndpoint(input, host, source, tlsChoice);
    case "ssh":
      return sshEndpoint(host, source);
    default:
      throw new Error(
        `unsupported Docker host scheme in ${host} (${source}): use unix://, tcp:// (TLS) or ssh://`,
      );
  }
}

function tcpEndpoint(
  input: ResolveEndpointInput,
  host: string,
  source: string,
  { tls, skipVerify }: TlsChoice,
): EngineEndpoint {
  let url: { readonly hostname: string; readonly port: string };
  try {
    url = new URL(host);
  } catch {
    throw new Error(`invalid Docker host ${host} (${source})`);
  }
  if (url.hostname === "") {
    throw new Error(`invalid Docker host ${host} (${source}): no host name`);
  }
  const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1");
  const port = url.port === "" ? (tls ? 2376 : 2375) : Number(url.port);
  const verified = tls !== undefined && !skipVerify;
  if (!verified && !input.allowInsecureTcp) {
    const what = tls
      ? `TLS without server verification (SkipTLSVerify) to ${hostname}:${port}`
      : `plaintext tcp://${hostname}:${port}`;
    throw new Error(
      `refusing ${what} (${source}): an unauthenticated Docker API is root on that server. Use TLS (tcp://${hostname}:2376 + DOCKER_TLS_VERIFY=1 and DOCKER_CERT_PATH with ca.pem/cert.pem/key.pem) or ssh://user@${hostname} — or force it with --insecure-docker-tcp`,
    );
  }
  return {
    kind: "tcp",
    host: hostname,
    port,
    ...(tls ? { tls } : {}),
    ...(verified ? {} : { insecure: true as const }),
    local: false,
    source,
  };
}

/** Reject what could become an ssh option or break argv (A2 runs `ssh … -- <host>`). */
function unsafeSshToken(token: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control chars are exactly what we refuse
  return token.startsWith("-") || /[\s\u0000-\u001f\u007f]/.test(token);
}

function sshEndpoint(host: string, source: string): EngineEndpoint {
  const rest = host.slice("ssh://".length);
  const invalid = (why: string): Error =>
    new Error(`invalid ssh Docker host ${JSON.stringify(host)} (${source}): ${why}`);
  if (rest.includes("/") || rest.includes("?") || rest.includes("#")) {
    throw invalid("a path is not supported (use ssh://[user@]host[:port])");
  }
  const at = rest.lastIndexOf("@");
  const user = at === -1 ? undefined : rest.slice(0, at);
  const hostPort = at === -1 ? rest : rest.slice(at + 1);
  const portMatch = /^(.*):(\d+)$/.exec(hostPort);
  const hostname = (portMatch ? (portMatch[1] ?? "") : hostPort).replace(/^\[(.*)\]$/, "$1");
  if (hostname === "") {
    throw invalid("no host name");
  }
  if (unsafeSshToken(hostname) || (user !== undefined && (user === "" || unsafeSshToken(user)))) {
    throw invalid("user and host must not start with '-' or contain whitespace/control characters");
  }
  const port = portMatch ? Number(portMatch[2]) : undefined;
  if (port !== undefined && (port < 1 || port > 65535)) {
    throw invalid("port out of range");
  }
  return {
    kind: "ssh",
    host: hostname,
    ...(user !== undefined ? { user } : {}),
    ...(port !== undefined ? { port } : {}),
    local: false,
    source,
  };
}

/** A short human label for an endpoint (`unix:///p`, `tcp://h:2376 (TLS)`, `ssh://u@h`). */
export function endpointLabel(ep: EngineEndpoint): string {
  switch (ep.kind) {
    case "unix":
      return `unix://${ep.path}`;
    case "tcp":
      return `tcp://${ep.host}:${ep.port}${ep.tls && !ep.insecure ? " (TLS)" : ""}`;
    case "ssh":
      return `ssh://${ep.user ? `${ep.user}@` : ""}${ep.host}${ep.port ? `:${ep.port}` : ""}`;
  }
}
