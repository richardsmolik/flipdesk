/**
 * Price advice learned from YOUR sales history:
 * per category, how long items take to sell and how much below the original price they sold.
 * Then for each unsold item: wait, small drop, or a specific drop - never below the floor.
 */
import type { Db, Item } from "../db.js";

const r2 = (n: number) => Math.round(n * 100) / 100;

export function recordPriceChange(db: Db, itemId: number, oldPrice: number, newPrice: number, reason: string) {
  if (Math.abs(oldPrice - newPrice) < 0.005) return;
  db.prepare("INSERT INTO price_changes (item_id, old_price, new_price, reason) VALUES (?, ?, ?, ?)").run(itemId, oldPrice, newPrice, reason);
  db.prepare("UPDATE items SET original_price = COALESCE(original_price, ?) WHERE id = ?").run(oldPrice, itemId);
}

export interface Stats {
  key: string;
  n: number;
  medianDays: number;
  p75Days: number;
  medianDiscountPct: number; // how far below original price items sold
  soldWithoutDropPct: number;
  medianDaysAfterDrop: number | null;
}

const quant = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  return s[Math.floor(i)] + (s[Math.ceil(i)] - s[Math.floor(i)]) * (i - Math.floor(i));
};

const topCat = (c: string) => (c.split(">")[0] || "").trim().toLowerCase() || "(other)";

export function learn(db: Db, lookbackDays = 365): { overall: Stats | null; byCategory: Stats[] } {
  const rows = db
    .prepare(
      `SELECT s.item_id, s.quantity, s.sale_price, s.sold_at, i.category, COALESCE(i.original_price, i.price) AS original,
              COALESCE((SELECT MIN(listed_at) FROM listings l WHERE l.item_id = i.id), i.created_at) AS listed,
              (SELECT COUNT(*) FROM price_changes pc WHERE pc.item_id = i.id AND pc.new_price < pc.old_price AND pc.at <= s.sold_at) AS drops,
              (SELECT MAX(at) FROM price_changes pc WHERE pc.item_id = i.id AND pc.new_price < pc.old_price AND pc.at <= s.sold_at) AS last_drop
       FROM sales s JOIN items i ON i.id = s.item_id
       WHERE s.sold_at >= datetime('now', ?) AND NOT EXISTS (SELECT 1 FROM bundle_items b WHERE b.bundle_id = i.id)`,
    )
    .all(`-${lookbackDays} days`) as { item_id: number; quantity: number; sale_price: number; sold_at: string; category: string; original: number; listed: string; drops: number; last_drop: string | null }[];

  const days = (a: string, b: string) => Math.max(0, (Date.parse(b.replace(" ", "T") + "Z") - Date.parse(a.replace(" ", "T") + "Z")) / 86400_000);
  const pts = rows
    .filter((r) => r.original > 0)
    .map((r) => ({
      cat: topCat(r.category),
      days: days(r.listed, r.sold_at),
      discount: Math.min(80, Math.max(0, (1 - r.sale_price / Math.max(1, r.quantity) / r.original) * 100)),
      dropped: r.drops > 0,
      afterDrop: r.last_drop ? days(r.last_drop, r.sold_at) : null,
    }));

  const summarize = (key: string, xs: typeof pts): Stats => {
    const after = xs.map((x) => x.afterDrop).filter((x): x is number => x !== null);
    return {
      key,
      n: xs.length,
      medianDays: Math.round(quant(xs.map((x) => x.days), 0.5)),
      p75Days: Math.round(quant(xs.map((x) => x.days), 0.75)),
      medianDiscountPct: Math.round(quant(xs.map((x) => x.discount), 0.5)),
      soldWithoutDropPct: Math.round((xs.filter((x) => !x.dropped).length / Math.max(1, xs.length)) * 100),
      medianDaysAfterDrop: after.length ? Math.round(quant(after, 0.5)) : null,
    };
  };
  const cats = new Map<string, typeof pts>();
  for (const p of pts) cats.set(p.cat, [...(cats.get(p.cat) ?? []), p]);
  return {
    overall: pts.length ? summarize("all items", pts) : null,
    byCategory: [...cats.entries()].map(([k, xs]) => summarize(k, xs)).sort((a, b) => b.n - a.n),
  };
}

