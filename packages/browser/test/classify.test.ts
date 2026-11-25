import { describe, expect, test } from "bun:test";
import { classifyAction, registrableDomain } from "../src/index.ts";

const visited = new Set(["example.com"]);
const base = { visited } as const;

describe("registrableDomain", () => {
  test("eTLD+1 incl. two-label suffixes", () => {
    expect(registrableDomain("https://www.example.com/x")).toBe("example.com");
    expect(registrableDomain("a.b.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("localhost")).toBe("localhost");
    expect(registrableDomain("http://127.0.0.1:3000/")).toBe("127.0.0.1");
    expect(registrableDomain("not a url://")).toBe("");
  });
});

describe("classifyAction", () => {
  test("submit control asks, not hard", () => {
    const v = classifyAction({
      ...base,
      kind: "click",
      facts: { tag: "button", submits: true, name: "Go" },
    });
    expect(v).toEqual({ ask: true, hard: false, reasons: ["submits a form"] });
  });
  test("lexicon EN and IT", () => {
    for (const name of [
      "Delete account",
      "Elimina",
      "Invia",
      "Send",
      "Pubblica ora",
      "Unsubscribe",
    ]) {
      expect(classifyAction({ ...base, kind: "click", facts: { tag: "button", name } }).ask).toBe(
        true,
      );
    }
    expect(
      classifyAction({ ...base, kind: "click", facts: { tag: "a", name: "Read more" } }).ask,
    ).toBe(false);
  });
  test("lexicon needs a whole word", () => {
    expect(
      classifyAction({ ...base, kind: "click", facts: { tag: "a", name: "Boarder" } }).ask,
    ).toBe(false);
    expect(
      classifyAction({ ...base, kind: "click", facts: { tag: "a", name: "Sender info" } }).ask,
    ).toBe(false);
  });
  test("payment wording is hard", () => {
    const v = classifyAction({
      ...base,
      kind: "click",
      facts: { tag: "button", name: "Paga ora" },
    });
    expect(v.hard).toBe(true);
    expect(
      classifyAction({ ...base, kind: "click", facts: { tag: "button", name: "Delete" } }).hard,
    ).toBe(false);
  });
  test("password / cc / otp typing is hard; ordinary typing is free", () => {
    for (const f of [
      { type: "password" },
      { autocomplete: "cc-number" },
      { autocomplete: "one-time-code" },
    ]) {
      const v = classifyAction({ ...base, kind: "type", facts: { tag: "input", ...f } });
      expect(v.ask && v.hard).toBe(true);
    }
    expect(
      classifyAction({ ...base, kind: "type", facts: { tag: "input", type: "text" } }).ask,
    ).toBe(false);
  });
  test("type with submit asks", () => {
    expect(
      classifyAction({ ...base, kind: "type", submit: true, facts: { tag: "input", type: "text" } })
        .ask,
    ).toBe(true);
  });
  test("cross-domain open asks; same eTLD+1 and visited do not", () => {
    expect(classifyAction({ ...base, kind: "open", targetUrl: "https://evil.test/" }).ask).toBe(
      true,
    );
    expect(
      classifyAction({ ...base, kind: "open", targetUrl: "https://sub.example.com/" }).ask,
    ).toBe(false);
    expect(
      classifyAction({
        kind: "open",
        targetUrl: "https://a.example.co.uk/",
        visited: new Set(["example.co.uk"]),
      }).ask,
    ).toBe(false);
    expect(
      classifyAction({
        kind: "open",
        targetUrl: "https://b.other.co.uk/",
        visited: new Set(["example.co.uk"]),
      }).ask,
    ).toBe(true);
  });
  test("same-domain link click does not ask; cross-domain link does", () => {
    expect(
      classifyAction({
        ...base,
        kind: "click",
        facts: { tag: "a", name: "Docs", href: "https://example.com/d" },
      }).ask,
    ).toBe(false);
    expect(
      classifyAction({
        ...base,
        kind: "click",
        facts: { tag: "a", name: "Docs", href: "https://x.test/d" },
      }).ask,
    ).toBe(true);
  });
  test("a form posting to a new domain names it (Enter-submit typing too)", () => {
    const facts = {
      tag: "input",
      name: "q",
      inForm: true,
      formAction: "https://evil.test/collect",
    };
    const v = classifyAction({ ...base, kind: "type", submit: true, facts });
    expect(v.reasons).toContain("navigates to a new domain (evil.test)");
    // Without submitting, typing into the same field navigates nowhere.
    expect(classifyAction({ ...base, kind: "type", facts }).ask).toBe(false);
    const click = classifyAction({
      ...base,
      kind: "click",
      facts: { tag: "button", name: "Go", submits: true, formAction: "https://evil.test/c" },
    });
    expect(click.reasons).toContain("navigates to a new domain (evil.test)");
  });
  test("handed-over first action asks", () => {
    const v = classifyAction({
      ...base,
      kind: "click",
      firstOnHandedOver: true,
      facts: { tag: "a", name: "Docs" },
    });
    expect(v.ask).toBe(true);
    expect(v.hard).toBe(false);
  });
});
