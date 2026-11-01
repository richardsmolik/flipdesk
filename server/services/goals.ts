/** Weekly goals ("list 30 items, profit $500") with pace: are you ahead or behind for this point in the week? */
import { getSetting, setSetting, type Db } from "../db.js";
import type { WeeklySettings } from "./digest.js";

export interface Goals {
  listed?: number; // items listed for the first time this week
  sales?: number; // units sold
  profit?: number; // $
}

export const sqlTime = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19);

/** Monday 00:00 in your time zone, as a UTC Date. */
export function weekStart(tz: string, now = new Date()) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, weekday: "short" });
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  const dow = (["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday) + 6) % 7; // Mon=0
  // Local wall-clock -> offset from UTC for this moment.
  const localAsUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  const offset = localAsUtc - Math.floor(now.getTime() / 1000) * 1000;
  const localMidnight = Date.UTC(+p.year, +p.month - 1, +p.day) - dow * 86400_000;
  return new Date(localMidnight - offset);
}

export const timezoneOf = (db: Db) => getSetting<WeeklySettings>(db, "weekly", {}).timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export function getGoals(db: Db): Goals {
  return getSetting<Goals>(db, "goals", {});
}

export function saveGoals(db: Db, g: Goals) {
  const clean: Goals = {};
  for (const k of ["listed", "sales", "profit"] as const) if (g[k] !== undefined && g[k]! > 0) clean[k] = Math.round(g[k]!);
  setSetting(db, "goals", clean);
  return clean;
}

export function goalProgress(db: Db, now = new Date()) {
  const goals = getGoals(db);
  const start = weekStart(timezoneOf(db), now);
  const s = sqlTime(start);
  const n = (sql: string) => Number((db.prepare(sql).get(s) as { n: number }).n);
  const actual = {
    listed: n("SELECT COUNT(*) AS n FROM (SELECT item_id FROM listings WHERE listed_at IS NOT NULL GROUP BY item_id HAVING MIN(listed_at) >= ?)"),
    sales: n("SELECT COALESCE(SUM(quantity),0) AS n FROM sales WHERE sold_at >= ?"),
    profit: Math.round(n("SELECT COALESCE(SUM(profit),0) AS n FROM sales WHERE sold_at >= ?") * 100) / 100,
  };
  const elapsed = Math.min(1, Math.max(0, (now.getTime() - start.getTime()) / (7 * 86400_000)));
  const daysLeft = Math.max(0, Math.ceil(7 - elapsed * 7));
  const rows = (Object.keys(actual) as (keyof typeof actual)[])
    .filter((k) => goals[k])
    .map((k) => {
      const target = goals[k]!;
      const done = actual[k];
      const expected = target * elapsed;
      const status = done >= target ? "done" : done >= expected * 0.9 ? "on_track" : "behind";
      const left = Math.max(0, target - done);
      return { key: k, target, done, pct: Math.min(100, Math.round((done / target) * 100)), status, left, perDay: daysLeft ? Math.ceil(left / daysLeft) : left };
    });
  return { goals, weekStart: s, daysLeft, elapsedPct: Math.round(elapsed * 100), rows, actual };
}

const fmt = (k: string, v: number) => (k === "profit" ? `$${Math.round(v).toLocaleString("en-US")}` : String(v));
const LABEL: Record<string, string> = { listed: "listed", sales: "sold", profit: "profit" };

/** One line for the weekly summary: last week's result vs goals. */
export function goalLine(db: Db, now = new Date()) {
  const p = goalProgress(db, now);
  if (!p.rows.length) return null;
  return "🎯 Goals: " + p.rows.map((r) => `${fmt(r.key, r.done)}/${fmt(r.key, r.target)} ${LABEL[r.key]}${r.status === "done" ? " ✅" : ""}`).join(" · ");
}
