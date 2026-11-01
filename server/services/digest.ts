/** Weekly summary pushed to your phone (default: Monday 8am, your time zone). */
import { getSetting, type Db } from "../db.js";
import { MARKETPLACES, type MarketplaceId } from "../marketplaces/registry.js";
import { notify, type NotifySettings } from "./alerts.js";
import { suggestBundles } from "./bundles.js";
import { goalLine } from "./goals.js";

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

export interface WeeklySettings {
  enabled?: boolean;
  day?: number; // 0=Sun ... 1=Mon
  hour?: number; // 0-23 local
  timezone?: string; // IANA, e.g. America/Chicago
}

function localParts(date: Date, tz: string) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", hour12: false, year: "numeric", month: "2-digit", day: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return { dow, hour: Number(p.hour) % 24, ymd: `${p.year}-${p.month}-${p.day}` };
}

/** ISO week key like 2026-W44 for a local Y-M-D. */
export function isoWeek(ymd: string) {
  const d = new Date(`${ymd}T12:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7; // Mon=0
  d.setUTCDate(d.getUTCDate() - day + 3); // Thursday of this week
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d.getTime() - firstThu.getTime()) / 86400_000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function buildDigest(db: Db) {
  const one = <T>(sql: string, ...a: (string | number)[]) => db.prepare(sql).get(...a) as T;
  const wk = one<{ n: number; units: number; rev: number; profit: number }>(
    "SELECT COUNT(*) AS n, COALESCE(SUM(quantity),0) AS units, COALESCE(SUM(sale_price + shipping_charged),0) AS rev, COALESCE(SUM(profit),0) AS profit FROM sales WHERE sold_at >= datetime('now','-7 days')",
  );
  const prev = one<{ profit: number }>("SELECT COALESCE(SUM(profit),0) AS profit FROM sales WHERE sold_at >= datetime('now','-14 days') AND sold_at < datetime('now','-7 days')");
  const top = one<{ title: string; profit: number; marketplace: string } | undefined>(
    "SELECT i.title, s.profit, s.marketplace FROM sales s JOIN items i ON i.id = s.item_id WHERE s.sold_at >= datetime('now','-7 days') ORDER BY s.profit DESC LIMIT 1",
  );
  const src = one<{ source: string; units: number; profit: number; cogs: number } | undefined>(
    `SELECT i.source, SUM(s.quantity) AS units, SUM(s.profit) AS profit, SUM(s.cost) AS cogs FROM sales s JOIN items i ON i.id = s.item_id
     WHERE s.sold_at >= datetime('now','-7 days') AND TRIM(i.source) != '' GROUP BY i.source ORDER BY profit DESC LIMIT 1`,
  );
  // Items that crossed 30/60/90 days in the last week.
  const stale = db
    .prepare(
      `SELECT title, cost * quantity AS tied, CAST(julianday('now') - julianday(COALESCE(sourced_at, created_at)) AS INTEGER) AS age FROM items
       WHERE status = 'active' AND quantity > 0 AND (
         CAST(julianday('now') - julianday(COALESCE(sourced_at, created_at)) AS INTEGER) BETWEEN 30 AND 36 OR
         CAST(julianday('now') - julianday(COALESCE(sourced_at, created_at)) AS INTEGER) BETWEEN 60 AND 66 OR
         CAST(julianday('now') - julianday(COALESCE(sourced_at, created_at)) AS INTEGER) BETWEEN 90 AND 96)
       ORDER BY age DESC`,
    )
    .all() as { title: string; tied: number; age: number }[];
  const allStale = one<{ n: number; tied: number }>(
    "SELECT COUNT(*) AS n, COALESCE(SUM(cost * quantity),0) AS tied FROM items WHERE status = 'active' AND quantity > 0 AND julianday('now') - julianday(COALESCE(sourced_at, created_at)) >= 30",
  );
  const inbox = one<{ n: number }>("SELECT COUNT(*) AS n FROM alerts WHERE resolved_at IS NULL").n;
  const drafts = one<{ n: number }>("SELECT COUNT(*) AS n FROM items WHERE status = 'draft' AND quantity > 0").n;
  const bundle = suggestBundles(db, 15, 1)[0];

  const change = prev.profit > 0 ? Math.round(((wk.profit - prev.profit) / prev.profit) * 100) : null;
  const lines: string[] = [];
  lines.push(
    wk.n
      ? `💵 ${wk.units} sold · ${money(wk.rev)} revenue · ${money(wk.profit)} profit${change !== null ? ` (${change >= 0 ? "▲" : "▼"}${Math.abs(change)}% vs last week)` : ""}`
      : "💵 No sales this week. Time to refresh listings or drop some prices.",
  );
  if (top) lines.push(`🏆 Top sale: ${top.title.slice(0, 45)}, ${money(top.profit)} profit (${MARKETPLACES[top.marketplace as MarketplaceId]?.name ?? top.marketplace})`);
  if (src) lines.push(`🛒 Best source: ${src.source} (${src.units} sold${src.cogs > 0 ? `, ${Math.round((src.profit / src.cogs) * 100)}% return` : ""})`);
  if (allStale.n)
    lines.push(
      `🐢 ${allStale.n} item${allStale.n === 1 ? "" : "s"} stale 30+ days (${money(allStale.tied)} tied up)` +
        (stale.length ? `. Just crossed: ${stale.slice(0, 2).map((s) => `${s.title.slice(0, 28)} (${s.age}d)`).join(", ")}` : ""),
    );
  // Goals are checked at the moment the summary goes out (Monday morning = how last week ended).
  const goals = goalLine(db, new Date(Date.now() - 12 * 3600_000));
  if (goals) lines.push(goals);
  if (bundle) lines.push(`🎁 Bundle idea: ${bundle.reason}, ${bundle.items.length} items for ${money(bundle.bundlePrice)}`);
  const todo: string[] = [];
  if (inbox) todo.push(`clear ${inbox} Inbox item${inbox === 1 ? "" : "s"}`);
  if (drafts) todo.push(`list ${drafts} draft${drafts === 1 ? "" : "s"}`);
  if (allStale.n) todo.push("drop prices or bundle stale stock");
  if (todo.length) lines.push(`👉 This week: ${todo.join(" · ")}`);

  return {
    title: wk.n ? `FlipDesk weekly: ${money(wk.profit)} profit` : "FlipDesk weekly summary",
    body: lines.join("\n"),
    stats: { sales: wk.n, units: wk.units, revenue: wk.rev, profit: wk.profit, changePct: change, staleCount: allStale.n, inbox, drafts },
  };
}

export async function sendDigest(db: Db, opts: { force?: boolean; now?: Date } = {}) {
  const ws = getSetting<WeeklySettings>(db, "weekly", {});
  const tz = ws.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const now = opts.now ?? new Date();
  const lp = localParts(now, tz);
  const week = isoWeek(lp.ymd);
  if (!opts.force) {
    if (ws.enabled === false) return { sent: false, reason: "disabled" };
    if (lp.dow !== (ws.day ?? 1) || lp.hour < (ws.hour ?? 8)) return { sent: false, reason: "not time yet" };
    if (db.prepare("SELECT 1 FROM digests WHERE week = ?").get(week)) return { sent: false, reason: "already sent" };
  }
  const d = buildDigest(db);
  const pushed = await notify(db, "weekly", d.title, d.body);
  if (!opts.force) db.prepare("INSERT OR IGNORE INTO digests (week, body) VALUES (?, ?)").run(week, `${d.title}\n${d.body}`);
  return { sent: true, pushed, week, ...d, ntfy: Boolean(getSetting<NotifySettings>(db, "notify", {}).ntfyTopic) };
}
