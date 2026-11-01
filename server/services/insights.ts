/** "What's actually making me money" - profit, ROI and speed by source, brand, category, marketplace. */
import { getSetting, type Db } from "../db.js";

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface GroupRow {
  key: string;
  unitsBought: number;
  unitsSold: number;
  revenue: number;
  profit: number;
  cogs: number;
  roiPct: number | null;
  sellThroughPct: number | null;
  avgDaysToSell: number | null;
  avgProfit: number | null;
  avgAgeDays: number | null;
}

function groupBy(db: Db, keyExpr: string, days: number): GroupRow[] {
  const bought = db
    .prepare(
      `SELECT ${keyExpr} AS k, SUM(i.quantity_purchased) AS units, AVG(julianday('now') - julianday(COALESCE(i.sourced_at, i.created_at))) AS age
       FROM items i WHERE i.status != 'archived' GROUP BY k`,
    )
    .all() as { k: string; units: number; age: number | null }[];
  const sold = db
    .prepare(
      `SELECT ${keyExpr} AS k, SUM(s.quantity) AS units, SUM(s.sale_price + s.shipping_charged) AS revenue, SUM(s.profit) AS profit, SUM(s.cost) AS cogs,
              AVG(julianday(s.sold_at) - julianday(COALESCE(i.sourced_at, i.created_at))) AS days
       FROM sales s JOIN items i ON i.id = s.item_id
       WHERE s.sold_at >= datetime('now', ?) GROUP BY k`,
    )
    .all(`-${days} days`) as { k: string; units: number; revenue: number; profit: number; cogs: number; days: number | null }[];
  const map = new Map<string, GroupRow>();
  const get = (k: string) => {
    const key = k || "(not set)";
    if (!map.has(key)) map.set(key, { key, unitsBought: 0, unitsSold: 0, revenue: 0, profit: 0, cogs: 0, roiPct: null, sellThroughPct: null, avgDaysToSell: null, avgProfit: null, avgAgeDays: null });
    return map.get(key)!;
  };
  for (const b of bought) {
    const g = get(b.k);
    g.unitsBought = Number(b.units ?? 0);
    g.avgAgeDays = b.age === null ? null : Math.round(b.age);
  }
  for (const s of sold) {
    const g = get(s.k);
    g.unitsSold = Number(s.units ?? 0);
    g.revenue = r2(Number(s.revenue ?? 0));
    g.profit = r2(Number(s.profit ?? 0));
    g.cogs = r2(Number(s.cogs ?? 0));
    g.avgDaysToSell = s.days === null ? null : Math.round(Math.max(0, s.days));
  }
  for (const g of map.values()) {
    g.roiPct = g.cogs > 0 ? Math.round((g.profit / g.cogs) * 100) : null;
    g.sellThroughPct = g.unitsBought > 0 ? Math.round((Math.min(g.unitsSold, g.unitsBought) / g.unitsBought) * 100) : null;
    g.avgProfit = g.unitsSold ? r2(g.profit / g.unitsSold) : null;
  }
  return [...map.values()].sort((a, b) => b.profit - a.profit);
}

