/**
 * Plays a `HapticKind` (`haptic-rules.ts` decides when). The only file that
 * touches `expo-haptics`; a failure (no Taptic Engine, simulator) is ignored —
 * a haptic is never worth an error on screen.
 */
import * as Haptics from "expo-haptics";
import type { HapticKind } from "./haptic-rules.ts";

export function playHaptic(kind: HapticKind | null): void {
  if (kind === null) {
    return;
  }
  const done =
    kind === "success"
      ? Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
      : Haptics.impactAsync(
          kind === "firm" ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light,
        );
  done.catch(() => undefined);
}
