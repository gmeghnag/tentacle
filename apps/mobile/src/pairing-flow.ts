/**
 * Pairing, as a pure reducer plus ONE runner (docs/feat/mobile-pairing-screen.md
 * 11b.1, Design 2; AGENTS §7 "logic in pure modules").
 *
 * The screen renders the view-model this module produces and dispatches into it;
 * every branch that decides something lives here, so it is tested without React:
 *
 *   intake → review{payload, existing?} → connecting → compare{sas}
 *          → done{computerId} | failed{reason, message, retry}
 *
 * Notes that are load-bearing:
 * - **Nothing is dialled before the review.** A paste only parses; a QR a
 *   hostile page opened stops here too (Owner Q6). A parse failure is
 *   `invalid-payload`/`payload-version` and never touches the network.
 * - **The device key is fresh per pairing** (Owner Q2), and the record is
 *   written BEFORE `done` is dispatched: a `done` the store did not back would
 *   show a computer the app cannot dial.
 * - **`onCompare` does not wait for a tap.** The human's decision is the
 *   computer's `[y/N]`; the phone's job at that moment is to show the code, so
 *   the runner dispatches `compare` and returns (P1 awaits `onCompare`).
 * - **Every failure is mapped from the ERROR OBJECT**, exhaustively, never from
 *   text (`describePairingError`). A `ChannelError{unauthorized}` out of
 *   `pairDevice` is `expired` (P4: the window is gone), NOT `revoked` — that
 *   verdict needs a LIVE link's authenticated `/e2e` handshake
 *   (`link-diagnosis.ts`).
 */
import { ChannelError } from "@tentacle/client";
import {
  PAIRING_REFUSED_MESSAGES,
  type PairDeviceResult,
  PairingRefused,
  pairDevice,
} from "@tentacle/client/pairing";
import {
  DevicePairParamsSchema,
  DomainErrorCode,
  type PairingPayload,
  type PairingRefusedReason,
  encodeBase64Url,
  parsePairingPayload,
} from "@tentacle/protocol";
import { type DuplexChannel, RpcError } from "@tentacle/transport";
import { type Random, generateStaticKeypair } from "@tentacle/transport/noise";
import type { ComputerStore, PairedComputer } from "./computer-store.ts";

/**
 * Every reason the app can show, one testID each (`pair-error-<reason>`): the
 * six the APP decides, `unknown` (a refusal reason this build does not know),
 * and `PairingRefused`'s own reasons verbatim (so the copy is the client's, and
 * a flow can name one).
 */
export type PairingFailureReason =
  | "invalid-payload"
  | "payload-version"
  | "expired"
  | "version"
  | "unreachable"
  | "store"
  | "unknown"
  | PairingRefusedReason;

/** F-P9's sentence: a cancel after the claim leaves the computer's prompt up. */
export const CANCELLED_MESSAGE = "Pairing cancelled — if the computer asks, answer n";

export interface PairingFailure {
  readonly reason: PairingFailureReason;
  /** The sentence the card shows. */
  readonly message: string;
  /** What the card's button does: edit the text, retry this payload, or nothing. */
  readonly retry: "edit" | "retry" | "no";
  /** F-P9: the phone cancelled after the claim, so the computer may still prompt. */
  readonly mayStillPrompt?: boolean;
}

/** A stored computer that already has this pinned key (Owner Q7: pair again?). */
export interface ExistingComputer {
  readonly id: string;
  readonly name: string;
}

export type PairingState =
  | { readonly name: "intake"; readonly text: string; readonly failure?: PairingFailure }
  | {
      readonly name: "review";
      readonly text: string;
      readonly payload: PairingPayload;
      readonly deviceName: string;
      readonly existing?: ExistingComputer;
      readonly failure?: PairingFailure;
    }
  | {
      readonly name: "connecting";
      readonly text: string;
      readonly payload: PairingPayload;
      readonly deviceName: string;
    }
  | {
      readonly name: "compare";
      readonly text: string;
      readonly payload: PairingPayload;
      readonly deviceName: string;
      readonly sas: string;
    }
  | { readonly name: "failed"; readonly text: string; readonly failure: PairingFailure }
  | { readonly name: "done"; readonly computerId: string; readonly computerName: string };

export type PairingAction =
  | { readonly type: "text"; readonly text: string }
  /** Parse the text and move to the review. `existing` is what the store already holds for this key. */
  | { readonly type: "submit"; readonly existing?: ExistingComputer }
  | { readonly type: "device-name"; readonly name: string }
  | { readonly type: "confirm" }
  | { readonly type: "compare"; readonly sas: string }
  | { readonly type: "done"; readonly result: PairDeviceResult }
  | { readonly type: "failed"; readonly failure: PairingFailure }
  /** Cancel: stop the attempt and go back to the review (the payload is still good). */
  | { readonly type: "cancel" }
  /** Start over with a new code (after a cancel, a refusal or a "no"). */
  | { readonly type: "again" };

