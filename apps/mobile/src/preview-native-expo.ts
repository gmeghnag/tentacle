/**
 * `PreviewNative` over the local native module `TentaclePreview`
 * (`modules/tentacle-preview/`, docs/feat/mobile-file-preview-cards.md): the ONE
 * native import of the preview cards, kept to wiring. Every rule lives in
 * `artifact-preview.ts` / `artifact-preview-source.ts`.
 *
 * `requireOptionalNativeModule`: on a build without it (Android, an older dev
 * client) the port is null and a page card keeps its kind's symbol.
 */
import { requireOptionalNativeModule } from "expo";
import type { PreviewNative } from "./artifact-preview-source.ts";

interface Native {
  thumbnail(
    fileUri: string,
    outUri: string,
    widthPt: number,
    heightPt: number,
  ): Promise<{ width: number; height: number }>;
  pdfPageCount(fileUri: string): number | null;
}

const native = requireOptionalNativeModule<Native>("TentaclePreview");

export const PREVIEW_NATIVE: PreviewNative | null =
  native === null
    ? null
    : {
        thumbnail: (fileUri, outUri, widthPt, heightPt) =>
          native.thumbnail(fileUri, outUri, widthPt, heightPt),
        pdfPageCount: (fileUri) => native.pdfPageCount(fileUri) ?? null,
      };
