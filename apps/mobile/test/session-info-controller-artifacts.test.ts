/**
 * Session info's artifacts pull (docs/feat/model-artifacts.md D9, T9.3): the
 * section reads the daemon's `artifact/list` through the port, and its phases
 * settle alone — an older daemon says `unsupported`, a dropped link `offline`,
 * and neither touches another section.
 */
import { describe, expect, test } from "bun:test";
import { ArtifactsUnsupportedError } from "@tentacle/client";
import type { ArtifactListResult, ArtifactMeta, McpServerStatus } from "@tentacle/protocol";
import { JsonRpcErrorCode } from "@tentacle/protocol";
import { RpcError } from "@tentacle/transport";
import { NOTHING_SEEN } from "../src/artifact-seen-store.ts";
import type { InfoPort, InfoSession } from "../src/session-info-controller.ts";
import { createSessionInfo } from "../src/session-info-controller.ts";

function meta(artifactId: string): ArtifactMeta {
  return {
    artifactId,
    version: 1,
    sha256: "a".repeat(64),
    size: 10,
    mimeType: "text/plain",
    kind: "text",
    title: artifactId,
    callId: `call-${artifactId}`,
    createdAt: 0,
  };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 40; i += 1) {
    await Promise.resolve();
  }
};

function port(
  options: {
    readonly artifacts?: () => Promise<ArtifactListResult>;
    /** Absent: a port that offers no artifacts pull at all (an older wiring). */
    readonly offers?: boolean;
  } = {},
): InfoPort & { calls: { artifacts: number } } {
  const calls = { artifacts: 0 };
  const session: InfoSession = {
    skills: () => Promise.resolve({ slash: [], skills: [], problems: [], moreProblems: 0 }),
    context: () => Promise.resolve({ used: 0, exact: true }),
  };
  const base: InfoPort = {
    daemon: () => ({ version: "1.4.0" }),
    now: () => 1,
    computerName: () => "e2e-mac",
    title: () => "Alpha",
    phase: () => "open",
    sessionId: "s1",
    mcpStatus: () => Promise.resolve([] as readonly McpServerStatus[]),
    sessionList: () => Promise.resolve({ sessions: [] }),
    session: () => session,
  };
  return {
    ...base,
    calls,
    ...(options.offers === false
      ? {}
      : {
          artifacts: () => {
            calls.artifacts += 1;
            return options.artifacts?.() ?? Promise.resolve({ artifacts: [meta("a")] });
          },
          artifactSeen: () => NOTHING_SEEN,
        }),
  };
}

const section = (controller: ReturnType<typeof createSessionInfo>) =>
  controller.state().view.sections.find((s) => s.id === "artifacts");

describe("the artifacts pull", () => {
  test("a landed list fills the section and its row", async () => {
    const controller = createSessionInfo(port());
    await controller.open();
    await settle();
    expect(section(controller)?.phase).toBe("ready");
    expect(section(controller)?.rows[0]?.value).toBe("1 artifact · 1 new");
  });

  test("an older daemon is `unsupported`, with no Retry", async () => {
    const controller = createSessionInfo(
      port({
        artifacts: () =>
          Promise.reject(
            new ArtifactsUnsupportedError(new RpcError(JsonRpcErrorCode.MethodNotFound, "no such method")),
          ),
      }),
    );
    await controller.open();
    await settle();
    expect(section(controller)?.phase).toBe("unsupported");
    expect(section(controller)?.retry).toBeUndefined();
  });

  test("a plain failure is retryable, and a refresh asks again", async () => {
    let fail = true;
    const p = port({
      artifacts: () =>
        fail ? Promise.reject(new Error("boom")) : Promise.resolve({ artifacts: [meta("b")] }),
    });
    const controller = createSessionInfo(p);
    await controller.open();
    await settle();
    expect(section(controller)?.phase).toBe("error");
    expect(section(controller)?.retry).toBe(true);
    fail = false;
    await controller.refresh();
    await settle();
    expect(section(controller)?.phase).toBe("ready");
    expect(p.calls.artifacts).toBe(2);
  });

  test("a port that offers no pull draws NO section (never a fake one)", async () => {
    const controller = createSessionInfo(port({ offers: false }));
    await controller.open();
    await settle();
    expect(section(controller)).toBeUndefined();
  });

  test("the pull is per-open: a closed sheet's late answer never paints", async () => {
    const held: { release: ((value: ArtifactListResult) => void) | null } = { release: null };
    const controller = createSessionInfo(
      port({
        artifacts: () =>
          new Promise<ArtifactListResult>((resolve) => {
            held.release = resolve;
          }),
      }),
    );
    const opened = controller.open();
    await settle();
    controller.close();
    held.release?.({ artifacts: [meta("late")] });
    await opened;
    await settle();
    // Nothing threw, and the section was never painted as ready by that answer.
    expect(section(controller)?.phase).not.toBe("ready");
  });
});
