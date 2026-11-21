import {
  PushEnvelopeSchema,
  PushMessageSchema,
  decodeBase64Url,
  encodeBase64Url,
} from "@tentacle/protocol";
import type { PushMessage } from "@tentacle/protocol";
import { openPush } from "@tentacle/transport/push";
import * as Notifications from "expo-notifications";
import { isRecordOfComputer } from "./computer-store.ts";
import { type CurrentScreen, presentFromHints } from "./foreground-presentation.ts";
import type { PinnedComputer, PushKeyMaterial } from "./notification-action.ts";
import { NOTIFICATION_CATEGORIES } from "./notification-categories.ts";

/**
 * What the app is looking at, for `shouldPresent`: the app sets this from its
 * navigation state (a session screen, or anything else). Absent before the first
 * screen mounts — and then a banner is shown, which is the safe default.
 */
let currentScreen: CurrentScreen = { kind: "other" };

/** The app's own screen, for the foreground handler's rule (Design 7). */
export function setCurrentScreen(screen: CurrentScreen): void {
  currentScreen = screen;
}

/** The foreground handler's rule with the app's current screen (Design 7). */
export function presentHere(userInfo: unknown): boolean {
  return presentFromHints(userInfo, currentScreen);
}

/**
 * Register the categories at every app start. iOS keeps no memory of them across
 * launches, so this runs before the first render (`index.ts`); it is idempotent.
 */
export async function registerCategories(): Promise<void> {
  for (const category of NOTIFICATION_CATEGORIES) {
    await Notifications.setNotificationCategoryAsync(
      category.identifier,
      category.actions.map((action) => ({
        identifier: action.identifier,
        buttonTitle: action.title,
        options: actionOptions(action),
        ...(action.textInput !== undefined
          ? {
              textInput: {
                submitButtonTitle: action.textInput.buttonTitle,
                placeholder: action.textInput.placeholder,
              },
            }
          : {}),
      })),
    );
  }
}

/** The `UNNotificationActionOptions` bits a category action asks for. */
function actionOptions(action: {
  opensAppToForeground: boolean;
  destructive?: boolean;
  authenticationRequired?: boolean;
}): NonNullable<Notifications.NotificationAction["options"]> {
  return {
    // Always explicit: `opensAppToForeground` defaults to TRUE in expo, and a
    // background Deny/Reply must NOT foreground the app (Design 4).
    opensAppToForeground: action.opensAppToForeground,
    ...(action.destructive === true ? { isDestructive: true } : {}),
    ...(action.authenticationRequired === true ? { isAuthenticationRequired: true } : {}),
  };
}

/** One action response, in this app's vocabulary (never expo's shapes). */
export interface NotificationResponse {
  readonly actionId: string;
  /** The notification's `userInfo` (untrusted: `tp` and the hints). */
  readonly userInfo: Record<string, unknown>;
  /** The text a `Reply…` action collected, when iOS provided one. */
  readonly userText?: string;
}

/** Map an expo response (or a cold-start `getLastNotificationResponseAsync`). */
export function toNotificationResponse(
  response: Notifications.NotificationResponse | null | undefined,
): NotificationResponse | undefined {
  if (!response) {
    return undefined;
  }
  const actionId = response.actionIdentifier;
  const userInfo = (response.notification.request.content.data ?? {}) as Record<string, unknown>;
  const userText = typeof response.userText === "string" ? response.userText : undefined;
  return {
    // Expo reports a plain tap as `DEFAULT_ACTION_IDENTIFIER`; this app calls it
    // `default` everywhere else (`notification-action.ts`).
    actionId: actionId === Notifications.DEFAULT_ACTION_IDENTIFIER ? "default" : actionId,
    userInfo,
    ...(userText !== undefined ? { userText } : {}),
  };
}

/**
 * Drain the response that LAUNCHED the app, exactly once. A cold start from an
 * action (F12) delivers its response only through here — the listener registered
 * in `index.ts` fires for later ones.
 */
