# Figtree (bundled for the Settings → Beta "Tema Figtree (prova)" try-out)

Figtree by The Figtree Project Authors (Erik Kennedy),
<https://github.com/erikdkennedy/figtree>, licensed under the **SIL Open Font
License 1.1** — the full text is [`OFL.txt`](OFL.txt), which must ship with the
fonts. Its licence declares no Reserved Font Name; the files are unmodified.

Static faces, copied from the owner's download (Owner decision 2026-11-21 in
`docs/feat/mobile-theme-beta.md`); upstream source not re-fetched. PostScript
names read from each file's `name` table (nameID 6).

| File | PostScript name | sha256 |
|---|---|---|
| `Figtree-Regular.ttf` | `Figtree-Regular` | `448d74e778cc9774db27bd86cf451bba982b2e4dc348f610390eb6e3439cf6ca` |
| `Figtree-Bold.ttf` | `Figtree-Bold` | `71a35e2bd92a05427e2dc9897bab41f8a865800e148238007735b5934508198a` |
| `Figtree-Italic.ttf` | `Figtree-Italic` | `462e367f49de2d2b09b712be18a4026c66f196455388d904f1038e8d1c859e11` |
| `Figtree-BoldItalic.ttf` | `Figtree-BoldItalic` | `a79c6930ff01245bc1c809acfe80e8defe55cbd21086f12b148e382548f220e2` |

Loaded at runtime by `src/fonts-expo.ts`, only once the Beta switch is on;
which face a text gets is `src/theme-beta.ts`. Light/Medium/SemiBold are not
bundled: no text in the app uses a weight below 400, and 500 maps to Regular,
600+ to Bold.
