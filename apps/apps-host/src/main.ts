/**
 * The apps host's entry point (docs/feat/session-apps-host.md; the runbook is
 * `docs/ops/apps-host-deploy.md`). Argument parsing is pure; an invalid value
 * is a refusal to start.
 */
import { parseStatusPort } from "@tentacle/relay/status";
import { APPS_LIMITS, APPS_LIMIT_NAMES, type AppsLimits, limitEnv, limitFlag } from "./limits.ts";
import { DEFAULT_APPS_HOST, DEFAULT_APPS_PORT, fileReader, startAppsHost } from "./server.ts";
import { createFsStore } from "./store.ts";

export const DEFAULT_DATA_DIR = "/var/lib/tentacle-apps";
export const DEFAULT_OPERATOR_DIR = "/etc/tentacle-apps";
/** The loopback status listener's port in the deployed binary (never proxied). */
export const DEFAULT_APPS_STATUS_PORT = 4201;

export interface AppsHostArgs {
  readonly host: string;
  readonly port: number;
  readonly domain: string;
  readonly abuseEmail: string;
  readonly termsUrl: string;
  readonly dataDir: string;
  readonly operatorDir: string;
  readonly trustProxy: boolean;
  readonly limits: Partial<AppsLimits>;
  /** The loopback status listener's port; `undefined` = `off`. */
  readonly statusPort: number | undefined;
  readonly help: boolean;
}

const VALUE_FLAGS = {
  "--host": "TENTACLE_APPS_HOST",
  "--port": "TENTACLE_APPS_PORT",
  "--domain": "TENTACLE_APPS_DOMAIN",
  "--abuse-email": "TENTACLE_APPS_ABUSE_EMAIL",
  "--terms-url": "TENTACLE_APPS_TERMS_URL",
  "--data-dir": "TENTACLE_APPS_DATA_DIR",
  "--operator-dir": "TENTACLE_APPS_OPERATOR_DIR",
  "--status-port": "TENTACLE_APPS_STATUS_PORT",
} as const;

type ValueFlag = keyof typeof VALUE_FLAGS;

const USAGE = `tentacle-apps-host: serves the apps tentacle sessions publish, one per <id>.<domain>.

Required:
  --domain <name>             The apps domain (e.g. apps.tentacle.so)
  --abuse-email <address>     Shown on the warning and report pages
  --terms-url <url>           The terms page (http or https)

Options:
  --host <host>               Bind address (default ${DEFAULT_APPS_HOST}; keep it loopback, with a
                              TLS proxy in front)
  --port <port>               Bind port (default ${DEFAULT_APPS_PORT})
  --trust-proxy               Key the limits on the client address in X-Forwarded-For,
                              read ONLY from a loopback peer. Required behind Caddy
  --data-dir <path>           Records, content, reports (default ${DEFAULT_DATA_DIR})
  --operator-dir <path>       kill-switch and takedowns (default ${DEFAULT_OPERATOR_DIR})
  --status-port <port|off>    GET /__status (aggregate counters, no ids) on 127.0.0.1
                              only, whatever --host says (default ${DEFAULT_APPS_STATUS_PORT}). Never
                              proxy it. Must differ from --port
  -h, --help                  This text

Limits (each a positive integer):
${APPS_LIMIT_NAMES.map((name) => `  --${limitFlag(name)} <n> (default ${APPS_LIMITS[name]})`).join("\n")}

Environment: ${Object.values(VALUE_FLAGS).join(", ")},
TENTACLE_APPS_TRUST_PROXY (1/true/0/false), and TENTACLE_APPS_<LIMIT> for each
limit (e.g. ${limitEnv("maxAppBytes")}). A flag wins over the environment.`;

export function appsHostUsage(): string {
  return USAGE;
}

