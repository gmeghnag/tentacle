/**
 * The Figtree faces' loader (docs/feat/mobile-theme-beta.md). Wiring only: which
 * face a text uses is `theme-beta.ts`. Loaded LAZILY, the first time the Beta
 * switch is on — with it off (the default) no font file is ever read.
 *
 * Each face is registered under its PostScript name (`FIGTREE_FACES`), so the name
 * a text asks for is the face's own on iOS whichever way it is looked up.
 * Figtree: SIL Open Font License 1.1, `assets/fonts/OFL.txt`.
 *
 * Eight files, one per (weight, style) the app can ask (docs/fix/mobile-transcript-type.md):
 * with only 400/700 bundled, a 500 was silently rounded to Regular.
 */
import * as Font from "expo-font";
import { FIGTREE_FACES } from "./theme-beta.ts";

let loading: Promise<void> | null = null;

/** Registers the eight faces once per run; a failure rejects and the next call retries. */
export function loadFigtree(): Promise<void> {
  loading ??= Font.loadAsync({
    [FIGTREE_FACES.regular]: require("../assets/fonts/Figtree-Regular.ttf"),
    [FIGTREE_FACES.medium]: require("../assets/fonts/Figtree-Medium.ttf"),
    [FIGTREE_FACES.semiBold]: require("../assets/fonts/Figtree-SemiBold.ttf"),
    [FIGTREE_FACES.bold]: require("../assets/fonts/Figtree-Bold.ttf"),
    [FIGTREE_FACES.italic]: require("../assets/fonts/Figtree-Italic.ttf"),
    [FIGTREE_FACES.mediumItalic]: require("../assets/fonts/Figtree-MediumItalic.ttf"),
    [FIGTREE_FACES.semiBoldItalic]: require("../assets/fonts/Figtree-SemiBoldItalic.ttf"),
    [FIGTREE_FACES.boldItalic]: require("../assets/fonts/Figtree-BoldItalic.ttf"),
  }).catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}
