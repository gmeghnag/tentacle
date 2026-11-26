/**
 * `connect <name>`: a paired laptop drives a `serve` the way a paired phone does
 * (docs/feat/connect-via-relay.md). This module adds a TRANSPORT (`deviceDial`)
 * and the pairing and address bookkeeping around it, nothing else: `connectTui`
 * builds the same `RemoteClient` and the one broker over it (AGENTS §7).
 */
import { hostname as osHostname } from "node:os";
import {
  ChannelError,
  type DialMemory,
  type FirstAnsweringOptions,
  type RemoteClient,
  firstAnswering,
  mergeAddresses,
  webSocketCarrierFactory,
} from "@tentacle/client";
import { PAIRING_OPEN_DEADLINE_MS, PairingRefused, pairDevice } from "@tentacle/client/pairing";
import { secureChannelFactory } from "@tentacle/client/secure-channel";
import {
  type DaemonDiscovery,
  PAIRING_COMPUTER_NAME_MAX,
  type PairingRefusal,
  decodeBase64Url,
  encodeBase64Url,
  isPairingName,
  parsePairingPayload,
} from "@tentacle/protocol";
import type { ByteCarrier, DuplexChannel } from "@tentacle/transport";
import {
  type Random,
  formatPairingSas,
  generateStaticKeypair,
  systemRandom,
} from "@tentacle/transport/noise";
import { type KeyStores, dropKey, loadKey, storeKey } from "./connect-keys.ts";
import {
  type ComputerRecord,
  createRecord,
  forgetRecord,
  listRecordNames,
  readRecord,
  writeRecord,
} from "./connect-store.ts";
import { type ConnectDeps, type ConnectOptions, connectTui } from "./connect.ts";

type Carrier = (address: string) => () => Promise<ByteCarrier>;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// ── routing ────────────────────────────────────────────────────────────────

export type ConnectRoute =
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "device"; readonly name: string }
  | { readonly kind: "pair"; readonly payload: string }
  | { readonly kind: "forget"; readonly name: string }
  | { readonly kind: "error"; readonly message: string };

/** The token path's flags: a paired computer takes none of them. */
const TOKEN_FLAGS = ["token", "token-command", "ca-cert", "insecure-skip-tls-verify"] as const;

/** What `connect`'s parsed arguments ask for (D8). Pure. */
export function routeConnect(parsed: {
  readonly positional: readonly string[];
  readonly flags: ReadonlyMap<string, string>;
  readonly bools: ReadonlySet<string>;
}): ConnectRoute {
  const { positional, flags, bools } = parsed;
  const given = [...flags.keys(), ...bools];
  for (const kind of ["pair", "forget"] as const) {
    const value = flags.get(kind);
    if (value === undefined) {
      continue;
    }
    if (positional.length > 0 || given.length > 1) {
      return { kind: "error", message: `--${kind} takes no name and no other flag` };
    }
    return kind === "pair" ? { kind, payload: value } : { kind, name: value };
  }
  const target = positional[0] ?? "";
  if (target === "") {
    return {
      kind: "error",
      message: "missing argument: a ws(s):// URL or a paired computer's name",
    };
  }
  if (/^wss?:\/\//i.test(target)) {
    return { kind: "url", url: target };
  }
  const refused = TOKEN_FLAGS.find((flag) => given.includes(flag));
  if (refused !== undefined) {
    return {
      kind: "error",
      message: `--${refused} does not apply to a paired computer: the pairing key replaces it`,
    };
  }
  return { kind: "device", name: target };
}

// ── dialling ───────────────────────────────────────────────────────────────

/** The relay's device route: `<relay>/d/<id>/e2e`. */
function isRelayAddress(address: string): boolean {
  return /\/d\/[^/]+\/e2e(\?.*)?$/.test(address);
}

export interface DeviceDialDeps {
  /** Opens a raw carrier to one address (default: Bun's WebSocket). */
  readonly carrier?: Carrier;
  readonly random?: Random;
  /** The race's own seams (a test's timer). */
  readonly race?: FirstAnsweringOptions;
  /** The address a successful dial won on. Must not throw. */
  readonly onAnswered?: (address: string) => void;
}

