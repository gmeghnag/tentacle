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
import { resolve } from "node:path";
import { projectKey } from "@tentacle/agent";
import {
  type AddDeviceResult,
  type DaemonRecord,
  type DeviceProjectRef,
  type DeviceStoreFailure,
  addDevice,
  closePairing,
  loadOrCreateIdentity,
  openPairing,
  projectLabel,
  readClaim,
  readDaemonRecords,
  sweepDeadDaemonRecords,
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
import { DEFAULT_STALE_AFTER_MS } from "./discovery.ts";
import {
  type InterfaceEntry,
  REACHABLE_HINT,
  machineInterfaces,
  pairAddresses,
} from "./pair-addresses.ts";
import { untrustedText } from "./untrusted-text.ts";
import { isYes } from "./workspace-mount.ts";

/** How often the window is checked for a claim: fast enough to feel instant, cheap enough to leave running. */
export const PAIR_POLL_MS = 250;

export interface PairOptions {
  /** `<configDir>` — the store lives in `<configDir>/devices`. */
  readonly configDir: string;
  /**
   * The project to pair (docs/feat/mobile-projects.md §5, Owner Q6): `--project
   * <dir>`, else the folder `pair` runs in. The phone gets THAT folder's live
   * `serve` only; with none running there, `pair` refuses.
   */
  readonly projectDir?: string;
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
  /** `os.networkInterfaces()`, flat. Default: `machineInterfaces()`. */
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
  /** Default: a cancellable `setTimeout`. Bounds the `[y/N]` by the window. */
  readonly timer?: (ms: number) => PairTimer;
  /** Default: 9a's `addDevice` / `writePairingDecision` for this window (F3). */
  readonly writes?: PairWrites;
  /**
   * Register a cleanup for a `pair` that is killed (F2). Main passes a hook on
   * `exit`/SIGINT/SIGTERM; without it the window is closed only on the normal
   * path (a crash then leaves the files, which the pid check and the sweep of
   * both `pair` and the daemon already refuse).
   *
   * RETURN a disposer: `pair` calls it when it returns, so a finished `pair`
   * leaves the process exactly as it found it. Without this the hooks
   * outlive the command and a later signal in the same process runs a cleanup
   * for a window that is long gone (and re-raises, killing the host).
   */
  readonly exitHooks?: (cleanup: () => void) => (() => void) | undefined;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** A cancellable "later", so the human's window can bound the question. */
export interface PairTimer {
  readonly elapsed: Promise<void>;
  readonly cancel: () => void;
}

/**
 * The two writes a pairing makes, in ONE object: the registry entry FIRST and
 * the decision second (F3). Injected because the order between them is
 * load-bearing and otherwise unobservable — both writes are synchronous and the
 * window is deleted on the way out, so no test can interleave between them.
 * With this seam the test can watch the decision write and see whether the
 * registry already held the key (mutation: swap the two → red).
 */
export interface PairWrites {
  readonly add: (device: {
    readonly publicKey: Uint8Array;
    readonly name: string;
    /** The project the key opens (the window's): one entry = one key = one serve. */
    readonly project: DeviceProjectRef;
  }) => AddDeviceResult;
  readonly decide: (accepted: boolean) => DeviceStoreFailure | { readonly ok: true };
}

const defaultTimer = (ms: number): PairTimer => {
  let handle: ReturnType<typeof setTimeout> | undefined;
  let cancel = (): void => {};
  const elapsed = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, ms);
    cancel = () => {
      if (handle !== undefined) {
        clearTimeout(handle);
        resolve();
      }
    };
  });
  return { elapsed, cancel };
};

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

/**
 * The ONE live `serve` of the project at `dir` (docs/feat/mobile-projects.md §5,
 * F6): records are matched by `projectKey(cwd)` — the same key the serve's store
 * and authority use, so a symlinked path or a trailing slash still matches — and
 * only among fresh ones (the heartbeat, `DEFAULT_STALE_AFTER_MS`: a crashed
 * serve whose pid a stranger holds is not offered). Several (one serve per
 * project is the store lock's rule, so only a stale twin): the newest start.
 */
export function projectRecordOf(
  records: readonly DaemonRecord[],
  dir: string,
): DaemonRecord | undefined {
  const key = projectKey(dir);
  const matches = records.filter((record) => projectKey(record.cwd) === key);
  return matches.reduce<DaemonRecord | undefined>(
    (best, record) => (best === undefined || record.startedAt >= best.startedAt ? record : best),
    undefined,
  );
}

