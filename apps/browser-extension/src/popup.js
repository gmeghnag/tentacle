// Handover popup: the user gives the active tab to one of the linked sessions.
const state = document.getElementById("state");
const select = document.getElementById("session");
const give = document.getElementById("give");

const bg = (msg) => chrome.runtime.sendMessage({ target: "tentacle-bg", ...msg });

const { sessions, linked } = await bg({ kind: "sessions" });
state.textContent = linked
  ? sessions.length > 0
    ? "Linked. Choose a session:"
    : "Linked, but no tentacle session has the browser on."
  : "Not linked to tentacle (is `tentacle browser install` done?).";
for (const s of sessions) select.add(new Option(s.title || s.uid, s.uid));
give.disabled = sessions.length === 0;

give.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const r = await bg({ kind: "handover", sessionUid: select.value, tab: tab.id });
  state.textContent = r.ok ? "Handed over." : "Refused.";
});