export interface Advice {
  action: "wait" | "small_drop" | "drop" | "at_floor" | "fix_visibility";
  pct: number;
  newPrice: number | null;
  ageDays: number;
  reason: string;
  confidence: "low" | "medium" | "high";
  basis: string;
}

export function advise(
  db: Db,
  item: Pick<Item, "id" | "price" | "min_price" | "category" | "created_at" | "listings"> & { original_price?: number | null },
  model = learn(db),
  traffic?: { impressions: number; views: number } | null,
): Advice {
  const listedAts = item.listings.filter((l) => l.listed_at && ["active"].includes(l.status)).map((l) => Date.parse(l.listed_at!.replace(" ", "T") + "Z"));
  const ageDays = Math.floor((Date.now() - (listedAts.length ? Math.min(...listedAts) : Date.parse(item.created_at.replace(" ", "T") + "Z"))) / 86400_000);
  const cat = model.byCategory.find((c) => c.key === topCat(item.category));
  const peers = cat && cat.n >= 5 ? cat : model.overall && model.overall.n >= 5 ? model.overall : null;
  const floor = item.min_price ?? 0;
  const confidence: Advice["confidence"] = !peers ? "low" : peers.n >= 20 ? "high" : peers.n >= 10 ? "medium" : "low";
  const basis = peers ? `${peers.key} (${peers.n} sales)` : "general rule (not enough sales yet)";
  const priceAt = (pct: number) => r2(Math.max(floor, item.price * (1 - pct / 100)));

  if (item.price <= floor && floor > 0) return { action: "at_floor", pct: 0, newPrice: null, ageDays, reason: "Already at your floor price. Try a bundle, relist or new photos instead.", confidence, basis };

  // Nobody is seeing it -> a price drop won't help; fix the listing first.
  if (traffic && ageDays >= 14 && traffic.impressions < 100) {
    return { action: "fix_visibility", pct: 0, newPrice: null, ageDays, reason: `Only ${traffic.impressions} search impressions. Buyers aren't seeing it, so a price drop won't help yet. Improve the title keywords and item specifics, or relist.`, confidence: "medium", basis: "eBay traffic" };
  }

  if (!peers) {
    if (ageDays < 21) return { action: "wait", pct: 0, newPrice: null, ageDays, reason: "Give it 3 weeks before dropping (general rule until you have more sales).", confidence, basis };
    return { action: "drop", pct: 10, newPrice: priceAt(10), ageDays, reason: "Listed 3+ weeks: a 10% drop is a common nudge.", confidence, basis };
  }
  if (ageDays < peers.medianDays) {
    return { action: "wait", pct: 0, newPrice: null, ageDays, reason: `Similar items usually sell around day ${peers.medianDays}; it's day ${ageDays}. Hold the price.`, confidence, basis };
  }
  if (ageDays < peers.p75Days) {
    return { action: "small_drop", pct: 5, newPrice: priceAt(5), ageDays, reason: `Past the typical ${peers.medianDays} days. A small 5% nudge, or hold until day ${peers.p75Days}.`, confidence, basis };
  }
  const already = item.original_price && item.original_price > 0 ? Math.max(0, (1 - item.price / item.original_price) * 100) : 0;
  const target = Math.max(peers.medianDiscountPct, 5);
  const pct = Math.min(30, Math.max(5, Math.round((target - already) / 5) * 5 || 5));
  return {
    action: "drop",
    pct,
    newPrice: priceAt(pct),
    ageDays,
    reason: `Slower than 3 out of 4 similar items (they sold by day ${peers.p75Days}, typically ${peers.medianDiscountPct}% below their first price${peers.medianDaysAfterDrop !== null ? `, about ${peers.medianDaysAfterDrop} days after a drop` : ""}).`,
    confidence,
    basis,
  };
}
