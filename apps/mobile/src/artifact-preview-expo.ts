/**
 * The preview cards' on-disk half (docs/feat/mobile-file-preview-cards.md):
 * where a made preview is kept, and the bounded text read. Wiring only, over
 * `expo-file-system`; the rules are `artifact-preview-source.ts`'s.
 *
 * Kept under the computer's cache directory (`artifacts/<computer>/previews/`),
 * so an unpair's `forgetComputer` (which removes that directory) drops them with
 * the versions they were made from.
 *
 * A preview is a few hundred KB at most (a JPEG page or 4 KB of text), and it is
 * deliberately NOT one of the 200 MB plan's entries: those bytes are the source
 * a preview is made FROM, and evicting a page because the artifact cap filled up
 * would throw away the cheap result of an expensive read. It is therefore bounded
 * on its own, by `planPreviewPrune` (`artifact-preview-store.ts`), applied here on
 * every `save` — otherwise every page card scrolled past would leave a JPEG (and
 * another per rotation width) until the phone is unpaired.
 */
import { Directory, File, FileMode, Paths } from "expo-file-system";
import { cacheDir } from "./artifact-cache-store.ts";
import { type PreviewStore, parseStoredPreview } from "./artifact-preview-source.ts";
import { PREVIEW_STORE_BYTES, planPreviewPrune } from "./artifact-preview-store.ts";

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
      const directory = new Directory(Paths.cache, dir);
      directory.create({ intermediates: true, idempotent: true });
      const file = at(meta.sha256, key, "json");
      file.create({ intermediates: true, overwrite: true });
      file.writeSync(JSON.stringify(preview));
      // Bounded here, on the write that could push it over: what goes is
      // `planPreviewPrune`'s decision, and the preview just saved is kept.
      // A prune that fails does not fail the card: the preview IS saved.
      try {
        const held = directory.list().filter((entry): entry is File => entry instanceof File);
        const files = held.map((entry) => {
          const info = entry.info();
          return { name: entry.name, size: info.size ?? 0, usedAt: info.modificationTime ?? 0 };
        });
        for (const name of planPreviewPrune(files, PREVIEW_STORE_BYTES, `${meta.sha256}-${key}`)) {
          const doomed = new File(Paths.cache, `${dir}/${name}`);
          if (doomed.exists) {
            doomed.delete();
          }
        }
      } catch {
        // The bound is best-effort; the preview the card is waiting for is not.
      }
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
