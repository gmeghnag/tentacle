/**
 * The dev computer source (docs/feat/mobile-app-shell.md, Owner Q2): env →
 * records, absent URL → `[]`, a non-ws URL → a typed config error naming the
 * variable, token optional.
 */
import { describe, expect, test } from "bun:test";
import { ComputerConfigError, devComputerSource } from "../src/computers.ts";

describe("devComputerSource", () => {
  test("url + token + name → one computer", async () => {
    const source = devComputerSource({
      EXPO_PUBLIC_TENTACLE_URL: "ws://127.0.0.1:4001/",
      EXPO_PUBLIC_TENTACLE_TOKEN: "abc",
      EXPO_PUBLIC_TENTACLE_NAME: "e2e-mac",
    });
    expect(await source.list()).toEqual([
      { id: "dev", name: "e2e-mac", url: "ws://127.0.0.1:4001/", token: "abc" },
    ]);
  });

  test("no URL → [] (the app shows the pairing placeholder, never a crash)", async () => {
    expect(await devComputerSource({}).list()).toEqual([]);
    expect(await devComputerSource({ EXPO_PUBLIC_TENTACLE_URL: "" }).list()).toEqual([]);
  });

  test("no token → the record has none (not an empty one)", async () => {
    const source = devComputerSource({ EXPO_PUBLIC_TENTACLE_URL: "wss://mac.local:4001/" });
    const [computer] = await source.list();
    expect(computer?.token).toBeUndefined();
    // No name → the host, so the computer row is never blank.
    expect(computer?.name).toBe("mac.local:4001");
  });

  test("an http: URL is a config error naming the variable", async () => {
    const source = devComputerSource({ EXPO_PUBLIC_TENTACLE_URL: "http://127.0.0.1:4001" });
    const caught = await source.list().catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(ComputerConfigError);
    expect((caught as ComputerConfigError).variable).toBe("EXPO_PUBLIC_TENTACLE_URL");
    expect((caught as ComputerConfigError).message).toContain("ws://");
  });

  test("garbage is a config error too, not a crash", async () => {
    const source = devComputerSource({ EXPO_PUBLIC_TENTACLE_URL: "not a url" });
    const caught = await source.list().catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(ComputerConfigError);
  });
});
