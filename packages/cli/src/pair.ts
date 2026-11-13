/**
 * `tentacle pair` (docs/feat/device-pairing.md 9d): print a QR (and a pasteable
 * line) carrying this computer's key, name, one-time code and reachable
 * addresses; wait for a phone to claim the code; ask the human, showing the
 * compare code; on `y` add the device to the registry.
 *
 * The exchange itself (message 1 … `device/pair` …) is 9c's, in the daemon. This
 * program is the HUMAN's half, and nothing more: it opens the window, watches
 * for the claim, and writes the answer. That split is why the one-time code
 * never leaves the terminal except inside the QR, and why the host's `y` is the
 * only thing that turns a claim into a device (decision 2: "the link addresses,
 * it never authorises").
 *
 * Ordering is load-bearing (F3): the registry entry is written BEFORE the
 * decision file. A `pair` that dies in between still paired the phone — the
 * daemon accepts a claim whose key the registry already holds — while the
 * reverse order would leave a decision with no device behind it.
 *
 * Plain stdout/stderr, never Ink (AGENTS §7: nothing writes raw to a terminal
 * Ink owns — there is no Ink here).
 */
import { hostname as osHostname } from "node:os";
import {
  type DaemonRecord,
  addDevice,
  closePairing,
  loadOrCreateIdentity,
  openPairing,
  readClaim,
  readDaemonRecords,
  writePairingDecision,
} from "@tentacle/daemon";
import {
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  formatPairingPayload,
  normalizePairingCode,
} from "@tentacle/protocol";
import { type Random, formatPairingSas, systemRandom } from "@tentacle/transport/noise";
import { renderUnicodeCompact } from "uqr";
import { type InterfaceEntry, REACHABLE_HINT, pairAddresses } from "./pair-addresses.ts";
import { untrustedText } from "./untrusted-text.ts";
import { isYes } from "./workspace-mount.ts";

/** How often the window is checked for a claim: fast enough to feel instant, cheap enough to leave running. */
export const PAIR_POLL_MS = 250;