function positiveInt(value: string): number | undefined {
  if (!/^[0-9]+$/.test(value.trim())) {
    return undefined;
  }
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

const DOMAIN = /^(?=.{1,200}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

type Parsed = { ok: true; args: AppsHostArgs } | { ok: false; error: string };

/** Parse argv and env (pure). */
export function parseAppsHostArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = {},
): Parsed {
  const refuse = (error: string): Parsed => ({ ok: false, error });
  /** Each value with the name it came from, for the refusal. */
  const values = new Map<ValueFlag, { value: string; from: string }>();
  const limits: { -readonly [K in keyof AppsLimits]?: number } = {};
  let help = false;
  let trustProxy = false;

  for (const [flag, variable] of Object.entries(VALUE_FLAGS) as [ValueFlag, string][]) {
    const raw = env[variable];
    if (raw !== undefined) {
      values.set(flag, { value: raw, from: variable });
    }
  }
  for (const name of APPS_LIMIT_NAMES) {
    const raw = env[limitEnv(name)];
    if (raw !== undefined) {
      const parsed = positiveInt(raw);
      if (parsed === undefined) {
        return refuse(`${limitEnv(name)} must be a positive integer`);
      }
      limits[name] = parsed;
    }
  }
  const proxy = env.TENTACLE_APPS_TRUST_PROXY?.trim().toLowerCase();
  if (proxy !== undefined) {
    if (!["1", "true", "0", "false"].includes(proxy)) {
      return refuse("TENTACLE_APPS_TRUST_PROXY must be 1, true, 0 or false");
    }
    trustProxy = proxy === "1" || proxy === "true";
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--trust-proxy") {
      trustProxy = true;
      continue;
    }
    const limit = APPS_LIMIT_NAMES.find((name) => arg === `--${limitFlag(name)}`);
    if (limit === undefined && !(arg in VALUE_FLAGS)) {
      return refuse(`unknown argument: ${arg}`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return refuse(`${arg} needs a value`);
    }
    i += 1;
    if (limit === undefined) {
      values.set(arg as ValueFlag, { value, from: arg });
      continue;
    }
    const parsed = positiveInt(value);
    if (parsed === undefined) {
      return refuse(`${arg} must be a positive integer`);
    }
    limits[limit] = parsed;
  }

  const take = (flag: ValueFlag, fallback: string): string =>
    values.get(flag)?.value.trim() ?? fallback;
  const host = take("--host", DEFAULT_APPS_HOST);
  const domain = take("--domain", "").toLowerCase();
  const abuseEmail = take("--abuse-email", "");
  const termsUrl = take("--terms-url", "");
  const dataDir = take("--data-dir", DEFAULT_DATA_DIR);
  const operatorDir = take("--operator-dir", DEFAULT_OPERATOR_DIR);
  const rawPort = take("--port", String(DEFAULT_APPS_PORT));
  const port = positiveInt(rawPort);
  if (port === undefined || port > 65_535) {
    return refuse(`${values.get("--port")?.from} must be a port number`);
  }
  const parsedStatus = parseStatusPort(take("--status-port", String(DEFAULT_APPS_STATUS_PORT)));
  if (parsedStatus === undefined) {
    return refuse(`${values.get("--status-port")?.from} must be a port number or off`);
  }
  const statusPort = parsedStatus === "off" ? undefined : parsedStatus;
  if (statusPort === port) {
    return refuse("--status-port must differ from --port");
  }
  for (const { value, from } of values.values()) {
    if (value.trim() === "") {
      return refuse(`${from} needs a value`);
    }
  }
  if (!help) {
    for (const flag of ["--domain", "--abuse-email", "--terms-url"] as const) {
      if (!values.has(flag)) {
        return refuse(`${flag} is required (or ${VALUE_FLAGS[flag]})`);
      }
    }
    if (!DOMAIN.test(domain)) {
      return refuse("--domain must be a bare domain name, like apps.example.com");
    }
    if (!/^[^\s@]+@[^\s@]+$/.test(abuseEmail)) {
      return refuse("--abuse-email must be an e-mail address");
    }
    if (!isHttpUrl(termsUrl)) {
      return refuse("--terms-url must be an http(s) URL");
    }
  }
  return {
    ok: true,
    args: {
      host,
      port,
      domain,
      abuseEmail,
      termsUrl,
      dataDir,
      operatorDir,
      trustProxy,
      limits,
      statusPort,
      help,
    },
  };
}

if (import.meta.main) {
  const parsed = parseAppsHostArgs(Bun.argv.slice(2), process.env);
  if (!parsed.ok) {
    process.stderr.write(`tentacle-apps-host: ${parsed.error}\n\n${USAGE}\n`);
    process.exit(1);
  }
  const { args } = parsed;
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  const log = (line: string): void => {
    process.stdout.write(`apps-host ${line}\n`);
  };
  const server = await startAppsHost({
    host: args.host,
    port: args.port,
    domain: args.domain,
    abuseEmail: args.abuseEmail,
    termsUrl: args.termsUrl,
    trustProxy: args.trustProxy,
    limits: args.limits,
    store: createFsStore(args.dataDir),
    readOperatorFile: fileReader(args.operatorDir),
    onLog: log,
    ...(args.statusPort === undefined ? {} : { statusPort: args.statusPort }),
  });
  log(`start http://${args.host}:${server.port} domain ${args.domain} (apps API v1)`);
  if (server.statusPort !== undefined) {
    log(`status on http://127.0.0.1:${server.statusPort}/__status`);
  }
  const shutdown = (): void => {
    void server.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
