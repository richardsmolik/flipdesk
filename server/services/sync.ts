/**
 * Sales + auto-delist. The single most important job of a crosslister:
 * the moment an item sells anywhere, pull it down everywhere else.
 */
import { getItem, getSetting, logActivity, setSetting, tx, type Db, type ListingRow } from "../db.js";
import { ebayIsLive, ebayOrdersSince } from "../marketplaces/ebay.js";
import { MARKETPLACES, type MarketplaceId } from "../marketplaces/registry.js";
import { breakdown } from "./fees.js";
import { enqueue, listingQty, requestDelist } from "./jobs.js";

export interface SaleInput {
  itemId: number;
  marketplace: MarketplaceId;
  salePrice: number;
  shippingCharged?: number;
  shippingCost?: number;
  fees?: number; // if the marketplace reported actual fees, use them
  orderId?: string;
  buyer?: string;
  soldAt?: string;
  quantity?: number;
}

export function recordSale(db: Db, s: SaleInput) {
  const item = getItem(db, s.itemId);
  if (!item) throw new Error("Item not found");
  if (s.orderId) {
    const dup = db.prepare("SELECT id FROM sales WHERE marketplace = ? AND order_id = ?").get(s.marketplace, s.orderId);
    if (dup) return { duplicate: true as const };
  }
  const qty = s.quantity ?? 1;
  const overrides = getSetting(db, "feeOverrides", {});
  const est = breakdown(s.marketplace, {
    price: s.salePrice,
    shippingCharged: s.shippingCharged,
    shippingCost: s.shippingCost,
    cost: item.cost * qty,
  }, overrides);
  const fees = s.fees ?? est.fees;
  const profit = Math.round((s.salePrice + (s.shippingCharged ?? 0) - fees - (s.shippingCost ?? 0) - item.cost * qty) * 100) / 100;

  return tx(db, () => {
    const saleId = Number(
      db
        .prepare(
          `INSERT INTO sales (item_id, marketplace, quantity, order_id, sale_price, shipping_charged, shipping_cost, fees, cost, profit, buyer, sold_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
        )
        .run(
          item.id,
          s.marketplace,
          qty,
          s.orderId ?? null,
          s.salePrice,
          s.shippingCharged ?? 0,
          s.shippingCost ?? 0,
          fees,
          item.cost * qty,
          profit,
          s.buyer ?? null,
          s.soldAt ?? null,
        ).lastInsertRowid,
    );

    if (qty > item.quantity) {
      logActivity(db, "alert", `OVERSOLD ${item.sku}: sold ${qty} on ${MARKETPLACES[s.marketplace].name} but only ${item.quantity} were left`, item.id);
    }
    const remaining = Math.max(0, item.quantity - qty);
    db.prepare("UPDATE items SET quantity = ?, status = ?, updated_at = datetime('now') WHERE id = ?").run(
      remaining,
      remaining === 0 ? "sold" : item.status,
      item.id,
    );

    const delisted: string[] = [];
    const synced: string[] = [];
    const relisted: string[] = [];
    const live = db
      .prepare("SELECT * FROM listings WHERE item_id = ? AND status IN ('active','queued','error')")
      .all(item.id) as unknown as ListingRow[];

    if (remaining === 0) {
      // Last unit gone: mark the selling listing sold and pull every other one.
      db.prepare("UPDATE listings SET status = 'sold', quantity = 0, ended_at = datetime('now') WHERE item_id = ? AND marketplace = ?").run(
        item.id,
        s.marketplace,
      );
      for (const l of live.filter((x) => x.marketplace !== s.marketplace)) {
        requestDelist(db, l, `sold on ${s.marketplace}`);
        delisted.push(l.marketplace);
      }
    } else {
      // Units remain: keep every marketplace's quantity in sync so nobody oversells.
      for (const l of live) {
        const m = l.marketplace as MarketplaceId;
        const want = listingQty(m, remaining);
        if (l.marketplace === s.marketplace) {
          if (!MARKETPLACES[m].multiQty) {
            // Single-quantity site: that listing is now sold out -> relist one more unit.
            db.prepare("UPDATE listings SET status = 'queued', quantity = 1, external_id = NULL, url = NULL WHERE id = ?").run(l.id);
            enqueue(db, m, "publish", item.id, l.id);
            relisted.push(l.marketplace);
          } else {
            db.prepare("UPDATE listings SET quantity = ? WHERE id = ?").run(want, l.id); // marketplace already decremented itself
          }
        } else if (l.quantity !== want) {
          db.prepare("UPDATE listings SET quantity = ? WHERE id = ?").run(want, l.id);
          if (l.status === "active") enqueue(db, m, "update", item.id, l.id);
          synced.push(l.marketplace);
        }
      }
    }
    const names = (ids: string[]) => ids.map((d) => MARKETPLACES[d as MarketplaceId].name).join(", ");
    logActivity(
      db,
      "sale",
      `SOLD ${qty > 1 ? qty + "x " : ""}${item.sku} on ${MARKETPLACES[s.marketplace].name} for $${s.salePrice.toFixed(2)} (profit $${profit.toFixed(2)}) - ${remaining} left` +
        (delisted.length ? ` - auto-delisting from ${names(delisted)}` : "") +
        (synced.length ? ` - quantity synced on ${names(synced)}` : "") +
        (relisted.length ? ` - relisting on ${names(relisted)}` : ""),
      item.id,
    );
    return { saleId, profit, fees, remaining, delisted, synced, relisted };
  });
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
      const row = li.sku
        ? (db.prepare("SELECT id FROM items WHERE sku = ?").get(li.sku) as { id: number } | undefined)
        : undefined;
      if (!row) continue;
      const r = recordSale(db, {
        itemId: row.id,
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

/** Add units (e.g. bought 5 more). Cost becomes the weighted average of units left + new units. */
export function restock(db: Db, itemId: number, units: number, unitCost?: number) {
  const item = getItem(db, itemId);
  if (!item) throw new Error("Item not found");
  if (units < 1) throw new Error("units must be >= 1");
  const newCost = unitCost ?? item.cost;
  const avgCost = Math.round(((item.cost * item.quantity + newCost * units) / (item.quantity + units)) * 100) / 100;
  const remaining = item.quantity + units;
  return tx(db, () => {
    db.prepare(
      `UPDATE items SET quantity = ?, quantity_purchased = quantity_purchased + ?, cost = ?,
         status = CASE WHEN status = 'sold' THEN 'active' ELSE status END, updated_at = datetime('now') WHERE id = ?`,
    ).run(remaining, units, avgCost, itemId);
    for (const l of item.listings.filter((x) => x.status === "active")) {
      const want = listingQty(l.marketplace as MarketplaceId, remaining);
      if (want !== l.quantity) {
        db.prepare("UPDATE listings SET quantity = ? WHERE id = ?").run(want, l.id);
        enqueue(db, l.marketplace as MarketplaceId, "update", itemId, l.id);
      }
    }
    logActivity(db, "restock", `Restocked ${item.sku}: +${units} @ $${newCost.toFixed(2)} (avg cost now $${avgCost.toFixed(2)}, ${remaining} left)`, itemId);
    return getItem(db, itemId);
  });
}
