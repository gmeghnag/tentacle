/**
 * A `serve` removes its record on every death it can catch
 * (docs/fix/daemon-records-stale.md), proven on REAL processes: Bun runs no
 * `exit` listener on an unhandled signal, so only a spawned process shows it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { untilAsync } from "../../client/test/support/fakes.ts";

const SRC = join(import.meta.dir, "..", "src");
const CONFIG = join(import.meta.dir, "..", "..", "config", "src", "index.ts");

const dirs: string[] = [];
const children: { kill(signal: "SIGKILL"): void }[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "serve-signal-"));
  dirs.push(root);
  const configDir = join(root, "config");
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  const env = { ...process.env, HOME: root, TENTACLE_CONFIG_DIR: configDir };
  return { root, project, env, daemons: join(configDir, "daemons"), configDir };
}

/** The directory's names; a directory that is not there yet is empty. */
function names(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

describe("a signalled serve removes its record", () => {
  for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
    test(`${signal}: a graceful stop, exit 0, no record left`, async () => {
      const { project, env, daemons } = scratch();
      const child = Bun.spawn(
        [process.execPath, join(SRC, "main.ts"), "serve", "--port", "0", "--no-relay"],
        { cwd: project, env, stdout: "pipe", stderr: "pipe" },
      );
      children.push(child);
      let log = "";
      const decoder = new TextDecoder();
      const drained = child.stderr.pipeTo(
        new WritableStream({
          write(chunk: Uint8Array) {
            log += decoder.decode(chunk);
          },
        }),
      );
      // The signal handlers are installed before the listening line is printed.
      await untilAsync(async () => log.includes("daemon listening on"), 20_000);
      expect(names(daemons)).toEqual([`${child.pid}.json`]);
      child.kill(signal);
      const code = await child.exited;
      await drained;
      expect({ code, signal: child.signalCode, left: names(daemons) }).toEqual({
        code: 0,
        signal: null,
        left: [],
      });
    }, 30_000);
  }

  test("an uncaught error: the exit listener removes the record", async () => {
    const { root, project, env, daemons, configDir } = scratch();
    const script = join(root, "crash.ts");
    writeFileSync(
      script,
      `import { readdirSync } from "node:fs";
import { loadConfig } from ${JSON.stringify(CONFIG)};
import { startDaemon } from ${JSON.stringify(join(SRC, "serve.ts"))};
const config = await loadConfig({
  configDir: ${JSON.stringify(configDir)},
  cwd: ${JSON.stringify(project)},
  scaffold: false,
  env: { HOME: ${JSON.stringify(root)}, TENTACLE_MODEL_API_KEY: "k" },
});
await startDaemon(config, { host: "127.0.0.1", port: 0, relay: { noRelay: true } });
console.log("records: " + readdirSync(${JSON.stringify(daemons)}).join(" "));
setTimeout(() => {
  throw new Error("boom");
}, 0);
`,
    );
    const child = Bun.spawn([process.execPath, script], {
      cwd: project,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    children.push(child);
    const [out, errors, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    // It died of OUR throw, with its record on disk until then.
    expect(errors).toContain("boom");
    expect(out).toContain(`records: ${child.pid}.json`);
    expect(code).toBe(1);
    expect(names(daemons)).toEqual([]);
  }, 30_000);
});
