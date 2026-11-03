import { PRESETS } from "./dropBacktest.js";
import { getItem, getSetting, logActivity, tx, type Db, type ListingRow } from "../db.js";
import { ebaySendOffer } from "../marketplaces/ebay.js";
import type { MarketplaceId } from "../marketplaces/registry.js";
import { enqueue, requestDelist } from "./jobs.js";
import { advise, learn, recordPriceChange } from "./priceAdvice.js";

const r2 = (n: number) => Math.round(n * 100) / 100;

export interface StaleRow {
  listingId: number;
  itemId: number;
  sku: string;
  title: string;
  marketplace: string;
  price: number;
  minPrice: number | null;
  daysListed: number;
  views: number;
  watchers: number;
  suggestion: "send_offer" | "price_drop" | "relist" | "crosslist";
  why: string;
}

/** Find listings that aren't moving and say what to do about each. */
export function staleListings(db: Db, minDays = 30): StaleRow[] {
  const rows = db
    .prepare(
      `SELECT l.*, i.sku, i.title, i.min_price,
              CAST(julianday('now') - julianday(l.listed_at) AS INTEGER) AS days,
              (SELECT COUNT(*) FROM listings l2 WHERE l2.item_id = l.item_id AND l2.status = 'active') AS live_count
       FROM listings l JOIN items i ON i.id = l.item_id
       WHERE l.status = 'active' AND l.listed_at IS NOT NULL
         AND julianday('now') - julianday(l.listed_at) >= ?
       ORDER BY days DESC`,
    )
    .all(minDays) as unknown as (ListingRow & { sku: string; title: string; min_price: number | null; days: number; live_count: number })[];

  return rows.map((l) => {
    let suggestion: StaleRow["suggestion"];
    let why: string;
    if (l.watchers > 0 && l.marketplace === "ebay") {
      suggestion = "send_offer";
      why = `${l.watchers} watcher${l.watchers > 1 ? "s" : ""} - send them a 10-15% offer`;
    } else if (l.live_count <= 2) {
      suggestion = "crosslist";
      why = `Only on ${l.live_count} site${l.live_count > 1 ? "s" : ""} - more exposure is the cheapest fix`;
    } else if (l.views < 10 * Math.max(1, l.days / 30)) {
      suggestion = "relist";
      why = `Low views (${l.views}) - relisting refreshes search placement`;
    } else {
      suggestion = "price_drop";
      why = `${l.views} views but no sale - price is likely the blocker`;
    }
    return {
      listingId: l.id,
      itemId: l.item_id,
      sku: l.sku,
      title: l.title,
      marketplace: l.marketplace,
      price: l.price,
      minPrice: l.min_price,
      daysListed: l.days,
      views: l.views,
      watchers: l.watchers,
      suggestion,
      why,
    };
  });
}

/** Change prices across items; respects each item's floor (min_price). Queues update jobs for live listings. */
export function bulkPrice(db: Db, itemIds: number[], change: { pct?: number; amount?: number; set?: number }, reason = "bulk") {
  return tx(db, () => {
    const results: { itemId: number; from: number; to: number }[] = [];
    for (const id of itemIds) {
      const item = getItem(db, id);
      if (!item) continue;
      let to = change.set ?? item.price;
      if (change.pct) to = item.price * (1 + change.pct / 100);
      if (change.amount) to = item.price + change.amount;
      to = r2(Math.max(item.min_price ?? 0.99, to));
      if (to === item.price) continue;
      recordPriceChange(db, id, item.price, to, reason);
      db.prepare("UPDATE items SET price = ?, updated_at = datetime('now') WHERE id = ?").run(to, id);
      for (const l of item.listings.filter((x) => x.status === "active")) {
        db.prepare("UPDATE listings SET price = ? WHERE id = ?").run(to, l.id);
        enqueue(db, l.marketplace as MarketplaceId, "update", id, l.id);
      }
      results.push({ itemId: id, from: item.price, to });
    }
    if (results.length) logActivity(db, "price", `Bulk price change on ${results.length} item(s)`);
    return results;
  });
}

