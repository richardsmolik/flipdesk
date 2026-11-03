/**
 * Item change history: every change to what buyers see (title, description, price, details), where it was sent,
 * whether each site took it, whether it seemed to help (views and watchers before vs after), and one-tap undo.
 */
import type { Db, Item } from "../db.js";
import { getItem } from "../db.js";
import { MARKETPLACES, type MarketplaceId } from "../marketplaces/registry.js";

const siteName = (m: string) => MARKETPLACES[m as MarketplaceId]?.name ?? m;

export interface Change { field: string; old: unknown; new: unknown }

export function ensureHistory(db: Db) {
  db.exec(`CREATE TABLE IF NOT EXISTS item_changes (id INTEGER PRIMARY KEY, batch TEXT NOT NULL, item_id INTEGER NOT NULL, field TEXT NOT NULL,
    old_value TEXT, new_value TEXT, source TEXT NOT NULL DEFAULT 'edit', stats TEXT, undone_by TEXT, at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE INDEX IF NOT EXISTS item_changes_item ON item_changes(item_id, batch);`);
}

const t = (s: string) => Date.parse(s.includes("T") ? s : s.replace(" ", "T") + "Z");
const DAY = 86400_000;

/** Views and watchers on the live listings right now, and how long they've been up. */
function snapshot(item: Item) {
  const live = item.listings.filter((l) => l.status === "active");
  const first = live.map((l) => l.listed_at).filter((x): x is string => Boolean(x)).map(t);
  return {
    views: live.reduce((a, l) => a + (l.views ?? 0), 0),
    watchers: live.reduce((a, l) => a + (l.watchers ?? 0), 0),
    listedDays: first.length ? Math.max(0, (Date.now() - Math.min(...first)) / DAY) : 0,
    listings: live.map((l) => l.id),
  };
}

/** Save one set of changes (one "batch"). Returns its id, or null if nothing changed. */
export function recordChanges(db: Db, itemId: number, changes: Change[], source = "edit") {
  if (!changes.length) return null;
  ensureHistory(db);
  const item = getItem(db, itemId);
  if (!item) return null;
  const batch = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const stats = JSON.stringify(snapshot(item));
  for (const c of changes)
    db.prepare("INSERT INTO item_changes (batch, item_id, field, old_value, new_value, source, stats) VALUES (?, ?, ?, ?, ?, ?, ?)").run(batch, itemId, c.field, JSON.stringify(c.old ?? null), JSON.stringify(c.new ?? null), source, stats);
  return batch;
}

const show = (v: unknown) => (typeof v === "string" ? v : v === null || v === undefined ? "" : JSON.stringify(v));

/** Did it help? Views/day and watchers before vs after (needs 3+ days after; "early" until 7). */
function impact(item: Item, statsJson: string | null, at: string, soldAt: string | null) {
  if (!statsJson) return null;
  const s = JSON.parse(statsJson) as { views: number; watchers: number; listedDays: number; listings: number[] };
  const days = (Date.now() - t(at)) / DAY;
  const sold = soldAt && t(soldAt) >= t(at) ? (t(soldAt) - t(at)) / DAY : 0;
  if (days < 3 && !sold) return { ready: false as const, days: Math.round(days * 10) / 10 };
  const live = item.listings.filter((l) => s.listings.includes(l.id));
  const viewsNow = live.reduce((a, l) => a + (l.views ?? 0), 0);
  const watchersNow = live.reduce((a, l) => a + (l.watchers ?? 0), 0);
  const before = s.listedDays >= 1 ? s.views / s.listedDays : null;
  const after = days > 0 ? Math.max(0, viewsNow - s.views) / days : null;
  return {
    ready: true as const,
    early: days < 7,
    days: Math.round(days),
    viewsPerDayBefore: before === null ? null : Math.round(before * 10) / 10,
    viewsPerDayAfter: after === null ? null : Math.round(after * 10) / 10,
    changePct: before && after !== null ? Math.round(((after - before) / before) * 100) : null,
    watchersAdded: Math.max(0, watchersNow - s.watchers),
    soldDaysAfter: sold ? Math.round(sold) : null,
  };
}

export interface HistoryEvent {
  kind: "edit" | "drop" | "listed" | "sold";
  at: string;
  batch?: string;
  source?: string;
  title: string;
  changes?: { field: string; old: string; new: string }[];
  pushes?: { marketplace: string; status: string; error: string | null }[];
  impact?: ReturnType<typeof impact>;
  undoneBy?: string | null;
  canUndo?: boolean;
  /** Order within the same second (later changes first). */
  seq?: number;
}

