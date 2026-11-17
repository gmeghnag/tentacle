/**
 * The diagram render service's native half (docs/feat/model-diagrams.md D6):
 * the app-wide service with its file store (`Paths.cache/diagrams/`, the
 * artifacts cache's place), and the renderer page loaded from the bundled asset.
 * No decisions here — `diagram-render-service.ts` owns them.
 */
import { File, Paths } from "expo-file-system";
import { Image } from "react-native";
import { createDiagramCache, diagramCachePath } from "./diagram-cache.ts";
import { type DiagramFileStore, createDiagramRenderService } from "./diagram-render-service.ts";

const store: DiagramFileStore = {
  async read(path) {
    const file = new File(Paths.cache, path);
    return file.exists ? await file.text() : null;
  },
  async write(path, svg) {
    const file = new File(Paths.cache, path);
    file.create({ intermediates: true, overwrite: true });
    await file.write(svg);
  },
};

/** One service for the app: every row and the one hidden renderer share it. */
export const diagramRenderService = createDiagramRenderService({
  cache: createDiagramCache(),
  files: store,
});

/** The rendered SVG's file uri when it is on disk (Share), else `null`. */
export function diagramFileUri(key: string): string | null {
  const file = new File(Paths.cache, diagramCachePath(key));
  return file.exists ? file.uri : null;
}

let page: Promise<string> | null = null;

/**
 * The generated renderer page (`assets/diagram/renderer.html`, a Metro asset:
 * `html` is in Metro's default `assetExts`). Read once: from Metro in a dev
 * build, from the app bundle (`file:`) in a release one. A failed read is
 * retried on the next mount.
 */
export function loadRendererPage(): Promise<string> {
  if (page === null) {
    const asset = Image.resolveAssetSource(require("../assets/diagram/renderer.html"));
    if (asset === undefined) return Promise.reject(new Error("diagram renderer asset missing"));
    page = fetch(asset.uri)
      .then((response) => response.text())
      .catch((error: unknown) => {
        page = null;
        throw error;
      });
  }
  return page;
}
