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
 *
 * The ONE exception is task 16's APNs auth key: `--apns-key-file` points at the
 * `.p8`, which puts a secret on this host (docs/feat/mobile-push.md C2). It is
 * read once, never logged, and never in argv — the file PATH is, the key is not
 * (AGENTS §7: argv is visible in `ps`).
 */
import { readFileSync } from "node:fs";
import { createApnsClient } from "./apns-client.ts";
import {
  type ApnsKeyConfig,
  createApnsJwtSource,
  decodeApnsKeyPem,
  readApnsKeySource,
} from "./apns.ts";
import { RELAY_LIMITS } from "./relay-core.ts";
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
  /** The four APNs values: `undefined` unless the deployment carries push. */
  readonly apns: {
    readonly keyFile?: string;
    readonly keyId?: string;
    readonly teamId?: string;
    readonly topic?: string;
  };
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
  --max-pushes-per-minute <n>   Pushes per registered daemon per minute (default ${RELAY_LIMITS.pushesPerMinutePerId})
  --max-pushes-per-token-per-minute <n>
                                Pushes to one device token per minute (default ${RELAY_LIMITS.pushesPerMinutePerToken})
  --apns-key-file <path>        The APNs auth key (.p8). All four --apns-* values are
                                required to carry push; without them the relay's ready
                                frame announces no "push" and no daemon sends one
  --apns-key-id <id>            The .p8 key's 10-character id (Apple's console)
  --apns-team-id <id>           The Apple team id
  --apns-topic <bundle-id>      The app's bundle id push goes to (never daemon-supplied)
  -h, --help                    This text

Environment: TENTACLE_RELAY_HOST, TENTACLE_RELAY_PORT,
TENTACLE_RELAY_MAX_DIALS_PER_MINUTE / _MAX_STREAMS_PER_IP / _MAX_STREAMS_PER_ID /
_MAX_IDS / _MAX_HELLOS_PER_MINUTE / _MAX_PUSHES_PER_MINUTE /
_MAX_PUSHES_PER_TOKEN_PER_MINUTE, and TENTACLE_RELAY_APNS_KEY_FILE /
TENTACLE_RELAY_APNS_KEY_ID / TENTACLE_RELAY_APNS_TEAM_ID /
TENTACLE_RELAY_APNS_TOPIC. A flag wins over the environment.

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
  "max-pushes-per-minute": "TENTACLE_RELAY_MAX_PUSHES_PER_MINUTE",
  "max-pushes-per-token-per-minute": "TENTACLE_RELAY_MAX_PUSHES_PER_TOKEN_PER_MINUTE",
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
  const apns: {
    keyFile?: string;
    keyId?: string;
    teamId?: string;
    topic?: string;
  } = {};
  const apnsNames = [
    ["keyFile", "TENTACLE_RELAY_APNS_KEY_FILE"],
    ["keyId", "TENTACLE_RELAY_APNS_KEY_ID"],
    ["teamId", "TENTACLE_RELAY_APNS_TEAM_ID"],
    ["topic", "TENTACLE_RELAY_APNS_TOPIC"],
  ] as const;
  for (const [name, variable] of apnsNames) {
    const raw = env[variable];
    if (raw !== undefined) {
      apns[name] = raw;
    }
  }

  /** The `--apns-*` flag a name maps onto (one table: the parse and `--help` share it). */
  const APNS_FLAGS: Record<keyof typeof apns, string> = {
    keyFile: "--apns-key-file",
    keyId: "--apns-key-id",
    teamId: "--apns-team-id",
    topic: "--apns-topic",
  };

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
    const apnsName = (Object.keys(APNS_FLAGS) as (keyof typeof apns)[]).find(
      (name) => arg === APNS_FLAGS[name],
    );
    if (apnsName !== undefined) {
      const taken = take(i, arg);
      if (typeof taken === "string") {
        return { ok: false, error: taken };
      }
      // A BLANK value means "not set", not a refusal. Deployed through systemd an
      // unset variable is an EMPTY ARGUMENT, never an absent one: `${VAR}` as a
      // word is always exactly one argument, whose value is "" when the variable
      // is unknown (systemd.service(5)). Refusing it would make a drop-in
      // installed a moment before its `EnvironmentFile` — or a rollback that
      // deletes one file — a `Restart=always` crash loop, i.e. every phone off
      // the relay because Apple's key is not where it was. So a blank value is
      // dropped, exactly as an unset variable would be; what remains is a partial
      // set, which `apnsSetupOf` reports with one `push off:` line while the
      // relay keeps serving (F4).
      //
      // A MISSING value (`--apns-key-id` with nothing after it) is still a
      // refusal: that is an operator's typo, indistinguishable from a mistake.
      if (taken.value.trim().length > 0) {
        apns[apnsName] = taken.value;
      }
      i = taken.next;
      continue;
    }
    return { ok: false, error: `unknown argument: ${arg}` };
  }

  return { ok: true, args: { host, port, limits, apns, help } };
}

/** The `--help` text (exported so the test pins it without capturing stdout). */
export function relayUsage(): string {
  return USAGE;
}

/**
 * Turn parsed APNs values into a delivery path, or `undefined` (no push) with
 * one honest log line. Async because importing the `.p8` into a WebCrypto key is.
 *
 * Every failure here is a relay that STARTS WITHOUT PUSH, never one that refuses
 * to start: reachability for the phones must not depend on Apple's key being
 * installed, and `ready.features` is exactly how a daemon learns that push is
 * not available on this relay (F4, Owner Q2).
 */
export async function apnsSetupOf(
  input: RelayArgs["apns"],
  log: (line: string) => void,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): Promise<
  | {
      readonly client: ReturnType<typeof createApnsClient>;
      readonly jwtSource: ReturnType<typeof createApnsJwtSource>;
      readonly topic: string;
    }
  | undefined
> {
  const source = readApnsKeySource({
    ...input,
    readFile,
  });
  if (source.kind === "off") {
    log("push off: no --apns-key-file (ready announces no features)");
    return undefined;
  }
  if (source.kind === "error") {
    // Names WHAT is missing, never a value from the key.
    log(`push off: ${source.error}`);
    return undefined;
  }
  const decoded = decodeApnsKeyPem(source.pem);
  if (decoded.kind === "error") {
    log(`push off: ${decoded.error}`);
    return undefined;
  }
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "pkcs8",
      decoded.der,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  } catch {
    log("push off: the apns key file is not a P-256 PKCS#8 private key");
    return undefined;
  }
  const config: ApnsKeyConfig = source.config;
  const jwtSource = createApnsJwtSource({ config, key, now: () => Date.now() });
  const client = createApnsClient({ topic: config.topic, jwtSource });
  // One line, no key material: the operator confirms push is ON, and nothing else.
  log(`push on: topic ${config.topic} key ${config.keyId}`);
  return { client, jwtSource, topic: config.topic };
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
  const log = (line: string): void => {
    process.stdout.write(`relay ${line}\n`);
  };
  // The key is read once, here, and never again: a rotation is a restart
  // (runbook, P10). An unreadable key means "no push", not "no relay".
  const apns = await apnsSetupOf(parsed.args.apns, log);
  const server = startRelay({
    host: parsed.args.host,
    port: parsed.args.port,
    limits: limitsFromFlags(parsed.args.limits),
    onLog: log,
    ...(apns === undefined ? {} : { apns }),
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
