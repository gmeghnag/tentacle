// Extension-side op handling over an injected `chrome` + `send` (native port),
// so every branch is unit-tested with a fake chrome. The hub arbitrates
// ownership; this layer still refuses what Chrome would let through but we must
// not touch (extension pages, chrome://, non-http(s)), and it reports facts —
// the decision to ask is the daemon's (docs/feat/browser-inspect.md §5).
export const DEBUGGER_IDLE_MS = 10 * 60 * 1000;

export function isTouchable(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

export function createOps({ chrome, send, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const sessions = new Map(); // sessionUid -> { title, groupId?, tabs:Set }
  const tabSession = new Map(); // tabId -> sessionUid
  const attached = new Map(); // tabId -> idle timer
  const tracing = new Set(); // tabIds the session asked to trace

  const fail = (error) => ({ ok: false, error });
  const ok = (result) => ({ ok: true, result });

  async function touchable(tab) {
    let t;
    try {
      t = await chrome.tabs.get(tab);
    } catch {
      return { error: "the user closed this tab" };
    }
    if (!isTouchable(t.url ?? t.pendingUrl)) {
      return { error: "this page cannot be read (browser or extension page)" };
    }
    return { tab: t };
  }

  async function pageOp(tab, msg) {
    const g = await touchable(tab);
    if (g.error) return fail(g.error);
    let reply;
    try {
      reply = await chrome.tabs.sendMessage(tab, { target: "tentacle-page", ...msg });
    } catch {
      // Tab opened before the extension: inject the content script once.
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab }, files: ["src/page.js"] });
        reply = await chrome.tabs.sendMessage(tab, { target: "tentacle-page", ...msg });
      } catch (e) {
        return fail(`the page does not answer: ${e?.message ?? e}`);
      }
    }
    if (!reply || reply.error) return fail(reply?.error ?? "the page did not answer");
    touch(tab);
    return ok(reply.value);
  }

  async function group(session, tabId) {
    const s = sessions.get(session);
    if (!s) return;
    const groupId = await chrome.tabs.group(
      s.groupId === undefined ? { tabIds: [tabId] } : { tabIds: [tabId], groupId: s.groupId },
    );
    if (s.groupId === undefined) {
      s.groupId = groupId;
      await chrome.tabGroups.update(groupId, { title: `tentacle · ${s.title}`, color: "grey" });
    }
    s.tabs.add(tabId);
    tabSession.set(tabId, session);
  }

  async function open(op) {
    if (!isTouchable(op.url)) return fail("only http(s) pages can be opened");
    const s = sessions.get(op.sessionUid);
    if (!s) return fail("this session has not claimed the browser");
    let tab;
    if (op.tab !== undefined) {
      tab = await chrome.tabs.update(op.tab, { url: op.url });
    } else {
      tab = await chrome.tabs.create({ url: op.url, active: false });
      await group(op.sessionUid, tab.id);
    }
    return ok({ tab: tab.id, url: tab.pendingUrl ?? tab.url ?? op.url, title: tab.title ?? "" });
  }

  async function tabs(op) {
    const s = sessions.get(op.sessionUid);
    const list = [];
    for (const id of op.tabs ?? s?.tabs ?? []) {
      try {
        const t = await chrome.tabs.get(id);
        list.push({
          id,
          title: t.title ?? "",
          url: t.url ?? "",
          traced: attached.has(id),
          handedOver: s ? !s.tabs.has(id) : true,
        });
      } catch {
        // closed: onRemoved already told the hub
      }
    }
    return ok({ tabs: list });
  }

  // ---- debugger: on demand, only for bodies / WS / raw cookies (Q4) -------------

  function touch(tab) {
    const t = attached.get(tab);
    if (t === undefined) return;
    clearTimer(t);
    attached.set(
      tab,
      setTimer(() => void detach(tab), DEBUGGER_IDLE_MS),
    );
  }

  async function attach(tab) {
    if (attached.has(tab)) return;
    await chrome.debugger.attach({ tabId: tab }, "1.3");
    attached.set(
      tab,
      setTimer(() => void detach(tab), DEBUGGER_IDLE_MS),
    );
    await chrome.debugger.sendCommand({ tabId: tab }, "Network.enable", {
      maxResourceBufferSize: 10 * 1024 * 1024,
      maxTotalBufferSize: 100 * 1024 * 1024,
    });
  }

  async function detach(tab) {
    const t = attached.get(tab);
    if (t !== undefined) clearTimer(t);
    attached.delete(tab);
    try {
      await chrome.debugger.detach({ tabId: tab });
    } catch {
      // already gone
    }
  }

  async function net(op) {
    if (op.action === "stop") {
      tracing.delete(op.tab);
      await detach(op.tab);
      return ok({ tracing: false });
    }
    const g = await touchable(op.tab);
    if (g.error) return fail(g.error);
    tracing.add(op.tab);
    try {
      await attach(op.tab);
    } catch (e) {
      tracing.delete(op.tab);
      return fail(`cannot trace this tab: ${e?.message ?? e}`);
    }
    return ok({ tracing: true, tier: "full" });
  }

  function onDebuggerEvent(source, method, params) {
    if (source.tabId === undefined || !tracing.has(source.tabId)) return;
    touch(source.tabId);
    send({ event: "net", tab: source.tabId, tier: "full", entry: { method, params } });
  }

  /** `reason` is Chrome's: only `canceled_by_user` is a revocation (U1). */
  function onDebuggerDetach(source, reason) {
    const tab = source.tabId;
    if (tab === undefined || !attached.has(tab)) return;
    const t = attached.get(tab);
    if (t !== undefined) clearTimer(t);
    attached.delete(tab);
    if (reason === "canceled_by_user") {
      tracing.delete(tab);
      send({ event: "detached", tab, reason: "canceled_by_user" });
      return;
    }
    // Cross-site navigation swaps the process: re-attach while the tab is still ours.
    if (reason === "target_closed" && tracing.has(tab)) {
      void attach(tab).catch(() => {
        tracing.delete(tab);
        send({ event: "detached", tab, reason: "target_closed" });
      });
      return;
    }
    tracing.delete(tab);
    send({ event: "detached", tab, reason: "other" });
  }

  /** Headers-only tier: no infobar. Fed for tabs of a claimed session. */
  function onWebRequest(d) {
    if (!tabSession.has(d.tabId)) return;
    send({
      event: "net",
      tab: d.tabId,
      tier: "headers",
      entry: { url: d.url, method: d.method, status: d.statusCode, type: d.type },
    });
  }

  function onTabRemoved(tab) {
    const session = tabSession.get(tab);
    tabSession.delete(tab);
    tracing.delete(tab);
    sessions.get(session)?.tabs.delete(tab);
    void detach(tab);
    send({ event: "tab_closed", tab });
  }

  /** The user gives a tab to a session (popup): the hub marks it handed-over. */
  function handover(sessionUid, tab) {
    if (!sessions.has(sessionUid)) return false;
    tabSession.set(tab, sessionUid);
    send({ event: "handover", sessionUid, tab });
    return true;
  }

  async function release(op) {
    const s = sessions.get(op.sessionUid);
    if (!s) return ok({});
    for (const tab of s.tabs) {
      tracing.delete(tab);
      tabSession.delete(tab);
      await detach(tab);
    }
    if (s.groupId !== undefined) {
      try {
        await chrome.tabGroups.update(s.groupId, { title: `tentacle · ${s.title} (ended)` });
      } catch {
        // group already gone
      }
    }
    sessions.delete(op.sessionUid);
    return ok({});
  }

  async function handle(msg) {
    try {
      switch (msg.op) {
        case "claim":
          sessions.set(msg.sessionUid, { title: msg.title, tabs: new Set() });
          return ok({});
        case "release":
          return await release(msg);
        case "tabs":
          return await tabs(msg);
        case "open":
          return await open(msg);
        case "read":
          return await pageOp(msg.tab, { kind: "read", ...msg });
        case "click":
          return await pageOp(msg.tab, { kind: "click", ...msg });
        case "type":
          return await pageOp(msg.tab, { kind: "type", ...msg });
        case "net":
          return await net(msg);
        default:
          return fail(`unknown op ${String(msg.op)}`);
      }
    } catch (e) {
      return fail(e?.message ?? String(e));
    }
  }

  const listSessions = () => [...sessions].map(([uid, s]) => ({ uid, title: s.title }));

  return {
    handle,
    onDebuggerEvent,
    onDebuggerDetach,
    onWebRequest,
    onTabRemoved,
    handover,
    listSessions,
  };
}
