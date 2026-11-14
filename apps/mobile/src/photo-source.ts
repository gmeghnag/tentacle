import { type ImageMimeType, MAX_ATTACHMENTS_PER_MESSAGE } from "@tentacle/core";
import { Directory, File, Paths } from "expo-file-system";
/**
 * The phone's photo SOURCE (docs/feat/mobile-compose.md D5) — a thin adapter,
 * no branching: every decision is `photo-input.ts`'s (pure, tested), and this
 * file only performs the effects it names.
 *
 * It is the ONLY module in the app that imports `expo-image-picker`,
 * `expo-image-manipulator` or `expo-file-system`, which is what keeps the
 * decision logic testable under `bun test` (none of the three runs there) and
 * lets a `__DEV__` fixture source replace it for E2E if the picker ever stops
 * being drivable (Step 0's fallback — not needed: PHPicker IS drivable, see
 * Execution).
 *
 * The loop it runs is `nextPhotoStep`: sniff → maybe convert (HEIC → JPEG) →
 * maybe downscale once → sniff again → `ready`, or `refuse` with a reason a
 * chip can show. Each effect happens at most once, so a photo that stays over
 * the cap is refused instead of shrunk forever.
 */
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import type { PhotoRefusal, PhotoStep, ReadyPhoto } from "./photo-input.ts";
import { nextPhotoStep, photoCopyName, photoName } from "./photo-input.ts";

/** What one picked photo became: a sendable ref's ingredients, or a refusal. */
export type PickedPhoto =
  | {
      readonly kind: "ready";
      readonly photo: ReadyPhoto;
      readonly bytes: Uint8Array;
      /** The copy in the app's own folder — what the outbox item keeps. */
      readonly file: string;
    }
  | { readonly kind: "refused"; readonly reason: PhotoRefusal; readonly detail: string };

/** Where the picker/camera put things the app keeps (excluded from iCloud backup by the outbox). */
const PHOTO_DIR = "photos";

/**
 * A per-process counter, part of every copy's name (`photoCopyName`): two picks
 * in one millisecond must never resolve to one file. Never reset — a counter
 * that restarts at 1 on relaunch only matters if the clock also went backwards,
 * and a stale file with the same name is then caught by `overwrite: false`.
 */
let pickSeq = 0;

function photoDir(): Directory {
  const dir = new Directory(Paths.document, PHOTO_DIR);
  dir.create({ intermediates: true, idempotent: true });
  return dir;
}

/**
 * A copy of `bytes` in the app's own folder, under a name unique to this pick
 * (`photoCopyName`: a stamp AND a counter, so neither a same-millisecond pick
 * nor a clock that went backwards can collide).
 */
function copyInto(
  bytes: Uint8Array,
  photo: { readonly name: string | undefined; readonly mimeType: ImageMimeType },
): string {
  pickSeq += 1;
  const target = new File(
    photoDir(),
    photoCopyName(photo.name, photo.mimeType, { stamp: Date.now(), seq: pickSeq }),
  );
  // NOT `overwrite: true`: a name collision would mean two outbox items share
  // one file (the second pick's bytes replacing the first's), so it must throw
  // here — where the pick is refused — rather than swap images silently.
  target.create({ overwrite: false });
  target.write(bytes);
  return target.uri;
}

/**
 * Read the bytes of a picked asset, decide, and perform at most one
 * conversion and one downscale. Never throws for a refusal: a refusal is a
 * value (a chip shows it), because "the user picked a 20 MB PNG" is not an
 * exception.
 */
