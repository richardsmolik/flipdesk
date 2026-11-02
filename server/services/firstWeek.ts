/**
 * "Your first week": a 7-day plan of small habits (docs/FIRST_WEEK.md) that ticks itself off from real activity.
 * Shown on the dashboard for the first 10 days, one highlighted step per day.
 */
import { getSetting, setSetting, type Db } from "../db.js";
import type { NotifySettings } from "./alerts.js";

export const FIRST_WEEK = [
  { day: 1, key: "items", title: "Add 5 items", how: "Shoot on your phone or New listing; let the AI write them.", href: "/shoot" },
  { day: 2, key: "crosslist", title: "Crosslist them to 3+ sites", how: "Open an item, tick the sites, Crosslist.", href: "/inventory" },
  { day: 3, key: "alerts", title: "Turn on phone alerts", how: "Free ntfy app + Settings → Phone notifications.", href: "/settings" },
  { day: 4, key: "goal", title: "Set a weekly goal", how: "Dashboard → This week's goals.", href: "/" },
  { day: 5, key: "bundle", title: "Make a bundle", how: "Bundles suggests lots of slow items.", href: "/bundles" },
  { day: 6, key: "move", title: "Move a slow item", how: "Send an offer or take a suggested price drop.", href: "/tools" },
  { day: 7, key: "numbers", title: "Look at your numbers", how: "Reports: what sells, where, and what to buy more of.", href: "/reports" },
];

export function startFirstWeek(db: Db) {
  if (!getSetting<string | null>(db, "firstWeekStart", null)) setSetting(db, "firstWeekStart", new Date().toISOString());
}

export function firstWeek(db: Db, now = new Date()) {
  const start = getSetting<string | null>(db, "firstWeekStart", null);
  if (!start) return { show: false as const };
  const dayNum = Math.floor((now.getTime() - Date.parse(start)) / 86400_000) + 1;
  const n = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
  const has = (table: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(table));
  const done: Record<string, boolean> = {
    items: n("SELECT COUNT(*) AS n FROM items") >= 5,
    crosslist: n("SELECT COUNT(*) AS n FROM (SELECT item_id FROM listings WHERE status IN ('active','sold') GROUP BY item_id HAVING COUNT(*) >= 3)") >= 1,
    alerts: Boolean(getSetting<NotifySettings>(db, "notify", {}).ntfyTopic),
    goal: Object.keys(getSetting<Record<string, number>>(db, "goals", {})).length > 0,
    bundle: has("bundle_items") && n("SELECT COUNT(*) AS n FROM bundle_items") > 0,
    move: has("price_changes") && n("SELECT COUNT(*) AS n FROM price_changes") > 0,
    numbers: Boolean(getSetting(db, "reportsViewed", false)),
  };
  const steps = FIRST_WEEK.map((s) => ({ ...s, done: done[s.key] ?? false }));
  const hidden = Boolean(getSetting(db, "firstWeekHidden", false));
  const doneCount = steps.filter((s) => s.done).length;
  // Today's step: the first unfinished one up to today's day number (catch-up first), else the next one.
  const today = steps.find((s) => !s.done && s.day <= Math.min(7, dayNum)) ?? steps.find((s) => !s.done) ?? null;
  return { show: !hidden && dayNum <= 10 && doneCount < 7, day: Math.min(7, dayNum), dayNum, steps, today, doneCount, hidden };
}
