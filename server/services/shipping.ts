/**
 * Shipping labels.
 *  - Who buys the label is a setting per marketplace (and a default for the account):
 *      "marketplace" - site's prepaid label (Poshmark, Depop, Vinted, Whatnot, Mercari, Facebook...)
 *      "ebay"        - eBay labels: cost pulled from eBay's Finances API automatically
 *      "pirateship"  - Pirate Ship: export orders as CSV, import shipment history to get costs + tracking
 *      "manual"      - you enter cost/tracking yourself
 *  - Pirate Ship has no public API; its spreadsheet import/export is the supported integration.
 */
import { getSetting, logActivity, setSetting, tx, type Db } from "../db.js";
import { ebayAddTracking, ebayIsLive, ebayLabelTransactions } from "../marketplaces/ebay.js";
import type { MarketplaceId } from "../marketplaces/registry.js";
import { parseCsv } from "./comps.js";
import { toCsv } from "./reports.js";

export type LabelProvider = "marketplace" | "ebay" | "pirateship" | "manual";

export interface ShippingSettings {
  defaultProvider?: LabelProvider; // for sites where you buy your own label
  perMarketplace?: Partial<Record<MarketplaceId, LabelProvider>>;
  defaultPackage?: { weightOz?: number; length?: number; width?: number; height?: number };
}

// Sites that hand you a prepaid label by default.
const PREPAID: MarketplaceId[] = ["poshmark", "mercari", "depop", "vinted", "whatnot", "grailed", "facebook"];

export function providerFor(db: Db, m: MarketplaceId): LabelProvider {
  const s = getSetting<ShippingSettings>(db, "shipping", {});
  if (s.perMarketplace?.[m]) return s.perMarketplace[m]!;
  if (PREPAID.includes(m)) return "marketplace";
  if (m === "ebay") return s.defaultProvider === "pirateship" ? "pirateship" : "ebay";
  return s.defaultProvider && s.defaultProvider !== "ebay" ? s.defaultProvider : "pirateship";
}

export interface Address {
  name: string;
  company?: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  zip: string;
  country?: string;
  phone?: string;
  email?: string;
  ebayOrderId?: string;
  lineItemId?: string | null;
}

/** Parse a pasted address block ("Jane Doe\n123 Main St\nApt 4\nAustin, TX 78701"). */
export function parseAddress(text: string): Address | null {
  const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 3) return null;
  const last = lines[lines.length - 1].replace(/\b(USA|United States)\b/i, "").trim() || lines[lines.length - 2];
  const m = last.match(/^(.*?),?\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/i);
  if (!m) return null;
  const middle = lines.slice(1, lines.indexOf(last) >= 0 ? lines.indexOf(last) : lines.length - 1);
  return { name: lines[0], line1: middle[0] ?? "", line2: middle.slice(1).join(", "), city: m[1].replace(/,$/, ""), state: m[2].toUpperCase(), zip: m[3], country: "US" };
}

export interface ShipRow {
  id: number;
  item_id: number;
  marketplace: MarketplaceId;
  quantity: number;
  sale_price: number;
  shipping_cost: number;
  order_id: string | null;
  buyer: string | null;
  sold_at: string;
  tracking: string | null;
  sku: string;
  title: string;
  weight_oz: number | null;
  ship_to: Address | null;
  provider: LabelProvider;
}

