/**
 * Build the relay's standalone binary with `bun build --compile`
 * (docs/feat/mobile-relay.md R7; the runbook is `docs/ops/relay-deploy.md`).
 *
 * Unlike `scripts/build.ts` this needs no plugin: the relay pulls in no ink, no
 * yoga.wasm and no worker entrypoint, so the bundle is `main.ts` and its own
 * imports. It is also built for a DIFFERENT machine (the deploy host), hence
 * `bun-linux-x64` by default rather than the host's triple — an accidental
 * macOS executable is the one mistake that only shows up on the server.
 *
 * The paths and the target are exported as pure functions so `deploy.test.ts`
 * can pin them against the systemd unit and the runbook: the three artefacts and
 * this script must name the same binary, or the owner's deploy fails on a server
 * (AGENTS §9 — a guard must fail on a real mismatch, not on a missing file).
 *
 * Usage (from the repo root):
 *   bun apps/relay/deploy/build.ts                       # → dist/tentacle-relay (linux-x64)
 *   TARGET=bun-linux-arm64 bun apps/relay/deploy/build.ts
 */
import { resolve } from "node:path";

/** The installed binary's name; the unit and the runbook use it verbatim. */
export const RELAY_BINARY_NAME = "tentacle-relay";

/** The deploy host's triple (a Linux x64 box behind Caddy — decision 9). */
export const DEFAULT_RELAY_TARGET = "bun-linux-x64";

/**
 * The triples `bun build --compile` accepts. Deliberately strict: passed a bare
 * `linux-x64` Bun does not refuse, it quietly builds the HOST'S binary, so a
 * dev-machine run would hand the owner a macOS executable named for a server.
 */
const BUN_TARGET = /^bun-(linux|darwin|windows)-(x64|arm64)(-(baseline|modern|musl))?$/;

/** The relay's entrypoint, under the repo root. */
export function relayEntrypoint(root: string): string {
  return resolve(root, "apps/relay/src/main.ts");
}

/** Where the compiled binary goes (`dist/` is gitignored, as for the CLI). */
export function relayOutfile(root: string): string {
  return resolve(root, "dist", RELAY_BINARY_NAME);
}

/** The compile target: `TARGET` when set, else the deploy host's. */
export function relayBuildTarget(
  env: Record<string, string | undefined>,
): { ok: true; target: string } | { ok: false; error: string } {
  const raw = env.TARGET?.trim();
  if (raw === undefined || raw === "") {
    return { ok: true, target: DEFAULT_RELAY_TARGET };
  }
  if (!BUN_TARGET.test(raw)) {
    return {
      ok: false,
      error: `TARGET must be a Bun triple (e.g. ${DEFAULT_RELAY_TARGET}), got ${JSON.stringify(raw)}`,
    };
  }
  return { ok: true, target: raw };
}

/** Compile `outfile` for `target`; `false` means the build itself failed. */
export async function buildRelayBinary(
  outfile: string,
  target: string,
  root: string,
): Promise<boolean> {
  const result = await Bun.build({
    entrypoints: [relayEntrypoint(root)],
    // @ts-expect-error - `compile` is supported by the Bun bundler
    compile: { outfile, target },
  });
  for (const log of result.logs) {
    console.error(String(log));
  }
  return result.success;
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..", "..", "..");
  const chosen = relayBuildTarget(process.env);
  if (!chosen.ok) {
    console.error(`tentacle-relay: ${chosen.error}`);
    process.exit(1);
  }
  const outfile = relayOutfile(root);
  if (!(await buildRelayBinary(outfile, chosen.target, root))) {
    process.exit(1);
  }
  console.log(`compiled ${RELAY_BINARY_NAME} (${chosen.target}) → ${outfile}`);
}
