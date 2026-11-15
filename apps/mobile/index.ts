import "./polyfills";
import { registerRootComponent } from "expo";
import App from "./App";

/**
 * docs/feat/mobile-notifications.md Design 7 / slice N7: the notification bits
 * that must exist BEFORE React mounts.
 *
 * Two, both module scope on purpose:
 *  - **the categories**, because iOS keeps no memory of them across launches and
 *    a notification delivered a moment after launch would show no actions;
 *  - **the foreground handler**, because iOS asks it synchronously when a push
 *    arrives while the app is foreground — and it must answer "show it" even
 *    while the app is still starting (a missed ask is a stuck turn).
 *
 * The RESPONSE listener is not here: it needs the app's links and store, so
 * `App.tsx` starts it once mounted (`startNotifications`). The response that
 * LAUNCHED the app is not lost either way — `startNotifications` drains
 * `getLastNotificationResponseAsync()` on mount, so a cold-start action is
 * handled exactly once (Design 7, F12).
 */
void (async () => {
  try {
    const { registerCategories } = await import("./src/notifications-expo");
    await registerCategories();
  } catch {
    // A build with no notification support (a plain simulator): nothing to do,
    // and nothing to report before the app log exists.
  }
  try {
    const Notifications = await import("expo-notifications");
    const { presentHere } = await import("./src/notifications-expo");
    // Show a banner unless the app is foreground ON THAT VERY SESSION (the sheet
    // already asks there — `foreground-presentation.ts`, tested). An unverifiable
    // notification is always shown: never a silent drop. The handler does not
    // decrypt (no keys here, and none should be): the ACTION path re-verifies
    // before anything is sent (Design 3).
    Notifications.setNotificationHandler({
      handleNotification: async (notification) => {
        const present = presentHere(notification.request.content.data);
        return {
          shouldShowBanner: present,
          shouldShowList: present,
          shouldPlaySound: present,
          shouldSetBadge: false,
        };
      },
    });
  } catch {
    // Same: no notification module in this build.
  }
})();

registerRootComponent(App);
