# tentacle-preview

Local Expo module (iOS only) behind the transcript preview cards
(`docs/feat/mobile-file-preview-cards.md`): `thumbnail(fileUri, outUri, wPt, hPt)`
(QuickLook `QLThumbnailGenerator`, `.thumbnail` only, JPEG out) and
`pdfPageCount(fileUri)` (PDFKit). Wired by `src/preview-native-expo.ts`; every
rule lives in the pure modules (`src/artifact-preview.ts`).
