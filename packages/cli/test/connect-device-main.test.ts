/**
 * `tentacle connect` through `main` (docs/feat/connect-via-relay.md D8): the
 * routing, the stores and the device dial as wired. The key store is a test seam
 * (a file store, as on Linux): the real Keychain is never touched.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeBase64Url, formatPairingPayload } from "@tentacle/protocol";
import { defaultKeyStores } from "../src/connect-keys.ts";
import { createRecord, listRecordNames } from "../src/connect-store.ts";
import { type CliIO, main } from "../src/main.ts";

let configDir = "";
let before: string | undefined;
beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "connect-main-"));
  before = process.env.TENTACLE_CONFIG_DIR;
  process.env.TENTACLE_CONFIG_DIR = configDir;
});
afterEach(() => {
  if (before === undefined) {
    // Computed: an env var is removed, not set to "undefined".
    const key = "TENTACLE_CONFIG_DIR";
    delete process.env[key];
  } else {
    process.env.TENTACLE_CONFIG_DIR = before;
  }
  rmSync(configDir, { recursive: true, force: true });
});

async function run(args: string[], io: CliIO = {}) {
  let text = "";
  const code = await main(["bun", "tentacle", ...args], {
    out: (t) => {
      text += t;
    },
    err: (t) => {
      text += t;
    },
    terminal: { stdin: false, stdout: false },
    connectKeys: (dir) => defaultKeyStores(dir, "linux"),
    ...io,
  });
  return { code, text };
}

const keyFiles = (): string[] => {
  const dir = join(configDir, "connect", "keys");
  return existsSync(dir) ? readdirSync(dir) : [];
};

async function addRecord(name: string, id = "ab".repeat(16)) {
  const record = createRecord(
    configDir,
    {
      id,
      computer: "workstation",
      computerKey: encodeBase64Url(new Uint8Array(32).fill(7)),
      deviceId: "0123456789abcdef",
      addresses: ["ws://127.0.0.1:1/e2e"],
      keyStore: "file",
    },
    name,
  );
  await defaultKeyStores(configDir, "linux").file.put(record.id, new Uint8Array(32).fill(3));
  return record;
}

const LINE = formatPairingPayload({
  v: 2,
  key: new Uint8Array(32).fill(7),
  computer: "Work Station",
  code: "ABCDEFGHJK",
  addresses: ["ws://127.0.0.1:1/e2e"],
});

describe("connect through main", () => {
  test("--pair with a name is a usage error", async () => {
    const { code, text } = await run(["connect", "--pair", LINE, "app"]);
    expect(code).toBe(1);
    expect(text).toContain("--pair takes no name and no other flag");
    expect(text).toContain("usage:");
    expect(keyFiles()).toEqual([]);
  });

  test("no target is a usage error", async () => {
    const { code, text } = await run(["connect"]);
    expect(code).toBe(1);
    expect(text).toContain("missing argument");
    expect(text).toContain("usage:");
  });

  test("a name with a token flag is refused", async () => {
    await addRecord("app");
    const { code, text } = await run(["connect", "app", "--token", "t"]);
    expect(code).toBe(1);
    expect(text).toContain("--token does not apply to a paired computer");
  });

  test("a ws(s):// target is still the token path", async () => {
    const { code, text } = await run(["connect", "ws://127.0.0.1:1", "--token", "t"]);
    expect(code).toBe(1);
    expect(text).toContain("[connect error]");
    expect(text).not.toContain("paired");
  });

  test("an unknown name prints the known ones", async () => {
    await addRecord("app");
    await addRecord("web", "cd".repeat(16));
    const { code, text } = await run(["connect", "nope"]);
    expect(code).toBe(1);
    expect(text).toContain("no paired computer named 'nope' — paired: app, web");
  });

  test("a known name dials its record's address, with the device hint", async () => {
    await addRecord("app");
    const { code, text } = await run(["connect", "app"]);
    expect(code).toBe(1);
    expect(text).toContain("app: no address answered — is `serve` running there?");
  });

  test("a missing key says to pair again (F2)", async () => {
    const record = await addRecord("app");
    await defaultKeyStores(configDir, "linux").file.remove(record.id);
    const { code, text } = await run(["connect", "app"]);
    expect(code).toBe(1);
    expect(text).toContain("key for 'app' unavailable (file) — pair again");
  });

  test("--pair - reads the line from stdin", async () => {
    let reads = 0;
    const { code, text } = await run(["connect", "--pair", "-"], {
      readStdin: async () => {
        reads++;
        return `${LINE}\n`;
      },
    });
    expect(reads).toBe(1);
    expect(code).toBe(1);
    // The line parsed and its (closed) address was dialled; nothing is left over.
    expect(text).toContain("can't pair");
    expect(keyFiles()).toEqual([]);
    expect(listRecordNames(configDir)).toEqual([]);
  });

  test("--forget removes the record and key, and names the revoke command", async () => {
    await addRecord("app");
    const { code, text } = await run(["connect", "--forget", "app"]);
    expect(code).toBe(0);
    expect(text).toContain("tentacle devices revoke 0123456789abcdef");
    expect(listRecordNames(configDir)).toEqual([]);
    expect(keyFiles()).toEqual([]);
  });

  test("--help names the device forms and the no-code fallback (D10)", async () => {
    const { text } = await run(["--help"]);
    expect(text).toContain("tentacle connect --pair '<tentacle://pair?");
    expect(text).toContain("tentacle connect <name>");
    expect(text).toContain("tailnet");
    expect(text).toContain("connect ws://<tailnet-name>");
  });
});
