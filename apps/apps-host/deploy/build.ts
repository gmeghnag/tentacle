/**
 * Build the apps host's standalone binary with `bun build --compile` (as
 * `apps/relay/deploy/build.ts`; the runbook is `docs/ops/apps-host-deploy.md`).
 * Built for the deploy host, so `bun-linux-x64` unless `TARGET` says otherwise.
 *
 * Usage (from the repo root):
 *   bun apps/apps-host/deploy/build.ts                    # → dist/tentacle-apps-host
 *   TARGET=bun-linux-arm64 bun apps/apps-host/deploy/build.ts
 */
import { resolve } from "node:path";

/** The installed binary's name; the unit and the runbook use it verbatim. */
export const APPS_HOST_BINARY_NAME = "tentacle-apps-host";

export const DEFAULT_APPS_HOST_TARGET = "bun-linux-x64";

/** Strict: given a bare `linux-x64` Bun quietly builds the HOST's binary. */
const BUN_TARGET = /^bun-(linux|darwin|windows)-(x64|arm64)(-(baseline|modern|musl))?$/;

export function appsHostEntrypoint(root: string): string {
  return resolve(root, "apps/apps-host/src/main.ts");
}

export function appsHostOutfile(root: string): string {
  return resolve(root, "dist", APPS_HOST_BINARY_NAME);
}

export function appsHostBuildTarget(
  env: Record<string, string | undefined>,
): { ok: true; target: string } | { ok: false; error: string } {
  const raw = env.TARGET?.trim();
  if (raw === undefined || raw === "") {
    return { ok: true, target: DEFAULT_APPS_HOST_TARGET };
  }
  if (!BUN_TARGET.test(raw)) {
    return {
      ok: false,
      error: `TARGET must be a Bun triple (e.g. ${DEFAULT_APPS_HOST_TARGET}), got ${JSON.stringify(raw)}`,
    };
  }
  return { ok: true, target: raw };
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..", "..", "..");
  const chosen = appsHostBuildTarget(process.env);
  if (!chosen.ok) {
    console.error(`${APPS_HOST_BINARY_NAME}: ${chosen.error}`);
    process.exit(1);
  }
  const outfile = appsHostOutfile(root);
  const result = await Bun.build({
    entrypoints: [appsHostEntrypoint(root)],
    // @ts-expect-error - `compile` is supported by the Bun bundler
    compile: { outfile, target: chosen.target },
  });
  for (const log of result.logs) {
    console.error(String(log));
  }
  if (!result.success) {
    process.exit(1);
  }
  console.log(`compiled ${APPS_HOST_BINARY_NAME} (${chosen.target}) → ${outfile}`);
}
