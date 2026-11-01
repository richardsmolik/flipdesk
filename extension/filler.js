// Injected into the marketplace tab. Fills the listing form, uploads photos and
// shows a small FlipDesk panel. The seller reviews and clicks the site's own
// "List" button (assisted mode keeps accounts safe from automation flags).
(() => {
  if (window.__flipdeskLoaded) return;
  window.__flipdeskLoaded = true;

  const setNative = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value); // works with React-controlled inputs
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  };

  const visible = (el) => el && el.offsetParent !== null && !el.disabled;

  function find(selectors = [], words = []) {
    for (const s of selectors) {
      const el = [...document.querySelectorAll(s)].find(visible);
      if (el) return el;
    }
    // Fallback: match label / placeholder / aria-label / name text.
    const fields = [...document.querySelectorAll("input:not([type=file]):not([type=checkbox]):not([type=radio]), textarea")].filter(visible);
    return fields.find((f) => {
      const label = f.labels?.[0]?.innerText || "";
      const hay = `${label} ${f.placeholder} ${f.getAttribute("aria-label") || ""} ${f.name} ${f.id}`.toLowerCase();
      return words.some((w) => hay.includes(w));
    });
  }

  function attachPhotos(input, photos) {
    if (!input || !photos.length) return 0;
    const dt = new DataTransfer();
    for (const p of photos) {
      const bytes = Uint8Array.from(atob(p.data), (c) => c.charCodeAt(0));
      dt.items.add(new File([bytes], p.name || "photo.jpg", { type: p.type }));
    }
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return photos.length;
  }

  function panel(html, buttons) {
    document.getElementById("flipdesk-panel")?.remove();
    const el = document.createElement("div");
    el.id = "flipdesk-panel";
    el.style.cssText =
      "position:fixed;z-index:2147483647;right:16px;bottom:16px;width:320px;background:#18181b;color:#f4f4f5;border:1px solid #3f3f46;border-radius:12px;padding:14px;font:13px/1.45 system-ui;box-shadow:0 10px 30px rgba(0,0,0,.5)";
    el.innerHTML = `<div style="font-weight:700;margin-bottom:6px">📦 FlipDesk</div><div>${html}</div><div id="fd-btns" style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap"></div>`;
    for (const [label, fn, primary] of buttons) {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText = `flex:1;padding:7px 10px;border-radius:8px;border:1px solid ${primary ? "#3987e5" : "#3f3f46"};background:${primary ? "#3987e5" : "#27272a"};color:#fff;cursor:pointer;font:600 12px system-ui`;
      b.onclick = fn;
      el.querySelector("#fd-btns").appendChild(b);
    }
    document.body.appendChild(el);
  }

  const complete = (result) => chrome.runtime.sendMessage({ type: "flipdesk:complete", result });

  async function fill(work, attempt = 0) {
    const { item, marketplace, photos, job } = work;
    const site = self.FLIPDESK_SITES[job.marketplace] || {};
    const titleMax = site.titleMax || marketplace.titleMax || 80;
    const filled = [];
    const set = (key, words, value) => {
      if (value === undefined || value === null || value === "") return;
      const el = find(site[key], words);
      if (el) (setNative(el, String(value)), filled.push(key));
    };
    set("title", ["title", "what are you selling", "item name"], item.title.slice(0, titleMax));
    set("description", ["description", "describe"], item.description.slice(0, marketplace.descriptionMax || 5000));
    set("price", ["price", "listing price"], (work.listing?.price ?? item.price).toFixed(0));
    set("brand", ["brand", "designer"], item.brand);
    set("quantity", ["quantity"], work.listing?.quantity);
    const nPhotos = attachPhotos(find(site.photos, []) || document.querySelector('input[type="file"]'), photos);

    // SPA forms often render late: retry a few times if nothing matched yet.
    if (!filled.length && attempt < 6) return setTimeout(() => fill(work, attempt + 1), 1500);

    const missing = ["title", "description", "price"].filter((k) => site[k] && !filled.includes(k));
    panel(
      `Filled <b>${filled.join(", ") || "nothing yet"}</b>${nPhotos ? ` + ${nPhotos} photo(s)` : ""} for <b>${item.sku}</b>.<br>` +
        (missing.length ? `<span style="color:#fab219">Please fill: ${missing.join(", ")}</span><br>` : "") +
        `Pick category / size / condition, then click the site's <b>List</b> button. FlipDesk will detect the new listing automatically.`,
      [
        ["Refill", () => fill(work)],
        ["I posted it", () => complete({ ok: true, url: location.href }).then(() => panel("✓ Marked as listed.", []))],
        ["Skip", () => complete({ ok: false, error: "skipped by user" }).then(() => panel("Skipped.", [])), false],
      ],
    );
  }

  function delist(work) {
    const { item, marketplace } = work;
    panel(
      `<b style="color:#ec835a">Delist ${item.sku}</b> from ${marketplace.name}${item.quantity === 0 ? " - it sold elsewhere" : ""}.<br>` +
        `Use the site's Edit/Delete (or "Mark as sold") button on this page, then confirm below.`,
      [
        ["Done - it's removed", () => complete({ ok: true }).then(() => panel("✓ Delisted.", [])), true],
        ["Couldn't", () => complete({ ok: false, error: "user could not delist" }).then(() => panel("Reported.", []))],
      ],
    );
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== "flipdesk:job") return;
    const { work } = msg;
    if (work.job.type === "publish") fill(work);
    else if (work.job.type === "delist") delist(work);
    else
      panel(`Update ${work.item.sku} on ${work.marketplace.name}: set price to <b>$${work.listing.price}</b> and quantity to <b>${work.listing.quantity}</b>, then save.`, [
        ["Done", () => complete({ ok: true }).then(() => panel("✓ Updated.", [])), true],
      ]);
  });
})();