export interface PairOptions {
  /** `<configDir>` — the store lives in `<configDir>/devices`. */
  readonly configDir: string;
  /** `--address`, in the order given: appended after the daemon records' own. */
  readonly extraAddresses?: readonly string[];
  /** `--name`: this computer's display name, used when the identity is created. */
  readonly name?: string;
  /** `os.hostname()`; the default computer name. */
  readonly hostname?: string;
  readonly now?: number;
  readonly ttlMs?: number;
  readonly pollMs?: number;
  readonly random?: Random;
  readonly alive?: (pid: number) => boolean;
  readonly interfaces?: readonly InterfaceEntry[];
  /** Draw the QR (a terminal). A pipe gets the pasteable line, which is the point of it. */
  readonly qr?: boolean;
  /** STDOUT: the payload line and the outcome — data, no prose. */
  readonly out: (text: string) => void;
  /** STDERR: instructions, the question, refusals. */
  readonly err: (text: string) => void;
  /** The `[y/N]`, when there is a terminal. Absent = nobody can confirm, so the claim is declined. */
  readonly ask?: (prompt: string) => Promise<string>;
  /** Default: `setTimeout`. */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Register a cleanup for a `pair` that is killed (F2). Main passes a hook on
   * `exit`/SIGINT/SIGTERM; without it the window is closed only on the normal
   * path (a crash then leaves the files, which the pid check and the sweep of
   * both `pair` and the daemon already refuse).
   */
  readonly exitHooks?: (cleanup: () => void) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * A fresh pairing code: 10 Crockford base32 characters (50 bits). Rejection-free
 * because 256 is a multiple of 32 — each byte's low five bits are uniform, so no
 * modulo bias can shrink the code's space below 50 bits (F6).
 */
export function newPairingCode(random: Random): string {
  let code = "";
  while (code.length < PAIRING_CODE_LENGTH) {
    for (const byte of random(PAIRING_CODE_LENGTH)) {
      code += PAIRING_CODE_ALPHABET.charAt(byte & 31);
      if (code.length === PAIRING_CODE_LENGTH) {
        break;
      }
    }
  }
  // `PAIRING_CODE_ALPHABET` is exactly the accepted alphabet, so this cannot
  // fail; asserting it anyway keeps a changed alphabet from shipping silently.
  const canonical = normalizePairingCode(code);
  if (canonical === undefined) {
    throw new Error("pair: the generated code is not a pairing code");
  }
  return canonical;
}

/** What `pair` found to say. Pure, so the wording is testable without a terminal. */
export function pairAddressesOf(
  configDir: string,
  options: Pick<PairOptions, "extraAddresses" | "interfaces" | "alive">,
): ReturnType<typeof pairAddresses> {
  let records: DaemonRecord[];
  try {
    records = readDaemonRecords(configDir, {
      ...(options.alive !== undefined ? { alive: options.alive } : {}),
    });
  } catch {
    records = [];
  }
  return pairAddresses({
    records,
    interfaces: options.interfaces ?? [],
    ...(options.extraAddresses !== undefined ? { extra: options.extraAddresses } : {}),
  });
}

/** The question the human answers. The name is PEER-CHOSEN, so it is untrusted text (F17). */
export function pairPrompt(name: string, sas: string): string {
  return `Add '${untrustedText(name)}'? It must show ${formatPairingSas(sas)}. [y/N] `;
}

/**
 * Run `pair`. Returns the exit code: 0 paired, 1 refused/expired/declined.
 * Every path closes the window it opened.
 */
export async function pairCommand(options: PairOptions): Promise<number> {
  const { configDir, out, err } = options;
  const now = options.now ?? Date.now();
  const random = options.random ?? systemRandom;
  const sleep = options.sleep ?? defaultSleep;
  const alive = options.alive;
  const ttlMs = options.ttlMs;

  const computerName = options.name ?? options.hostname ?? osHostname();
  const identity = loadOrCreateIdentity(configDir, { name: computerName, random, now });
  if (!identity.ok) {
    // F14: never overwritten, never guessed at — the file is named.
    err(`[error] cannot read this computer's identity: ${identity.path}: ${identity.reason}\n`);
    return 1;
  }
  if (options.name !== undefined && identity.identity.name !== options.name) {
    // The name is part of the identity (`identity.json`), written once and only
    // replaced by `devices reset` — silently renaming would hand phones a
    // different computer name than they paired with.
    err(
      `[pair] this computer is already named '${untrustedText(identity.identity.name)}'; --name applies when the identity is created (\`tentacle devices reset\` makes a new one)\n`,
    );
  }

  const found = pairAddressesOf(configDir, {
    ...(options.extraAddresses !== undefined ? { extraAddresses: options.extraAddresses } : {}),
    ...(options.interfaces !== undefined ? { interfaces: options.interfaces } : {}),
    ...(alive !== undefined ? { alive } : {}),
  });
  if (!found.ok) {
    if (found.reason === "invalid") {
      err(
        `[error] not an address a phone can dial (a ws(s) URL ending in /e2e): ${found.invalid
          .map((a) => untrustedText(a))
          .join(", ")}\n`,
      );
    } else {
      err(`[error] too many addresses for one QR code (${found.count}); keep at most 8\n`);
    }
    return 1;
  }
  if (found.addresses.length === 0) {
    err(`[error] ${REACHABLE_HINT}\n`);
    return 1;
  }

  const code = newPairingCode(random);
  const opened = openPairing(configDir, {
    code,
    now,
    random,
    ...(ttlMs !== undefined ? { ttlMs } : {}),
  });
  if (!opened.ok) {
    err(`[error] cannot open a pairing window: ${opened.path}: ${opened.reason}\n`);
    return 1;
  }
  const session = opened.session;
  let closed = false;
  const close = (): void => {
    if (!closed) {
      closed = true;
      closePairing(configDir, session.sid);
    }
  };
  options.exitHooks?.(close);

  try {
    const payload = formatPairingPayload({
      v: 1,
      key: identity.identity.publicKey,
      computer: identity.identity.name,
      code,
      addresses: found.addresses,
    });
    // The QR is the phone's path in; the line below it is the paste form (an
    // app that cannot scan, a terminal that cannot draw).
    if (options.qr) {
      err(`${renderUnicodeCompact(payload)}\n`);
    }
    out(`${payload}\n`);
    err(
      `[pair] scan the code, or paste the line above into the app. It expires in ${Math.round(
        (session.expiresAt - now) / 60_000,
      )} minute(s).\n`,
    );

    const verdict = await waitForClaim(session.sid, session.expiresAt, {
      configDir,
      computerName: identity.identity.name,
      ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
      sleep,
      now: Date.now,
      ...(options.ask !== undefined ? { ask: options.ask } : {}),
      out,
      err,
    });
    return verdict;
  } finally {
    close();
  }
}

/** One claim's outcome, as `pair` reports it. */
type Verdict = 0 | 1;

/**
 * Watch the window until a phone claims it, the human answers, or it expires.
 * The claim file is the daemon's (9c writes it exclusively, taking the key from
 * the channel), so watching the file is watching the handshake's result — this
 * program never parses a frame and needs no second RPC path (§7 "one session
 * path").
 */
async function waitForClaim(
  sid: string,
  expiresAt: number,
  io: {
    readonly configDir: string;
    readonly computerName: string;
    readonly pollMs?: number;
    readonly sleep: (ms: number) => Promise<void>;
    readonly now: () => number;
    readonly ask?: (prompt: string) => Promise<string>;
    readonly out: (text: string) => void;
    readonly err: (text: string) => void;
  },
): Promise<Verdict> {
  const pollMs = io.pollMs ?? PAIR_POLL_MS;
  for (;;) {
    const claim = readClaim(io.configDir, sid);
    if (claim !== undefined) {
      return answerClaim(sid, claim, io);
    }
    if (io.now() >= expiresAt) {
      io.err("[pair] the code expired without being used. Run `tentacle pair` again.\n");
      return 1;
    }
    await io.sleep(pollMs);
  }
}

/** The human's `[y/N]`, then registry FIRST and decision second (F3). */
async function answerClaim(
  sid: string,
  claim: { readonly publicKey: Uint8Array; readonly name: string; readonly sas: string },
  io: {
    readonly configDir: string;
    readonly computerName: string;
    readonly ask?: (prompt: string) => Promise<string>;
    readonly out: (text: string) => void;
    readonly err: (text: string) => void;
  },
): Promise<Verdict> {
  if (io.ask === undefined) {
    // No terminal, no human: a claim is never auto-accepted (decision 2). The
    // answer is written so a waiting daemon stops at once instead of at expiry.
    io.err("[pair] a device is trying to pair, but there is no terminal to confirm it.\n");
    refuse(sid, io.configDir);
    return 1;
  }
  const answer = await io.ask(pairPrompt(claim.name, claim.sas));
  if (!isYes(answer)) {
    io.err("[pair] not added.\n");
    refuse(sid, io.configDir);
    return 1;
  }
  const added = addDevice(io.configDir, { publicKey: claim.publicKey, name: claim.name });
  if (!added.ok) {
    io.err(`[error] cannot write the device registry: ${added.path}: ${added.reason}\n`);
    refuse(sid, io.configDir);
    return 1;
  }
  const decided = writePairingDecision(io.configDir, sid, true);
  if (!decided.ok) {
    // The registry already holds the key, so the phone is paired even if the
    // daemon never reads this (F3). Say so rather than pretending otherwise.
    io.err(`[pair] paired, but the daemon was not told: ${decided.path}: ${decided.reason}\n`);
  }
  io.out(
    `Paired '${untrustedText(added.device.name)}' (${added.device.id}). It can now connect to every tentacle on this computer "${untrustedText(io.computerName)}".\n`,
  );
  return 0;
}

/** Write a `declined` decision, best effort: the daemon also stops at expiry. */
function refuse(sid: string, configDir: string): void {
  writePairingDecision(configDir, sid, false);
}