/** Why `pair` cannot target a project: no live `serve` runs there. */
export type PairTarget =
  | { readonly ok: true; readonly record: DaemonRecord; readonly project: DeviceProjectRef }
  | { readonly ok: false; readonly reason: "no_serve"; readonly dir: string };

/** The project `pair` targets: `--project <dir>` or the cwd, and its live serve. */
export function pairTargetOf(
  configDir: string,
  options: Pick<PairOptions, "projectDir" | "alive" | "now">,
): PairTarget {
  const dir = resolve(options.projectDir ?? process.cwd());
  let records: DaemonRecord[];
  try {
    const liveness = {
      freshWithinMs: DEFAULT_STALE_AFTER_MS,
      ...(options.alive !== undefined ? { alive: options.alive } : {}),
    };
    sweepDeadDaemonRecords(configDir, liveness);
    records = readDaemonRecords(configDir, liveness);
  } catch {
    records = [];
  }
  const record = projectRecordOf(records, dir);
  if (record === undefined) {
    return { ok: false, reason: "no_serve", dir };
  }
  // The project as the SERVE knows it (its own `cwd`): the window's key and the
  // label are then exactly what its authority and its `device/pair` result say.
  return { ok: true, record, project: { key: projectKey(record.cwd), cwd: record.cwd } };
}

/**
 * What `pair` found to say: the addresses of ONE serve (the target project's)
 * plus `--address` — never a sibling's (the repro's (4), inverted). Pure, so the
 * wording is testable without a terminal.
 */
export function pairAddressesOf(
  record: DaemonRecord,
  options: Pick<PairOptions, "extraAddresses" | "interfaces">,
): ReturnType<typeof pairAddresses> {
  return pairAddresses({
    records: [record],
    // NOT `[]`: a `0.0.0.0` bind expands to these, and a default of none would
    // make `pair` refuse the very `serve` REACHABLE_HINT tells the user to run
    // (review round 1, finding 1).
    interfaces: options.interfaces ?? machineInterfaces(),
    ...(options.extraAddresses !== undefined ? { extra: options.extraAddresses } : {}),
  });
}

/**
 * The question the human answers, naming the project the device would open.
 * The name is PEER-CHOSEN, so it is untrusted text (F17); the label is a folder
 * name, printed the same way.
 */
export function pairPrompt(name: string, sas: string, project: string): string {
  return `Add '${untrustedText(name)}' to project ${untrustedText(project)}? It must show ${formatPairingSas(sas)}. [y/N] `;
}

