/**
 * Bundles: move more stuff per sale.
 *  - Lots: one listing made of several items ("Lot of 3 Lululemon leggings size 6").
 *    Stock stays in sync both ways (see sync.ts propagateBundles).
 *  - Suggestions: groups of items that buyers buy together (same brand / category + size),
 *    stale stock first.
 *  - eBay multi-buy discounts (Marketing API volume pricing).
 */
import { getItem, getSetting, logActivity, tx, type Db, type Item } from "../db.js";
import { ebayCreateVolumeDiscount, ebayEndPromotion } from "../marketplaces/ebay.js";
import { recommend } from "./fees.js";
import { uploadUrl } from "../context.js";

const r2 = (n: number) => Math.round(n * 100) / 100;

export interface BundlePart {
  itemId: number;
  quantity?: number;
}

export function bundleTitle(items: Item[]) {
  const brands = [...new Set(items.map((i) => i.brand).filter(Boolean))];
  const sizes = [...new Set(items.map((i) => i.size).filter(Boolean))];
  const cat = items[0]?.category.split(">").pop()?.trim() ?? "";
  const base = brands.length === 1 ? `${brands[0]} ${cat}` : brands.length ? `${brands.slice(0, 3).join(" ")} ${cat}` : cat || "Items";
  return `Lot of ${items.length} ${base}${sizes.length === 1 ? ` Size ${sizes[0]}` : ""}`.replace(/\s+/g, " ").trim().slice(0, 80);
}

