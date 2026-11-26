/**
 * The `container_preview` dialog (docs/feat/container-apps-devices.md OD2):
 * «Show once» or «No», never «always»; every engine fact is shown.
 */
import { describe, expect, test } from "bun:test";
import type { PermissionRequest } from "@tentacle/core";
import { buildPermissionChoices, permissionDetailLines } from "../src/permission-ui.ts";

const detail = [
  "Engine: docker · unix:///var/run/docker.sock",
  "Container: web · 0123456789ab",
  "Image: nginx · fedcba987654",
  "Port: 80/tcp → 127.0.0.1:8080",
  "Only your paired devices can open it, while this session is open",
].join("\n");

const ask: PermissionRequest = {
  kind: "container_preview",
  tool: "container_preview",
  level: "ask",
  title: "Show container web port 80/tcp on your paired devices?",
  detail,
  input: {},
  suggestion: { prefix: "x" },
};

describe("container_preview dialog", () => {
  test("offers «Show once» or «No», nothing else", () => {
    expect(buildPermissionChoices(ask)).toEqual([
      { label: "Show once", response: { allowed: true, scope: "once" } },
      { label: "No", response: { allowed: false } },
    ]);
  });

  test("shows every engine fact", () => {
    expect(permissionDetailLines(ask)).toEqual(detail.split("\n"));
  });
});