export function itemHistory(db: Db, itemId: number): HistoryEvent[] {
  ensureHistory(db);
  const item = getItem(db, itemId);
  if (!item) return [];
  const soldAt = (db.prepare("SELECT MIN(sold_at) AS s FROM sales WHERE item_id = ?").get(itemId) as { s: string | null }).s;
  const rows = db.prepare("SELECT * FROM item_changes WHERE item_id = ? ORDER BY id").all(itemId) as { id: number; batch: string; field: string; old_value: string; new_value: string; source: string; stats: string | null; undone_by: string | null; at: string }[];
  const jobs = db.prepare("SELECT marketplace, status, result, payload FROM jobs WHERE item_id = ? AND type = 'revise' ORDER BY id").all(itemId) as { marketplace: string; status: string; result: string | null; payload: string | null }[];
  const batches = new Map<string, typeof rows>();
  for (const r of rows) batches.set(r.batch, [...(batches.get(r.batch) ?? []), r]);
  const events: HistoryEvent[] = [];
  for (const [batch, rs] of batches) {
    const first = rs[0];
    const pushes = jobs
      .filter((j) => ((JSON.parse(j.payload ?? "{}") as { batches?: string[] }).batches ?? []).includes(batch))
      .map((j) => ({ marketplace: j.marketplace, status: j.status, error: j.status === "failed" ? ((JSON.parse(j.result ?? "{}") as { error?: string }).error ?? null) : null }));
    // Undo is offered while every field still has the value this change set (nothing changed it since).
    const canUndo = !first.undone_by && rs.every((r) => JSON.stringify((item as unknown as Record<string, unknown>)[r.field] ?? null) === r.new_value);
    events.push({
      kind: "edit",
      at: first.at,
      batch,
      source: first.source,
      title: first.source === "edit" ? "You changed" : first.source.startsWith("undo") ? "Undone" : first.source === "fresh title" ? "Fresh title" : first.source,
      changes: rs.map((r) => {
        const fmt = (v: unknown) => (r.field === "price" && typeof v === "number" ? "$" + v.toFixed(2) : show(v));
        return { field: r.field, old: fmt(JSON.parse(r.old_value)), new: fmt(JSON.parse(r.new_value)) };
      }),
      pushes: pushes.map((p) => ({ ...p, marketplace: siteName(p.marketplace) })),
      impact: impact(item, first.stats, first.at, soldAt),
      undoneBy: first.undone_by,
      canUndo,
      seq: first.id,
    });
  }
  for (const p of db.prepare("SELECT old_price, new_price, reason, at FROM price_changes WHERE item_id = ? AND reason != 'manual'").all(itemId) as { old_price: number; new_price: number; reason: string; at: string }[])
    events.push({ kind: "drop", at: p.at, title: `${p.reason === "auto_drop" ? "Automatic price drop" : p.reason === "smart_drop" ? "Smart price drop" : "Price change"}: $${p.old_price.toFixed(2)} → $${p.new_price.toFixed(2)}` });
  // One line per site (a site with one listing per size shows a count).
  const bySite = new Map<string, { at: string; n: number }>();
  for (const l of item.listings) if (l.listed_at) {
    const cur = bySite.get(l.marketplace);
    bySite.set(l.marketplace, { at: cur && t(cur.at) < t(l.listed_at) ? cur.at : l.listed_at, n: (cur?.n ?? 0) + 1 });
  }
  for (const [m, v] of bySite) events.push({ kind: "listed", at: v.at, title: `Listed on ${siteName(m)}${v.n > 1 ? ` (${v.n} listings)` : ""}` });
  for (const s of db.prepare("SELECT marketplace, sale_price, sold_at FROM sales WHERE item_id = ?").all(itemId) as { marketplace: string; sale_price: number; sold_at: string }[])
    events.push({ kind: "sold", at: s.sold_at, title: `Sold on ${siteName(s.marketplace)} for $${s.sale_price.toFixed(2)}` });
  return events.sort((a, b) => t(b.at) - t(a.at) || (b.seq ?? 0) - (a.seq ?? 0));
}

/** Put a batch's old values back (only fields nothing has changed since). Returns what was restored. */
export function undoBatch(db: Db, itemId: number, batch: string) {
  ensureHistory(db);
  const item = getItem(db, itemId);
  if (!item) throw Object.assign(new Error("Not found"), { status: 404 });
  const rows = db.prepare("SELECT * FROM item_changes WHERE item_id = ? AND batch = ?").all(itemId, batch) as { field: string; old_value: string; new_value: string; undone_by: string | null }[];
  if (!rows.length) throw Object.assign(new Error("No such change"), { status: 404 });
  if (rows[0].undone_by) throw Object.assign(new Error("Already undone"), { status: 400 });
  const restore: Change[] = [];
  const skipped: string[] = [];
  for (const r of rows) {
    const cur = (item as unknown as Record<string, unknown>)[r.field] ?? null;
    if (JSON.stringify(cur) !== r.new_value) skipped.push(r.field);
    else restore.push({ field: r.field, old: cur, new: JSON.parse(r.old_value) });
  }
  return { restore, skipped, mark: (undoBatchId: string) => db.prepare("UPDATE item_changes SET undone_by = ? WHERE item_id = ? AND batch = ?").run(undoBatchId, itemId, batch) };
}
