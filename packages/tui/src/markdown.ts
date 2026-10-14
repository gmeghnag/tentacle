/**
 * Render Markdown to an ANSI string for the terminal (bold, headings, lists,
 * inline code, fenced code blocks). The result is embedded in an Ink `<Text>`.
 *
 * Pure and synchronous: `marked` is configured without async extensions.
 */
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";

// Configure the singleton once with the terminal renderer.
marked.use(markedTerminal());

export function renderMarkdown(text: string): string {
  const out = marked.parse(text, { async: false });
  return (typeof out === "string" ? out : text).replace(/\n+$/, "");
}
