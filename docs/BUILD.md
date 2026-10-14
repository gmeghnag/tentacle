# Building a standalone binary

`agent-harness` compiles to a single self-contained executable with
[`bun build --compile`](https://bun.sh/docs/bundler/executables) — no Bun or
`node_modules` needed on the target machine.

## Build it

```sh
bun install          # once
bun run compile      # → dist/agent-harness
```

`bun run compile` runs `scripts/build.ts`, which calls `Bun.build({ compile })`
with a small plugin (see below). The result is `dist/agent-harness` (~60 MB — it
embeds the Bun runtime). Run it like any binary:

```sh
./dist/agent-harness --help
./dist/agent-harness                       # interactive TUI
./dist/agent-harness "summarise this repo" # one-shot
./dist/agent-harness serve --token "$(cat ~/.cache/harness-remote-token)"
```

Configuration still comes from `~/.config/agent-harness/` and the `HARNESS_*`
environment variables exactly as when run from source.

## Cross-compile

Pass a Bun target triple via `TARGET`:

```sh
TARGET=bun-linux-x64     bun run compile   # Linux x64
TARGET=bun-linux-arm64   bun run compile   # Linux arm64
TARGET=bun-darwin-arm64  bun run compile   # macOS Apple Silicon
TARGET=bun-darwin-x64    bun run compile   # macOS Intel
TARGET=bun-windows-x64   bun run compile   # Windows x64 (produces .exe)
```

(See `bun build --help` for the full list.) All of them are produced from one
host; no target toolchain is required.

## Why a build script instead of a one-line `bun build --compile`

Two of the TUI's transitive dependencies don't bundle cleanly on their own, so
`scripts/build.ts` smooths them over:

1. **`react-devtools-core`** — `ink` imports it eagerly but only uses it in its
   (never-enabled) DEV mode. A local no-op stub (`stubs/react-devtools-core`,
   wired as a root `dependencies` entry) satisfies the import without pulling in
   the real, heavy package.
2. **`yoga-wasm-web` (`yoga.wasm`)** — ink's layout engine reads `yoga.wasm`
   from disk at runtime, which a compiled binary has no filesystem for. The
   build plugin aliases `yoga-wasm-web/auto` to `scripts/yoga-auto.ts` and
   embeds the wasm bytes (base64) through a `virtual:yoga-wasm` module, so the
   layout engine is fully self-contained in the binary.

Both are build-time concerns only; running from source (`bun run
packages/cli/src/main.ts`) needs neither.

## macOS code signing (Apple Silicon)

`bun build --compile` appends the JS payload *after* the linker ad-hoc-signs the
executable, so the embedded signature no longer matches the file. The binary
runs where it was built, but macOS SIGKILLs it (`killed: 9`) once it is copied or
moved to a new path (e.g. installing it to `~/bin`). So `scripts/build.ts`
re-signs the output ad-hoc (`codesign --sign - --force`) on macOS after
compiling; the signature then covers the whole file and survives relocation.

If you have an older, unsigned copy lying around, either recompile and reinstall,
or re-sign it in place:

```sh
codesign --sign - --force ~/bin/yaha
```
