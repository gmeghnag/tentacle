/**
 * A session's working folder as the header and the drawer show it
 * (docs/feat/mobile-header-status.md, owner addendum): small mono, the home
 * folder as `~`, a long path cut in the MIDDLE so the last component always
 * shows. The phone does not know the computer's `$HOME`, so the usual roots
 * (`/Users/<u>`, `/home/<u>`, `/root`) are folded. Pure (AGENTS §7); the Text
 * also middle-ellipsizes for the final width fit.
 */

/** More components than this and the middle is cut (`~` counts as one). */
const MAX_PARTS = 5;

export function folderLabel(cwd: string): string {
  const path = cwd.trim();
  if (path === "") {
    return "";
  }
  const parts = path.split("/").filter((part) => part !== "");
  if (parts.length === 0) {
    return "/";
  }
  let tokens: string[];
  const [first, second] = parts;
  if ((first === "Users" || first === "home") && second !== undefined) {
    tokens = ["~", ...parts.slice(2)];
  } else if (first === "root") {
    tokens = ["~", ...parts.slice(1)];
  } else {
    tokens = ["", ...parts];
  }
  const absolute = tokens[0] === "";
  // The leading "" of an absolute path is not a component of its own.
  const count = absolute ? tokens.length - 1 : tokens.length;
  if (count > MAX_PARTS) {
    const head = absolute ? tokens.slice(0, 3) : tokens.slice(0, 2);
    tokens = [...head, "…", ...tokens.slice(-2)];
  }
  return tokens.join("/");
}
