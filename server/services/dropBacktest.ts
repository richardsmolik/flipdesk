/**
 * Price-drop backtest: "would automatic price drops have sold my items sooner, and for how much less?"
 *
 * Replays each rule on items you've already sold. Nobody can know what buyers would really have done, so it uses
 * one plain assumption, shown on screen: the buyer who bought each item would pay what they actually paid, and
 * shows up as long after the price reaches that point as they actually did. So:
 *  - a rule that brings the price down to the sale price sooner sells it sooner, for the rule's price at that time;
 *  - a rule that keeps the price higher for longer sells it later (or not at all, if it never gets there);
 *  - items that sold through an offer below the asking price sell on the same day, for the lower of the two prices.
 * No AI is used: it costs nothing to run.
 */
import type { Db } from "../db.js";
import { getSetting } from "../db.js";
import type { AutoDropRule } from "./ebayTools.js";

export interface DropRule { key: string; name: string; afterDays: number; everyDays: number; dropPct: number; floorPct: number }
export interface DropResult { rule: DropRule; sold: number; unsold: number; avgDays: number | null; avgPrice: number | null; daysSaved: number | null; revenueChange: number; revenueChangePct: number | null }

const DAY = 86400_000;
const t = (s: string) => Date.parse(s.includes("T") ? s : s.replace(" ", "T") + "Z");
const r2 = (n: number) => Math.round(n * 100) / 100;

export function rulesToTest(db: Db): DropRule[] {
  const mine = getSetting<AutoDropRule>(db, "autoDrop", { enabled: false, afterDays: 21, everyDays: 7, dropPct: 5 });
  const rules: DropRule[] = [
    { key: "none", name: "No drops (what you'd get without them)", afterDays: 10000, everyDays: 10000, dropPct: 0, floorPct: 100 },
    { key: "gentle", name: "Gentle: 5% every 14 days after 2 weeks", afterDays: 14, everyDays: 14, dropPct: 5, floorPct: 70 },
    { key: "steady", name: "Steady: 5% every week after 3 weeks", afterDays: 21, everyDays: 7, dropPct: 5, floorPct: 70 },
    { key: "fast", name: "Fast: 10% every week after 1 week", afterDays: 7, everyDays: 7, dropPct: 10, floorPct: 60 },
  ];
  const same = rules.find((r) => r.afterDays === mine.afterDays && r.everyDays === mine.everyDays && r.dropPct === mine.dropPct);
  if (!same) rules.splice(1, 0, { key: "yours", name: `Your setting: ${mine.dropPct}% every ${mine.everyDays} days after ${mine.afterDays} days${mine.enabled ? "" : " (currently off)"}`, afterDays: mine.afterDays, everyDays: mine.everyDays, dropPct: mine.dropPct, floorPct: 70 });
  else same.name = `${same.name} (your setting${mine.enabled ? "" : ", currently off"})`;
  return rules;
}

/** The asking price on day `d` under a rule, starting from `start`, never below the floor. */
export function rulePrice(rule: DropRule, start: number, floor: number, d: number) {
  if (rule.dropPct <= 0 || d < rule.afterDays) return start;
  const drops = 1 + Math.floor((d - rule.afterDays) / rule.everyDays);
  return Math.max(floor, r2(start * Math.pow(1 - rule.dropPct / 100, drops)));
}

interface Sold { start: number; floor: number | null; listed: string; soldAt: string; price: number; changes: { at: string; price: number }[] }

function soldItems(db: Db, limit = 300): Sold[] {
  const rows = db
    .prepare(
      `SELECT i.id, i.price, i.original_price, i.min_price, i.created_at,
        (SELECT MIN(listed_at) FROM listings l WHERE l.item_id = i.id AND l.listed_at IS NOT NULL) AS listed_at,
        (SELECT old_price FROM price_changes p WHERE p.item_id = i.id ORDER BY p.at, p.id LIMIT 1) AS first_price,
        s.sold_at, s.sale_price, s.quantity
       FROM sales s JOIN items i ON i.id = s.item_id
       WHERE s.sale_price > 0 AND s.id = (SELECT MIN(id) FROM sales WHERE item_id = i.id)
       ORDER BY s.sold_at DESC LIMIT ?`,
    )
    .all(limit) as { id: number; price: number; original_price: number | null; min_price: number | null; created_at: string; listed_at: string | null; first_price: number | null; sold_at: string; sale_price: number; quantity: number }[];
  const out: Sold[] = [];
  for (const r of rows) {
    const listed = r.listed_at ?? r.created_at;
    const start = r.first_price ?? r.original_price ?? r.price;
    if (!(start > 0) || t(r.sold_at) < t(listed)) continue;
    const changes = (db.prepare("SELECT at, new_price AS price FROM price_changes WHERE item_id = ? ORDER BY at, id").all(r.id) as { at: string; price: number }[]).filter((c) => t(c.at) <= t(r.sold_at));
    out.push({ start, floor: r.min_price, listed, soldAt: r.sold_at, price: r2(r.sale_price / Math.max(1, r.quantity)), changes });
  }
  return out;
}

