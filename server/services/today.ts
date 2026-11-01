/**
 * "Do these 3 things today": everything that needs you, scored by money at stake and urgency,
 * so the dashboard can show just the top three. Skipped items stay hidden until tomorrow.
 */
import { getSetting, hydrateItem, setSetting, type Db, type ItemRow } from "../db.js";
import { advise, learn } from "./priceAdvice.js";
import { goalProgress, timezoneOf } from "./goals.js";
import { suggestBundles } from "./bundles.js";

export interface Task {
  key: string;
  icon: string;
  title: string;
  why: string;
  href: string;
  score: number;
  action?: { kind: "price"; itemId: number; price: number };
}

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function localDay(db: Db, now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezoneOf(db), year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function candidates(db: Db): Task[] {
  const one = <T>(sql: string) => db.prepare(sql).get() as T;
  const out: Task[] = [];

  const oversell = one<{ n: number; id: number | null }>("SELECT COUNT(*) AS n, MIN(id) AS id FROM alerts WHERE resolved_at IS NULL AND severity = 'critical'");
  if (oversell.n) out.push({ key: "oversell", icon: "🚨", title: `Sort out ${plural(oversell.n, "oversold item")}`, why: "A buyer is waiting. Message them before they open a case.", href: "/inbox", score: 1000 });

  const ship = one<{ n: number; oldest: number | null }>(
    "SELECT COUNT(*) AS n, MAX(CAST(julianday('now') - julianday(sold_at) AS INTEGER)) AS oldest FROM sales WHERE shipped_at IS NULL AND sold_at >= datetime('now','-30 days')",
  );
  if (ship.n)
    out.push({
      key: "ship",
      icon: "📦",
      title: `Ship ${plural(ship.n, "order")}`,
      why: ship.oldest ? `Oldest sold ${plural(ship.oldest, "day")} ago. Late shipping hurts your seller rating.` : "Ship today to keep your seller rating high.",
      href: "/shipping",
      score: 500 + (ship.oldest ?? 0) * 60 + ship.n * 5,
    });

  const inbox = one<{ n: number }>("SELECT COUNT(*) AS n FROM alerts WHERE resolved_at IS NULL AND severity != 'critical'").n;
  if (inbox) out.push({ key: "inbox", icon: "🔔", title: `Clear ${plural(inbox, "Inbox item")}`, why: "Sale emails to confirm and warnings. One tap each.", href: "/inbox", score: 300 + inbox * 10 });

  const failed = one<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE status = 'failed' AND updated_at >= datetime('now','-7 days')").n;
  if (failed) out.push({ key: "failed", icon: "⚠️", title: `Fix ${plural(failed, "failed sync")}`, why: "Something didn't list or delist. An item could sell twice.", href: "/queue", score: 400 + failed * 10 });

  const watchers = one<{ n: number; w: number }>(
    "SELECT COUNT(DISTINCT item_id) AS n, COALESCE(SUM(watchers),0) AS w FROM listings WHERE marketplace = 'ebay' AND status = 'active' AND watchers > 0",
  );
  if (watchers.n)
    out.push({ key: "offers", icon: "💌", title: `Send offers to ${plural(watchers.w, "watcher")}`, why: `${plural(watchers.n, "eBay listing")} with interested buyers. Offers often close the sale.`, href: "/tools", score: 150 + watchers.w * 8 });

  // The single best price move: oldest item the advisor says to drop.
  const model = learn(db);
  const rows = db
    .prepare(
      `SELECT i.* FROM items i WHERE i.status = 'active' AND i.quantity > 0
       AND EXISTS (SELECT 1 FROM listings l WHERE l.item_id = i.id AND l.status = 'active')
       ORDER BY (SELECT MIN(listed_at) FROM listings l WHERE l.item_id = i.id AND l.status = 'active') ASC LIMIT 40`,
    )
    .all() as unknown as ItemRow[];
  for (const r of rows) {
    const it = hydrateItem(db, r);
    const a = advise(db, it, model);
    if ((a.action === "drop" || a.action === "small_drop") && a.newPrice && a.newPrice < it.price) {
      out.push({
        key: `price-${it.id}`,
        icon: "🏷️",
        title: `Drop ${it.title.slice(0, 40) || it.sku} to ${money(a.newPrice)}`,
        why: `Listed ${a.ageDays} days. ${a.reason}`,
        href: `/items/${it.id}`,
        score: 120 + a.ageDays + it.price / 10,
        action: { kind: "price", itemId: it.id, price: a.newPrice },
      });
      break;
    }
  }

  const drafts = one<{ n: number; value: number }>("SELECT COUNT(*) AS n, COALESCE(SUM(price * quantity),0) AS value FROM items WHERE status = 'draft'");
  if (drafts.n)
    out.push({
      key: "drafts",
      icon: "📝",
      title: `Finish and list ${plural(Math.min(drafts.n, 5), "draft")}`,
      why: drafts.value > 0 ? `${money(drafts.value)} of stock not for sale yet.` : "Items sitting in drafts can't sell.",
      href: "/inventory?view=drafts",
      score: 100 + Math.min(drafts.n, 20) * 4 + drafts.value / 50,
    });

  const g = goalProgress(db);
  const behind = g.rows.find((r) => r.status === "behind");
  if (behind) {
    const what = behind.key === "listed" ? `List ${plural(behind.perDay, "item")} today` : behind.key === "sales" ? `Push for ${plural(behind.perDay, "sale")} today` : `Find ${money(behind.perDay)} profit today`;
    out.push({ key: `goal-${behind.key}`, icon: "🎯", title: what, why: `To hit this week's goal (${behind.done} of ${behind.target}, ${g.daysLeft} days left).`, href: behind.key === "listed" ? "/items/new" : "/tools", score: 140 });
  }

  const bundle = suggestBundles(db, 15, 1)[0];
  if (bundle) out.push({ key: "bundle", icon: "🎁", title: `Make a bundle: ${bundle.reason}`, why: `${plural(bundle.items.length, "slow item")} as one lot for ${money(bundle.bundlePrice)}.`, href: "/bundles", score: 60 });

  return out.sort((a, b) => b.score - a.score);
}

export function today(db: Db, limit = 3) {
  const day = localDay(db);
  const skip = getSetting<{ day: string; keys: string[] }>(db, "todaySkipped", { day, keys: [] });
  const skipped = skip.day === day ? skip.keys : [];
  const all = candidates(db).filter((t) => !skipped.includes(t.key));
  return { day, tasks: all.slice(0, limit), more: Math.max(0, all.length - limit) };
}

export function skipToday(db: Db, key: string) {
  const day = localDay(db);
  const skip = getSetting<{ day: string; keys: string[] }>(db, "todaySkipped", { day, keys: [] });
  setSetting(db, "todaySkipped", { day, keys: [...(skip.day === day ? skip.keys : []), key] });
}
