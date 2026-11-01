// FlipDesk extension service worker: polls the local FlipDesk server for jobs on
// browser-only marketplaces, opens the right page, and hands the job to filler.js.
importScripts("sites.js");

const DEFAULTS = { server: "http://localhost:8787", token: "", enabled: Object.keys(self.FLIPDESK_SITES), auto: true };
const cfg = async () => ({ ...DEFAULTS, ...(await chrome.storage.local.get(["server", "token", "enabled", "auto"])) });

async function api(path, init = {}) {
  const c = await cfg();
  const res = await fetch(c.server.replace(/\/$/, "") + path, {
    ...init,
    headers: { "Content-Type": "application/json", "X-FlipDesk-Token": c.token, ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

// tabId -> job payload currently being worked on
const active = new Map();

async function toDataUrls(photos) {
  const c = await cfg();
  const out = [];
  for (const p of photos.slice(0, 16)) {
    const url = p.url.startsWith("http") ? p.url : c.server.replace(/\/$/, "") + p.url;
    try {
      const blob = await (await fetch(url)).blob();
      if (!/^image\/(jpeg|png|webp)/.test(blob.type)) continue; // sites reject svg/gif
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = "";
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      out.push({ name: url.split("/").pop(), type: blob.type, data: btoa(bin) });
    } catch (e) {
      console.warn("photo fetch failed", url, e);
    }
  }
  return out;
}

async function poll() {
  const c = await cfg();
  if (!c.token || !c.auto || active.size > 0) return; // one job at a time
  let next;
  try {
    next = await api(`/api/ext/next?m=${c.enabled.join(",")}`);
  } catch (e) {
    await chrome.storage.local.set({ lastError: String(e), lastPoll: Date.now() });
    return;
  }
  await chrome.storage.local.set({ lastError: null, lastPoll: Date.now() });
  if (!next || !next.job) return;
  const { job, item, listing, marketplace } = next;
  const url = job.type === "publish" ? marketplace.newListingUrl : listing?.url || marketplace.newListingUrl;
  const tab = await chrome.tabs.create({ url, active: true });
  active.set(tab.id, { job, item, listing, marketplace, photos: job.type === "publish" ? await toDataUrls(item.photos) : [] });
}

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  const work = active.get(tabId);
  if (!work || info.status !== "complete") return;
  const site = self.FLIPDESK_SITES[work.job.marketplace];
  // Listing went live -> report success with the new URL.
  if (work.job.type === "publish" && site?.successUrl?.test(tab.url || "")) {
    const externalId = (tab.url.match(/(\d{6,}|m\d+|[a-f0-9]{24})/) || [])[0];
    await api(`/api/ext/jobs/${work.job.id}/complete`, { method: "POST", body: JSON.stringify({ ok: true, url: tab.url, externalId }) });
    active.delete(tabId);
    return;
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: ["sites.js", "filler.js"] });
  chrome.tabs.sendMessage(tabId, { type: "flipdesk:job", work });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const tabId = sender.tab?.id;
    if (msg.type === "flipdesk:complete" && tabId && active.has(tabId)) {
      const { job } = active.get(tabId);
      await api(`/api/ext/jobs/${job.id}/complete`, { method: "POST", body: JSON.stringify(msg.result) });
      active.delete(tabId);
      sendResponse({ ok: true });
    } else if (msg.type === "flipdesk:poll") {
      await poll();
      sendResponse({ ok: true, active: active.size });
    } else if (msg.type === "flipdesk:test") {
      try {
        await api("/api/ext/ping");
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    }
  })();
  return true;
});

// Tab closed without finishing -> release it; the server re-queues stale claims after 15 min.
chrome.tabs.onRemoved.addListener((tabId) => active.delete(tabId));

chrome.alarms.create("poll", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => a.name === "poll" && poll());
