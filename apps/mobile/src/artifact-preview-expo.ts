/**
 * The preview cards' on-disk half (docs/feat/mobile-file-preview-cards.md):
 * where a made preview is kept, and the bounded text read. Wiring only, over
 * `expo-file-system`; the rules are `artifact-preview-source.ts`'s.
 *
 * Kept under the computer's cache directory (`artifacts/<computer>/previews/`),
 * so an unpair's `forgetComputer` (which removes that directory) drops them with
 * the versions they were made from. A preview is a few hundred KB at most (a
 * JPEG page or 4 KB of text) and is not counted in the 200 MB cap (Notes/debt).
 */
import { Directory, File, FileMode, Paths } from "expo-file-system";
import { cacheDir } from "./artifact-cache-store.ts";
import { type PreviewStore, parseStoredPreview } from "./artifact-preview-source.ts";

function previewsDir(computerId: string): string {
  return `${cacheDir(computerId)}/previews`;
}

/** The store for one computer's previews. */
export function previewStore(computerId: string): PreviewStore {
  const dir = previewsDir(computerId);
  const at = (sha256: string, key: string, ext: string): File =>
    new File(Paths.cache, `${dir}/${sha256}-${key}.${ext}`);
  return {
    load(meta, key) {
      const file = at(meta.sha256, key, "json");
      if (!file.exists) {
        return null;
      }
      const preview = parseStoredPreview(file.textSync());
      // A page whose image is gone is not a preview: it is made again.
      if (preview?.kind === "picture" && !new File(preview.uri).exists) {
        return null;
      }
      return preview;
    },
    save(meta, key, preview) {
      new Directory(Paths.cache, dir).create({ intermediates: true, idempotent: true });
      const file = at(meta.sha256, key, "json");
      file.create({ intermediates: true, overwrite: true });
      file.writeSync(JSON.stringify(preview));
    },
    imageUri(meta, key) {
      return at(meta.sha256, key, "jpg").uri;
    },
  };
}

/** Up to `maxBytes` of a local file, decoded as UTF-8 (a cut character is replaced). */
export function readTextHead(uri: string, maxBytes: number): string {
  const handle = new File(uri).open(FileMode.ReadOnly);
  try {
    return new TextDecoder().decode(handle.readBytesSync(maxBytes));
  } finally {
    handle.close();
  }
}
