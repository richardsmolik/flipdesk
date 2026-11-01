import type { Db } from "../db.js";

const n = (v: unknown) => Number(v ?? 0);
const r2 = (x: number) => Math.round(x * 100) / 100;

export function dashboard(db: Db) {
  const one = <T>(sql: string, ...a: (string | number)[]) => db.prepare(sql).get(...a) as T;

  const inv = one<{ active: number; draft: number; value: number; cost_basis: number; units: number }>(
    `SELECT SUM(status = 'active') AS active, SUM(status = 'draft') AS draft,
            SUM(CASE WHEN status IN ('active','draft') THEN price * quantity END) AS value,
            SUM(CASE WHEN status IN ('active','draft') THEN cost * quantity END) AS cost_basis,
            SUM(CASE WHEN status IN ('active','draft') THEN quantity END) AS units
     FROM items`,
  );

  const period = (days: number) =>
    one<{ revenue: number; profit: number; sales: number; fees: number }>(
      `SELECT SUM(sale_price + shipping_charged) AS revenue, SUM(profit) AS profit, COUNT(*) AS sales, SUM(fees) AS fees
       FROM sales WHERE sold_at >= datetime('now', ?)`,
      `-${days} days`,
    );
  const d30 = period(30);
  const prev30 = one<{ revenue: number; profit: number; sales: number }>(
    `SELECT SUM(sale_price + shipping_charged) AS revenue, SUM(profit) AS profit, COUNT(*) AS sales
     FROM sales WHERE sold_at >= datetime('now', '-60 days') AND sold_at < datetime('now', '-30 days')`,
  );
  const ytd = one<{ revenue: number; profit: number; sales: number; fees: number }>(
    `SELECT SUM(sale_price + shipping_charged) AS revenue, SUM(profit) AS profit, COUNT(*) AS sales, SUM(fees) AS fees
     FROM sales WHERE strftime('%Y', sold_at) = strftime('%Y', 'now')`,
  );
  const expensesYtd = one<{ total: number }>(`SELECT SUM(amount) AS total FROM expenses WHERE strftime('%Y', date) = strftime('%Y', 'now')`);

  const daysToSell = one<{ avg: number }>(
    `SELECT AVG(julianday(s.sold_at) - julianday(COALESCE(
        (SELECT MIN(listed_at) FROM listings l WHERE l.item_id = s.item_id), i.created_at))) AS avg
     FROM sales s JOIN items i ON i.id = s.item_id WHERE s.sold_at >= datetime('now', '-90 days')`,
  );

  const sellThrough = n(d30.sales) / Math.max(1, n(d30.sales) + n(inv.active));

  const byMarketplace = db
    .prepare(
      `SELECT marketplace, COUNT(*) AS sales, SUM(sale_price + shipping_charged) AS revenue, SUM(profit) AS profit, SUM(fees) AS fees
       FROM sales WHERE sold_at >= datetime('now', '-90 days') GROUP BY marketplace ORDER BY profit DESC`,
    )
    .all();

  const daily = db
    .prepare(
      `WITH RECURSIVE d(day) AS (SELECT date('now', '-29 days') UNION ALL SELECT date(day, '+1 day') FROM d WHERE day < date('now'))
       SELECT d.day, COALESCE(SUM(s.sale_price + s.shipping_charged), 0) AS revenue, COALESCE(SUM(s.profit), 0) AS profit, COUNT(s.id) AS sales
       FROM d LEFT JOIN sales s ON date(s.sold_at) = d.day GROUP BY d.day ORDER BY d.day`,
    )
    .all();

  const jobs = one<{ pending: number; failed: number }>(
    `SELECT SUM(status IN ('pending','claimed')) AS pending, SUM(status = 'failed' AND updated_at >= datetime('now','-7 days')) AS failed FROM jobs`,
  );
  const stale = one<{ c: number }>(
    `SELECT COUNT(DISTINCT item_id) AS c FROM listings WHERE status = 'active' AND listed_at <= datetime('now', '-30 days')`,
  );
  const topSellers = db
    .prepare(
      `SELECT i.brand, COUNT(*) AS sales, SUM(s.profit) AS profit FROM sales s JOIN items i ON i.id = s.item_id
       WHERE i.brand != '' GROUP BY i.brand ORDER BY profit DESC LIMIT 5`,
    )
    .all();

  return {
    inventory: { active: n(inv.active), draft: n(inv.draft), value: r2(n(inv.value)), costBasis: r2(n(inv.cost_basis)), units: n(inv.units) },
    last30: { revenue: r2(n(d30.revenue)), profit: r2(n(d30.profit)), sales: n(d30.sales), fees: r2(n(d30.fees)) },
    prev30: { revenue: r2(n(prev30.revenue)), profit: r2(n(prev30.profit)), sales: n(prev30.sales) },
    ytd: {
      revenue: r2(n(ytd.revenue)),
      profit: r2(n(ytd.profit)),
      sales: n(ytd.sales),
      fees: r2(n(ytd.fees)),
      expenses: r2(n(expensesYtd.total)),
      netAfterExpenses: r2(n(ytd.profit) - n(expensesYtd.total)),
    },
    avgDaysToSell: daysToSell.avg ? Math.round(daysToSell.avg) : null,
    sellThroughPct: Math.round(sellThrough * 1000) / 10,
    byMarketplace,
    daily,
    topBrands: topSellers,
    queue: { pending: n(jobs.pending), failed: n(jobs.failed) },
    staleCount: n(stale.c),
    alerts: db.prepare("SELECT id, kind, severity, title, item_id FROM alerts WHERE resolved_at IS NULL ORDER BY CASE severity WHEN 'critical' THEN 0 ELSE 1 END, id DESC LIMIT 5").all(),
    alertCount: n((db.prepare("SELECT COUNT(*) AS c FROM alerts WHERE resolved_at IS NULL").get() as { c: number }).c),
    recent: db.prepare("SELECT * FROM activity ORDER BY id DESC LIMIT 12").all(),
  };
}

export function toCsv(rows: Record<string, unknown>[]) {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
}
