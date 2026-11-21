/**
 * A 6/8 pt status dot (docs/feat/mobile-ui-polish.md Design 2): filled for
 * online/running, a ring for offline. The tone is decided by a pure helper
 * (`computer-status.ts`); this only draws it. Render only.
 */
import type { JSX } from "react";
import { View } from "react-native";
import type { Palette } from "../theme.ts";

export type StatusTone = "online" | "offline" | "attention" | "running" | "wait";

export function toneColor(palette: Palette, tone: StatusTone): string {
  switch (tone) {
    case "online":
      return palette.green;
    case "running":
      return palette.accent;
    case "attention":
      return palette.orange;
    case "offline":
    case "wait":
      return palette.sec;
  }
}

export function StatusDot({
  palette,
  tone,
  size = 8,
}: {
  readonly palette: Palette;
  readonly tone: StatusTone;
  readonly size?: number;
}): JSX.Element {
  const color = toneColor(palette, tone);
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        ...(tone === "offline" || tone === "wait"
          ? { borderWidth: 1.5, borderColor: color }
          : { backgroundColor: color }),
      }}
    />
  );
}
