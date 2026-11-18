/**
 * The executor port (docs/feat/app-decomposition.md S3, `keys/execute.ts`): the
 * ONE place a decided effect becomes a call into the App.
 *
 * The router's own tests pin WHAT is decided; this pins that each effect reaches
 * the RIGHT host method. The two halves are separate on purpose — a wrong wiring
 * here (an `abortTurn` that calls `sendNow`) is invisible to every decision test,
 * because the decision was correct and only its execution was wrong.
 */
import { describe, expect, test } from "bun:test";
import type { KeyEffect } from "../src/keys/effects.ts";
import { type KeyHost, executeEffect, executeEffects } from "../src/keys/execute.ts";

/** A host that records the call each method received, in order. */
function spyHost(): { host: KeyHost; calls: string[] } {
  const calls: string[] = [];
  const rec =
    (name: string, ...args: unknown[]) =>
    (...rest: unknown[]) => {
      calls.push(`${name}(${[...args, ...rest].map((a) => JSON.stringify(a)).join(",")})`);
    };
  const host = {
    toggleAutoApprove: rec("toggleAutoApprove"),
    setQuitConfirm: rec("setQuitConfirm"),
    requestQuit: rec("requestQuit"),
    closeForAll: rec("closeForAll"),
    setChord: rec("setChord"),
    sendNow: rec("sendNow"),
    setPasteBuffer: rec("setPasteBuffer"),
    armPasteTimeout: rec("armPasteTimeout"),
    clearPasteTimeout: rec("clearPasteTimeout"),
    insertReply: () => {
      calls.push("insertReply");
      return true;
    },
    setReplyMode: rec("setReplyMode"),
    permissionSelect: rec("permissionSelect"),
    permissionAnswer: rec("permissionAnswer"),
    permissionStop: rec("permissionStop"),
    pasteReply: rec("pasteReply"),
    exit: rec("exit"),
    stopTurn: rec("stopTurn"),
    routeAttach: rec("routeAttach"),
    fieldSet: rec("fieldSet"),
    fieldReset: rec("fieldReset"),
    cancelUpload: rec("cancelUpload"),
    closePanel: rec("closePanel"),
    panelApply: rec("panelApply"),
    switchCapability: rec("switchCapability"),
    setSessionsState: rec("setSessionsState"),
    switchTo: rec("switchTo"),
    openNewestArtifact: rec("openNewestArtifact"),
    previewArtifact: rec("previewArtifact"),
    answerArtifactConfirm: rec("answerArtifactConfirm"),
    sessionsDelete: rec("sessionsDelete"),
    killJob: rec("killJob"),
    killChild: rec("killChild"),
    setDock: rec("setDock"),
    toggleAgents: rec("toggleAgents"),
    toggleExpandAll: rec("toggleExpandAll"),
    moveCommandSel: rec("moveCommandSel"),
    runCommand: rec("runCommand"),
    pushNotice: rec("pushNotice"),
    fieldInsert: rec("fieldInsert"),
    fieldDeleteBack: rec("fieldDeleteBack"),
    fieldDeleteWord: rec("fieldDeleteWord"),
    fieldMoveCursor: rec("fieldMoveCursor"),
    fieldMoveWord: rec("fieldMoveWord"),
    fieldMoveLine: rec("fieldMoveLine"),
    fieldMoveVertical: rec("fieldMoveVertical"),
    setHistoryCursor: rec("setHistoryCursor"),
    dockDown: rec("dockDown"),
    scroll: rec("scroll"),
    pasteClipboard: rec("pasteClipboard"),
    submit: rec("submit"),
    removeLastChip: rec("removeLastChip"),
  } as unknown as KeyHost;
  return { host, calls };
}