/** Send offers to watchers on eBay. Offer = max(floor, price * (1 - pctOff)). */
export async function sendOffersToWatchers(db: Db, itemIds: number[], pctOff: number, message: string) {
  const out: { itemId: number; listingId: string; offer: number; result: unknown }[] = [];
  for (const id of itemIds) {
    const item = getItem(db, id);
    const l = item?.listings.find((x) => x.marketplace === "ebay" && x.status === "active" && x.external_id);
    if (!item || !l) continue;
    const offer = r2(Math.max(item.min_price ?? 0, l.price * (1 - pctOff / 100)));
    const result = await ebaySendOffer(db, l.external_id!, offer, message);
    out.push({ itemId: id, listingId: l.external_id!, offer, result });
    logActivity(db, "offer", `Sent $${offer.toFixed(2)} offer to watchers of ${item.sku}`, id);
  }
  return out;
}

/** End + relist (fresh listing date improves search placement on most sites). */
export function relist(db: Db, listingIds: number[]) {
  return tx(db, () => {
    let n = 0;
    for (const lid of listingIds) {
      const l = db.prepare("SELECT * FROM listings WHERE id = ?").get(lid) as ListingRow | undefined;
      if (!l || l.status !== "active") continue;
      requestDelist(db, l, "relist");
      enqueue(db, l.marketplace as MarketplaceId, "publish", l.item_id, l.id);
      n++;
    }
    if (n) logActivity(db, "relist", `Relisting ${n} listing(s)`);
    return n;
  });
}

export interface AutoDropRule {
  enabled: boolean;
  smart?: boolean; // use advice learned from your sales instead of a fixed %
  afterDays: number; // start dropping after N days listed
  everyDays: number; // then every N days
  dropPct: number; // by this %
}

/** Scheduled price drops for listings that haven't sold. Never goes below min_price. */
export function applyAutoPriceDrops(db: Db) {
  const rule = getSetting<AutoDropRule>(db, "autoDrop", { enabled: false, afterDays: 21, everyDays: 7, dropPct: 5 });
  if (!rule.enabled) return [];
  const last = getSetting<Record<string, string>>(db, "autoDrop.last", {});
  // Per-category rules from the price-drop backtest ("none" = never drop that category).
  const perCat = getSetting<Record<string, string>>(db, "autoDrop.byCategory", {});
  const ruleFor = (category: string) => {
    const key = perCat[(category ?? "").split(">")[0].trim() || "Other"];
    if (!key) return rule;
    if (key === "none") return null;
    const p = PRESETS.find((x) => x.key === key);
    return p ? { ...rule, afterDays: p.afterDays, everyDays: p.everyDays, dropPct: p.dropPct } : rule;
  };
  const rows = db
    .prepare(
      `SELECT DISTINCT i.id, i.price, i.min_price, i.category, julianday('now') - julianday(MIN(l.listed_at)) AS age
       FROM items i JOIN listings l ON l.item_id = i.id AND l.status = 'active'
       WHERE i.status = 'active' GROUP BY i.id`,
    )
    .all() as { id: number; price: number; min_price: number | null; category: string; age: number | null }[];
  const now = Date.now();
  const due = rows
    .map((d) => ({ ...d, r: ruleFor(d.category) }))
    .filter((d) => d.r && d.age !== null && d.age >= d.r.afterDays)
    .filter((d) => {
      const prev = last[d.id];
      return !prev || now - Date.parse(prev) >= d.r!.everyDays * 86400_000;
    })
    .filter((d) => d.min_price === null || d.price > d.min_price);
  const ids = due.map((d) => d.id);
  let res: { itemId: number; from: number; to: number }[] = [];
  if (rule.smart) {
    const model = learn(db);
    for (const id of ids) {
      const item = getItem(db, id);
      if (!item) continue;
      const a = advise(db, item, model);
      if ((a.action === "drop" || a.action === "small_drop") && a.newPrice) res.push(...bulkPrice(db, [id], { set: a.newPrice }, "smart_drop"));
    }
  } else {
    // Group by drop size (per-category rules can differ).
    const byPct = new Map<number, number[]>();
    for (const d of due) byPct.set(d.r!.dropPct, [...(byPct.get(d.r!.dropPct) ?? []), d.id]);
    for (const [pct, group] of byPct) res.push(...bulkPrice(db, group, { pct: -Math.abs(pct) }, "auto_drop"));
  }
  for (const r of res) last[r.itemId] = new Date().toISOString();
  db.prepare("INSERT INTO settings (key, value) VALUES ('autoDrop.last', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    JSON.stringify(last),
  );
  return res;
}
