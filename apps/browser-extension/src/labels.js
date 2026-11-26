// Pure naming helpers shared by the worker (tab group titles) and the popup
// (session list). The session's NAME is the title tentacle shows in its TUI and
// on the phone (the daemon sends it in `claim` / `retitle`); the id is the
// session uid. Everything here may see untrusted strings: coerce, never throw.

const GROUP_MAX = 40;
const ID_MIN = 8;

const str = (v) => (typeof v === "string" ? v : "");

/** First 8 characters of the uid (what `claim` used to use as a stand-in title). */
export function shortId(uid) {
  return str(uid).slice(0, ID_MIN);
}

function clean(title) {
  // Control characters (incl. newlines) become spaces, then runs of space collapse.
  let out = "";
  for (const ch of str(title)) {
    const c = ch.charCodeAt(0);
    out += c < 32 || c === 127 ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * The Chrome tab group's label: ONLY the session's name. A session with no
 * name yet shows «tentacle» + 4 id characters, so two unnamed groups differ.
 */
export function groupLabel(title, uid) {
  const t = clean(title);
  if (t === "") return `tentacle ${str(uid).slice(0, 4)}`.trimEnd();
  return t.length > GROUP_MAX ? `${t.slice(0, GROUP_MAX - 1)}…` : t;
}

/**
 * The popup's rows: name (primary) + id (secondary). The id is the shortest
 * prefix (≥ 8 chars) that tells the listed sessions apart.
 */
export function sessionRows(sessions) {
  const list = (Array.isArray(sessions) ? sessions : []).filter(
    (s) => s && typeof s.uid === "string" && s.uid !== "",
  );
  return list.map((s) => {
    const title = clean(s.title);
    let n = ID_MIN;
    while (n < s.uid.length && list.some((o) => o !== s && o.uid.slice(0, n) === s.uid.slice(0, n)))
      n++;
    return {
      uid: s.uid,
      name: groupLabel(title, s.uid),
      id: s.uid.slice(0, n),
      unnamed: title === "",
    };
  });
}

/** What the popup shows: `unlinked` (no native link), `empty` (linked, no session) or `list`. */
export function popupView(linked, rows) {
  if (linked !== true) return "unlinked";
  return rows.length > 0 ? "list" : "empty";
}
