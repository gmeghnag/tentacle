# Lato (bundled for the Settings → Beta "Tema Lato (prova)" try-out)

Lato by Łukasz Dziedzic (tyPoland), <https://www.latofonts.com>, licensed under
the **SIL Open Font License 1.1** — the full text is [`OFL.txt`](OFL.txt), which
must ship with the fonts. "Lato" is a Reserved Font Name: these files are
unmodified, so the name is kept.

Source: `github.com/google/fonts`, `ofl/lato/` (fetched 2026-11-20).

| File | PostScript name | sha256 |
|---|---|---|
| `Lato-Regular.ttf` | `Lato-Regular` | `d636e4683231f931eda222d588e944d082bfd3bdba02f928bee461c0f185b251` |
| `Lato-Bold.ttf` | `Lato-Bold` | `8a0aace75d33794eece4b28187bfc1df0bbd2888b5d8a56e01788c8d65d16be1` |
| `Lato-Italic.ttf` | `Lato-Italic` | `e399c44efe1387100531d26c7e4800c5d12251b890d6654a3098c7c679cb1786` |
| `Lato-BoldItalic.ttf` | `Lato-BoldItalic` | `62c1b7f0d2e74b45960154c3520efc337b553db0961bfdc950d5618334596cc8` |

Loaded at runtime by `src/fonts-expo.ts`, only once the Beta switch is on;
which face a text gets is `src/theme-beta.ts`. Light is not bundled: no text in
the app uses a weight below 400.