/** Sales that still need shipping, with who buys the label. */
export function toShip(db: Db, days = 30): ShipRow[] {
  const rows = db
    .prepare(
      `SELECT s.id, s.item_id, s.marketplace, s.quantity, s.sale_price, s.shipping_cost, s.order_id, s.buyer, s.sold_at, s.ship_to, s.tracking, i.sku, i.title, i.weight_oz
       FROM sales s JOIN items i ON i.id = s.item_id
       WHERE s.shipped_at IS NULL AND s.sold_at >= datetime('now', ?) ORDER BY s.sold_at`,
    )
    .all(`-${days} days`) as unknown as (Omit<ShipRow, "ship_to" | "provider"> & { ship_to: string | null })[];
  return rows.map((r) => ({ ...r, ship_to: r.ship_to ? (JSON.parse(r.ship_to) as Address) : null, provider: providerFor(db, r.marketplace) }));
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Set label cost / tracking and recompute profit. */
export function updateShipping(db: Db, saleId: number, u: { cost?: number; tracking?: string; carrier?: string; source?: LabelProvider; shipped?: boolean; shipTo?: Address }) {
  const s = db.prepare("SELECT * FROM sales WHERE id = ?").get(saleId) as
    | { sale_price: number; shipping_charged: number; fees: number; cost: number; shipping_cost: number }
    | undefined;
  if (!s) throw new Error("Sale not found");
  const cost = u.cost ?? s.shipping_cost;
  const profit = r2(s.sale_price + s.shipping_charged - s.fees - cost - s.cost);
  db.prepare(
    `UPDATE sales SET shipping_cost = ?, profit = ?, tracking = COALESCE(?, tracking), carrier = COALESCE(?, carrier), label_source = COALESCE(?, label_source),
       shipped_at = CASE WHEN ? THEN COALESCE(shipped_at, datetime('now')) ELSE shipped_at END, ship_to = COALESCE(?, ship_to) WHERE id = ?`,
  ).run(cost, profit, u.tracking ?? null, u.carrier ?? null, u.source ?? null, u.shipped ? 1 : 0, u.shipTo ? JSON.stringify(u.shipTo) : null, saleId);
  return { saleId, shippingCost: cost, profit };
}

// ---------------- Pirate Ship ----------------

/** CSV for Pirate Ship's spreadsheet import. "Order ID" lets us match the labels back later. */
export function pirateShipExport(db: Db, saleIds: number[]) {
  const pkg = getSetting<ShippingSettings>(db, "shipping", {}).defaultPackage ?? {};
  const rows = toShip(db, 3650).filter((r) => saleIds.includes(r.id as number));
  const missing = rows.filter((r) => !r.ship_to?.line1).map((r) => r.sku);
  const csv = toCsv(
    rows
      .filter((r) => r.ship_to?.line1)
      .map((r) => {
        const a = r.ship_to as Address;
        const oz = Number(r.weight_oz ?? pkg.weightOz ?? 16) * Number(r.quantity ?? 1);
        return {
          Name: a.name,
          Company: a.company ?? "",
          Address: a.line1,
          "Address Line 2": a.line2 ?? "",
          City: a.city,
          State: a.state,
          Zipcode: a.zip,
          Country: a.country ?? "US",
          Email: a.email ?? "",
          Phone: a.phone ?? "",
          Pounds: Math.floor(oz / 16),
          Ounces: Math.round(oz % 16),
          Length: pkg.length ?? "",
          Width: pkg.width ?? "",
          Height: pkg.height ?? "",
          "Order ID": `FD-${r.id}`,
          "Item Description": String(r.title).slice(0, 60),
        };
      }),
  );
  return { csv, count: rows.length - missing.length, missing };
}

/** Import Pirate Ship shipment history (Ship > History > Export). Matches by Order ID, then recipient name. */
export async function pirateShipImport(db: Db, text: string) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error("That file has no rows.");
  const h = rows[0].map((x) => x.toLowerCase().trim());
  const col = (...res: RegExp[]) => {
    for (const re of res) {
      const i = h.findIndex((x) => re.test(x));
      if (i >= 0) return i;
    }
    return -1;
  };
  const c = {
    tracking: col(/tracking/),
    cost: col(/^cost$|total cost|label cost|^price$|amount|postage|^total$|cost/),
    order: col(/order id|order|reference|ref/),
    name: col(/recipient|^name$|ship to|to name|name/),
    carrier: col(/carrier/),
    status: col(/status/),
  };
  if (c.tracking < 0 || c.cost < 0) throw new Error(`Couldn't find tracking and cost columns. Found: ${rows[0].join(", ")}`);
  const pending = toShip(db, 60);
  let matched = 0;
  let uploaded = 0;
  const unmatched: string[] = [];
  const results: { saleId: number; tracking: string; cost: number }[] = [];
  tx(db, () => {
    for (const r of rows.slice(1)) {
      if (c.status >= 0 && /void|refund|cancel/i.test(r[c.status] ?? "")) continue;
      const tracking = (r[c.tracking] ?? "").trim();
      const cost = Number((r[c.cost] ?? "").replace(/[^0-9.\-]/g, ""));
      if (!tracking || !Number.isFinite(cost)) continue;
      const ref = c.order >= 0 ? (r[c.order] ?? "").trim() : "";
      const name = c.name >= 0 ? (r[c.name] ?? "").trim().toLowerCase() : "";
      let sale = ref.match(/^FD-(\d+)$/i) ? pending.find((p) => p.id === Number(ref.slice(3))) : undefined;
      if (!sale && name) {
        const byName = pending.filter((p) => (p.ship_to?.name ?? "").toLowerCase() === name && !results.some((x) => x.saleId === p.id));
        if (byName.length === 1) sale = byName[0];
      }
      if (!sale) {
        unmatched.push(`${name || ref || tracking}`);
        continue;
      }
      const carrier = c.carrier >= 0 ? r[c.carrier] || "USPS" : /^1Z/i.test(tracking) ? "UPS" : "USPS";
      updateShipping(db, sale.id as number, { cost: Math.abs(cost), tracking, carrier, source: "pirateship", shipped: true });
      results.push({ saleId: sale.id as number, tracking, cost: Math.abs(cost) });
      matched++;
    }
  });
  // eBay orders: upload tracking so you're covered by seller protection.
  for (const r of results) {
    const sale = pending.find((p) => p.id === r.saleId)!;
    const a = sale.ship_to as Address | null;
    if (sale.marketplace === "ebay" && a?.ebayOrderId && a.lineItemId && ebayIsLive(db)) {
      try {
        await ebayAddTracking(db, a.ebayOrderId, a.lineItemId, Number(sale.quantity ?? 1), /^1Z/i.test(r.tracking) ? "UPS" : "USPS", r.tracking);
        uploaded++;
      } catch (e) {
        console.warn("[ebay tracking]", (e as Error).message);
      }
    }
  }
  if (matched) logActivity(db, "shipping", `Imported ${matched} Pirate Ship label(s)${uploaded ? `, uploaded ${uploaded} tracking number(s) to eBay` : ""}`);
  return { matched, unmatched, trackingUploaded: uploaded };
}

// ---------------- eBay labels ----------------

/** Attach exact eBay label costs (Finances API) to sales. */
export async function syncEbayLabelCosts(db: Db) {
  if (!ebayIsLive(db)) return 0;
  const since = getSetting(db, "ebay.lastLabelSync", new Date(Date.now() - 14 * 86400_000).toISOString());
  const started = new Date().toISOString();
  const txs = await ebayLabelTransactions(db, since);
  let n = 0;
  for (const t of txs) {
    const sale = db.prepare("SELECT id FROM sales WHERE marketplace = 'ebay' AND order_id LIKE ? ORDER BY id LIMIT 1").get(`${t.orderId}:%`) as { id: number } | undefined;
    if (!sale) continue;
    updateShipping(db, sale.id, { cost: t.amount, source: "ebay", shipped: true });
    n++;
  }
  setSetting(db, "ebay.lastLabelSync", started);
  return n;
}
