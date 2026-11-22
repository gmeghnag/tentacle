# Figtree (bundled for the Settings → Beta "Tema Figtree (prova)" try-out)

Figtree by The Figtree Project Authors (Erik Kennedy),
<https://github.com/erikdkennedy/figtree>, licensed under the **SIL Open Font
License 1.1** — the full text is [`OFL.txt`](OFL.txt), which must ship with the
fonts. Its licence declares no Reserved Font Name; the files are unmodified.

Static faces, copied from the same place as the owner's download (Owner decision
2026-11-21 in `docs/feat/mobile-theme-beta.md`), the upstream repository
`github.com/erikdkennedy/figtree` `fonts/ttf/` at `master`; Medium, MediumItalic,
SemiBold and SemiBoldItalic fetched 2026-11-22
(`docs/fix/mobile-transcript-type.md` — the app asks 500/600 and iOS cannot find a
weight a custom family does not carry). The four faces already bundled were
re-fetched from that same URL and are byte-identical to the tree's, so all eight
files come from one source. PostScript names read from each file's `name` table
(nameID 6); the weight class from its `OS/2` table (`usWeightClass`).

| File | PostScript name | weight | sha256 |
|---|---|---|---|
| `Figtree-Regular.ttf` | `Figtree-Regular` | 400 | `448d74e778cc9774db27bd86cf451bba982b2e4dc348f610390eb6e3439cf6ca` |
| `Figtree-Medium.ttf` | `Figtree-Medium` | 500 | `358a4de79ae6c3fd7c6a54fcd778c1101ba376af75b8463e715df6988387bc19` |
| `Figtree-SemiBold.ttf` | `Figtree-SemiBold` | 600 | `35fc4508d627f8402a7d5ae91d842d1adb36846eea902c0a849642afecd0ac74` |
| `Figtree-Bold.ttf` | `Figtree-Bold` | 700 | `71a35e2bd92a05427e2dc9897bab41f8a865800e148238007735b5934508198a` |
| `Figtree-Italic.ttf` | `Figtree-Italic` | 400 | `462e367f49de2d2b09b712be18a4026c66f196455388d904f1038e8d1c859e11` |
| `Figtree-MediumItalic.ttf` | `Figtree-MediumItalic` | 500 | `5cabcef8a72e2cd34a3ea244b1ab99ccad5cc5fb5488e5df163b21eb8656b9bc` |
| `Figtree-SemiBoldItalic.ttf` | `Figtree-SemiBoldItalic` | 600 | `0302171fbef7747ff915b55495a2fdb3123fa50f52ad6c1907d480cb9091eec9` |
| `Figtree-BoldItalic.ttf` | `Figtree-BoldItalic` | 700 | `a79c6930ff01245bc1c809acfe80e8defe55cbd21086f12b148e382548f220e2` |

Medium and SemiBold declare their OWN family names in their `name` tables
(`Figtree Medium`, `Figtree SemiBold`): each of those families holds exactly one
normal face, which is why the faces are loaded and asked for by PostScript name
(`src/fonts-expo.ts`, `src/theme-beta.ts`).

Loaded at runtime by `src/fonts-expo.ts`, only once the Beta switch is on; which
face a text gets is `src/theme-beta.ts`. Every weight the tokens ask (400, 500,
600, 700) is a bundled file, so a token's weight is never silently rounded —
`test/theme-fonts.test.ts` walks every token and fails if one is.