export async function drainColdStartResponse(): Promise<NotificationResponse | undefined> {
  const response = await Notifications.getLastNotificationResponseAsync();
  if (!response) {
    return undefined;
  }
  // Clearing it keeps a second call (a remount) from answering twice.
  await Notifications.clearLastNotificationResponseAsync();
  return toNotificationResponse(response);
}

/** The listener for responses while the app runs; returns its unsubscribe. */
export function onNotificationResponse(
  handler: (response: NotificationResponse) => void,
): () => void {
  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    const mapped = toNotificationResponse(response);
    if (mapped) {
      handler(mapped);
    }
  });
  return () => subscription.remove();
}

/**
 * Open a delivered notification's envelope with the app's own keys — the
 * "re-open in JS" of Design 3, so an answer never trusts `userInfo.tn`.
 * `undefined` when it does not open (the caller refuses `unverified`).
 */
export function openInApp(
  userInfo: unknown,
  computers: readonly PinnedComputer[],
  pushKeys: readonly PushKeyMaterial[],
): { readonly message: PushMessage; readonly computer: PinnedComputer } | undefined {
  if (userInfo === null || typeof userInfo !== "object") {
    return undefined;
  }
  const envelope = PushEnvelopeSchema.safeParse((userInfo as { tp?: unknown }).tp);
  if (!envelope.success) {
    return undefined;
  }
  const { k, e, c } = envelope.data;
  const enc = decodeBase64Url(e);
  const ciphertext = decodeBase64Url(c);
  if (!enc || !ciphertext) {
    return undefined;
  }
  for (const computer of computers) {
    const senderPub = decodeBase64Url(computer.computerKey);
    if (!senderPub) {
      continue;
    }
    for (const key of pushKeys) {
      const recipient = decodeBase64Url(key.privateKey);
      if (!recipient) {
        continue;
      }
      try {
        const plaintext = openPush({ keyId: k, enc, ciphertext }, recipient, senderPub);
        const parsed = PushMessageSchema.safeParse(JSON.parse(new TextDecoder().decode(plaintext)));
        if (parsed.success && isRecordOfComputer(computer.id, parsed.data.computer)) {
          return { message: parsed.data, computer };
        }
      } catch {
        // That key/computer pair is not it: try the next (a retained key, or
        // another paired computer).
      }
    }
  }
  return undefined;
}

/** The local fallback notification of Design 4 step 2 (its canceller). */
export async function scheduleFallbackNotice(
  notice: { readonly sessionId: string; readonly title: string; readonly text: string },
  ms: number,
): Promise<() => void> {
  const identifier = await Notifications.scheduleNotificationAsync({
    content: {
      title: "tentacle",
      body: notice.text,
      categoryIdentifier: "tentacle.open",
      threadIdentifier: `s:${notice.sessionId}`,
      interruptionLevel: "timeSensitive" as const,
      // The route for the tap: the SESSION the fallback is about. Not an answer
      // path: opening the app and its sheet is the honest way to finish (F1).
      data: { tn: { v: 1, kind: "fallback", sessionId: notice.sessionId } },
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds: Math.max(1, Math.round(ms / 1000)),
      repeats: false,
    },
  });
  return () => {
    void Notifications.cancelScheduledNotificationAsync(identifier).catch(() => undefined);
  };
}

/** Dismiss every presented banner whose hints name this ask (Design 7). */
export async function dismissForRequest(
  predicates: (hints: { requestId?: string; sessionId?: string }) => boolean,
): Promise<void> {
  const presented = await Notifications.getPresentedNotificationsAsync();
  for (const notification of presented) {
    const tn = (notification.request.content.data as { tn?: Record<string, unknown> } | undefined)
      ?.tn;
    const hints = tn as { requestId?: string; sessionId?: string } | undefined;
    if (hints && predicates(hints)) {
      await Notifications.dismissNotificationAsync(notification.request.identifier);
    }
  }
}

/** base64url of bytes (the envelope's own alphabet), for a caller that needs it. */
export { encodeBase64Url };
