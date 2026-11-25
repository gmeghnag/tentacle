// MV3 service worker: wiring only. The logic is in ops.js (unit-tested). The
// worker opens ITS port at browser start (B0: it does not otherwise wake until
// a tab event) and again whenever the host dies (docs/feat/browser-inspect.md
// failure modes: «Host crash» → reconnect in onDisconnect).
import { createOps } from "./ops.js";

const HOST = "so.tentacle.browser";
let port = null;
let retry = 0;

const ops = createOps({
  chrome,
  send: (m) => {
    try {
      port?.postMessage(m);
    } catch {
      // port gone: the reconnect below restores the link
    }
  },
});

function connect() {
  if (port) return;
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch {
    port = null;
    return schedule();
  }
  port.onMessage.addListener(async (msg) => {
    if (typeof msg?.id !== "number") return;
    const reply = await ops.handle(msg);
    port?.postMessage({ id: msg.id, ...reply });
  });
  port.onDisconnect.addListener(() => {
    port = null;
    schedule();
  });
  retry = 0;
}

function schedule() {
  retry = Math.min(retry + 1, 6);
  setTimeout(connect, 1000 * 2 ** retry);
}

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.tabs.onRemoved.addListener((tab) => ops.onTabRemoved(tab));
chrome.tabs.onUpdated.addListener((tab, info) => ops.onTabUpdated(tab, info));
chrome.debugger.onEvent.addListener((s, m, p) => ops.onDebuggerEvent(s, m, p));
chrome.debugger.onDetach.addListener((s, r) => ops.onDebuggerDetach(s, r));
chrome.webRequest.onCompleted.addListener((d) => ops.onWebRequest(d), { urls: ["<all_urls>"] });

// The popup asks which sessions exist and hands a tab over.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.target !== "tentacle-bg") return false;
  if (msg.kind === "sessions") reply({ sessions: ops.listSessions(), linked: port !== null });
  else if (msg.kind === "handover") reply({ ok: ops.handover(msg.sessionUid, msg.tab) });
  else return false;
  return false;
});

connect();
