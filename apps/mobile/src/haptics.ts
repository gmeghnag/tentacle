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
  play(kind).catch(() => undefined);
}

function play(kind: HapticKind): Promise<void> {
  switch (kind) {
    case "success":
      return Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    case "tick":
      return Haptics.selectionAsync();
    case "commit":
      return Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid);
    case "firm":
      return Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    case "light":
      return Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }
}