export function createBundle(db: Db, parts: BundlePart[], opts: { title?: string; price?: number; discountPct?: number } = {}) {
  if (parts.length < 2) throw new Error("A lot needs at least 2 items.");
  const items = parts.map((p) => {
    const it = getItem(db, p.itemId);
    if (!it) throw new Error(`Item ${p.itemId} not found`);
    if (it.variations.length) throw new Error(`${it.sku} has sizes/colors - lots of variation items aren't supported yet.`);
    if (db.prepare("SELECT 1 FROM bundle_items WHERE bundle_id = ?").get(it.id)) throw new Error(`${it.sku} is itself a lot.`);
    if (it.quantity < (p.quantity ?? 1)) throw new Error(`${it.sku} doesn't have enough units left.`);
    return { it, need: p.quantity ?? 1 };
  });
  const sumPrice = items.reduce((a, x) => a + x.it.price * x.need, 0);
  const cost = r2(items.reduce((a, x) => a + x.it.cost * x.need, 0));
  const floor = r2(items.reduce((a, x) => a + (x.it.min_price ?? x.it.price * 0.7) * x.need, 0));
  const price = r2(opts.price ?? Math.max(floor, sumPrice * (1 - (opts.discountPct ?? 15) / 100)));
  const cap = Math.min(...items.map((x) => Math.floor(x.it.quantity / x.need)));
  const prefix = getSetting(db, "skuPrefix", "FD");
  const title = opts.title || bundleTitle(items.map((x) => x.it));
  const description =
    `${title}\n\nThis lot includes:\n` +
    items.map((x) => `- ${x.need > 1 ? x.need + "x " : ""}${x.it.title}`).join("\n") +
    `\n\nBought separately: $${sumPrice.toFixed(2)}. Save by buying the lot!`;

  return tx(db, () => {
    let sku = `${prefix}-LOT${String(Date.now()).slice(-5)}`;
    while (db.prepare("SELECT 1 FROM items WHERE sku = ?").get(sku)) sku += "X";
    const id = Number(
      db
        .prepare(
          `INSERT INTO items (sku, title, description, brand, category, condition, cost, price, min_price, quantity, quantity_purchased, status, specifics, keywords, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
        )
        .run(
          sku,
          title,
          description,
          [...new Set(items.map((x) => x.it.brand).filter(Boolean))].join(", "),
          items[0].it.category,
          items[0].it.condition,
          cost,
          price,
          floor,
          cap,
          cap,
          JSON.stringify({ Bundle: "Yes", "Number of Items in Lot": String(items.reduce((a, x) => a + x.need, 0)) }),
          JSON.stringify([...new Set(items.flatMap((x) => x.it.keywords))].slice(0, 13)),
          `Lot built from ${items.map((x) => x.it.sku).join(", ")}`,
        ).lastInsertRowid,
    );
    for (const x of items) {
      db.prepare("INSERT INTO bundle_items (bundle_id, item_id, quantity) VALUES (?, ?, ?)").run(id, x.it.id, x.need);
      // Reuse each item's cover photo (same file, no copy).
      const ph = db.prepare("SELECT path FROM photos WHERE item_id = ? ORDER BY position LIMIT 1").get(x.it.id) as { path: string } | undefined;
      if (ph) db.prepare("INSERT INTO photos (item_id, path, position) VALUES (?, ?, (SELECT COUNT(*) FROM photos WHERE item_id = ?))").run(id, ph.path, id);
    }
    logActivity(db, "bundle", `Created ${sku}: ${title} at $${price.toFixed(2)} (bought separately $${sumPrice.toFixed(2)})`, id);
    return getItem(db, id)!;
  });
}

export function bundleParts(db: Db, bundleId: number) {
  return db
    .prepare(
      `SELECT b.item_id AS itemId, b.quantity, i.sku, i.title, i.price, i.cost, i.quantity AS available, i.status
       FROM bundle_items b JOIN items i ON i.id = b.item_id WHERE b.bundle_id = ?`,
    )
    .all(bundleId) as { itemId: number; quantity: number; sku: string; title: string; price: number; cost: number; available: number; status: string }[];
}

export interface BundleSuggestion {
  reason: string;
  itemIds: number[];
  items: { id: number; sku: string; title: string; price: number; ageDays: number; photo: string | null }[];
  separatePrice: number;
  bundlePrice: number;
  bundleProfit: number;
  marketplace: string;
  staleCount: number;
}

/** Groups of active items that make natural lots. Stale stock first. */
export function suggestBundles(db: Db, discountPct = 15, limit = 8): BundleSuggestion[] {
  const rows = db
    .prepare(
      `SELECT i.id, i.sku, i.title, i.brand, i.category, i.size, i.price, i.cost, i.min_price,
              CAST(julianday('now') - julianday(COALESCE(i.sourced_at, i.created_at)) AS INTEGER) AS age,
              (SELECT path FROM photos p WHERE p.item_id = i.id ORDER BY position LIMIT 1) AS photo
       FROM items i
       WHERE i.status = 'active' AND i.quantity > 0
         AND NOT EXISTS (SELECT 1 FROM variations v WHERE v.item_id = i.id)
         AND NOT EXISTS (SELECT 1 FROM bundle_items b WHERE b.bundle_id = i.id)
         AND NOT EXISTS (SELECT 1 FROM bundle_items b JOIN items bi ON bi.id = b.bundle_id WHERE b.item_id = i.id AND bi.status IN ('active','draft'))`,
    )
    .all() as { id: number; sku: string; title: string; brand: string; category: string; size: string; price: number; cost: number; min_price: number | null; age: number; photo: string | null }[];

  const groups = new Map<string, { reason: string; rows: typeof rows }>();
  const add = (key: string, reason: string, r: (typeof rows)[number]) => {
    if (!groups.has(key)) groups.set(key, { reason, rows: [] });
    groups.get(key)!.rows.push(r);
  };
  for (const r of rows) {
    const top = r.category.split(">")[0].trim().toLowerCase();
    const leaf = r.category.split(">").pop()!.trim().toLowerCase();
    if (r.brand) add(`brand:${r.brand.toLowerCase()}`, `Same brand: ${r.brand}`, r);
    if (r.size && top) add(`size:${top}:${r.size.toLowerCase()}`, `Same size (${r.size}) ${top}`, r);
    const GENERIC = new Set(["vintage", "new", "used", "other", "misc", "lot", "unbranded"]);
    if (leaf && leaf !== top && !GENERIC.has(leaf)) add(`cat:${top}>${leaf}`, `Same category: ${leaf}`, r);
  }
  const overrides = getSetting(db, "feeOverrides", {});
  const out: BundleSuggestion[] = [];
  const seen = new Set<string>();
  for (const g of groups.values()) {
    if (g.rows.length < 2) continue;
    // Buyers bundle similar things at similar prices: keep items within 3x of the cheapest.
    const sorted = [...g.rows].sort((a, b) => b.age - a.age);
    const cheapest = Math.min(...sorted.map((r) => r.price || 1));
    const pick = sorted.filter((r) => r.price <= cheapest * 3).slice(0, 4);
    if (pick.length < 2) continue;
    const key = pick.map((p) => p.id).sort().join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    const separate = r2(pick.reduce((a, p) => a + p.price, 0));
    const floor = pick.reduce((a, p) => a + (p.min_price ?? p.price * 0.7), 0);
    const price = r2(Math.max(floor, separate * (1 - discountPct / 100)));
    const cost = pick.reduce((a, p) => a + p.cost, 0);
    const best = recommend({ price, cost, category: pick[0].category, title: pick.map((p) => p.title).join(" ") }, overrides)[0];
    out.push({
      reason: g.reason,
      itemIds: pick.map((p) => p.id),
      items: pick.map((p) => ({ id: p.id, sku: p.sku, title: p.title, price: p.price, ageDays: p.age, photo: p.photo ? uploadUrl(p.photo) : null })),
      separatePrice: separate,
      bundlePrice: price,
      bundleProfit: best?.profit ?? 0,
      marketplace: best?.marketplace ?? "ebay",
      staleCount: pick.filter((p) => p.age >= 30).length,
    });
  }
  return out.sort((a, b) => b.staleCount - a.staleCount || b.bundleProfit - a.bundleProfit).slice(0, limit);
}

/** eBay multi-buy: buy 2 save X%, 3+ save Y% across the chosen items' eBay listings. */
export async function createMultiBuy(db: Db, itemIds: number[], tiers: { minQuantity: number; pctOff: number }[], name?: string) {
  const listingIds = (
    db
      .prepare(`SELECT external_id FROM listings WHERE marketplace = 'ebay' AND status = 'active' AND external_id IS NOT NULL AND item_id IN (${itemIds.map(() => "?").join(",")})`)
      .all(...itemIds) as { external_id: string }[]
  ).map((r) => r.external_id);
  if (listingIds.length < 2) throw new Error("Multi-buy needs at least 2 items that are live on eBay.");
  const label = name || `Buy ${tiers[0].minQuantity}+ save ${tiers[0].pctOff}%`;
  const r = await ebayCreateVolumeDiscount(db, label, listingIds, tiers);
  const id = Number(
    db
      .prepare("INSERT INTO promotions (marketplace, external_id, name, kind, rules, item_ids) VALUES ('ebay', ?, ?, 'volume_discount', ?, ?)")
      .run(r.promotionId, label, JSON.stringify(tiers), JSON.stringify(itemIds)).lastInsertRowid,
  );
  logActivity(db, "promotion", `Started eBay multi-buy "${label}" on ${listingIds.length} listings${r.demo ? " (demo)" : ""}`);
  return { id, ...r, listings: listingIds.length };
}

export async function endPromotion(db: Db, id: number) {
  const p = db.prepare("SELECT * FROM promotions WHERE id = ?").get(id) as { external_id: string | null } | undefined;
  if (!p) throw new Error("Promotion not found");
  if (p.external_id) await ebayEndPromotion(db, p.external_id);
  db.prepare("UPDATE promotions SET status = 'ended' WHERE id = ?").run(id);
}