export async function preparePickedPhoto(
  asset: { readonly uri: string; readonly fileName?: string | null },
  taken: number,
): Promise<PickedPhoto> {
  let bytes = await new File(asset.uri).bytes();
  // A picked URI's own name is the picker's claim; `photoName` sanitises it by
  // the wire's rule and drops it when nothing safe is left.
  const name = photoName(asset.fileName ?? undefined);
  let converted = false;
  let downscaled = false;
  // Three turns at most (`nextPhotoStep`'s own bound): sniff, after the
  // conversion, after the shrink.
  for (let turn = 0; turn < 3; turn += 1) {
    const step: PhotoStep = nextPhotoStep({
      bytes,
      taken,
      converted,
      downscaled,
      ...(name === undefined ? {} : { name }),
    });
    if (step.kind === "refuse") {
      return { kind: "refused", reason: step.reason, detail: step.detail };
    }
    if (step.kind === "ready") {
      return {
        kind: "ready",
        photo: step.photo,
        bytes,
        // `photoCopyName` (pure, tested): a name unique to this pick, so two
        // picks can never share one file (`copyInto` writes `overwrite: false`).
        file: copyInto(bytes, { name, mimeType: step.photo.mimeType }),
      };
    }
    if (step.kind === "convert-to-jpeg") {
      converted = true;
      bytes = await convert(asset.uri, { format: SaveFormat.JPEG, compress: 0.9 });
      continue;
    }
    downscaled = true;
    bytes = await convert(asset.uri, { format: SaveFormat.JPEG, compress: 0.8 }, 0.5);
  }
  // Unreachable through `nextPhotoStep`'s own bound; a refusal, never a loop.
  return {
    kind: "refused",
    reason: "not-an-image",
    detail: "the photo could not be converted into a sendable image",
  };
}

/**
 * Re-encode `uri` through `expo-image-manipulator` and read the result's
 * bytes. `scale` below 1 shrinks the width (the one downscale step, which
 * keeps the aspect ratio); `undefined` keeps the size and only changes the
 * format (HEIC → JPEG).
 *
 * The copy through `new Uint8Array(...)` is not ceremony: `expo-file-system`
 * types its bytes as `Uint8Array<ArrayBuffer>` and this package's own type is
 * the wider `ArrayBufferLike`, so the value is normalised at the boundary
 * rather than cast away at every use.
 */
async function convert(
  uri: string,
  options: { readonly format: SaveFormat; readonly compress: number },
  scale?: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const context = ImageManipulator.manipulate(uri);
  if (scale !== undefined) {
    const image = await context.renderAsync();
    context.resize({ width: Math.max(1, Math.round(image.width * scale)) });
  }
  const rendered = await context.renderAsync();
  const saved = await rendered.saveAsync(options);
  return new Uint8Array(await new File(saved.uri).bytes());
}

/** One picker result, as the pick's photos (or `[]` when the person cancelled). */
export async function pickFromLibrary(taken: number): Promise<readonly PickedPhoto[]> {
  const limit = MAX_ATTACHMENTS_PER_MESSAGE - taken;
  if (limit <= 0) {
    return [
      {
        kind: "refused",
        reason: "too-many",
        detail: `a message carries at most ${MAX_ATTACHMENTS_PER_MESSAGE} photos`,
      },
    ];
  }
  const result = await ImagePicker.launchImageLibraryAsync({
    // PHPicker: no library permission prompt (D5), multi-select up to the cap.
    mediaTypes: ["images"],
    allowsMultipleSelection: limit > 1,
    selectionLimit: limit,
    quality: 1,
  });
  return result.canceled ? [] : prepareAll(result.assets, taken);
}

/** One camera shot. The permission is asked HERE, at first use (decision 10). */
export async function takePhoto(taken: number): Promise<readonly PickedPhoto[]> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) {
    return [
      {
        kind: "refused",
        reason: "empty",
        detail: permission.canAskAgain
          ? "camera access was not granted"
          : "camera access is off — allow it in Settings to take a photo",
      },
    ];
  }
  const result = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 1 });
  return result.canceled ? [] : prepareAll(result.assets, taken);
}

/** Every asset of one pick, prepared in order (the cap counts what is already attached). */
async function prepareAll(
  assets: readonly { readonly uri: string; readonly fileName?: string | null }[],
  taken: number,
): Promise<readonly PickedPhoto[]> {
  const out: PickedPhoto[] = [];
  for (const asset of assets) {
    out.push(await preparePickedPhoto(asset, taken + out.length));
  }
  return out;
}
