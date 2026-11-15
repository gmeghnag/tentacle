/**
 * A command name inside running copy ("Run `tentacle pair` on your computer…"),
 * as the mockups set it (`Pair.dc.html`: the mono span in the label colour).
 * SF Mono runs wider and taller than SF Pro at the same size, so it is set ONE
 * point below the sentence around it to match x-heights (visual review 1, P2).
 * Render only; must be nested in a `<Text>`.
 */
import type { JSX } from "react";
import { Text } from "react-native";
import { MONO, type Palette } from "../theme.ts";

export function InlineMono({
  palette,
  size,
  children,
}: {
  readonly palette: Palette;
  /** The surrounding text's font size. */
  readonly size: number;
  readonly children: string;
}): JSX.Element {
  return (
    <Text style={{ fontFamily: MONO, fontSize: size - 1, color: palette.label }}>{children}</Text>
  );
}
