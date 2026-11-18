import { describe, expect, test } from "bun:test";
import { isSecretPath } from "../src/secret-path.ts";

describe("isSecretPath — what `present` never ships (docs/feat/model-artifacts.md D3)", () => {
  test("secret-looking basenames are refused", () => {
    for (const path of [
      ".env",
      ".env.local",
      "app/.env.production",
      "certs/x.pem",
      "server.key",
      "store.p12",
      "store.pfx",
      "id_rsa",
      "keys/id_rsa.pub",
      "id_ed25519",
      "id_ecdsa_sk",
      "id_dsa",
      ".netrc",
      ".npmrc",
      ".pypirc",
      "credentials",
      "credentials.json",
    ]) {
      expect(isSecretPath(path), path).toBe(true);
    }
  });

  test("any secret directory segment is refused", () => {
    for (const path of [
      "a/.ssh/config",
      ".aws/config",
      "home/.gnupg/pubring.kbx",
      ".kube/config",
      "x/.docker/config.json",
    ]) {
      expect(isSecretPath(path), path).toBe(true);
    }
  });

  test("case does not hide a secret (case-insensitive filesystems)", () => {
    for (const path of [".ENV", "Certs/X.PEM", "A/.SSH/config", "Credentials.txt"]) {
      expect(isSecretPath(path), path).toBe(true);
    }
  });

  test("ordinary files are allowed, including look-alikes", () => {
    for (const path of [
      "env.md",
      "docs/environment.html",
      "report.pdf",
      "a/b/chart.png",
      "keys.md",
      "monkey.txt",
      "ssh-notes.md",
      "my.envelope",
      "README.md",
    ]) {
      expect(isSecretPath(path), path).toBe(false);
    }
  });

  test("absolute paths and backslash separators are split into segments too", () => {
    expect(isSecretPath("/w/project/.ssh/known_hosts")).toBe(true);
    expect(isSecretPath("dir\\.aws\\credentials")).toBe(true);
    expect(isSecretPath("/w/project/out/plot.svg")).toBe(false);
  });
});
