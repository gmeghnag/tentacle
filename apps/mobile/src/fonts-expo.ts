/**
 * The Lato faces' loader (docs/feat/mobile-theme-beta.md). Wiring only: which
 * face a text uses is `theme-beta.ts`. Loaded LAZILY, the first time the Beta
 * switch is on — with it off (the default) no font file is ever read.
 *
 * Each face is registered under its PostScript name (`LATO_FACES`), so the name
 * a text asks for is the face's own on iOS whichever way it is looked up.
 * Lato: SIL Open Font License 1.1, `assets/fonts/OFL.txt`.
 */
import * as Font from "expo-font";
import { LATO_FACES } from "./theme-beta.ts";

let loading: Promise<void> | null = null;

/** Registers the four faces once per run; a failure rejects and the next call retries. */
export function loadLato(): Promise<void> {
  loading ??= Font.loadAsync({
    [LATO_FACES.regular]: require("../assets/fonts/Lato-Regular.ttf"),
    [LATO_FACES.bold]: require("../assets/fonts/Lato-Bold.ttf"),
    [LATO_FACES.italic]: require("../assets/fonts/Lato-Italic.ttf"),
    [LATO_FACES.boldItalic]: require("../assets/fonts/Lato-BoldItalic.ttf"),
  }).catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}
