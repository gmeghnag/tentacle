// Extension-side op handling over an injected `chrome` + `send` (native port),
// so every branch is unit-tested with a fake chrome. The hub arbitrates
// ownership; this layer still refuses what Chrome would let through but we must
// not touch (extension pages, chrome://, non-http(s)), and it reports facts —
// the decision to ask is the daemon's (docs/feat/browser-inspect.md §5).
export const DEBUGGER_IDLE_MS = 10 * 60 * 1000;

export function isTouchable(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

/** A response body the daemon may see: text ≤ 1 MiB; binary only as size + sha256. */
export const BODY_MAX_CHARS = 1024 * 1024;

const toBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
function toBase64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** Downscale a JPEG to `maxEdge` in the worker (OffscreenCanvas); unchanged when it fits or cannot. */
export async function scaleJpeg(b64, maxEdge) {
  if (
    !maxEdge ||
    typeof OffscreenCanvas === "undefined" ||
    typeof createImageBitmap !== "function"
  ) {
    return b64;
  }
  const bmp = await createImageBitmap(new Blob([toBytes(b64)], { type: "image/jpeg" }));
  const k = maxEdge / Math.max(bmp.width, bmp.height);
  if (k >= 1) return b64;
  const canvas = new OffscreenCanvas(
    Math.max(1, Math.round(bmp.width * k)),
    Math.max(1, Math.round(bmp.height * k)),
  );
  canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 });
  return toBase64(new Uint8Array(await blob.arrayBuffer()));
}

export function createOps({
  chrome,
  send,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  scale = scaleJpeg,
}) {
  const sessions = new Map(); // sessionUid -> { title, groupId?, tabs:Set }
  const tabSession = new Map(); // tabId -> sessionUid
  const attached = new Map(); // tabId -> idle timer
  const tracing = new Set(); // tabIds the session asked to trace
  const handed = new Set(); // tabIds the user handed over (closing releases, never closes)

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
      // Its first `loading` may have fired before the tab was ours.
      void hookConsole(tab.id);
    }
    return ok({ tab: tab.id, url: tab.pendingUrl ?? tab.url ?? op.url, title: tab.title ?? "" });
  }

  // ---- console: a MAIN-world hook, injected ONLY into owned tabs -----------------

  /** Idempotent (the hook guards itself); a page that refuses scripting just has no console capture. */
  async function hookConsole(tab) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab },
        world: "MAIN",
        injectImmediately: true,
        files: ["src/console-hook.js"],
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * A navigation in an owned tab starts a new document: hook it as early as we
   * can. A `groupId` change that takes an owned tab OUT of its session's group
   * is the user taking it back (§6): the session loses it like a closed tab.
   */
  function onTabUpdated(tab, info) {
    if (info?.groupId !== undefined && tabSession.has(tab)) {
      const s = sessions.get(tabSession.get(tab));
      if (s?.groupId !== info.groupId) {
        takeBack(tab);
        return;
      }
    }
    if (info?.status === "loading" && tabSession.has(tab)) void hookConsole(tab);
  }

  async function consoleOp(op) {
    const g = await touchable(op.tab);
    if (g.error) return fail(g.error);
    const hooked = await hookConsole(op.tab);
    const r = await pageOp(op.tab, { kind: "console", cursor: op.cursor ?? 0 });
    if (r.ok && !hooked) r.result = { ...r.result, hookFailed: true };
    return r;
  }

  // ---- screenshot: the visible tab without the debugger; a background one with it --

  async function shot(op) {
    const g = await touchable(op.tab);
    if (g.error) return fail(g.error);
    let data;
    let via;
    if (g.tab.active) {
      const url = await chrome.tabs.captureVisibleTab(g.tab.windowId, {
        format: "jpeg",
        quality: 80,
      });
      data = String(url).replace(/^data:image\/jpeg;base64,/, "");
      via = "visible";
    } else {
      try {
        await attach(op.tab);
      } catch (e) {
        return fail(`cannot capture this background tab: ${e?.message ?? e}`);
      }
      const r = await chrome.debugger.sendCommand({ tabId: op.tab }, "Page.captureScreenshot", {
        format: "jpeg",
        quality: 80,
      });
      data = r?.data;
      via = "debugger";
      touch(op.tab);
    }
    if (typeof data !== "string" || data === "") return fail("Chrome returned no picture");
    return ok({ mimeType: "image/jpeg", data: await scale(data, op.maxEdge), via });
  }

  // ---- one response body (full tier only) ---------------------------------------

  async function body(op) {
    if (!attached.has(op.tab)) {
      return fail("a response body needs full tracing: browser_net start on this tab first");
    }
    let r;
    try {
      r = await chrome.debugger.sendCommand({ tabId: op.tab }, "Network.getResponseBody", {
        requestId: op.requestId,
      });
    } catch (e) {
      return fail(`no body for ${op.requestId}: ${e?.message ?? e}`);
    }
    touch(op.tab);
    const text = String(r?.body ?? "");
    if (r?.base64Encoded) {
      const bytes = toBytes(text);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      const sha256 = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
      return ok({ binary: true, size: bytes.length, sha256 });
    }
    return ok({
      binary: false,
      size: text.length,
      text: text.slice(0, BODY_MAX_CHARS),
      truncated: text.length > BODY_MAX_CHARS,
    });
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
          handedOver: handed.has(id) || !s?.tabs.has(id),
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

  /** The tab is no longer the session's (closed, or dragged out of its group). */
  function takeBack(tab) {
    const session = tabSession.get(tab);
    tabSession.delete(tab);
    handed.delete(tab);
    tracing.delete(tab);
    sessions.get(session)?.tabs.delete(tab);
    void detach(tab);
    send({ event: "tab_closed", tab });
  }

  function onTabRemoved(tab) {
    takeBack(tab);
  }

  /**
   * The user gives a tab to a session (popup): it joins the session's group
   * (D1: the user sees what the session holds, and drags it out to take it
   * back), then the hub marks it handed-over. A tab Chrome refuses to group is
   * not handed over.
   */
  async function handover(sessionUid, tab) {
    if (!sessions.has(sessionUid)) return false;
    try {
      await group(sessionUid, tab);
    } catch {
      return false;
    }
    handed.add(tab);
    send({ event: "handover", sessionUid, tab });
    return true;
  }

  /**
   * `browser_close` (B5): the session's OWN tab is closed (onRemoved then tells
   * the hub); a handed-over tab is the user's — it leaves the group and goes
   * back to them, open. The hub checked ownership before forwarding.
   */
  async function close(op) {
    if (handed.has(op.tab)) {
      takeBack(op.tab);
      try {
        await chrome.tabs.ungroup(op.tab);
      } catch {
        // already out of the group, or gone
      }
      return ok({ closed: false, released: true });
    }
    await chrome.tabs.remove(op.tab);
    return ok({ closed: true, released: false });
  }

  /** The session's title changed (B5b): its group follows; its tabs stay. */
  async function retitle(op) {
    const s = sessions.get(op.sessionUid);
    if (!s) return fail("this session has not claimed the browser");
    s.title = op.title;
    if (s.groupId !== undefined) {
      await chrome.tabGroups.update(s.groupId, { title: `tentacle · ${s.title}` });
    }
    return ok({});
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
        case "retitle":
          return await retitle(msg);
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
        case "close":
          return await close(msg);
        case "net":
          return await net(msg);
        case "shot":
          return await shot(msg);
        case "console":
          return await consoleOp(msg);
        case "body":
          return await body(msg);
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
    onTabUpdated,
    handover,
    listSessions,
  };
}