export function initialState(): PairingState {
  return { name: "intake", text: "" };
}

/**
 * The device name, as the protocol validates it (1–64 chars, no control
 * characters): `DevicePairParamsSchema.shape.name` is the ONE definition, so a
 * name the screen accepts cannot be one `device/pair` would refuse.
 */
export function isValidDeviceName(name: string): boolean {
  return DevicePairParamsSchema.shape.name.safeParse(name).success;
}

/** The default device name (iOS 16+ hides the user-assigned one without an Apple entitlement). */
export function defaultDeviceName(): string {
  return "iPhone";
}

/** Every reason, and its copy. Exhaustive by TYPE: a new reason must get a sentence. */
const MESSAGES: Record<
  PairingFailureReason,
  { readonly message: string; readonly retry: PairingFailure["retry"] }
> = {
  "invalid-payload": {
    message: "Not a tentacle pairing code — paste the line `tentacle pair` printed, or scan its QR",
    retry: "edit",
  },
  "payload-version": {
    message:
      "This code is from a different tentacle version — update the app, or tentacle on the computer",
    retry: "no",
  },
  // P4: an expired window / a stopped `pair` is a handshake DENY, so this IS
  // what "the code is gone" looks like. Never "this phone was removed".
  expired: {
    message: "This code expired, or `tentacle pair` stopped — run `tentacle pair` again",
    retry: "edit",
  },
  version: {
    message: "Update tentacle on this computer, or the app — their versions do not match",
    retry: "no",
  },
  unreachable: {
    message:
      "Can't reach the computer at its addresses — same network or Tailscale? `tentacle serve --host 0.0.0.0` running and up to date?",
    retry: "retry",
  },
  store: {
    message:
      "Paired, but this phone could not save it — pair again, then remove the stale entry on the computer with `tentacle devices revoke <name>`",
    retry: "retry",
  },
  unknown: { message: "The computer refused the pairing", retry: "retry" },
  invalid_code: { message: PAIRING_REFUSED_MESSAGES.invalid_code, retry: "edit" },
  used: { message: PAIRING_REFUSED_MESSAGES.used, retry: "edit" },
  declined: { message: PAIRING_REFUSED_MESSAGES.declined, retry: "edit" },
  timeout: { message: PAIRING_REFUSED_MESSAGES.timeout, retry: "edit" },
  too_many_attempts: { message: PAIRING_REFUSED_MESSAGES.too_many_attempts, retry: "edit" },
  already_paired: { message: PAIRING_REFUSED_MESSAGES.already_paired, retry: "no" },
};

/** The copy of one reason (the screen's only way to get a sentence). */
export function failureFor(reason: PairingFailureReason): PairingFailure {
  return { reason, ...MESSAGES[reason] };
}

/** Every reason this build can show (the tests' exhaustive walk; the record's keys). */
export const PAIRING_FAILURE_REASONS: readonly PairingFailureReason[] = Object.keys(
  MESSAGES,
) as readonly PairingFailureReason[];

/** The failure a refused PAYLOAD is: `version` has its own sentence (F-P2), the rest is F-P1. */
export function payloadFailure(reason: string): PairingFailure {
  return failureFor(reason === "version" ? "payload-version" : "invalid-payload");
}

/**
 * Error object → failure. `PairingRefused` first (it is not a `ChannelError`),
 * then the authenticated channel verdict, then the RPC codes, then the rest
 * (a dial error, a TLS failure, `pairDevice`'s collapsed `unreachable`).
 */
export function describePairingError(error: unknown): PairingFailure {
  if (error instanceof PairingRefused) {
    // An unknown reason (a newer daemon's) is `unknown`, not a crash.
    return failureFor(error.reason === "unknown" ? "unknown" : error.reason);
  }
  if (error instanceof ChannelError && error.kind === "unauthorized") {
    // P4, and NOT `revoked`: on a pairing dial a `denied` means our key is not a
    // device yet — the window is gone (expired, or `pair` stopped).
    return failureFor("expired");
  }
  if (error instanceof RpcError && error.code === DomainErrorCode.VersionMismatch) {
    return failureFor("version");
  }
  if (error instanceof ChannelError) {
    // `closed`/`timeout`/`rejected`/`gone` at the dial or in the handshake: an
    // on-path party can produce them, so they say "unreachable" and nothing more.
    return failureFor("unreachable");
  }
  return failureFor("unreachable");
}

/** The state's text, whatever stage it is at (a retry keeps what the person pasted). */
function textOf(state: PairingState): string {
  return state.name === "done" ? "" : state.text;
}

