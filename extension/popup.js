const $ = (id) => document.getElementById(id);
const ids = Object.keys(self.FLIPDESK_SITES);
(async () => {
  const c = await chrome.storage.local.get(["server", "token", "enabled", "auto", "lastError", "lastPoll"]);
  $("server").value = c.server || "http://localhost:8787";
  $("token").value = c.token || "";
  $("auto").checked = c.auto !== false;
  const enabled = c.enabled || ids;
  $("sites").innerHTML = ids.map((id) => `<label style="text-transform:none;color:#e4e4e7;margin:0"><input type="checkbox" value="${id}" ${enabled.includes(id) ? "checked" : ""}/> ${id}</label>`).join("");
  $("status").textContent = c.lastError ? `⚠ ${c.lastError}` : c.lastPoll ? `Last check ${new Date(c.lastPoll).toLocaleTimeString()}` : "";
})();
$("save").onclick = async () => {
  const enabled = [...document.querySelectorAll("#sites input:checked")].map((i) => i.value);
  await chrome.storage.local.set({ server: $("server").value.trim(), token: $("token").value.trim(), enabled, auto: $("auto").checked });
  const r = await chrome.runtime.sendMessage({ type: "flipdesk:test" });
  $("status").textContent = r.ok ? "✓ Connected to FlipDesk" : `⚠ ${r.error}`;
};
$("now").onclick = async () => {
  const r = await chrome.runtime.sendMessage({ type: "flipdesk:poll" });
  $("status").textContent = r.active ? "Opened a job tab" : "No pending jobs";
};
