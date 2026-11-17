import * as DocumentPicker from "expo-document-picker";
/**
 * The phone's PDF SOURCE (docs/feat/pdf-read.md D7) — a thin adapter, no
 * branching: every decision is `pdf-input.ts`'s (pure, tested), and this file
 * only performs the effects it names.
 *
 * It is the ONLY module in the app that imports `expo-document-picker`, which is
 * what keeps the decision logic testable under `bun test` (the picker does not
 * run there) and lets a fake source replace it in the compose tests.
 *
 * The phone never PARSES a PDF: there is no pdf.js in Hermes, and (for a pod
 * daemon) the laptop's binary extractor is the one that may read it. So the pick
 * ends at `attachDocument` — the session uploads the bytes or extracts the text,
 * by the daemon's own capability (AGENTS §7: one session path).
 */
import { Directory, File, Paths } from "expo-file-system";
import type { PickedDocument, PickedPdf } from "./compose-chips.ts";
import { MAX_PDF_ATTACH_BYTES, nextPdfStep, pdfCopyName } from "./pdf-input.ts";

/** Where the app's PDF copies live (`<documents>/pdfs`), beside the photo ones. */
const PDF_DIR = "pdfs";

/**
 * A per-process counter, part of every copy's name (`pdfCopyName`): two picks in
 * one millisecond must never resolve to one file. Never reset — a counter that
 * restarts at 1 on relaunch only matters if the clock also went backwards, and a
 * stale file with the same name is then caught by `overwrite: false`.
 */
let pickSeq = 0;

function pdfDir(): Directory {
  const dir = new Directory(Paths.document, PDF_DIR);
  dir.create({ intermediates: true, idempotent: true });
  return dir;
}

/** Where the app's PDF copies live (what pruning may trim, like `photosRoot`). */
export function pdfsRoot(): string {
  return pdfDir().uri;
}

/**
 * A copy of `bytes` in the app's own folder, under a name unique to this pick
 * (`pdfCopyName`: a stamp AND a counter, so neither a same-millisecond pick nor
 * a clock that went backwards can collide).
 *
 * The copy exists because the picked URI is a temporary one (a cache file the
 * system may collect, or a UIDocumentPicker hand-off that vanishes with its
 * provider) and the outbox item OUTLIVES the pick: a retry minutes later, or
 * after a relaunch, must still find the bytes.
 */
function copyInto(bytes: Uint8Array, name: string): string {
  pickSeq += 1;
  const target = new File(pdfDir(), pdfCopyName(name, { stamp: Date.now(), seq: pickSeq }));
  // NOT `overwrite: true`: a collision would mean two outbox items share one
  // file (the second pick's bytes replacing the first's), so it must throw here
  // — where the pick is refused — rather than swap documents silently.
  target.create({ overwrite: false });
  target.write(bytes);
  return target.uri;
}

/**
 * One pick of the Files app. `[]` when the person cancelled; every refusal is a
 * `Picked{kind:"refused"}` (a chip shows it) — never an exception, because "the
 * person picked a 30 MB PDF" is not an error.
 *
 * `maxBytes` is the daemon's advertised cap when it is smaller than ours
 * (`documentsInput().maxBytes`): refusing here rather than after 30 MB have
 * crossed the wire is the whole point of checking at the pick.
 */
export async function pickPdf(
  taken: number,
  maxBytes: number = MAX_PDF_ATTACH_BYTES,
): Promise<readonly PickedPdf[]> {
  const result = await DocumentPicker.getDocumentAsync({
    // A HINT for the picker's own UI, never evidence: `nextPdfStep` sniffs the
    // header, because a provider can serve `application/pdf` for a text file.
    type: "application/pdf",
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled) {
    return [];
  }
  const out: PickedPdf[] = [];
  for (const [index, asset] of result.assets.entries()) {
    out.push(await preparePickedPdf(asset, taken + index, maxBytes));
  }
  return out;
}

/** Read one picked asset's bytes, decide, and copy it — or refuse with a reason. */
async function preparePickedPdf(
  asset: {
    readonly uri: string;
    readonly name: string;
    readonly size?: number;
  },
  taken: number,
  maxBytes: number,
): Promise<PickedPdf> {
  const bytes = await new File(asset.uri).bytes();
  const step = nextPdfStep({
    bytes,
    taken,
    maxBytes,
    name: asset.name,
    // The picker's own measurement: the ONLY way to tell an iCloud placeholder
    // (a zero-byte copy of a real file) from an empty pick.
    ...(asset.size === undefined ? {} : { declaredSize: asset.size }),
  });
  if (step.kind === "refuse") {
    return { kind: "refused", detail: step.detail };
  }
  return {
    kind: "document",
    file: copyInto(bytes, step.pdf.name),
    name: step.pdf.name,
    size: step.pdf.size,
    bytes,
  };
}
