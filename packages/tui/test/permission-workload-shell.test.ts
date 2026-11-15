/**
 * The arrow menu for a `workload_shell` ask (docs/feat/workload-shell.md D6).
 *
 * The owner's decision is that an "always" is scoped to the SINGLE workload. The
 * label has to say so, or a person reading "don't ask again for `ls` commands"
 * would think it covers their prod pod too — and the safe direction is that the
 * real rule is NARROWER than the label, never the reverse. With no derivable
 * prefix there is no rule to offer, so there is no "always" option at all.
 */
import { describe, expect, test } from "bun:test";
import { describeToolCall } from "@tentacle/agent";
import type { PermissionRequest } from "@tentacle/core";
import { buildPermissionChoices } from "../src/permission-ui.ts";

const target = { engine: "kubernetes", namespace: "dev", name: "api-0" };

function ask(input: Record<string, unknown>): PermissionRequest {
  return describeToolCall({ name: "workload_shell", permission: "ask" } as never, input);
}

describe("workload_shell permission choices", () => {
  test("with a derivable prefix, the always label names the workload scope", () => {
    const choices = buildPermissionChoices(ask({ action: "run", target, command: "ls -la" }));
    const labels = choices.map((c) => c.label);
    expect(labels[0]).toBe("Yes");
    expect(labels).toContain("No");
    const always = labels.find((l) => l.includes("don't ask again"));
    expect(always).toBeDefined();
    expect(always as string).toContain("`ls`");
    // The scope is stated, not implied: "on this workload".
    expect(always as string).toContain("this workload");
    // And the session-wide wording must never appear for this tool.
    expect(always as string).not.toContain("this session");
  });

  test("with NO derivable prefix there is no always option at all (Yes / No only)", () => {
    // A command substitution is never auto-approvable (the shell-prefix rule).
    const choices = buildPermissionChoices(
      ask({ action: "run", target, command: "echo $(rm -rf /)" }),
    );
    const labels = choices.map((c) => c.label);
    expect(labels.some((l) => l.includes("don't ask again"))).toBe(false);
    expect(labels).toContain("Yes");
    expect(labels).toContain("No");
  });

  test("the prompt names the workload and the command", () => {
    const request = ask({ action: "run", target, command: "cat /etc/os-release" });
    expect(request.title).toBe("Run a command in a workload");
    expect(request.detail).toContain("kubernetes dev/api-0");
    expect(request.detail).toContain("cat /etc/os-release");
  });

  test("a container and no namespace are named as the engine words them", () => {
    const request = ask({
      action: "run",
      target: { engine: "docker", name: "box" },
      command: "ls",
    });
    expect(request.detail).toContain("docker box");
  });
});
