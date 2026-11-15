/**
 * docs/feat/mobile-notifications.md Design 3 / slice N2: the notification
 * CATEGORIES the app registers at every start (iOS keeps no memory of them
 * across launches), as pure data — the ids, the actions, and the rule that makes
 * them safe.
 *
 * The one rule that matters here: **the ids and action ids are ours alone.** An
 * action id means "Approve" because this file says so, and the app resolves it
 * against a RE-OPENED plaintext (Design 3, `notification-action.ts`) — never
 * against the notification's own text. A relay that puts `category:
 * "tentacle.ask"` in `aps` gains nothing: the NSE overwrites the category, and a
 * push that never went through the NSE still cannot make the phone send anything
 * (`decideAction` refuses `unverified`).
 */
import { CATEGORY_ASK, CATEGORY_ASK_REPLY, CATEGORY_OPEN } from "./push-render.ts";

/** The action ids. Stable: a delivered notification keeps its buttons until it is replaced. */
export const ACTION_APPROVE = "tentacle.approve";
export const ACTION_DENY = "tentacle.deny";
export const ACTION_REPLY = "tentacle.reply";
export const ACTION_OPEN = "tentacle.open";

export interface CategoryAction {
  /** `UNNotificationAction.identifier` — what a response reports back. */
  readonly identifier: string;
  readonly title: string;
  /**
   * Whether tapping it brings the app to the foreground. Approve always does
   * (Face ID needs a foreground app, decision 14); Deny and Reply are answered
   * in the background within iOS's budget (Design 4); Open obviously does.
   */
  readonly opensAppToForeground: boolean;
  /** Red text: a destructive-looking denial. */
  readonly destructive?: boolean;
  /** Deny is not authenticated (it decides nothing); Reply is (the phone's passcode, Owner Q3). */
  readonly authenticationRequired?: boolean;
  /** Reply only: the person types into the action itself. */
  readonly textInput?: {
    readonly buttonTitle: string;
    readonly placeholder: string;
  };
}

export interface NotificationCategorySpec {
  readonly identifier: string;
  readonly actions: readonly CategoryAction[];
}

const OPEN: CategoryAction = {
  identifier: ACTION_OPEN,
  title: "Open",
  opensAppToForeground: true,
};

/**
 * Approve is `opensAppToForeground: true` and nothing else: the app, then Face
 * ID, then `allow_once` (never a lasting rule — decision 8, Owner Q2).
 */
const APPROVE: CategoryAction = {
  identifier: ACTION_APPROVE,
  title: "Approve",
  opensAppToForeground: true,
};

/**
 * Deny works from the LOCK SCREEN with no authentication (`decision 8`: "Deny
 * (no Face ID)"): it stops the agent, it grants nothing, and the ask is still
 * shown in the app.
 */
const DENY: CategoryAction = {
  identifier: ACTION_DENY,
  title: "Deny",
  opensAppToForeground: false,
  destructive: true,
};

/**
 * Reply asks the DEVICE's passcode/Face ID (`isAuthenticationRequired`), not the
 * app's (Owner Q3): the person's words go to the model, so a phone someone else
 * is holding must not be able to type instructions to an agent.
 */
const REPLY: CategoryAction = {
  identifier: ACTION_REPLY,
  title: "Reply…",
  opensAppToForeground: false,
  authenticationRequired: true,
  textInput: { buttonTitle: "Send", placeholder: "Tell the agent what to do instead" },
};

/** The categories, in registration order (`setNotificationCategoryAsync` on each). */
export const NOTIFICATION_CATEGORIES: readonly NotificationCategorySpec[] = [
  { identifier: CATEGORY_ASK, actions: [APPROVE, DENY, OPEN] },
  { identifier: CATEGORY_ASK_REPLY, actions: [APPROVE, DENY, REPLY, OPEN] },
  { identifier: CATEGORY_OPEN, actions: [OPEN] },
];

/** The category spec an id names, or undefined (an id from an older build). */
export function categorySpec(identifier: string): NotificationCategorySpec | undefined {
  return NOTIFICATION_CATEGORIES.find((c) => c.identifier === identifier);
}