/**
 * The channel factory for a paired computer: the phone's staggered race over the
 * record's addresses ("direct first, relay last" is their order), and the Noise
 * initiator over the winner, pinned to the computer key. A redial is a fresh
 * race and a fresh handshake.
 */
export function deviceDial(
  record: ComputerRecord,
  deviceKey: Uint8Array,
  deps: DeviceDialDeps = {},
): () => Promise<DuplexChannel> {
  const carrier: Carrier = deps.carrier ?? ((address) => webSocketCarrierFactory(address));
  const remoteStatic = decodeBase64Url(record.computerKey) ?? new Uint8Array(0);
  // A remembered DIRECT address starts the race. A remembered relay one does
  // not: the relay answers from anywhere, so starting there would keep a laptop
  // that is back on the LAN on the relay for good.
  const last = record.lastAddress;
  const remembered =
    last === undefined || isRelayAddress(last) ? -1 : record.addresses.indexOf(last);
  const memory: DialMemory = { lastGood: remembered < 0 ? undefined : remembered };
  return async () => {
    const channel = await firstAnswering<ByteCarrier, DuplexChannel>(
      record.addresses,
      {
        open: (address) => carrier(address)(),
        abandon: (raw) => raw.close(),
        confirm: (raw) =>
          secureChannelFactory(async () => raw, {
            staticKey: deviceKey,
            remoteStatic,
            random: deps.random ?? systemRandom,
          })(),
      },
      memory,
      // Bounds the OPEN only: without it a hanging TCP connect would hold the
      // first dial (before the TUI) for the system's own timeout.
      { openDeadlineMs: PAIRING_OPEN_DEADLINE_MS, ...deps.race },
    );
    const winner = memory.lastGood === undefined ? undefined : record.addresses[memory.lastGood];
    if (winner !== undefined) {
      deps.onAnswered?.(winner);
    }
    return channel;
  };
}

