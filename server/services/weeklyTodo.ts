/**
 * "This week: do these 5 things." One short list from everything FlipDesk knows, most valuable first:
 * orders to ship, failed listings, prices the AIs disagree on, suggested drops, old listings that need a fresh
 * title, problem reports waiting. Shown on the dashboard and in the Monday summary.
 */
import type { Db } from "../db.js";
import { getItem, getSetting } from "../db.js";
import { advise, learn } from "./priceAdvice.js";
import { staleItems, type PriceWhy } from "./aiInsights.js";
import { failedUpdates } from "./jobs.js";

export interface Todo { kind: string; title: string; detail: string; href: string; priority: number }

const money = (n: number) => `$${n.toFixed(2)}`;

export function weeklyTodo(db: Db, limit = 5): Todo[] {
  const out: Todo[] = [];
  const one = <T>(sql: string, ...a: (string | number)[]) => db.prepare(sql).get(...a) as T;

  // 1. Orders waiting to ship (oldest first): late shipping hurts seller ratings.
  const ship = one<{ n: number; oldest: string | null }>("SELECT COUNT(*) AS n, MIN(sold_at) AS oldest FROM sales WHERE shipped_at IS NULL AND sold_at >= datetime('now','-30 days')");
  if (ship.n) out.push({ kind: "ship", title: `Ship ${ship.n} order${ship.n === 1 ? "" : "s"}`, detail: ship.oldest ? `Oldest sold ${ship.oldest.slice(0, 10)}` : "", href: "/shipping", priority: 100 });

  // 2. Listings that failed to post or update.
  const failed = one<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE status = 'failed' AND type NOT IN ('revise', 'update') AND updated_at >= datetime('now','-14 days')");
  const upd = failedUpdates(db).length;
  const publish = failed.n;
  if (upd) out.push({ kind: "failed-update", title: `Retry ${upd} update${upd === 1 ? "" : "s"} that didn't reach a live listing`, detail: "The listing still shows the old details", href: "/#failed-updates", priority: 92 });
  if (publish) out.push({ kind: "failed", title: `Fix ${publish} listing${publish === 1 ? "" : "s"} that didn't go through`, detail: "See the reason and retry", href: "/queue", priority: 90 });

  // 3. Prices the AIs disagreed on (still for sale).
  const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'priceWhy.%'").all() as { key: string; value: string }[];
  for (const r of rows) {
    const w = JSON.parse(r.value) as PriceWhy;
    if (!w.secondOpinion || w.secondOpinion.agree) continue;
    const item = getItem(db, Number(r.key.split(".")[1]));
    if (!item || !["active", "draft"].includes(item.status)) continue;
    out.push({ kind: "price-check", title: `Check the price of “${item.title.slice(0, 40)}”`, detail: `${money(item.price)} now; ${w.secondOpinion.name} said ${money(w.secondOpinion.price)} (${w.secondOpinion.diffPct}% apart)`, href: `/items/${item.id}`, priority: 80 });
  }

  // 4. Suggested price drops (from your own sales history), biggest first. Skipped when automatic drops are on.
  if (!getSetting<{ enabled?: boolean }>(db, "autoDrop", {}).enabled) {
    const model = learn(db);
    const active = db.prepare("SELECT id FROM items WHERE status = 'active' ORDER BY created_at LIMIT 40").all() as { id: number }[];
    const drops = active
      .map((a) => getItem(db, a.id)!)
      .filter(Boolean)
      .map((item) => ({ item, a: advise(db, item, model) }))
      .filter((x) => (x.a.action === "drop" || x.a.action === "small_drop") && x.a.newPrice)
      .sort((x, y) => y.a.pct - x.a.pct)
      .slice(0, 2);
    for (const { item, a } of drops) out.push({ kind: "drop", title: `Drop “${item.title.slice(0, 40)}” to ${money(a.newPrice!)}`, detail: a.reason, href: `/items/${item.id}`, priority: 70 });
  }

  // 5. Old listings: a fresh title (oldest first, not refreshed in the last 30 days).
  const stale = staleItems(db, 30, 20).filter((s) => !s.rewritten_at || Date.now() - Date.parse(s.rewritten_at.replace(" ", "T") + "Z") > 30 * 86400_000);
  for (const s of stale.slice(0, 2)) out.push({ kind: "fresh-title", title: `Refresh the title of “${s.title.slice(0, 40)}”`, detail: `Listed ${s.days} days without a sale`, href: `/items/${s.id}`, priority: 60 });

  // 6. Problem reports nobody sent yet.
  try {
    const p = one<{ n: number }>("SELECT COUNT(*) AS n FROM problem_reports WHERE sent_at IS NULL AND created_at >= datetime('now','-30 days')");
    if (p.n) out.push({ kind: "report", title: `Send ${p.n} problem report${p.n === 1 ? "" : "s"}`, detail: "So they can be fixed", href: "/inbox", priority: 40 });
  } catch {
    /* no reports table yet */
  }

  // 7. Drafts waiting to be listed.
  const drafts = one<{ n: number }>("SELECT COUNT(*) AS n FROM items WHERE status = 'draft' AND title != ''");
  if (drafts.n) out.push({ kind: "drafts", title: `List ${drafts.n} draft${drafts.n === 1 ? "" : "s"}`, detail: "Written but not posted yet", href: "/inventory?view=drafts", priority: 50 });

  return out.sort((a, b) => b.priority - a.priority).slice(0, limit);
}
