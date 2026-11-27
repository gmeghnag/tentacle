/**
 * `/model` through the real App (docs/feat/model-switch.md T5): the switch
 * lands on the input rule's label, the ctx meter's window and a notice; a
 * refusal changes neither.
 */
import { describe, expect, test } from "bun:test";
import { PermissionBroker } from "@tentacle/core";
import { render } from "ink-testing-library";
import { App } from "../src/App.tsx";
import type { SessionController } from "../src/app-types.ts";

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

const RESULT = {
  start: { model: "start-model", contextWindow: 111_000 },
  entries: [{ name: "haiku", model: "haiku-model", contextWindow: 22_000 }],
  active: null,
};

function fakeSession(setModel: (name: string | null) => Promise<unknown>) {
  const asked: (string | null)[] = [];
  const session = {
    sessionId: "s1",
    async *send() {},
    enqueue: async () => {},
    clear: async () => ({ before: 0, after: 0 }),
    attachImage: async () => {
      throw new Error("unused");
    },
    imageInput: () => ({ kind: "off", reason: "unused" }),
    attachDocument: async () => {
      throw new Error("unused");
    },
    documentsInput: () => ({ kind: "off", reason: "unused" }),
    models: async () => RESULT,
    setModel: (name: string | null) => {
      asked.push(name);
      return setModel(name);
    },
  } as unknown as SessionController;
  return { session, asked };
}

function mount(session: SessionController) {
  const ink = render(
    <App
      createSession={() => session}
      permissions={new PermissionBroker()}
      model="start-model"
      cwd="/tmp"
      contextWindow={111_000}
      columns={120}
    />,
  );
  const frame = (): string => ink.lastFrame() ?? "";
  const until = async (done: () => boolean): Promise<void> => {
    const deadline = Date.now() + 3000;
    while (!done()) {
      if (Date.now() > deadline) {
        throw new Error(`timed out:\n${frame()}`);
      }
      await tick(5);
    }
  };
  const line = async (text: string): Promise<void> => {
    await tick();
    ink.stdin.write(text);
    await tick();
    ink.stdin.write("\r");
  };
  /** The input rule and the status bar: the header row keeps the start name. */
  const chrome = (): string => frame().split("\n").slice(-6).join("\n");
  return { ...ink, frame, until, line, chrome };
}

describe("/model", () => {
  test("lists the models, the active one marked", async () => {
    const t = mount(fakeSession(async () => RESULT).session);
    await t.line("/model");
    await t.until(() => t.frame().includes("haiku-model"));
    expect(t.frame()).toContain("start-model (111k) ← active");
    t.unmount();
  });

  test("a switch updates the label, the ctx window and says so", async () => {
    const fake = fakeSession(async () => ({
      active: "haiku",
      model: "haiku-model",
      contextWindow: 22_000,
    }));
    const t = mount(fake.session);
    await tick();
    expect(t.chrome()).toContain("start-model");
    expect(t.chrome()).toContain("111k");
    await t.line("/model haiku");
    await t.until(() => t.frame().includes("(for this session)"));
    await tick(60);
    expect(fake.asked).toEqual(["haiku"]);
    expect(t.frame()).toContain("start-model → haiku-model");
    expect(t.chrome()).toContain("haiku-model");
    expect(t.chrome()).not.toContain("start-model");
    expect(t.chrome()).toContain("22k");
    expect(t.chrome()).not.toContain("111k");
    t.unmount();
  });

  test("a refusal says why and changes nothing", async () => {
    const t = mount(
      fakeSession(async () => {
        throw Object.assign(new Error("a turn is already running"), { code: -32004 });
      }).session,
    );
    await t.line("/model haiku");
    await t.until(() => t.frame().includes("Model not switched"));
    await tick(60);
    expect(t.chrome()).toContain("start-model");
    expect(t.chrome()).toContain("111k");
    t.unmount();
  });

  test("a runtime with no switching shows the model and says so", async () => {
    const { session } = fakeSession(async () => RESULT);
    const bare = { ...session, models: undefined, setModel: undefined } as SessionController;
    const t = mount(bare);
    await t.line("/model haiku");
    await t.until(() => t.frame().includes("switching isn't available on this runtime"));
    expect(t.frame()).toContain("Model: start-model");
    t.unmount();
  });
});
