/**
 * The app font in force (`null`: the system font), set once by `App.tsx` from
 * `themeFor` (docs/feat/mobile-theme-beta.md). Its own module so a renderer
 * that draws text outside the `Text` seam — the shimmer's svg glyphs
 * (`StepNode.tsx`, docs/fix/mobile-running-row.md) — reads the same font
 * without importing the seam; `Text.tsx` re-exports it.
 */
import { createContext } from "react";
import type { AppFont } from "../theme-beta.ts";

export const AppFontContext = createContext<AppFont>(null);
