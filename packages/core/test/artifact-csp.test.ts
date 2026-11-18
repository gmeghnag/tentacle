import { describe, expect, test } from "bun:test";
import { artifactCsp, artifactCspPolicy, wrapArtifactHtml } from "../src/artifact-csp.ts";

/** The policy's directives as a map: `default-src` → `'none'`. */
function directives(policy: string): Map<string, string> {
  return new Map(
    policy
      .split(";")
      .map((d) => d.trim())
      .filter((d) => d.length > 0)
      .map((d) => {
        const [name = "", ...values] = d.split(/\s+/);
        return [name, values.join(" ")] as const;
      }),
  );
}

describe("artifactCsp — the ONE policy the Mac and the phone wrap artifacts in (D8/D9)", () => {
  test("network off (default): exactly the plan's policy", () => {
    expect(artifactCspPolicy()).toBe(
      "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; script-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'",
    );
  });

  test("network off: no directive names a scheme or host that leaves the device", () => {
    for (const [name, value] of directives(artifactCspPolicy())) {
      expect(value, name).not.toMatch(/\*|https?:|wss?:/);
    }
  });

  test("network on: fetch/img/style/font/script/media reach the network; frames, forms, base stay closed", () => {
    const d = directives(artifactCspPolicy({ network: true }));
    expect(d.get("default-src")).toBe("'none'");
    for (const name of [
      "connect-src",
      "img-src",
      "style-src",
      "font-src",
      "script-src",
      "media-src",
    ]) {
      expect(d.get(name), name).toContain("*");
    }
    expect(d.get("frame-src")).toBe("'none'");
    expect(d.get("form-action")).toBe("'none'");
    expect(d.get("base-uri")).toBe("'none'");
  });

  test("the prefix is a doctype + the meta, and wrapping puts it FIRST", () => {
    const prefix = artifactCsp();
    expect(
      prefix.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy" content="'),
    ).toBe(true);
    expect(prefix).toContain(artifactCspPolicy());
    expect(prefix.includes('"', prefix.indexOf('content="') + 9)).toBe(true);
    const body = "<script>fetch('https://x')</script>";
    const wrapped = wrapArtifactHtml(body);
    expect(wrapped.startsWith(prefix)).toBe(true);
    expect(wrapped.endsWith(body)).toBe(true);
    expect(
      wrapArtifactHtml(body, { network: true }).startsWith(artifactCsp({ network: true })),
    ).toBe(true);
  });

  test('a policy never contains a double quote (it lives inside content="…")', () => {
    expect(artifactCspPolicy()).not.toContain('"');
    expect(artifactCspPolicy({ network: true })).not.toContain('"');
  });
});
