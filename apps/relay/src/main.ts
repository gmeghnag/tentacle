import { RELAY_LIMITS } from "./relay-core.ts";
/**
 * `tentacle-relay` — the mobile relay service's entry point
 * (docs/feat/mobile-relay.md R2; deployed in R7). Flags and env only: every
 * decision lives in `relay-core.ts` (pure) and every socket in `server.ts`.
 *
 *   bun apps/relay/src/main.ts --port 4100
 *   TENTACLE_RELAY_PORT=4100 bun apps/relay/src/main.ts
 *
 * No secret, no config file, no persistence (Owner Q4): the relay is a stateless
 * splicer, so a restart costs every daemon one jittered re-registration (F3).
 */
import {
  DEFAULT_RELAY_HOST,
  DEFAULT_RELAY_PORT,
  RELAY_LIMIT_FLAGS,
  type RelayLimitFlag,
  limitsFromFlags,
  startRelay,
} from "./server.ts";

export interface RelayArgs {
  readonly host: string;
  readonly port: number;
  readonly limits: Partial<Record<RelayLimitFlag, number>>;
  readonly help: boolean;
}

/** What a flag name maps onto (the `--help` text and the parse share this). */
const USAGE = `tentacle-relay — the mobile relay (docs/feat/mobile-relay.md)

Usage: tentacle-relay [options]

  --host <host>                 Bind address (default ${DEFAULT_RELAY_HOST}; put a TLS
                                proxy in front — the relay speaks ws:// only)
  --port <port>                 Bind port (default ${DEFAULT_RELAY_PORT})
  --max-dials-per-minute <n>    Phone dials per source address per minute (default ${RELAY_LIMITS.dialsPerMinutePerIp})
  --max-streams-per-ip <n>      Concurrent phone sockets per source address (default ${RELAY_LIMITS.concurrentPerIp})
  --max-streams-per-id <n>      Concurrent phone streams per daemon id (default ${RELAY_LIMITS.streamsPerId})
  --max-ids <n>                 Registered daemons (default ${RELAY_LIMITS.registeredIds})
  --max-hellos-per-minute <n>   Registrations per source address per minute (default ${RELAY_LIMITS.hellosPerMinutePerIp})
  -h, --help                    This text

Environment: TENTACLE_RELAY_HOST, TENTACLE_RELAY_PORT, and
TENTACLE_RELAY_MAX_DIALS_PER_MINUTE / _MAX_STREAMS_PER_IP / _MAX_STREAMS_PER_ID /
_MAX_IDS / _MAX_HELLOS_PER_MINUTE. A flag wins over the environment.

The relay carries ciphertext and authorises nobody: it cannot read a session,
impersonate a computer or make a daemon record false state. What it can always do
is refuse service and observe metadata (id, address, sizes, timing).`;

/** The flag ↔ limit mapping: one table, so a name cannot drift from its limit. */
const LIMIT_ENV: Record<RelayLimitFlag, string> = {
  "max-dials-per-minute": "TENTACLE_RELAY_MAX_DIALS_PER_MINUTE",
  "max-streams-per-ip": "TENTACLE_RELAY_MAX_STREAMS_PER_IP",
  "max-streams-per-id": "TENTACLE_RELAY_MAX_STREAMS_PER_ID",
  "max-ids": "TENTACLE_RELAY_MAX_IDS",
  "max-hellos-per-minute": "TENTACLE_RELAY_MAX_HELLOS_PER_MINUTE",
};

/** A positive integer, or `undefined` — the only shape any of these numbers may take. */
function positiveInt(value: string): number | undefined {
  if (!/^[0-9]+$/.test(value.trim())) {
    return undefined;
  }
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Parse argv and env (pure: `main.ts` runs it, a test asserts it). An invalid
 * value is a REFUSAL (`error`), never a silently ignored flag: a limit that did
 * not apply is worse than a relay that did not start.
 */
export function parseRelayArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = {},
): { ok: true; args: RelayArgs } | { ok: false; error: string } {
  const limits: Partial<Record<RelayLimitFlag, number>> = {};
  for (const flag of RELAY_LIMIT_FLAGS) {
    const raw = env[LIMIT_ENV[flag]];
    if (raw !== undefined) {
      const parsed = positiveInt(raw);
      if (parsed === undefined) {
        return { ok: false, error: `${LIMIT_ENV[flag]} must be a positive integer` };
      }
      limits[flag] = parsed;
    }
  }

  let host = env.TENTACLE_RELAY_HOST ?? DEFAULT_RELAY_HOST;
  let port = DEFAULT_RELAY_PORT;
  if (env.TENTACLE_RELAY_PORT !== undefined) {
    const parsed = positiveInt(env.TENTACLE_RELAY_PORT);
    if (parsed === undefined || parsed > 65_535) {
      return { ok: false, error: "TENTACLE_RELAY_PORT must be a port number" };
    }
    port = parsed;
  }
  let help = false;

  const take = (index: number, flag: string): { value: string; next: number } | string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return `${flag} needs a value`;
    }
    return { value, next: index + 2 };
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i] ?? "";
    if (arg === "--help" || arg === "-h") {
      help = true;
      i += 1;
      continue;
    }
    if (arg === "--host") {
      const taken = take(i, arg);
      if (typeof taken === "string") {
        return { ok: false, error: taken };
      }
      if (taken.value.trim().length === 0) {
        return { ok: false, error: "--host needs a value" };
      }
      host = taken.value;
      i = taken.next;
      continue;
    }
    if (arg === "--port") {
      const taken = take(i, arg);
      if (typeof taken === "string") {
        return { ok: false, error: taken };
      }
      const parsed = positiveInt(taken.value);
      if (parsed === undefined || parsed > 65_535) {
        return { ok: false, error: "--port must be a port number" };
      }
      port = parsed;
      i = taken.next;
      continue;
    }
    const limit = RELAY_LIMIT_FLAGS.find((flag) => arg === `--${flag}`);
    if (limit !== undefined) {
      const taken = take(i, arg);
      if (typeof taken === "string") {
        return { ok: false, error: taken };
      }
      const parsed = positiveInt(taken.value);
      if (parsed === undefined) {
        return { ok: false, error: `${arg} must be a positive integer` };
      }
      limits[limit] = parsed;
      i = taken.next;
      continue;
    }
    return { ok: false, error: `unknown argument: ${arg}` };
  }

  return { ok: true, args: { host, port, limits, help } };
}

/** The `--help` text (exported so the test pins it without capturing stdout). */
export function relayUsage(): string {
  return USAGE;
}

if (import.meta.main) {
  const parsed = parseRelayArgs(Bun.argv.slice(2), process.env);
  if (!parsed.ok) {
    process.stderr.write(`tentacle-relay: ${parsed.error}\n\n${USAGE}\n`);
    process.exit(1);
  }
  if (parsed.args.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  const server = startRelay({
    host: parsed.args.host,
    port: parsed.args.port,
    limits: limitsFromFlags(parsed.args.limits),
    onLog: (line) => process.stdout.write(`relay ${line}\n`),
  });
  process.stdout.write(
    `relay listening on ws://${parsed.args.host}:${server.port} (relay protocol v1)\n`,
  );
  const shutdown = (): void => {
    server.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
