// Page-side logic (content script). A classic script (content scripts cannot be
// ES modules), so it publishes `createPage` on globalThis; `content.js`-style
// installation is at the bottom and runs only inside Chrome. Pure over an
// injected `doc`, so the unit tests drive it with a fake DOM.
(() => {
  const MAX_DEFAULT = 20000;
  const INTERACTIVE =
    'a[href],button,input,select,textarea,summary,[role="button"],[role="link"],[contenteditable=""],[contenteditable="true"]';

  function createPage(doc) {
    const refs = new Map(); // ref -> element
    const ids = new WeakMap(); // element -> ref
    let next = 1;

    function refOf(el) {
      let r = ids.get(el);
      if (r === undefined) {
        r = `e${next++}`;
        ids.set(el, r);
        refs.set(r, el);
      }
      return r;
    }

    function nameOf(el) {
      const label =
        el.getAttribute?.("aria-label") ||
        el.getAttribute?.("title") ||
        el.getAttribute?.("placeholder") ||
        el.innerText ||
        el.textContent ||
        el.getAttribute?.("name") ||
        "";
      return String(label).replace(/\s+/g, " ").trim().slice(0, 80);
    }

    function isPassword(el) {
      return (el.getAttribute?.("type") || "").toLowerCase() === "password";
    }

    function facts(el) {
      const form = el.form ?? el.closest?.("form") ?? null;
      const tag = String(el.tagName || "").toLowerCase();
      const type = (el.getAttribute?.("type") || "").toLowerCase();
      const submits =
        form !== null &&
        ((tag === "button" && (type === "" || type === "submit")) ||
          (tag === "input" && (type === "submit" || type === "image")));
      return {
        tag,
        ...(type ? { type } : {}),
        ...(el.getAttribute?.("autocomplete")
          ? { autocomplete: el.getAttribute("autocomplete") }
          : {}),
        name: nameOf(el),
        ...(el.href ? { href: String(el.href) } : {}),
        ...(el.isContentEditable ? { isContentEditable: true } : {}),
        inForm: form !== null,
        submits,
        ...(form
          ? {
              formMethod: String(form.method || "get").toLowerCase(),
              formAction: String(form.action || ""),
            }
          : {}),
      };
    }

    function resolve(msg) {
      if (msg.ref !== undefined) {
        const el = refs.get(msg.ref);
        if (!el || el.isConnected === false) {
          return { error: `unknown or stale ref ${msg.ref}: read the outline again` };
        }
        return { el };
      }
      if (typeof msg.x === "number" && typeof msg.y === "number") {
        const el = doc.elementFromPoint?.(msg.x, msg.y);
        return el ? { el } : { error: "nothing at those coordinates" };
      }
      return { error: "click needs a ref or x,y" };
    }

    function outline(root) {
      const lines = [];
      for (const el of root.querySelectorAll(INTERACTIVE)) {
        if (el.hidden || el.getAttribute?.("aria-hidden") === "true") continue;
        if (el.getAttribute?.("type") === "hidden") continue;
        const tag = String(el.tagName).toLowerCase();
        const type = el.getAttribute?.("type");
        lines.push(`${refOf(el)} ${tag}${type ? `[${type}]` : ""} "${nameOf(el)}"`);
        if (lines.length >= 400) break;
      }
      return lines.join("\n");
    }

    function html(root, max) {
      const clone = root.cloneNode(true);
      // DOM password values never leave the page (docs/feat/browser-inspect.md §3).
      for (const p of clone.querySelectorAll('input[type="password"]')) {
        p.removeAttribute("value");
      }
      return String(clone.outerHTML ?? "").slice(0, max);
    }

    function read(msg) {
      const max = msg.maxChars ?? MAX_DEFAULT;
      const root = msg.selector ? doc.querySelector(msg.selector) : doc.body;
      if (!root) return { error: `nothing matches ${msg.selector}` };
      let text;
      if (msg.mode === "outline") text = outline(root);
      else if (msg.mode === "html") text = html(root, max);
      else text = String(root.innerText ?? root.textContent ?? "");
      const truncated = text.length > max;
      return {
        value: { url: doc.location?.href, title: doc.title, text: text.slice(0, max), truncated },
      };
    }

    function click(msg) {
      const r = resolve(msg);
      if (r.error) return r;
      const f = facts(r.el);
      if (msg.probe) return { value: { facts: f } };
      r.el.click();
      return { value: { facts: f, clicked: true } };
    }

    function type(msg) {
      const r = resolve(msg);
      if (r.error) return r;
      const el = r.el;
      const f = facts(el);
      if (msg.probe) return { value: { facts: f } };
      if (el.isContentEditable) {
        el.textContent = msg.text;
      } else if ("value" in el) {
        el.focus?.();
        el.value = msg.text;
      } else {
        return { error: "that element does not take text" };
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      if (msg.submit) {
        const form = el.form ?? el.closest?.("form");
        if (form?.requestSubmit) form.requestSubmit();
        else el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      }
      const shown = isPassword(el)
        ? "•".repeat(Math.min(msg.text.length, 12))
        : msg.text.slice(0, 200);
      return { value: { facts: f, typed: shown } };
    }

    return {
      handle(msg) {
        if (msg.kind === "read") return read(msg);
        if (msg.kind === "click") return click(msg);
        if (msg.kind === "type") return type(msg);
        return { error: `unknown page op ${msg.kind}` };
      },
    };
  }

  globalThis.__tentacleCreatePage = createPage;
  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage && globalThis.document) {
    if (!globalThis.__tentaclePage) {
      globalThis.__tentaclePage = createPage(globalThis.document);
      chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
        if (msg?.target !== "tentacle-page") return false;
        reply(globalThis.__tentaclePage.handle(msg));
        return false;
      });
    }
  }
})();