/** Replay one item under one rule: the day it would have sold (from listing) and for how much, or null if never. */
export function replay(rule: DropRule, s: Sold): { day: number; price: number } | null {
  const D = Math.max(0, Math.round((t(s.soldAt) - t(s.listed)) / DAY));
  const P = s.price;
  // When did the real asking price first reach the sale price?
  let reached: number | null = s.start <= P + 0.005 ? 0 : null;
  if (reached === null) for (const c of s.changes) if (c.price <= P + 0.005) {
    reached = Math.max(0, Math.round((t(c.at) - t(s.listed)) / DAY));
    break;
  }
  const floor = s.floor ?? r2(s.start * (rule.floorPct / 100));
  if (reached === null) {
    // Sold through an offer below asking: same buyer, same day, for the lower of the offer and the rule's price.
    return { day: D, price: Math.min(P, rulePrice(rule, s.start, floor, D)) };
  }
  const lag = Math.max(0, D - reached);
  for (let d = 0; d <= 365; d++) {
    if (rulePrice(rule, s.start, floor, d) <= P + 0.005) {
      const day = d + lag;
      return { day, price: Math.min(P, rulePrice(rule, s.start, floor, day)) };
    }
  }
  return null; // the rule never brings the price down to what the buyer paid
}

export function dropBacktest(db: Db) {
  const items = soldItems(db);
  const rules = rulesToTest(db);
  const actualRevenue = items.reduce((a, s) => a + s.price, 0);
  const actualDays = items.length ? items.reduce((a, s) => a + Math.max(0, (t(s.soldAt) - t(s.listed)) / DAY), 0) / items.length : null;
  const results: DropResult[] = rules.map((rule) => {
    const sims = items.map((s) => ({ s, r: replay(rule, s) }));
    const sold = sims.filter((x) => x.r);
    const revenue = sold.reduce((a, x) => a + x.r!.price, 0);
    const avgDays = sold.length ? sold.reduce((a, x) => a + x.r!.day, 0) / sold.length : null;
    // Days saved: on the items that sell under both, how much sooner than they really did.
    const both = sold.map((x) => Math.max(0, (t(x.s.soldAt) - t(x.s.listed)) / DAY) - x.r!.day);
    return {
      rule,
      sold: sold.length,
      unsold: items.length - sold.length,
      avgDays: avgDays === null ? null : Math.round(avgDays * 10) / 10,
      avgPrice: sold.length ? r2(revenue / sold.length) : null,
      daysSaved: both.length ? Math.round((both.reduce((a, x) => a + x, 0) / both.length) * 10) / 10 : null,
      revenueChange: r2(revenue - actualRevenue),
      revenueChangePct: actualRevenue ? Math.round(((revenue - actualRevenue) / actualRevenue) * 1000) / 10 : null,
    };
  });
  // Plain-words takeaway: the rule that saves the most time per dollar given up (needs 10+ items).
  let takeaway: string | null = null;
  if (items.length >= 10) {
    const real = results.filter((r) => r.rule.key !== "none" && r.daysSaved !== null && r.unsold <= items.length * 0.1);
    const best = real.sort((a, b) => b.daysSaved! - a.daysSaved!)[0];
    if (best && best.daysSaved! >= 1)
      takeaway = `${best.rule.name.split(":")[0]} would have sold your items about ${best.daysSaved} days sooner on average, for ${Math.abs(best.revenueChangePct ?? 0)}% ${best.revenueChange < 0 ? "less" : "more"} money in total${best.unsold ? ` (and ${best.unsold} item${best.unsold === 1 ? "" : "s"} wouldn't have sold at its floor)` : ""}.`;
    else takeaway = "On your past sales, automatic drops wouldn't have sold things meaningfully sooner.";
  }
  return { items: items.length, actual: { revenue: r2(actualRevenue), avgDays: actualDays === null ? null : Math.round(actualDays * 10) / 10 }, results, takeaway };
}
