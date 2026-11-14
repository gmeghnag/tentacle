/**
 * A link tap confirms before it opens (docs/feat/mobile-session-view.md 12c,
 * plan F22 / Owner Q7): the transcript's text came from another machine, so the
 * app shows the FULL url and opens it only on an explicit Open.
 */
import { describe, expect, test } from "bun:test";
import { linkPrompt, openableUrl, tapLink } from "../src/links.ts";

describe("what a link tap offers", () => {
  test("http(s) and mailto are openable; anything else is not", () => {
    expect(openableUrl("https://example.com/a?b=c")).toBe(true);
    expect(openableUrl("http://127.0.0.1:8080/")).toBe(true);
    expect(openableUrl("mailto:someone@example.com")).toBe(true);
    // A scheme the OS would hand to another app, and a non-URL.
    expect(openableUrl("javascript:alert(1)")).toBe(false);
    expect(openableUrl("file:///etc/passwd")).toBe(false);
    expect(openableUrl("not a url")).toBe(false);
  });

  test("the confirmation shows the WHOLE url, never a row's short label", () => {
    const href = "https://example.com/a/very/long/path?with=query#and-fragment";
    expect(linkPrompt(href)?.message).toBe(href);
  });

  test("an unopenable scheme gets no prompt at all (its text stays in the row)", () => {
    expect(linkPrompt("javascript:alert(1)")).toBeNull();
  });
});

describe("tapLink", () => {
  test("nothing opens until the person confirms", () => {
    const opened: string[] = [];
    let pending: (() => void) | null = null;
    tapLink("https://example.com/x", {
      confirm: (_prompt, onConfirm) => {
        pending = onConfirm;
      },
      open: (href) => {
        opened.push(href);
      },
    });
    expect(opened).toEqual([]); // shown, not opened
    expect(pending).not.toBeNull();
    (pending as unknown as () => void)();
    expect(opened).toEqual(["https://example.com/x"]);
  });

  test("a cancelled prompt opens nothing (the callback is simply never called)", () => {
    const opened: string[] = [];
    tapLink("https://example.com/x", {
      confirm: () => {
        // the person tapped Cancel: no callback
      },
      open: (href) => {
        opened.push(href);
      },
    });
    expect(opened).toEqual([]);
  });

  test("an unopenable link is not even offered", () => {
    let prompted = 0;
    tapLink("file:///etc/passwd", {
      confirm: () => {
        prompted += 1;
      },
      open: () => {},
    });
    expect(prompted).toBe(0);
  });
});
