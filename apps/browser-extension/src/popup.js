// Handover popup: the user gives the active tab to one of the linked sessions.
// Names / ids / which view to show come from labels.js (pure, tested); this file
// only draws. Text goes in via textContent, never innerHTML (names are untrusted).
import { popupView, sessionRows } from "./labels.js";

const $ = (id) => document.getElementById(id);
const give = $("give");
const msg = $("msg");
const HINT = "Read-only until the session asks.";

const bg = (m) => chrome.runtime.sendMessage({ target: "tentacle-bg", ...m });

const { sessions, linked } = await bg({ kind: "sessions" });
const rows = sessionRows(sessions);
const view = popupView(linked, rows);

$("link").classList.toggle("on", linked === true);
$("linktext").textContent = linked ? "linked" : "not linked";
$("list-view").hidden = view !== "list";
$("empty-view").hidden = view !== "empty";
$("unlinked-view").hidden = view !== "unlinked";
give.disabled = view !== "list";
$("footer").hidden = view !== "list";

let chosen = rows[0]?.uid;
const list = $("sessions");

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function draw() {
  list.replaceChildren(
    ...rows.map((r) => {
      const li = el("li");
      li.setAttribute("role", "presentation");
      const b = el("button");
      b.type = "button";
      b.setAttribute("role", "option");
      b.setAttribute("aria-selected", String(r.uid === chosen));
      b.title = r.uid;
      const txt = el("span", "txt");
      txt.append(el("span", r.unnamed ? "name unnamed" : "name", r.name), el("span", "sid", r.id));
      b.append(txt, el("span", "tick", "✓"));
      b.addEventListener("click", () => {
        chosen = r.uid;
        draw();
      });
      li.append(b);
      return li;
    }),
  );
}
draw();

give.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const r = await bg({ kind: "handover", sessionUid: chosen, tab: tab.id });
  msg.textContent = r.ok ? "Handed over." : "Refused.";
  setTimeout(() => {
    msg.textContent = HINT;
  }, 3000);
});
