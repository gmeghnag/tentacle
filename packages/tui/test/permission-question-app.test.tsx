import { describe, expect, test } from "bun:test";
import {
  PermissionBroker,
  type PermissionRequest,
  type PermissionRequestOptions,
  type PermissionResponse,
} from "@tentacle/core";
import { render } from "ink-testing-library";
import { App, type SessionController } from "../src/App.tsx";
import { inertSession } from "./session-stub.ts";

// docs/feat/a2a-client.md a2c-5: a remote question in the real App (frames via
// ink-testing-library, AGENTS §6).

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const session = (): SessionController => ({
  ...inertSession(),
  async *send(prompt) {
    yield { type: "text", delta: `reply to ${prompt}` };
    yield { type: "turn_end", reason: "end_turn" };
  },
  ownsTurn: (id) => id.startsWith("own"),
});

const QUESTION: PermissionRequest = {
  kind: "question",
  tool: "a2a:x",
  level: "ask",
  title: "x asks",
  detail: "Remote question (x): which env?",
  input: {},
  reply: { maxChars: 4000 },
};

async function mount() {
  const permissions = new PermissionBroker();
  const app = render(
    <App createSession={session} permissions={permissions} model="m" cwd="/tmp/work" />,
  );
  await delay(30);
  const answers: PermissionResponse[] = [];
  const ask = async (req: PermissionRequest, options: PermissionRequestOptions = {}) => {
    void permissions.request(req, { turnId: "own-1", ...options }).then((r) => answers.push(r));
    await delay(40);
  };
  const keys = async (...chunks: string[]) => {
    for (const c of chunks) {
      app.stdin.write(c);
      await delay(15);
    }
    await delay(25);
  };
  const frame = () => app.lastFrame() ?? "";
  return { app, answers, ask, keys, frame };
}

describe("a remote question in the App", () => {
  test("menu shows Answer… / Skip; Answer… + text + Enter answers allowed:true + message", async () => {
    const t = await mount();
    await t.ask(QUESTION);
    expect(t.frame()).toContain("x asks");
    expect(t.frame()).toContain("Answer…");
    expect(t.frame()).toContain("Skip");
    expect(t.frame()).not.toContain("don't ask again");
    await t.keys("\r", "p", "r", "o", "d", "\r");
    expect(t.answers.length).toBe(1);
    expect(t.answers[0]?.allowed).toBe(true);
    expect(t.answers[0]?.message).toBe("prod");
    t.app.unmount();
  });

  test("Skip answers allowed:false", async () => {
    const t = await mount();
    await t.ask(QUESTION);
    await t.keys("n");
    expect(t.answers).toEqual([{ allowed: false }]);
    t.app.unmount();
  });
});