export function profitReport(db: Db, days = 365) {
  const bySource = groupBy(db, "COALESCE(NULLIF(TRIM(i.source), ''), '(not set)')", days);
  const byBrand = groupBy(db, "COALESCE(NULLIF(TRIM(i.brand), ''), '(not set)')", days);
  const byCategory = groupBy(
    db,
    "COALESCE(NULLIF(LOWER(TRIM(CASE WHEN instr(i.category, '>') > 0 THEN substr(i.category, 1, instr(i.category, '>') - 1) ELSE i.category END)), ''), '(not set)')",
    days,
  ).map((g) => ({ ...g, key: g.key === "(not set)" ? g.key : g.key[0].toUpperCase() + g.key.slice(1) }));

  const byMarketplace = (
    db
      .prepare(
        `SELECT s.marketplace AS key, SUM(s.quantity) AS units, SUM(s.sale_price + s.shipping_charged) AS revenue, SUM(s.profit) AS profit, SUM(s.fees) AS fees,
                AVG(julianday(s.sold_at) - julianday(COALESCE((SELECT MIN(l.listed_at) FROM listings l WHERE l.item_id = s.item_id AND l.marketplace = s.marketplace), i.created_at))) AS days
         FROM sales s JOIN items i ON i.id = s.item_id WHERE s.sold_at >= datetime('now', ?) GROUP BY s.marketplace ORDER BY profit DESC`,
      )
      .all(`-${days} days`) as { key: string; units: number; revenue: number; profit: number; fees: number; days: number | null }[]
  ).map((m) => ({
    ...m,
    revenue: r2(m.revenue),
    profit: r2(m.profit),
    feePct: m.revenue ? r1((m.fees / m.revenue) * 100) : 0,
    avgDaysToSell: m.days === null ? null : Math.round(Math.max(0, m.days)),
  }));

  const byMonth = db
    .prepare(
      `SELECT strftime('%Y-%m', sold_at) AS month, SUM(quantity) AS units, ROUND(SUM(sale_price + shipping_charged), 2) AS revenue, ROUND(SUM(profit), 2) AS profit
       FROM sales WHERE sold_at >= date('now', 'start of month', '-11 months') GROUP BY month ORDER BY month`,
    )
    .all() as { month: string; units: number; revenue: number; profit: number }[];

  const aging = db
    .prepare(
      `SELECT CASE WHEN age <= 30 THEN '0-30 days' WHEN age <= 60 THEN '31-60 days' WHEN age <= 90 THEN '61-90 days' ELSE '90+ days' END AS bucket,
              COUNT(*) AS items, SUM(quantity) AS units, ROUND(SUM(cost * quantity), 2) AS cost, ROUND(SUM(price * quantity), 2) AS value
       FROM (SELECT *, julianday('now') - julianday(COALESCE(sourced_at, created_at)) AS age FROM items WHERE status IN ('active','draft') AND quantity > 0)
       GROUP BY bucket ORDER BY MIN(age)`,
    )
    .all() as { bucket: string; items: number; units: number; cost: number; value: number }[];

  const totals = db
    .prepare(`SELECT SUM(quantity) AS units, SUM(profit) AS profit, SUM(cost) AS cogs FROM sales WHERE sold_at >= datetime('now', ?)`)
    .get(`-${days} days`) as { units: number | null; profit: number | null; cogs: number | null };
  const minutes = getSetting(db, "minutesPerItem", 20) as number;
  const hours = ((totals.units ?? 0) * minutes) / 60;
  const perHour = hours > 0 ? r2((totals.profit ?? 0) / hours) : null;

  // ---- Plain-English insights ----
  const insights: { kind: "good" | "bad" | "info"; text: string }[] = [];
  const meaningful = (rows: GroupRow[]) => rows.filter((r) => r.unitsSold >= 3 && r.key !== "(not set)");
  const src = meaningful(bySource).filter((r) => r.roiPct !== null).sort((a, b) => b.roiPct! - a.roiPct!);
  if (src.length) insights.push({ kind: "good", text: `Best source: ${src[0].key}, with ${src[0].roiPct}% return on cost and $${src[0].avgProfit} average profit per item. Go back more often.` });
  if (src.length > 1 && src[src.length - 1].roiPct! < (src[0].roiPct ?? 0) / 2) {
    const w = src[src.length - 1];
    insights.push({ kind: "bad", text: `Weakest source: ${w.key} (${w.roiPct}% return). Be pickier there or skip it.` });
  }
  const brands = meaningful(byBrand);
  const fast = brands.filter((b) => (b.avgDaysToSell ?? 999) <= 21 && (b.roiPct ?? 0) >= 100).slice(0, 3);
  if (fast.length) insights.push({ kind: "good", text: `Buy more: ${fast.map((b) => `${b.key} (${b.avgDaysToSell}d, ${b.roiPct}% return)`).join(", ")}. They sell fast and pay well.` });
  const slow = byBrand.filter((b) => b.key !== "(not set)" && b.unitsBought >= 3 && (b.sellThroughPct ?? 100) < 25 && (b.avgAgeDays ?? 0) >= 30).slice(0, 3);
  if (slow.length) insights.push({ kind: "bad", text: `Slow movers: ${slow.map((b) => `${b.key} (${b.sellThroughPct}% sold)`).join(", ")}. Consider price drops or stop buying.` });
  const dead = aging.find((a) => a.bucket === "90+ days");
  if (dead && dead.cost > 0) insights.push({ kind: "bad", text: `$${dead.cost} of cash is tied up in ${dead.units} unit(s) older than 90 days. Run price drops, bundle them, or donate for a tax write-off.` });
  const mp = byMarketplace.filter((m) => m.units >= 3).sort((a, b) => b.profit / b.units - a.profit / a.units)[0];
  if (mp) insights.push({ kind: "info", text: `Most profit per sale on ${mp.key}: $${r2(mp.profit / mp.units)} average, ${mp.feePct}% fees.` });
  if (perHour !== null) insights.push({ kind: perHour >= 25 ? "good" : "info", text: `You're earning about $${perHour}/hour at ${minutes} min per item (change the minutes in Settings).` });

  return { days, bySource, byBrand: byBrand.slice(0, 25), byCategory, byMarketplace, byMonth, aging, perHour, minutesPerItem: minutes, insights };
}