/** A pre-TUI dial failure as one line that says what to do (F6-F8, F10). */
export function deviceConnectError(error: unknown, record: ComputerRecord): Error {
  if (!(error instanceof ChannelError)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  const hint =
    error.kind === "unauthorized"
      ? `this laptop's key was refused (revoked?) — pair again with \`tentacle connect --pair\` (\`tentacle devices\` on the host lists what is paired)`
      : error.remoteE2eVersion !== undefined
        ? "the two sides speak different channel versions — update tentacle on the older one"
        : "no address answered — is `serve` running there? (computer key changed? pair again)";
  return new ChannelError(
    error.kind,
    `${record.name}: ${hint} [${error.message}]`,
    error.closeCode,
    error.remoteE2eVersion,
  );
}

// ── the address refresh ────────────────────────────────────────────────────

/**
 * The record after a `daemon/discover` announcement (D9), or `undefined` when
 * nothing changes: only the daemon that answered (`self`), only for the
 * record's project, merged by the shared rule (`mergeAddresses`: announced
 * first, known ones kept). Pure.
 */
export function foldDiscovery(
  record: ComputerRecord,
  discovery: DaemonDiscovery | undefined,
  now: number,
): ComputerRecord | undefined {
  const self = discovery?.daemons.find((daemon) => daemon.self === true);
  if (discovery === undefined || self === undefined) {
    return undefined;
  }
  if (record.project !== undefined && record.project.cwd !== self.cwd) {
    return undefined;
  }
  // The record keeps no per-address stamps, so none expires here.
  const merged = mergeAddresses(
    [{ cwd: self.cwd, addresses: record.addresses, lastSeenAt: now, startedAt: 0 }],
    { rev: discovery.rev, daemons: [self] },
    now,
  ).projects[0];
  const addresses = [...(merged?.addresses ?? [])];
  const changed =
    addresses.length > 0 &&
    (addresses.length !== record.addresses.length ||
      addresses.some((address, i) => address !== record.addresses[i]));
  const label = self.cwd.split("/").filter(Boolean).pop() ?? "";
  const adopted =
    record.project === undefined && isPairingName(label) ? { cwd: self.cwd, label } : undefined;
  if (!changed && adopted === undefined) {
    return undefined;
  }
  const { lastAddress, ...rest } = record;
  const next = changed ? addresses : record.addresses;
  return {
    ...rest,
    addresses: next,
    ...(lastAddress !== undefined && next.includes(lastAddress) ? { lastAddress } : {}),
    ...(adopted === undefined ? {} : { project: adopted }),
  };
}

/**
 * Keeps one record fresh while connected: the winning address and what the
 * daemon announces. Best effort, never throws; a failure is reported through
 * the sink `onClient` hands over (held until then).
 */
export function recordKeeper(
  configDir: string,
  record: ComputerRecord,
  now: () => number = Date.now,
): {
  readonly answered: (address: string) => void;
  readonly onClient: (client: RemoteClient, report: (error: Error) => void) => void;
} {
  let current = record;
  let report: ((error: Error) => void) | undefined;
  const held: Error[] = [];
  const fail = (what: string, error: unknown): void => {
    const failure = new Error(`${what}: ${messageOf(error)}`);
    if (report === undefined) {
      held.push(failure);
    } else {
      report(failure);
    }
  };
  const save = (next: ComputerRecord): void => {
    try {
      writeRecord(configDir, next);
      current = next;
    } catch (error) {
      fail(`could not update the saved record for '${record.name}'`, error);
    }
  };
  const fold = (discovery: DaemonDiscovery | undefined): void => {
    const next = foldDiscovery(current, discovery, now());
    if (next !== undefined) {
      save(next);
    }
  };
  return {
    answered: (address) => {
      if (current.lastAddress !== address) {
        save({ ...current, lastAddress: address });
      }
    },
    onClient: (client, sink) => {
      report = sink;
      for (const error of held.splice(0)) {
        sink(error);
      }
      client.discover(fold).then(fold, (error: unknown) => {
        fail("could not ask the daemon for its addresses", error);
      });
    },
  };
}

// ── the commands ───────────────────────────────────────────────────────────

function unknownName(configDir: string, name: string): Error {
  const known = listRecordNames(configDir);
  return new Error(
    `no paired computer named '${name}' — ${
      known.length > 0
        ? `paired: ${known.join(", ")}`
        : "none yet: run `tentacle pair` on the host, then `tentacle connect --pair '<line>'`"
    }`,
  );
}

/** `connect <name>`: `connectTui` over the paired computer's device dial. */
export async function connectComputer(
  name: string,
  options: Pick<ConnectOptions, "resume">,
  deps: {
    readonly configDir: string;
    readonly keys: KeyStores;
    readonly write: (line: string) => void;
    readonly startTui: ConnectDeps["startTui"];
    readonly pick?: ConnectDeps["pick"];
  },
): Promise<void> {
  const read = readRecord(deps.configDir, name);
  if (!read.ok) {
    throw read.kind === "missing"
      ? unknownName(deps.configDir, name)
      : new Error(`${read.path}: ${read.reason} — left untouched`);
  }
  const { record } = read;
  const key = await loadKey(deps.keys, record);
  const keeper = recordKeeper(deps.configDir, record);
  try {
    await connectTui(
      // `url` is display text only on this path: the cwd line and the resume hint.
      { url: record.name, configDir: deps.configDir, ...options },
      deps.write,
      {
        dial: () => deviceDial(record, key, { onAnswered: keeper.answered }),
        startTui: deps.startTui,
        onClient: keeper.onClient,
        ...(deps.pick === undefined ? {} : { pick: deps.pick }),
      },
    );
  } catch (error) {
    throw deviceConnectError(error, record);
  }
}

/** `connect --forget <name>` (D7). Forgetting here revokes nothing on the host: say how. */
export async function forgetComputer(
  name: string,
  deps: {
    readonly configDir: string;
    readonly keys: KeyStores;
    readonly write: (line: string) => void;
  },
): Promise<void> {
  const record = await forgetRecord(deps.configDir, name, async (gone) => {
    try {
      await dropKey(deps.keys, gone.keyStore, gone.id);
    } catch (error) {
      deps.write(`[connect] the key was not removed (${gone.keyStore}): ${messageOf(error)}\n`);
    }
  });
  if (record === undefined) {
    throw unknownName(deps.configDir, name);
  }
  deps.write(
    `forgot '${record.name}'. The computer still accepts that key until you revoke it there: tentacle devices revoke ${record.deviceId}\n`,
  );
}

// ── pairing ────────────────────────────────────────────────────────────────

/** The name the host is asked to confirm (D4). */
export function deviceName(hostname: () => string = osHostname): string {
  const name = hostname().trim().slice(0, PAIRING_COMPUTER_NAME_MAX);
  return isPairingName(name) ? name : "laptop";
}

function payloadProblem(reason: PairingRefusal): string {
  switch (reason) {
    case "prefix":
      return "that is not a pairing line (it starts with tentacle://pair?)";
    case "version":
      return "this pairing line is from another tentacle version — update the older side";
    case "no_address":
      return "the pairing line carries no address to dial";
    default:
      return `the pairing line is damaged (${reason}) — copy it again`;
  }
}

export interface PairLaptopDeps {
  readonly configDir: string;
  readonly keys: KeyStores;
  readonly write: (line: string) => void;
  readonly random?: Random;
  readonly hostname?: () => string;
  /** The exchange itself (default: `pairDevice`, the phone's). */
  readonly pair?: typeof pairDevice;
  readonly dial?: Carrier;
}

/**
 * `connect --pair`: a fresh key, stored FIRST; then the exchange (the host's
 * `y` after the compare code); then the record. No crash can leave a record
 * without a key; a failure removes the key (F3, F4).
 */
export async function pairLaptop(
  payloadText: string,
  deps: PairLaptopDeps,
): Promise<ComputerRecord> {
  const parsed = parsePairingPayload(payloadText);
  if (!parsed.ok) {
    throw new Error(payloadProblem(parsed.reason));
  }
  const { payload } = parsed;
  const random = deps.random ?? systemRandom;
  const key = generateStaticKeypair(random).privateKey;
  const id = Buffer.from(random(16)).toString("hex");
  const keyStore = await storeKey(deps.keys, id, key, deps.write);
  // Best effort: an orphan key is harmless, the first failure is the one to report.
  const discard = (): Promise<void> => dropKey(deps.keys, keyStore, id).catch(() => {});

  let paired: Awaited<ReturnType<typeof pairDevice>>;
  try {
    paired = await (deps.pair ?? pairDevice)({
      payload,
      deviceKey: key,
      name: deviceName(deps.hostname),
      dial: deps.dial ?? ((address) => webSocketCarrierFactory(address)),
      random,
      // A record is per project, and a current daemon refuses a pair without it.
      perProject: true,
      onCompare: (sas) => {
        deps.write(
          `[connect] compare code ${formatPairingSas(sas)} — check the computer shows the same, then answer y there\n`,
        );
      },
    });
  } catch (error) {
    await discard();
    if (error instanceof PairingRefused || !(error instanceof ChannelError)) {
      throw error;
    }
    throw new Error(
      error.kind === "unauthorized"
        ? `the computer refused the connection — is \`tentacle pair\` still open there? [${error.message}]`
        : `can't pair: ${error.message} — is \`serve\` running there?`,
    );
  }

  let record: ComputerRecord;
  try {
    record = createRecord(
      deps.configDir,
      {
        id,
        computer: paired.computer.name,
        computerKey: encodeBase64Url(payload.key),
        deviceId: paired.deviceId,
        ...(paired.project === undefined
          ? {}
          : { project: { cwd: paired.project.cwd, label: paired.project.label } }),
        addresses: [...payload.addresses],
        keyStore,
      },
      paired.project?.label ?? payload.computer,
    );
  } catch (error) {
    await discard();
    throw new Error(
      `paired on the host but not saved here — revoke it there: tentacle devices revoke ${paired.deviceId} (${messageOf(error)})`,
    );
  }
  deps.write(`paired as '${record.name}' — connect with: tentacle connect ${record.name}\n`);
  return record;
}
