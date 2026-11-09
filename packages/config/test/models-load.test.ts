/**
 * `loadConfig` and the `models` entries' keys (docs/feat/models-map.md A5):
 * every distinct key command runs once, at load, never for a pod daemon; a
 * failure names the entry and never carries a key. Scratch config dirs only.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILENAME } from "../src/defaults.ts";
import { ConfigError, loadConfig } from "../src/load.ts";

let dir: string;
let configDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "models-load-"));
  configDir = join(dir, "cfg");
  await mkdir(configDir, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = (config: unknown) =>
  writeFile(join(configDir, CONFIG_FILENAME), JSON.stringify(config), "utf8");

const ENTRY_KEY = "s3cret-entry";
const MAIN_KEY = "s3cret-main";

function spyRunner(outputs: Record<string, string | Error>) {
  const calls: string[] = [];
  const run = async (command: string): Promise<string> => {
    calls.push(command);
    const out = outputs[command];
    if (out instanceof Error) {
      throw out;
    }
    return out ?? "";
  };
  return { calls, run };
}

type NoTerminal = {
  report: (name: string, line: string) => void;
  timeoutMs?: number;
};

const load = (
  run: (c: string, signal?: AbortSignal) => Promise<string>,
  extra: { podDaemon?: boolean; modelKeysNoTerminal?: NoTerminal; model?: string } = {},
) => loadConfig({ env: { HOME: dir }, configDir, cwd: dir, runCommand: run, ...extra });

/** A collector for `modelKeysNoTerminal.report`. */
function reports(timeoutMs?: number) {
  const lines: string[] = [];
  const option: NoTerminal = {
    report: (name, line) => lines.push(`${name}: ${line}`),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
  return { lines, option };
}

describe("models: keys at load", () => {
  test("each distinct command runs once; inherited entries get the main command's key", async () => {
    await write({
      model: { apiKeyCommand: "main-cmd" },
      models: {
        same: { model: "small" },
        a: { baseURL: "http://a/v1", apiKeyCommand: "entry-cmd" },
        b: { baseURL: "http://b/v1", apiKeyCommand: "entry-cmd" },
        c: { baseURL: "http://c/v1", apiKeyCommand: "main-cmd" },
      },
    });
    const spy = spyRunner({ "main-cmd": `${MAIN_KEY}\n`, "entry-cmd": ` ${ENTRY_KEY} ` });
    const cfg = await load(spy.run);
    expect(spy.calls.sort()).toEqual(["entry-cmd", "main-cmd"]);
    expect(cfg.models.same?.apiKey).toBe(MAIN_KEY);
    expect(cfg.models.a?.apiKey).toBe(ENTRY_KEY);
    expect(cfg.models.b?.apiKey).toBe(ENTRY_KEY);
    expect(cfg.models.c?.apiKey).toBe(MAIN_KEY);
    expect(cfg.models.a?.apiKeyCommand).toBe("entry-cmd");
  });

  test("a pod daemon load runs no entry command", async () => {
    await write({ models: { a: { baseURL: "http://a/v1", apiKeyCommand: "entry-cmd" } } });
    const spy = spyRunner({ "entry-cmd": ENTRY_KEY });
    const cfg = await load(spy.run, { podDaemon: true });
    expect(spy.calls).toEqual([]);
    expect(cfg.models.a?.apiKey).toBeUndefined();
  });

  describe("modelKeysNoTerminal (a detached relay, docs/feat/models-map-pod.md D6)", () => {
    const PUBLISHED = {
      model: { apiKeyCommand: "main-cmd" },
      models: {
        same: { model: "small" },
        pub: { baseURL: "http://a/v1", apiKeyCommand: "pub-cmd" },
        other: { baseURL: "http://b/v1", apiKeyCommand: "unpublished-cmd" },
      },
      subagents: { types: { explore: { model: "pub" } }, selectableModels: ["same"] },
    };

    test("the main command and the PUBLISHED entries' run; an unpublished entry's never does", async () => {
      await write(PUBLISHED);
      const spy = spyRunner({
        "main-cmd": MAIN_KEY,
        "pub-cmd": ENTRY_KEY,
        "unpublished-cmd": "never",
      });
      const { lines, option } = reports();
      const cfg = await load(spy.run, { modelKeysNoTerminal: option });
      expect(spy.calls.sort()).toEqual(["main-cmd", "pub-cmd"]);
      expect(lines).toEqual([]);
      expect(cfg.apiKey).toBe(MAIN_KEY);
      expect(cfg.models.pub?.apiKey).toBe(ENTRY_KEY);
      expect(cfg.models.same?.apiKey).toBe(MAIN_KEY);
      expect(cfg.models.other?.apiKey).toBeUndefined();
      // The command stays known: a docker/podman run must still hide its key file.
      expect(cfg.models.other?.apiKeyCommand).toBe("unpublished-cmd");
    });

    test("a failing command leaves that entry keyless and the load alive, with one line", async () => {
      await write(PUBLISHED);
      const spy = spyRunner({
        "main-cmd": MAIN_KEY,
        "pub-cmd": new ConfigError("apiKeyCommand exited with code 7: pinentry: no tty"),
      });
      const { lines, option } = reports();
      const cfg = await load(spy.run, { modelKeysNoTerminal: option });
      expect(cfg.models.pub?.apiKey).toBeUndefined();
      expect(cfg.apiKey).toBe(MAIN_KEY);
      expect(lines).toEqual(["pub: models.pub.apiKeyCommand exited with code 7: pinentry: no tty"]);
    });

    test("an empty output is a failure too", async () => {
      await write(PUBLISHED);
      const spy = spyRunner({ "main-cmd": MAIN_KEY, "pub-cmd": "  \n" });
      const { lines, option } = reports();
      const cfg = await load(spy.run, { modelKeysNoTerminal: option });
      expect(cfg.models.pub?.apiKey).toBeUndefined();
      expect(lines).toEqual(["pub: models.pub.apiKeyCommand produced an empty key"]);
    });

    test("a non-ConfigError failure is reported with no detail of its own", async () => {
      await write(PUBLISHED);
      const spy = spyRunner({ "main-cmd": MAIN_KEY, "pub-cmd": new Error(`leak ${ENTRY_KEY}`) });
      const { lines, option } = reports();
      await load(spy.run, { modelKeysNoTerminal: option });
      expect(lines).toEqual(["pub: models.pub.apiKeyCommand failed"]);
    });

    test("a command shared by two published entries runs once and reports both", async () => {
      await write({
        models: {
          a: { baseURL: "http://a/v1", apiKeyCommand: "shared" },
          b: { baseURL: "http://b/v1", apiKeyCommand: "shared" },
        },
        subagents: { selectableModels: ["a", "b"] },
      });
      const spy = spyRunner({ shared: new ConfigError("apiKeyCommand exited with code 1: x") });
      const { lines, option } = reports();
      await load(spy.run, { modelKeysNoTerminal: option });
      expect(spy.calls).toEqual(["shared"]);
      expect(lines).toEqual([
        "a: models.a.apiKeyCommand exited with code 1: x",
        "b: models.b.apiKeyCommand exited with code 1: x",
      ]);
    });

    test("the main command stays required: its failure still fails the load", async () => {
      await write(PUBLISHED);
      const spy = spyRunner({
        "main-cmd": new ConfigError("apiKeyCommand exited with code 4: boom"),
        "pub-cmd": ENTRY_KEY,
      });
      await expect(load(spy.run, { modelKeysNoTerminal: reports().option })).rejects.toThrow(
        "apiKeyCommand exited with code 4: boom",
      );
    });

    test("a command that never ends is cut at the deadline, even one that ignores the signal", async () => {
      await write(PUBLISHED);
      let signal: AbortSignal | undefined;
      const run = (command: string, s?: AbortSignal): Promise<string> => {
        if (command === "main-cmd") {
          return Promise.resolve(MAIN_KEY);
        }
        signal = s;
        return new Promise(() => {});
      };
      const { lines, option } = reports(20);
      const cfg = await load(run, { modelKeysNoTerminal: option });
      expect(cfg.models.pub?.apiKey).toBeUndefined();
      expect(signal?.aborted).toBe(true);
      expect(lines).toEqual([
        "pub: models.pub.apiKeyCommand did not finish within 1s (it may need a terminal)",
      ]);
    });

    test("F5, the real runner: a failing command reports its exit code and never its stderr", async () => {
      // Mutation: report `error.message` of the exit error → "oops-from-stderr" in the line.
      await write({
        models: {
          pub: {
            baseURL: "http://a/v1",
            apiKeyCommand: "echo oops-from-stderr-s3cret >&2; exit 3",
          },
        },
        subagents: { selectableModels: ["pub"] },
      });
      const { lines, option } = reports();
      const cfg = await loadConfig({
        env: { HOME: dir },
        configDir,
        cwd: dir,
        modelKeysNoTerminal: option,
      });
      expect(cfg.models.pub?.apiKey).toBeUndefined();
      expect(lines).toEqual(["pub: models.pub.apiKeyCommand exited with code 3"]);
    });

    test("R2 nit, the real runner: a failing MAIN command in a no-terminal load reports its code alone", async () => {
      // Mutation: drop the catch → "MAIN-STDERR-MARKER" in the error.
      await write({ model: { apiKeyCommand: "echo MAIN-STDERR-MARKER >&2; exit 4" } });
      const { option } = reports();
      const error = await loadConfig({
        env: { HOME: dir },
        configDir,
        cwd: dir,
        modelKeysNoTerminal: option,
      }).catch((e: unknown) => e);
      expect((error as Error).message).toBe("apiKeyCommand exited with code 4");
      const strict = await loadConfig({ env: { HOME: dir }, configDir, cwd: dir }).catch(
        (e: unknown) => e,
      );
      expect((strict as Error).message).toBe(
        "apiKeyCommand exited with code 4: MAIN-STDERR-MARKER",
      );
    });

    test("F5, the strict load still carries the stderr (a terminal user needs it)", async () => {
      await write({
        models: {
          pub: { baseURL: "http://a/v1", apiKeyCommand: "echo why-it-failed >&2; exit 3" },
        },
      });
      const error = await loadConfig({ env: { HOME: dir }, configDir, cwd: dir }).catch(
        (e: unknown) => e,
      );
      expect((error as Error).message).toBe(
        "models.pub.apiKeyCommand exited with code 3: why-it-failed",
      );
    });

    test("the real runner: a grandchild holding the pipe does not hold the load", async () => {
      await write({
        models: { pub: { baseURL: "http://a/v1", apiKeyCommand: "sleep 3; echo key" } },
        subagents: { selectableModels: ["pub"] },
      });
      const { lines, option } = reports(100);
      const started = Date.now();
      const cfg = await loadConfig({
        env: { HOME: dir },
        configDir,
        cwd: dir,
        modelKeysNoTerminal: option,
      });
      expect(Date.now() - started).toBeLessThan(2000);
      expect(cfg.models.pub?.apiKey).toBeUndefined();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("did not finish within");
    });

    test("a fast real command is not touched by the deadline", async () => {
      await write({
        models: { pub: { baseURL: "http://a/v1", apiKeyCommand: "echo fake-entry-key" } },
        subagents: { selectableModels: ["pub"] },
      });
      const { lines, option } = reports(5000);
      const cfg = await loadConfig({
        env: { HOME: dir },
        configDir,
        cwd: dir,
        modelKeysNoTerminal: option,
      });
      expect(cfg.models.pub?.apiKey).toBe("fake-entry-key");
      expect(lines).toEqual([]);
    });

    test("no key appears in a report line", async () => {
      await write(PUBLISHED);
      const spy = spyRunner({
        "main-cmd": MAIN_KEY,
        "pub-cmd": new ConfigError("apiKeyCommand exited with code 2: denied"),
      });
      const { lines, option } = reports();
      await load(spy.run, { modelKeysNoTerminal: option });
      expect(lines.join("\n")).not.toContain(MAIN_KEY);
      expect(lines.join("\n")).not.toContain(ENTRY_KEY);
    });

    test("without the option a failing entry command still fails the load (a terminal is there)", async () => {
      await write(PUBLISHED);
      const spy = spyRunner({
        "main-cmd": MAIN_KEY,
        "pub-cmd": new ConfigError("apiKeyCommand exited with code 7: no tty"),
        "unpublished-cmd": "k",
      });
      await expect(load(spy.run)).rejects.toThrow(
        "models.pub.apiKeyCommand exited with code 7: no tty",
      );
    });
  });

  test("--model reaches an inheriting entry, not one with its own model id", async () => {
    await write({
      model: { model: "file-id" },
      models: { plain: { contextWindow: 1000 }, own: { model: "own-id" } },
    });
    const cfg = await load(spyRunner({}).run, { model: "flag-id" });
    expect(cfg.models.plain?.model).toBe("flag-id");
    expect(cfg.models.own?.model).toBe("own-id");
  });

  test("__proto__ as a model name is refused by name, wherever it is written", async () => {
    const message = 'a model cannot be named "__proto__" (a reserved name): choose another';
    const path = join(configDir, CONFIG_FILENAME);
    for (const text of [
      '{"models":{"__proto__":{"model":"x"}}}',
      '{"models":{"__proto__":{}}}',
      '{"profiles":{"p":{"models":{"__proto__":{"model":"x"}}}}}',
    ]) {
      await writeFile(path, text, "utf8");
      const error = await load(spyRunner({}).run).catch((e: unknown) => e);
      expect({ text, message: (error as Error).message }).toEqual({
        text,
        message: `Invalid ${path}: ${message}`,
      });
    }
  });

  test("constructor is an ordinary model name", async () => {
    await writeFile(
      join(configDir, CONFIG_FILENAME),
      '{"models":{"constructor":{"model":"x"}}}',
      "utf8",
    );
    const cfg = await load(spyRunner({}).run);
    expect(Object.keys(cfg.models)).toEqual(["constructor"]);
    expect(Object.values(cfg.models)[0]?.model).toBe("x");
  });

  test("a failing command names the entry, never a key", async () => {
    await write({
      model: { apiKey: MAIN_KEY },
      models: { zeta: { apiKeyCommand: "bad" }, alpha: { apiKeyCommand: "bad" } },
    });
    const spy = spyRunner({ bad: new ConfigError("apiKeyCommand exited with code 1: denied") });
    const error = await load(spy.run).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toBe("models.alpha.apiKeyCommand exited with code 1: denied");
    expect((error as Error).message).not.toContain(MAIN_KEY);
    expect(spy.calls).toEqual(["bad"]);
  });

  test("an empty key is an error naming the entry", async () => {
    await write({ models: { a: { apiKeyCommand: "empty" } } });
    const error = await load(spyRunner({ empty: "  \n" }).run).catch((e: unknown) => e);
    expect((error as Error).message).toBe("models.a.apiKeyCommand produced an empty key");
  });

  test("selectableModels and types reach the loaded config", async () => {
    await write({
      models: { fast: { model: "f" } },
      subagents: { types: { explore: { model: "fast" } }, selectableModels: ["fast"] },
    });
    const cfg = await load(spyRunner({}).run);
    expect(cfg.subagentModels).toEqual({ explore: "fast" });
    expect(cfg.selectableModels).toEqual(["fast"]);
    expect(cfg.models.fast?.model).toBe("f");
  });

  test("an unknown name refuses the config, naming the file and the key", async () => {
    await write({ subagents: { types: { explore: { model: "nope" } } } });
    const error = await load(spyRunner({}).run).catch((e: unknown) => e);
    expect((error as Error).message).toBe(
      `Invalid ${join(configDir, CONFIG_FILENAME)}: subagents.types.explore.model: "nope" is not a models entry (no models defined)`,
    );
  });
});
