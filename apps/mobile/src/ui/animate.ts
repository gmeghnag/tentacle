/**
 * The one layout animation the app uses (docs/feat/mobile-ui-polish.md
 * Cross-cutting → Animation): native ease-in-out for rows that open, close,
 * arrive or leave (tool output, diff, queue). No animation library. Call it
 * right BEFORE the state change whose layout should animate. Under Reduce
 * Motion (`reduceMotion`), it does nothing: the change just lands.
 */
import { LayoutAnimation } from "react-native";

export function animateNextLayout(reduceMotion = false): void {
  if (reduceMotion) {
    return;
  }
  LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
}