/**
 * The reducer. Pure: no clock, no I/O, and `submit` is the only action that can
 * fail without an external error — without dialling anything.
 */
export function reduce(state: PairingState, action: PairingAction): PairingState {
  switch (action.type) {
    case "text":
      return state.name === "intake" || state.name === "failed"
        ? { name: "intake", text: action.text }
        : state;
    case "submit": {
      if (state.name !== "intake" && state.name !== "failed") {
        return state;
      }
      const text = textOf(state);
      // An empty field has nothing to submit: its "Continue" is drawn disabled
      // (P1), so a tap on it must not turn into a "not a pairing line" error.
      if (text.trim() === "") {
        return state;
      }
      const parsed = parsePairingPayload(text);
      if (!parsed.ok) {
        return { name: "intake", text, failure: payloadFailure(parsed.reason) };
      }
      return {
        name: "review",
        text,
        payload: parsed.payload,
        deviceName: "iPhone",
        ...(action.existing === undefined ? {} : { existing: action.existing }),
      };
    }
    case "device-name":
      return state.name === "review" ? { ...state, deviceName: action.name } : state;
    case "confirm":
      if (state.name !== "review" || !isValidDeviceName(state.deviceName)) {
        return state;
      }
      return {
        name: "connecting",
        text: state.text,
        payload: state.payload,
        deviceName: state.deviceName,
      };
    case "compare":
      return state.name === "connecting"
        ? {
            name: "compare",
            text: state.text,
            payload: state.payload,
            deviceName: state.deviceName,
            sas: action.sas,
          }
        : state;
    case "done":
      return {
        name: "done",
        computerId: action.result.computer.id,
        computerName: action.result.computer.name,
      };
    case "failed":
      return { name: "failed", text: textOf(state), failure: action.failure };
    case "cancel": {
      // Back to the review, with the payload still in hand: a wrong device name
      // (or a change of mind) does not cost a new QR.
      if (state.name !== "connecting" && state.name !== "compare") {
        return state;
      }
      return {
        name: "review",
        text: state.text,
        payload: state.payload,
        deviceName: state.deviceName,
        failure: {
          reason: "unreachable",
          message: CANCELLED_MESSAGE,
          retry: "retry",
          // Only a cancel AFTER the compare code was shown can leave the
          // computer's prompt standing (the claim is sent after it).
          mayStillPrompt: state.name === "compare",
        },
      };
    }
    case "again":
      return initialState();
  }
}

/** The published view-model: what the screen renders, decided here (AGENTS §7). */
export interface PairingView {
  readonly stage: PairingState["name"];
  /** `pair-review` shows the computer's name and how many addresses will be tried. */
  readonly review?: {
    readonly computerName: string;
    readonly addressCount: number;
    readonly deviceName: string;
    readonly deviceNameValid: boolean;
    readonly existing?: ExistingComputer;
  };
  /** `pair-sas-<digits>` (the digits only; the card groups them). */
  readonly sas?: string;
  readonly failure?: PairingFailure;
  readonly computerId?: string;
  readonly computerName?: string;
  /** The text field's value (always shown at `intake`). */
  readonly text: string;
  /** How the paste field's "Continue" reads for `text` (`pasteSubmit`). */
  readonly submit: PasteSubmit;
}

/**
 * The paste field's "Continue" (visual review 1, P1): `empty` — nothing to
 * submit, drawn disabled and inert; `unparsed` — text that is not a pairing
 * line, still pressable so the person learns WHY (the payload failure), but not
 * drawn as the ready action; `ready` — a line that parses, the tinted action.
 */
export type PasteSubmit = "empty" | "unparsed" | "ready";

export function pasteSubmit(text: string): PasteSubmit {
  if (text.trim() === "") {
    return "empty";
  }
  return parsePairingPayload(text).ok ? "ready" : "unparsed";
}

export function pairingView(state: PairingState): PairingView {
  return { ...stageView(state), submit: pasteSubmit(textOf(state)) };
}

function stageView(state: PairingState): Omit<PairingView, "submit"> {
  switch (state.name) {
    case "intake":
      return {
        stage: "intake",
        text: state.text,
        ...(state.failure ? { failure: state.failure } : {}),
      };
    case "review":
      return {
        stage: "review",
        text: state.text,
        review: {
          computerName: state.payload.computer,
          addressCount: state.payload.addresses.length,
          deviceName: state.deviceName,
          deviceNameValid: isValidDeviceName(state.deviceName),
          ...(state.existing === undefined ? {} : { existing: state.existing }),
        },
        ...(state.failure === undefined ? {} : { failure: state.failure }),
      };
    case "connecting":
      return { stage: "connecting", text: state.text };
    case "compare":
      return { stage: "compare", text: state.text, sas: state.sas };
    case "failed":
      return { stage: "failed", text: state.text, failure: state.failure };
    case "done":
      return {
        stage: "done",
        text: "",
        computerId: state.computerId,
        computerName: state.computerName,
      };
  }
}

