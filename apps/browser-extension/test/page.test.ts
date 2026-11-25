import { beforeAll, describe, expect, test } from "bun:test";

// biome-ignore lint/suspicious/noExplicitAny: fake DOM
type Any = Record<string, any>;

// A tiny fake DOM: just what page.js touches.
function el(tag: string, attrs: Any = {}, extra: Any = {}): Any {
  const e: Any = {
    tagName: tag.toUpperCase(),
    hidden: false,
    isConnected: true,
    innerText: extra.text ?? "",
    clicked: 0,
    events: [] as string[],
    getAttribute: (k: string) => attrs[k] ?? null,
    click() {
      e.clicked++;
    },
    dispatchEvent: (ev: Event) => e.events.push(ev.type),
    focus() {},
    closest: () => e.form ?? null,
    ...extra,
  };
  if (attrs.href) e.href = attrs.href;
  return e;
}

function docOf(items: Any[], html = "<p>x</p>"): Any {
  const body: Any = {
    innerText: "hello world ".repeat(10),
    querySelectorAll: (sel: string) => (sel.includes("a[href]") ? items : []),
    cloneNode: () => ({
      outerHTML: html,
      querySelectorAll: () => [{ removeAttribute: (k: string) => removed.push(k) }],
    }),
  };
  const removed: string[] = [];
  return {
    body,
    removed,
    title: "T",
    location: { href: "https://a.test/" },
    querySelector: (s: string) => (s === "#none" ? null : body),
    elementFromPoint: () => items[0] ?? null,
  };
}

let create: (d: Any) => { handle: (m: Any) => Any };
beforeAll(async () => {
  await import("../src/page.js");
  create = (globalThis as Any).__tentacleCreatePage;
});