/** Each effect kind → the exact host call it must produce. */
const TABLE: readonly (readonly [KeyEffect, string])[] = [
  [{ kind: "toggleAutoAccept" }, "toggleAutoApprove()"],
  [{ kind: "setQuitConfirm", facts: null }, "setQuitConfirm(null)"],
  [{ kind: "setChord", state: { armedAt: 7 } }, 'setChord({"armedAt":7})'],
  [{ kind: "sendNow" }, "sendNow()"],
  [{ kind: "setPasteBuffer", buffer: "a" }, 'setPasteBuffer("a")'],
  [{ kind: "armPasteTimeout" }, "armPasteTimeout()"],
  [{ kind: "clearPasteTimeout" }, "clearPasteTimeout()"],
  [{ kind: "insertReply", text: "why" }, "insertReply"],
  [{ kind: "setReplyMode", mode: { mode: "menu" } }, 'setReplyMode({"mode":"menu"})'],
  [{ kind: "permissionSelect", index: 2 }, "permissionSelect(2)"],
  [
    { kind: "permissionAnswer", response: { allowed: true, scope: "once" } },
    'permissionAnswer({"allowed":true,"scope":"once"})',
  ],
  [{ kind: "permissionStop" }, "permissionStop()"],
  [{ kind: "pasteReply" }, "pasteReply()"],
  [{ kind: "exit" }, "exit()"],
  // The one a mis-wire turns into a silent send.
  [{ kind: "abortTurn" }, "stopTurn()"],
  [{ kind: "routeAttach", text: "x.png" }, 'routeAttach("x.png")'],
  [{ kind: "fieldSet", text: "/help" }, 'fieldSet("/help")'],
  [{ kind: "fieldReset" }, "fieldReset()"],
  [{ kind: "cancelUpload" }, "cancelUpload()"],
  [{ kind: "closePanel" }, "closePanel()"],
  [{ kind: "applyPanel", action: "down" }, 'panelApply("down")'],
  [{ kind: "switchCapability" }, "switchCapability()"],
  [
    { kind: "setSessionsState", state: { cursor: 1, armed: null } },
    'setSessionsState({"cursor":1,"armed":null})',
  ],
  [{ kind: "switchTo", id: "s2", reopen: true }, 'switchTo("s2",true)'],
  [{ kind: "openNewestArtifact" }, "openNewestArtifact()"],
  [{ kind: "previewArtifact", artifact: null }, "previewArtifact(null)"],
  [{ kind: "answerArtifactConfirm", yes: true }, "answerArtifactConfirm(true)"],
  [{ kind: "sessionsDelete", id: "s2", startedGen: 3 }, 'sessionsDelete("s2",3)'],
  [{ kind: "killJob", id: "bg-1" }, 'killJob("bg-1")'],
  [{ kind: "killChild", id: "sa-1" }, 'killChild("sa-1")'],
  [
    { kind: "setDock", state: { focus: { kind: "input" }, drafts: {}, sent: {} } },
    'setDock({"focus":{"kind":"input"},"drafts":{},"sent":{}})',
  ],
  [{ kind: "toggleAgents" }, "toggleAgents()"],
  [{ kind: "toggleExpandAll" }, "toggleExpandAll()"],
  [{ kind: "moveCommandSel", step: -1 }, "moveCommandSel(-1)"],
  [{ kind: "runCommand", name: "/help" }, 'runCommand("/help")'],
  [{ kind: "pushNotice", text: "_x_" }, 'pushNotice("_x_")'],
  // The line-editing tail (S12): every argument reaches the host in order.
  [{ kind: "fieldInsert", text: "ab" }, 'fieldInsert("ab")'],
  [{ kind: "fieldDeleteBack" }, "fieldDeleteBack()"],
  [{ kind: "fieldDeleteWord", dir: 1 }, "fieldDeleteWord(1)"],
  [{ kind: "fieldMoveCursor", delta: -1, extend: true }, "fieldMoveCursor(-1,true)"],
  [{ kind: "fieldMoveWord", dir: 1, extend: false }, "fieldMoveWord(1,false)"],
  [{ kind: "fieldMoveLine", edge: "start", extend: true }, 'fieldMoveLine("start",true)'],
  [{ kind: "fieldMoveVertical", dir: -1, extend: false }, "fieldMoveVertical(-1,false)"],
  [{ kind: "setHistoryCursor", index: 2, draft: "d" }, 'setHistoryCursor(2,"d")'],
  [{ kind: "dockDown" }, "dockDown()"],
  [{ kind: "scroll", dir: "pageUp" }, 'scroll("pageUp")'],
  [{ kind: "pasteClipboard" }, "pasteClipboard()"],
  [{ kind: "submit", text: "go" }, 'submit("go")'],
  [{ kind: "removeLastChip" }, "removeLastChip()"],
];

describe("executeEffect", () => {
  for (const [effect, expected] of TABLE) {
    test(`${effect.kind} → ${expected}`, () => {
      const { host, calls } = spyHost();
      executeEffect(effect, host);
      expect(calls).toEqual([expected]);
    });
  }
});

describe("executeEffects", () => {
  test("applies in the walk's order, one call each", () => {
    const { host, calls } = spyHost();
    executeEffects(
      [
        { kind: "setQuitConfirm", facts: null },
        { kind: "quit", closeForAll: true },
      ],
      host,
    );
    // `quit` closes for all FIRST, then asks — the order the inline handler used.
    expect(calls).toEqual(["setQuitConfirm(null)", "closeForAll()", "requestQuit(true)"]);
  });

  test("a quit that does not close for all still asks", () => {
    const { host, calls } = spyHost();
    executeEffect({ kind: "quit", closeForAll: false }, host);
    expect(calls).toEqual(["requestQuit(true)"]);
  });

  test("no effects means no calls", () => {
    const { host, calls } = spyHost();
    executeEffects([], host);
    expect(calls).toEqual([]);
  });
});