export interface RunPairingOptions {
  readonly payload: PairingPayload;
  readonly deviceName: string;
  readonly store: Pick<ComputerStore, "add">;
  /** One address's raw channel (the app passes its RN WebSocket dial). */
  readonly dial: (address: string) => () => Promise<DuplexChannel>;
  readonly random: Random;
  /** Every state change goes through here (the screen re-renders). */
  readonly dispatch: (action: PairingAction) => void;
  readonly now?: () => number;
  /** Cancel: closing the channel in flight rejects `pairDevice` (P1/F-P9). */
  readonly signal?: AbortSignal;
  /**
   * The FIRST successful pairing's one extra step (docs/feat/mobile-push.md P9,
   * decision 10: notifications are "asked only when needed and explained").
   *
   * Called AFTER the record is stored and the `done` action dispatched, and its
   * result is IGNORED (`void`): a notification prompt is never a reason to fail
   * a pairing that already succeeded, and the person may be looking at the OS
   * sheet for as long as they like (Owner Q7). The decision of WHETHER to ask
   * lives in `push-registration.ts`; this is only the call site, so a flow test
   * can prove the order (stored → done → ask).
   */
  readonly onPaired?: (computerId: string) => void;
}

export type PairingOutcome =
  | { readonly ok: true; readonly computerId: string }
  | { readonly ok: false };

/**
 * Run the pairing the person confirmed: a FRESH device key (Owner Q2), the
 * exchange, the record, `done`. A failure is a UI state (it dispatches `failed`
 * and resolves `ok: false`), never an exception the screen has to catch.
 */
export async function runPairing(options: RunPairingOptions): Promise<PairingOutcome> {
  const { payload, deviceName, store, random, dispatch } = options;
  const now = options.now ?? Date.now;
  // A fresh key per pairing: removing a computer destroys exactly its key, and
  // two computers cannot correlate this phone by it (Owner Q2).
  const keypair = generateStaticKeypair(random);
  /** The raw channel of the attempt in flight: Cancel closes exactly this one. */
  let inFlight: DuplexChannel | undefined;
  const onAbort = (): void => {
    try {
      inFlight?.close();
    } catch {
      // already closed: `pairDevice` rejects on its own
    }
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const dial = (address: string) => {
    const one = options.dial(address);
    return async (): Promise<DuplexChannel> => {
      const channel = await one();
      inFlight = channel;
      if (options.signal?.aborted === true) {
        channel.close();
      }
      return channel;
    };
  };
  try {
    const result = await pairDevice({
      payload,
      deviceKey: keypair.privateKey,
      name: deviceName,
      dial,
      random,
      // Report the code and return: the human compares it with the computer's
      // terminal and answers THERE (the phone's job is to show it).
      onCompare: (sas) => {
        dispatch({ type: "compare", sas });
      },
    });
    // The computer accepted: write the record, THEN say so (F-P12).
    const record: PairedComputer = {
      id: result.computer.id,
      name: result.computer.name,
      computerKey: encodeBase64Url(payload.key),
      addresses: payload.addresses,
      deviceName,
      // This phone's OWN label, as the computer will list it (`device/pair`'s
      // `name`): the one string that matches on both ends, for an ask's "also
      // asked on" and a flip's `by` (docs/feat/session-auto-accept.md D7).
      thisDeviceName: deviceName,
      pairedAt: now(),
    };
    try {
      await store.add(record, encodeBase64Url(keypair.privateKey));
    } catch {
      dispatch({ type: "failed", failure: failureFor("store") });
      return { ok: false };
    }
    dispatch({ type: "done", result });
    // The first successful pairing's one extra step (P9): notifications are
    // asked about HERE and nowhere else (decision 10). After `done`, so the
    // screen is already moving on, and never awaited — a prompt is not part of
    // the pairing's success. Guarded for the same reason: a hook that throws
    // must not turn a stored computer into a `failed` card (the catch below is
    // the PAIRING's, and this is no longer the pairing).
    try {
      options.onPaired?.(result.computer.id);
    } catch {
      // A notification prompt is never a reason to lose a paired computer.
    }
    return { ok: true, computerId: result.computer.id };
  } catch (error) {
    if (options.signal?.aborted === true) {
      // F-P9: the phone hung up. If the claim went out, the computer's prompt
      // may still be standing, so the copy says which answer leaves no device.
      dispatch({
        type: "failed",
        failure: {
          reason: "unreachable",
          message: CANCELLED_MESSAGE,
          retry: "retry",
          mayStillPrompt: true,
        },
      });
      return { ok: false };
    }
    dispatch({ type: "failed", failure: describePairingError(error) });
    return { ok: false };
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
}
