/**
 * Import past sales (Vendoo / List Perfectly sold exports, eBay orders report, your own sheet).
 * History only: no delisting, notifications or oversell alerts, and sales are marked shipped.
 * Rows with a listed date teach the price advice how long things take to sell.
 */
import { getSetting, logActivity, type Db } from "../db.js";
import { isMarketplaceId, type MarketplaceId } from "../marketplaces/registry.js";
import { parseCsv } from "./comps.js";
import { breakdown } from "./fees.js";
import { mapCondition } from "./inventoryImport.js";

type F = "title" | "sku" | "marketplace" | "price" | "soldAt" | "listedAt" | "cost" | "fees" | "shipCost" | "shipCharged" | "quantity" | "buyer" | "orderId" | "brand" | "category" | "source" | "condition" | "listPrice";

const PATTERNS: [F, RegExp[]][] = [
  ["orderId", [/order (id|number|#)/, /^order$/, /transaction id/, /sales record/]],
  ["sku", [/^sku$/, /custom label/, /^sku\b/]],
  ["title", [/^title$/, /item title/, /listing title/, /^name$/, /item name/, /product/]],
  ["marketplace", [/marketplace/, /platform/, /sold on/, /channel/, /^site$/, /^store$/]],
  ["soldAt", [/sold date/, /date sold/, /sale date/, /order date/, /paid (on )?date/, /^sold$/, /^date$/]],
  ["listedAt", [/listed date/, /date listed/, /list date/, /created/, /start date/]],
  ["shipCharged", [/shipping charged/, /shipping (income|paid by buyer|collected)/, /buyer shipping/, /shipping and handling/]],
  ["shipCost", [/shipping cost/, /label cost/, /postage/, /shipping (paid|expense)/, /^shipping$/]],
  ["fees", [/fees?$/, /selling fee/, /final value/, /commission/]],
  ["cost", [/^cost/, /cogs/, /cost of goods/, /purchase price/, /price paid/]],
  ["listPrice", [/list(ing)? price/, /original price/, /asking/]],
  ["price", [/sold price/, /sale price/, /price sold/, /sold for/, /item (price|subtotal)/, /^price$/, /^total$/, /sale amount/, /gross/]],
  ["quantity", [/^qty/, /quantity/]],
  ["buyer", [/buyer/, /customer/]],
  ["brand", [/^brand/, /designer/]],
  ["category", [/category/]],
  ["source", [/^source/, /sourced/]],
  ["condition", [/condition/]],
];

function detect(header: string[]) {
  const h = header.map((x) => x.toLowerCase().trim());
  const used = new Set<number>();
  const map: Partial<Record<F, number>> = {};
  for (const [f, res] of PATTERNS) {
    for (const re of res) {
      const i = h.findIndex((x, k) => re.test(x) && !used.has(k));
      if (i >= 0) {
        map[f] = i;
        used.add(i);
        break;
      }
    }
  }
  return map;
}

export function mapMarketplace(v: string): MarketplaceId | null {
  const s = v.toLowerCase();
  const table: [RegExp, MarketplaceId][] = [
    [/ebay/, "ebay"],
    [/posh/, "poshmark"],
    [/mercari/, "mercari"],
    [/depop/, "depop"],
    [/vinted/, "vinted"],
    [/grailed/, "grailed"],
    [/facebook|^fb\b|fb market/, "facebook"],
    [/etsy/, "etsy"],
    [/shopify/, "shopify"],
    [/amazon/, "amazon"],
    [/whatnot/, "whatnot"],
  ];
  for (const [re, id] of table) if (re.test(s)) return id;
  return isMarketplaceId(s) ? s : null;
}

const money = (s?: string) => {
  const t = String(s ?? "").trim();
  if (!t) return null;
  const n = Number(t.replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? Math.round(Math.abs(n) * 100) / 100 : null;
};
const sqlDate = (s?: string) => {
  const t = String(s ?? "").trim();
  if (!t) return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) || d.getFullYear() < 2000 ? null : d.toISOString().replace("T", " ").slice(0, 19);
};

export interface SaleRow {
  line: number;
  title: string;
  sku: string | null;
  marketplace: MarketplaceId | null;
  price: number;
  quantity: number;
  soldAt: string | null;
  listedAt: string | null;
  cost: number | null;
  fees: number | null;
  shipCost: number;
  shipCharged: number;
  buyer: string | null;
  orderId: string | null;
  brand: string;
  category: string;
  source: string;
  condition: string;
  listPrice: number | null;
  problem?: string;
}

export function parseSales(text: string, defaultMarketplace?: MarketplaceId) {
  const rows = parseCsv(text);
  const hi = rows.findIndex((r) => r.some((c) => /title|name|product/i.test(c)) && r.some((c) => /price|sold|total|amount/i.test(c)));
  if (hi < 0) throw new Error("Couldn't find title and sold-price columns. Export your sold items as CSV with a header row.");
  const header = rows[hi];
  const m = detect(header);
  const c = (r: string[], f: F) => (m[f] !== undefined ? (r[m[f]!] ?? "").trim() : "");
  const out: SaleRow[] = [];
  rows.slice(hi + 1).forEach((r, k) => {
    if (!r.some((x) => x.trim())) return;
    const mp = m.marketplace !== undefined ? mapMarketplace(c(r, "marketplace")) : defaultMarketplace ?? null;
    const row: SaleRow = {
      line: hi + 2 + k,
      title: c(r, "title").slice(0, 255),
      sku: c(r, "sku") || null,
      marketplace: mp,
      price: money(c(r, "price")) ?? 0,
      quantity: Math.max(1, Math.round(money(c(r, "quantity")) ?? 1)),
      soldAt: sqlDate(c(r, "soldAt")),
      listedAt: sqlDate(c(r, "listedAt")),
      cost: money(c(r, "cost")),
      fees: money(c(r, "fees")),
      shipCost: money(c(r, "shipCost")) ?? 0,
      shipCharged: money(c(r, "shipCharged")) ?? 0,
      buyer: c(r, "buyer") || null,
      orderId: c(r, "orderId") || null,
      brand: c(r, "brand"),
      category: c(r, "category"),
      source: c(r, "source"),
      condition: mapCondition(c(r, "condition")),
      listPrice: money(c(r, "listPrice")),
    };
    if (!row.title && !row.sku) row.problem = "no title";
    else if (!row.price) row.problem = "no sold price";
    else if (!row.soldAt) row.problem = "no/unreadable sold date";
    else if (!row.marketplace) row.problem = `unknown marketplace "${c(r, "marketplace")}"`;
    out.push(row);
  });
  const found = Object.fromEntries(Object.entries(m).map(([f, i]) => [f, header[i!]]));
  return { found, rows: out, hasMarketplaceColumn: m.marketplace !== undefined };
}

function isDuplicate(db: Db, r: SaleRow) {
  if (r.orderId && r.marketplace) return Boolean(db.prepare("SELECT 1 FROM sales WHERE marketplace = ? AND order_id = ?").get(r.marketplace, `hist:${r.orderId}`));
  return Boolean(
    db
      .prepare("SELECT 1 FROM sales s JOIN items i ON i.id = s.item_id WHERE i.title = ? AND date(s.sold_at) = date(?) AND ABS(s.sale_price - ?) < 0.01")
      .get(r.title, r.soldAt, r.price),
  );
}

export function previewSales(db: Db, text: string, defaultMarketplace?: MarketplaceId) {
  const { found, rows, hasMarketplaceColumn } = parseSales(text, defaultMarketplace);
  const ok = rows.filter((r) => !r.problem);
  const dupes = ok.filter((r) => isDuplicate(db, r)).length;
  const by: Record<string, number> = {};
  for (const r of ok) by[r.marketplace!] = (by[r.marketplace!] ?? 0) + 1;
  const dates = ok.map((r) => r.soldAt!).sort();
  const warnings: string[] = [];
  if (!hasMarketplaceColumn && !defaultMarketplace) warnings.push("No marketplace column - choose which site these sales came from.");
  if (!found.cost) warnings.push("No cost column - profit will look higher than it really was (cost counted as $0).");
  if (!found.fees) warnings.push("No fees column - fees are estimated from each site's current fee rates.");
  if (!found.listedAt) warnings.push("No listed-date column - imported sales won't help 'days to sell' in price advice.");
  if (dupes) warnings.push(`${dupes} sale(s) are already in FlipDesk and will be skipped.`);
  return {
    columns: found,
    total: rows.length,
    ready: ok.length - dupes,
    problems: rows.filter((r) => r.problem).map((r) => ({ line: r.line, reason: r.problem })).slice(0, 20),
    problemCount: rows.filter((r) => r.problem).length,
    duplicates: dupes,
    byMarketplace: by,
    from: dates[0] ?? null,
    to: dates[dates.length - 1] ?? null,
    revenue: Math.round(ok.reduce((a, r) => a + r.price + r.shipCharged, 0) * 100) / 100,
    sample: rows.slice(0, 8),
    warnings,
  };
}

export function importSales(db: Db, text: string, defaultMarketplace?: MarketplaceId) {
  const { rows } = parseSales(text, defaultMarketplace);
  const overrides = getSetting(db, "feeOverrides", {});
  const prefix = getSetting(db, "skuPrefix", "FD");
  let imported = 0;
  let attached = 0;
  const skipped: { line: number; reason: string }[] = [];
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      if (r.problem) {
        skipped.push({ line: r.line, reason: r.problem });
        continue;
      }
      if (isDuplicate(db, r)) {
        skipped.push({ line: r.line, reason: "already imported" });
        continue;
      }
      const mp = r.marketplace!;
      const existing = r.sku ? (db.prepare("SELECT id FROM items WHERE sku = ?").get(r.sku) as { id: number } | undefined) : undefined;
      let itemId: number;
      if (existing) {
        itemId = existing.id; // history for an item you still have: don't touch its stock
        attached++;
      } else {
        let sku = r.sku ?? `${prefix}-H${String(Date.now()).slice(-6)}${imported}`;
        while (db.prepare("SELECT 1 FROM items WHERE sku = ?").get(sku)) sku += "X";
        const unitCost = r.cost !== null ? r.cost / r.quantity : 0;
        itemId = Number(
          db
            .prepare(
              `INSERT INTO items (sku, title, brand, category, condition, cost, price, original_price, quantity, quantity_purchased, source, status, created_at, updated_at, sourced_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'sold', COALESCE(?, ?), ?, date(COALESCE(?, ?)))`,
            )
            .run(sku, r.title, r.brand, r.category, r.condition, unitCost, r.price / r.quantity, r.listPrice ?? r.price / r.quantity, r.quantity, r.source, r.listedAt, r.soldAt, r.soldAt, r.listedAt, r.soldAt)
            .lastInsertRowid,
        );
        db.prepare("INSERT INTO listings (item_id, marketplace, status, price, quantity, listed_at, ended_at) VALUES (?, ?, 'sold', ?, 0, ?, ?)").run(
          itemId, mp, r.listPrice ?? r.price, r.listedAt ?? r.soldAt, r.soldAt,
        );
      }
      const fees = r.fees ?? breakdown(mp, { price: r.price, shippingCharged: r.shipCharged }, overrides).fees;
      const cost = r.cost ?? 0;
      const profit = Math.round((r.price + r.shipCharged - fees - r.shipCost - cost) * 100) / 100;
      db.prepare(
        `INSERT INTO sales (item_id, marketplace, quantity, order_id, sale_price, shipping_charged, shipping_cost, fees, cost, profit, buyer, sold_at, shipped_at, label_source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'history')`,
      ).run(itemId, mp, r.quantity, r.orderId ? `hist:${r.orderId}` : null, r.price, r.shipCharged, r.shipCost, fees, cost, profit, r.buyer, r.soldAt, r.soldAt);
      imported++;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  logActivity(db, "import", `Imported ${imported} past sale(s)${attached ? ` (${attached} matched existing SKUs)` : ""}${skipped.length ? `, skipped ${skipped.length}` : ""}`);
  return { imported, attached, skipped };
}