describe("page logic", () => {
  test("outline gives stable refs; hidden / aria-hidden skipped", () => {
    const a = el("button", {}, { text: "Buy now" });
    const hidden = el("button", { "aria-hidden": "true" }, { text: "no" });
    const p = create(docOf([a, hidden]));
    const r1 = p.handle({ kind: "read", mode: "outline" }).value.text;
    const r2 = p.handle({ kind: "read", mode: "outline" }).value.text;
    expect(r1).toBe('e1 button "Buy now"');
    expect(r2).toBe(r1);
  });

  test("read truncates and flags it; bad selector is an error", () => {
    const p = create(docOf([]));
    const r = p.handle({ kind: "read", mode: "text", maxChars: 20 }).value;
    expect(r.text).toHaveLength(20);
    expect(r.truncated).toBe(true);
    expect(p.handle({ kind: "read", mode: "text", selector: "#none" }).error).toContain("nothing");
  });

  test("html mode strips DOM password values", () => {
    const d = docOf([]);
    create(d).handle({ kind: "read", mode: "html" });
    expect(d.removed).toEqual(["value"]);
  });

  test("probe reports facts without acting; click acts; stale ref refused", () => {
    const form = { method: "POST", action: "https://pay.test/go" };
    const b = el("button", { type: "submit" }, { text: "Pay", form });
    const p = create(docOf([b]));
    p.handle({ kind: "read", mode: "outline" });
    const probe = p.handle({ kind: "click", ref: "e1", probe: true }).value;
    expect(probe.facts).toMatchObject({ tag: "button", submits: true, formMethod: "post" });
    expect(b.clicked).toBe(0);
    expect(p.handle({ kind: "click", ref: "e1" }).value.clicked).toBe(true);
    expect(b.clicked).toBe(1);
    b.isConnected = false;
    expect(p.handle({ kind: "click", ref: "e1" }).error).toContain("stale");
    expect(p.handle({ kind: "click", ref: "e99" }).error).toContain("unknown");
  });

  // Review B5 finding 2 (probe/act TOCTOU). Mutation: ignore `expect` in
  // page.js → the reflowed / rewritten target is acted on → red.
  test("an act whose target changed since the probe is refused, nothing done", () => {
    const search = el("button", {}, { text: "Search" });
    const buy = el("button", {}, { text: "Buy now" });
    const items = [search, buy];
    const d = docOf(items);
    const p = create(d);
    const approved = p.handle({ kind: "click", x: 1, y: 1, probe: true }).value.facts;
    // A reflow while the ask was open: the point now hits «Buy now».
    d.elementFromPoint = () => buy;
    const r = p.handle({ kind: "click", x: 1, y: 1, expect: approved });
    expect(r.error).toContain("changed");
    expect(buy.clicked).toBe(0);
    // Page JS rewrites a link's href during the ask (ref path).
    const link = el("a", { href: "https://a.test/x" }, { text: "Go" });
    const p2 = create(docOf([link]));
    p2.handle({ kind: "read", mode: "outline" });
    const ok = p2.handle({ kind: "click", ref: "e1", probe: true }).value.facts;
    link.href = "https://evil.test/steal";
    expect(p2.handle({ kind: "click", ref: "e1", expect: ok }).error).toContain("changed");
    expect(link.clicked).toBe(0);
    // A form's action rewritten during a type ask: nothing is typed.
    const form = { method: "post", action: "https://a.test/login" };
    const field = el("input", { type: "text" }, { value: "", form });
    const p3 = create(docOf([field]));
    p3.handle({ kind: "read", mode: "outline" });
    const f3 = p3.handle({ kind: "type", ref: "e1", text: "hi", probe: true }).value.facts;
    form.action = "https://evil.test/post";
    expect(p3.handle({ kind: "type", ref: "e1", text: "hi", expect: f3 }).error).toContain(
      "changed",
    );
    expect(field.value).toBe("");
    // Unchanged → acts.
    link.href = "https://a.test/x";
    expect(p2.handle({ kind: "click", ref: "e1", expect: ok }).value.clicked).toBe(true);
  });

  test("type sets value + events; a password field echoes only dots; probe types nothing", () => {
    const pw = el("input", { type: "password" }, { value: "" });
    const p = create(docOf([pw]));
    p.handle({ kind: "read", mode: "outline" });
    expect(
      p.handle({ kind: "type", ref: "e1", text: "s3cret", probe: true }).value.facts.type,
    ).toBe("password");
    expect(pw.value).toBe("");
    const r = p.handle({ kind: "type", ref: "e1", text: "s3cret" }).value;
    expect(pw.value).toBe("s3cret");
    expect(pw.events).toEqual(["input", "change"]);
    expect(r.typed).toBe("••••••");
    expect(r.typed).not.toContain("s3cret");
  });
});

describe("page console ring (B4)", () => {
  test("bounded at 300 with an honest dropped count; cursor paging; long text capped", () => {
    const log = (globalThis as Any).__tentacleCreateLog();
    const p = create({ ...docOf([]) }, log);
    for (let i = 0; i < 305; i++) log.push({ level: "log", text: `m${i}` });
    const all = p.handle({ kind: "console" }).value;
    expect(all.entries).toHaveLength(300);
    expect(all.entries[0].text).toBe("m5");
    expect(all.dropped).toBe(5);
    expect(all.next).toBe(305);
    const tail = p.handle({ kind: "console", cursor: 303 }).value;
    expect(tail.entries.map((e: Any) => e.text)).toEqual(["m303", "m304"]);
    expect(tail.dropped).toBe(0);
    log.push({ level: "error", text: "x".repeat(5000), stack: "s".repeat(9000) });
    const last = p.handle({ kind: "console", cursor: 305 }).value.entries[0];
    expect(last.text).toHaveLength(2000);
    expect(last.stack).toHaveLength(4000);
  });

  test("the hook's hello marks it hooked and is not an entry", () => {
    const log = (globalThis as Any).__tentacleCreateLog();
    expect(log.hooked).toBe(false);
    log.push({ level: "hook", text: "" });
    expect(log.hooked).toBe(true);
    expect(log.list().entries).toEqual([]);
  });
});
