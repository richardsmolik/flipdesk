/**
 * Sales, quantity sync and auto-delist - the most important job of a crosslister:
 * the moment something sells anywhere, every other listing must reflect it.
 *
 * Handles: single items, multi-quantity items, and variations (sizes/colors),
 * including per-variation listings on sites without variation support.
 */
import { getItem, getSetting, logActivity, recomputeItemTotals, setSetting, tx, type Db, type ListingRow } from "../db.js";
import { ebayIsLive, ebayOrdersSince } from "../marketplaces/ebay.js";
import { MARKETPLACES, type MarketplaceId } from "../marketplaces/registry.js";
import { notify, raiseOversell } from "./alerts.js";
import { breakdown } from "./fees.js";
import { crosslist, enqueue, listingQty, requestDelist } from "./jobs.js";

export interface SaleInput {
  itemId: number;
  marketplace: MarketplaceId;
  salePrice: number; // total for the order line
  variationId?: number;
  listingId?: number; // lets us infer the variation for per-variation listings
  shippingCharged?: number;
  shippingCost?: number;
  fees?: number; // actual fees if the marketplace reported them
  orderId?: string;
  buyer?: string;
  soldAt?: string;
  quantity?: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export class NeedsVariationError extends Error {
  constructor(public options: { id: number; name: string; quantity: number }[]) {
    super("This item has variations - choose which one sold.");
  }
}

function resolveVariation(db: Db, s: SaleInput, item: NonNullable<ReturnType<typeof getItem>>) {
  if (!item.variations.length) return undefined;
  let vid = s.variationId;
  if (!vid && s.listingId) {
    vid = (db.prepare("SELECT variation_id FROM listings WHERE id = ?").get(s.listingId) as { variation_id: number | null } | undefined)?.variation_id ?? undefined;
  }
  if (!vid) {
    const inStock = item.variations.filter((v) => v.quantity > 0);
    if (inStock.length === 1) vid = inStock[0].id;
  }
  const v = item.variations.find((x) => x.id === vid);
  if (!v) throw new NeedsVariationError(item.variations.map((x) => ({ id: x.id, name: x.name, quantity: x.quantity })));
  return v;
}

export function recordSale(db: Db, s: SaleInput) {
  const before = getItem(db, s.itemId);
  if (!before) throw new Error("Item not found");
  if (s.orderId) {
    const dup = db.prepare("SELECT id FROM sales WHERE marketplace = ? AND order_id = ?").get(s.marketplace, s.orderId);
    if (dup) return { duplicate: true as const };
  }
  const v = resolveVariation(db, s, before);
  const qty = s.quantity ?? 1;
  const available = v ? v.quantity : before.quantity;
  const fees = s.fees ?? breakdown(s.marketplace, { price: s.salePrice, shippingCharged: s.shippingCharged }, getSetting(db, "feeOverrides", {})).fees;
  const cogs = r2(before.cost * qty);
  const profit = r2(s.salePrice + (s.shippingCharged ?? 0) - fees - (s.shippingCost ?? 0) - cogs);
  const mpName = MARKETPLACES[s.marketplace].name;

  const result = tx(db, () => {
    const saleId = Number(
      db
        .prepare(
          `INSERT INTO sales (item_id, variation_id, marketplace, quantity, order_id, sale_price, shipping_charged, shipping_cost, fees, cost, profit, buyer, sold_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
        )
        .run(before.id, v?.id ?? null, s.marketplace, qty, s.orderId ?? null, s.salePrice, s.shippingCharged ?? 0, s.shippingCost ?? 0, fees, cogs, profit, s.buyer ?? null, s.soldAt ?? null)
        .lastInsertRowid,
    );

    // Decrement stock.
    if (v) {
      db.prepare("UPDATE variations SET quantity = MAX(0, quantity - ?) WHERE id = ?").run(qty, v.id);
      recomputeItemTotals(db, before.id);
    } else {
      const left = Math.max(0, before.quantity - qty);
      db.prepare("UPDATE items SET quantity = ?, status = ?, updated_at = datetime('now') WHERE id = ?").run(left, left === 0 ? "sold" : before.status, before.id);
    }
    const item = getItem(db, before.id)!;
    const remaining = item.quantity;
    const vLeft = (id: number) => item.variations.find((x) => x.id === id)?.quantity ?? 0;

    const delisted: string[] = [];
    const synced: string[] = [];
    const relisted: string[] = [];
    const live = db
      .prepare("SELECT * FROM listings WHERE item_id = ? AND status IN ('active','queued','error')")
      .all(item.id) as unknown as ListingRow[];

    for (const l of live) {
      const m = l.marketplace as MarketplaceId;
      const isSellingSite = l.marketplace === s.marketplace;
      const isSellingListing = isSellingSite && (l.variation_id === null || l.variation_id === (v?.id ?? null));
      const markSold = () => db.prepare("UPDATE listings SET status = 'sold', quantity = 0, ended_at = datetime('now') WHERE id = ?").run(l.id);

      // How many units should this listing now offer?
      const pool = l.variation_id !== null ? vLeft(l.variation_id) : remaining;
      if (pool === 0) {
        if (isSellingListing) markSold();
        else {
          requestDelist(db, l, `sold out (sold on ${s.marketplace})`);
          delisted.push(l.marketplace);
        }
        continue;
      }
      const want = l.variation_id === null && item.variations.length ? Math.max(1, remaining) : listingQty(m, pool);
      if (isSellingListing) {
        if (!MARKETPLACES[m].multiQty && (l.variation_id !== null || !item.variations.length)) {
          // Single-quantity site: that listing is gone; post the next unit.
          db.prepare("UPDATE listings SET status = 'queued', quantity = 1, external_id = NULL, url = NULL WHERE id = ?").run(l.id);
          enqueue(db, m, "publish", item.id, l.id);
          relisted.push(l.marketplace);
        } else {
          db.prepare("UPDATE listings SET quantity = ? WHERE id = ?").run(want, l.id); // marketplace already decremented itself
        }
      } else if (l.quantity !== want || (l.variation_id === null && v && MARKETPLACES[m].variations)) {
        // Variation-capable sites track per-size stock inside one listing, so push an update even if the total looks equal.
        db.prepare("UPDATE listings SET quantity = ? WHERE id = ?").run(want, l.id);
        if (l.status === "active") enqueue(db, m, "update", item.id, l.id);
        synced.push(l.marketplace);
      }
    }

    const names = (ids: string[]) => [...new Set(ids)].map((d) => MARKETPLACES[d as MarketplaceId].name).join(", ");
    logActivity(
      db,
      "sale",
      `SOLD ${qty > 1 ? qty + "x " : ""}${item.sku}${v ? ` (${v.name})` : ""} on ${mpName} for $${s.salePrice.toFixed(2)} (profit $${profit.toFixed(2)}) - ${remaining} left` +
        (delisted.length ? ` - auto-delisting from ${names(delisted)}` : "") +
        (synced.length ? ` - quantity synced on ${names(synced)}` : "") +
        (relisted.length ? ` - relisting on ${names(relisted)}` : ""),
      item.id,
    );

    let alertId: number | undefined;
    if (qty > available) {
      alertId = raiseOversell(db, { item, marketplace: s.marketplace, saleId, buyer: s.buyer, qty, available, variationName: v?.name });
    }
    return { saleId, profit, fees, remaining, delisted: [...new Set(delisted)], synced: [...new Set(synced)], relisted, oversold: qty > available, alertId };
  });

  void notify(db, "sale", `Sold on ${mpName}: $${s.salePrice.toFixed(2)}`, `${before.title}${v ? ` (${v.name})` : ""} - profit $${profit.toFixed(2)}, ${result.remaining} left`);
  return result;
}

/** Poll eBay orders and record any new sales (live mode only). */
export async function pollEbaySales(db: Db) {
  if (!ebayIsLive(db)) return 0;
  const since = getSetting(db, "ebay.lastOrderPoll", new Date(Date.now() - 2 * 86400_000).toISOString());
  const startedAt = new Date().toISOString();
  const orders = await ebayOrdersSince(db, since);
  let n = 0;
  for (const o of orders) {
    for (const li of o.lineItems) {
      if (!li.sku) continue;
      // Variation SKUs map to a variation; plain SKUs to an item.
      const vrow = db.prepare("SELECT id, item_id FROM variations WHERE sku = ?").get(li.sku) as { id: number; item_id: number } | undefined;
      const irow = vrow ? { id: vrow.item_id } : (db.prepare("SELECT id FROM items WHERE sku = ?").get(li.sku) as { id: number } | undefined);
      if (!irow) continue;
      const r = recordSale(db, {
        itemId: irow.id,
        variationId: vrow?.id,
        marketplace: "ebay",
        salePrice: Number(li.lineItemCost.value),
        quantity: li.quantity ?? 1,
        shippingCharged: Number(li.deliveryCost?.shippingCost?.value ?? 0),
        orderId: `${o.orderId}:${li.sku}`,
        buyer: o.buyer?.username,
        soldAt: o.creationDate,
      });
      if (!("duplicate" in r)) n++;
    }
  }
  setSetting(db, "ebay.lastOrderPoll", startedAt);
  return n;
}

/**
 * Add units (e.g. bought 5 more). Cost becomes the weighted average of units
 * left + new units. Live listings get the new quantity; a restocked variation
 * that had sold out is re-listed on every site where the item is still live.
 */
export function restock(db: Db, itemId: number, units: number, unitCost?: number, variationId?: number) {
  const item = getItem(db, itemId);
  if (!item) throw new Error("Item not found");
  if (units < 1) throw new Error("units must be >= 1");
  if (item.variations.length && !variationId) throw new Error("Choose which variation you restocked.");
  const v = variationId ? item.variations.find((x) => x.id === variationId) : undefined;
  if (variationId && !v) throw new Error("Variation not found");
  const newCost = unitCost ?? item.cost;
  const avgCost = r2((item.cost * item.quantity + newCost * units) / (item.quantity + units));

  tx(db, () => {
    db.prepare("UPDATE items SET cost = ?, status = CASE WHEN status = 'sold' THEN 'active' ELSE status END, updated_at = datetime('now') WHERE id = ?").run(avgCost, itemId);
    if (v) {
      db.prepare("UPDATE variations SET quantity = quantity + ?, quantity_purchased = quantity_purchased + ? WHERE id = ?").run(units, units, v.id);
      recomputeItemTotals(db, itemId);
    } else {
      db.prepare("UPDATE items SET quantity = quantity + ?, quantity_purchased = quantity_purchased + ? WHERE id = ?").run(units, units, itemId);
    }
    const fresh = getItem(db, itemId)!;
    for (const l of fresh.listings.filter((x) => x.status === "active")) {
      const m = l.marketplace as MarketplaceId;
      const pool = l.variation_id !== null ? (fresh.variations.find((x) => x.id === l.variation_id)?.quantity ?? 0) : fresh.quantity;
      const want = l.variation_id === null && fresh.variations.length ? Math.max(1, fresh.quantity) : listingQty(m, pool);
      if (want !== l.quantity || (v && l.variation_id === null)) {
        db.prepare("UPDATE listings SET quantity = ? WHERE id = ?").run(want, l.id);
        enqueue(db, m, "update", itemId, l.id);
      }
    }
    logActivity(db, "restock", `Restocked ${item.sku}${v ? ` (${v.name})` : ""}: +${units} @ $${newCost.toFixed(2)} (avg cost now $${avgCost.toFixed(2)}, ${fresh.quantity} left)`, itemId);
  });

  // Re-list a restocked variation on sites that list variations separately.
  if (v) {
    const liveSites = [...new Set(item.listings.filter((l) => ["active", "queued"].includes(l.status)).map((l) => l.marketplace as MarketplaceId))];
    const needs = liveSites.filter((m) => !MARKETPLACES[m].variations);
    if (needs.length) crosslist(db, itemId, needs);
  }
  return getItem(db, itemId);
}

export interface VariationInput {
  id?: number;
  attrs: Record<string, string>;
  quantity: number;
  quantity_purchased?: number;
  price?: number | null;
}

/** Replace an item's variations. Variations with sales can't be removed (set quantity to 0 instead). */
export function saveVariations(db: Db, itemId: number, input: VariationInput[]) {
  const item = getItem(db, itemId);
  if (!item) throw new Error("Item not found");
  const keep = new Set(input.filter((x) => x.id).map((x) => x.id));
  for (const old of item.variations) {
    if (!keep.has(old.id) && old.quantity_sold > 0) throw new Error(`"${old.name}" has sales - set its quantity to 0 instead of deleting it.`);
  }
  const slug = (a: Record<string, string>) =>
    Object.values(a)
      .filter(Boolean)
      .join("-")
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "")
      .slice(0, 12) || "V";
  tx(db, () => {
    for (const old of item.variations) if (!keep.has(old.id)) db.prepare("DELETE FROM variations WHERE id = ?").run(old.id);
    input.forEach((x, i) => {
      if (x.id) {
        db.prepare("UPDATE variations SET attrs = ?, quantity = ?, quantity_purchased = ?, price = ?, position = ? WHERE id = ? AND item_id = ?").run(
          JSON.stringify(x.attrs),
          x.quantity,
          Math.max(x.quantity_purchased ?? x.quantity, x.quantity),
          x.price ?? null,
          i,
          x.id,
          itemId,
        );
      } else {
        let sku = `${item.sku}-${slug(x.attrs)}`;
        for (let n = 2; db.prepare("SELECT 1 FROM variations WHERE sku = ?").get(sku); n++) sku = `${item.sku}-${slug(x.attrs)}${n}`;
        db.prepare("INSERT INTO variations (item_id, sku, attrs, quantity, quantity_purchased, price, position) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
          itemId,
          sku,
          JSON.stringify(x.attrs),
          x.quantity,
          Math.max(x.quantity_purchased ?? x.quantity, x.quantity),
          x.price ?? null,
          i,
        );
      }
    });
    if (input.length) recomputeItemTotals(db, itemId);
    // Combined listings get the new totals.
    const fresh = getItem(db, itemId)!;
    for (const l of fresh.listings.filter((x) => x.status === "active")) {
      const m = l.marketplace as MarketplaceId;
      if (l.variation_id !== null) {
        const vq = fresh.variations.find((x) => x.id === l.variation_id)?.quantity ?? 0;
        if (vq === 0) requestDelist(db, l, "variation set to 0");
        else if (listingQty(m, vq) !== l.quantity) {
          db.prepare("UPDATE listings SET quantity = ? WHERE id = ?").run(listingQty(m, vq), l.id);
          enqueue(db, m, "update", itemId, l.id);
        }
      } else {
        db.prepare("UPDATE listings SET quantity = ? WHERE id = ?").run(Math.max(1, fresh.quantity), l.id);
        enqueue(db, m, "update", itemId, l.id);
      }
    }
    logActivity(db, "variations", `Updated variations on ${item.sku} (${input.length})`, itemId);
  });
  // New in-stock variations go live where the item already is (separate-listing sites only).
  const liveSites = [...new Set(item.listings.filter((l) => ["active", "queued"].includes(l.status)).map((l) => l.marketplace as MarketplaceId))];
  const needs = liveSites.filter((m) => !MARKETPLACES[m].variations);
  if (needs.length && getItem(db, itemId)!.quantity > 0) crosslist(db, itemId, needs);
  return getItem(db, itemId);
}