/** The refusal when the target folder has no live `serve` (Owner Q6). */
export function noServeHint(dir: string): string {
  return `No \`tentacle serve\` is running in ${untrustedText(dir)} — start it there first, then run \`tentacle pair\` again.`;
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

  // The target project FIRST (Owner Q6): with no live serve in that folder there
  // is nothing a phone could pair with, and opening a window anyway would hand
  // out a code no serve will ever honour.
  const target = pairTargetOf(configDir, {
    ...(options.projectDir !== undefined ? { projectDir: options.projectDir } : {}),
    ...(alive !== undefined ? { alive } : {}),
  });
  if (!target.ok) {
    err(`[error] ${noServeHint(target.dir)}\n`);
    return 1;
  }
  const project = target.project;
  const label = projectLabel(project);
  const found = pairAddressesOf(target.record, {
    ...(options.extraAddresses !== undefined ? { extraAddresses: options.extraAddresses } : {}),
    ...(options.interfaces !== undefined ? { interfaces: options.interfaces } : {}),
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
    // Only this project's serve admits a stranger on this window (F12).
    project,
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
  let dispose: (() => void) | undefined;
  try {
    dispose = options.exitHooks?.(close);
    const payload = formatPairingPayload({
      v: 1,
      key: identity.identity.publicKey,
      computer: identity.identity.name,
      code,
      addresses: found.addresses,
      // `p=`: the phone shows it before the human answers, and refuses a
      // pairing whose result names another project (F17).
      project: label,
    });
    // The QR is the phone's path in; the line below it is the paste form (an
    // app that cannot scan, a terminal that cannot draw).
    if (options.qr) {
      err(`${renderUnicodeCompact(payload)}\n`);
    }
    out(`${payload}\n`);
    err(
      `[pair] project ${untrustedText(label)} (${untrustedText(project.cwd)}): scan the code, or paste the line above into the app. It expires in ${Math.round(
        (session.expiresAt - now) / 60_000,
      )} minute(s).\n`,
    );

    const verdict = await waitForClaim(session.sid, session.expiresAt, {
      configDir,
      computerName: identity.identity.name,
      project,
      label,
      ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
      sleep,
      timer: options.timer ?? defaultTimer,
      ...(options.writes !== undefined ? { writes: options.writes } : {}),
      now: Date.now,
      ...(options.ask !== undefined ? { ask: options.ask } : {}),
      out,
      err,
    });
    return verdict;
  } finally {
    close();
    // The window is closed, so the hooks have nothing left to do: detach them
    // or a later SIGINT in this process would run a stale cleanup (and, in
    // main, re-raise the signal at a host that no longer expects it).
    dispose?.();
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
    readonly project: DeviceProjectRef;
    readonly label: string;
    readonly pollMs?: number;
    readonly sleep: (ms: number) => Promise<void>;
    readonly timer: (ms: number) => PairTimer;
    readonly writes?: PairWrites;
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
      return answerClaim(sid, claim, expiresAt, io);
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
  expiresAt: number,
  io: {
    readonly configDir: string;
    readonly computerName: string;
    readonly project: DeviceProjectRef;
    readonly label: string;
    readonly timer: (ms: number) => PairTimer;
    readonly writes?: PairWrites;
    readonly now: () => number;
    readonly ask?: (prompt: string) => Promise<string>;
    readonly out: (text: string) => void;
    readonly err: (text: string) => void;
  },
): Promise<Verdict> {
  const writes: PairWrites = io.writes ?? {
    add: (device) => addDevice(io.configDir, device),
    decide: (accepted) => writePairingDecision(io.configDir, sid, accepted),
  };
  if (io.ask === undefined) {
    // No terminal, no human: a claim is never auto-accepted (decision 2). The
    // answer is written so a waiting daemon stops at once instead of at expiry.
    io.err("[pair] a device is trying to pair, but there is no terminal to confirm it.\n");
    refuse(writes, false);
    return 1;
  }
  // The question is bounded by the window: a prompt nobody answers must not
  // hold `pair` past the expiry (the F-table's "N / timeout / Ctrl+C →
  // declined"), while the daemon has already told the phone `timeout`.
  const deadline = io.timer(Math.max(0, expiresAt - io.now()));
  const answer = await Promise.race([
    io.ask(pairPrompt(claim.name, claim.sas, io.label)),
    deadline.elapsed,
  ]);
  deadline.cancel();
  // Checked AFTER the human's answer, not only before it: a `y` typed after the
  // window closed must not pair the phone the daemon already told `timeout`
  // (review round 1, finding 2 — the registry would then hold a device the
  // phone was told failed). `undefined` is the timer winning the race.
  if (answer === undefined || io.now() >= expiresAt) {
    return expiredBeforeAnswer(writes, io.err);
  }
  if (!isYes(answer)) {
    io.err("[pair] not added.\n");
    refuse(writes, false);
    return 1;
  }
  const added = writes.add({ publicKey: claim.publicKey, name: claim.name, project: io.project });
  if (!added.ok) {
    io.err(`[error] cannot write the device registry: ${added.path}: ${added.reason}\n`);
    refuse(writes, false);
    return 1;
  }
  const decided = writes.decide(true);
  if (!decided.ok) {
    // The registry already holds the key, so the phone is paired even if the
    // daemon never reads this (F3). Say so rather than pretending otherwise.
    io.err(`[pair] paired, but the daemon was not told: ${decided.path}: ${decided.reason}\n`);
  }
  io.out(
    `Paired '${untrustedText(added.device.name)}' (${added.device.id}). It can now connect to project ${untrustedText(io.label)} (${untrustedText(io.project.cwd)}) on "${untrustedText(io.computerName)}" — run \`tentacle pair\` in another project's folder to add that one.\n`,
  );
  return 0;
}

/**
 * The window closed before the human's `[y/N]` was answered: pair nobody, and
 * write the decline so a daemon still waiting stops now instead of at expiry.
 */
function expiredBeforeAnswer(writes: PairWrites, err: (text: string) => void): Verdict {
  err("[pair] the code expired before you answered, so the device was not added.\n");
  refuse(writes, false);
  return 1;
}

/** Write a `declined` decision, best effort: the daemon also stops at expiry. */
function refuse(writes: PairWrites, accepted: boolean): void {
  writes.decide(accepted);
}
