/**
 * docs/feat/mobile-notifications.md slice N8 (Owner Q7): the DEV-BUILD-ONLY
 * channel the `notify-respond` hook uses to inject a notification response.
 *
 * Why it exists: Maestro cannot reliably long-press a system banner and tap an
 * action, so the E2E harness cannot produce a real response. Everything the app
 * does AFTER a response — verifying the seal, Face ID, the gate hold, the dial,
 * the answer, the fallback — is the real path; only the "which button did the
 * person tap" half is injected.
 *
 * Two rules keep it from being a hole:
 *  - **`__DEV__` only.** A release build never starts the reader, so there is no
 *    production path to it at all.
 *  - **It injects a RESPONSE, never an answer.** The response goes through
 *    `dispatchNotification` exactly like a real tap, so a forged payload injected
 *    this way is refused `unverified` like any other (the flow
 *    `22-notify-forged` proves exactly that).
 *
 * The transport is a file in the app's own container (`Library/Caches/
 * notify-respond.json`), written by the harness through `simctl get_app_container`.
 * The filesystem is INJECTED (the app passes `expo-file-system`), because the
 * phone's bundle must hold no Node built-in (`node-builtins-guard.test.ts`).
 */
/**
 * Where the harness writes one response. Relative to the app's data container:
 * `Library/Caches` is what `Paths.cache` resolves to on iOS
 * (`app-log-fs-expo.ts` uses the same directory for its own file).
 */
export const NOTIFY_RESPONSE_FILE = "Library/Caches/notify-respond.json";

/** The file's name inside `Paths.cache` (what the app actually reads). */
export const NOTIFY_RESPONSE_NAME = "notify-respond.json";

/** One injected response, as the harness wrote it. */
export interface InjectedResponseFile {
  readonly actionId: string;
  readonly userInfo: unknown;
  readonly userText?: string;
}

/** The two filesystem operations this module needs (the app's `expo-file-system`). */
export interface InjectedResponseIo {
  read(path: string): string | undefined;
  remove(path: string): void;
}

/**
 * Read and CONSUME the pending injected response, if any. Undefined when there is
 * none, or when what is there is not a response (never guessed at). Pure over the
 * filesystem functions, so a test drives it without a simulator.
 */
export function takeInjectedResponse(
  file: string,
  io: InjectedResponseIo,
): InjectedResponseFile | undefined {
  const raw = io.read(file);
  if (raw === undefined) {
    return undefined;
  }
  // Consumed either way: a malformed file must not be retried forever.
  io.remove(file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") {
    return undefined;
  }
  const candidate = parsed as Partial<InjectedResponseFile>;
  if (typeof candidate.actionId !== "string") {
    return undefined;
  }
  return {
    actionId: candidate.actionId,
    userInfo: candidate.userInfo,
    ...(typeof candidate.userText === "string" ? { userText: candidate.userText } : {}),
  };
}
