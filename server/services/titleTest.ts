/**
 * Title A/B test: run title A for N days, then title B for N days, and keep the one that got more views per
 * day (watchers break near-ties). A sale during a phase wins it outright. Each switch goes to every live
 * listing like any other edit (and shows in the item's history). Changing the title yourself stops the test.
 */
import type { Db, Item } from "../db.js";
import { getItem, logActivity } from "../db.js";
import { recordChanges } from "./history.js";
import { queueRevise } from "./jobs.js";

export function ensureTitleTests(db: Db) {
  db.exec(`CREATE TABLE IF NOT EXISTS title_tests (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL, a TEXT NOT NULL, b TEXT NOT NULL, days INTEGER NOT NULL,
    phase TEXT NOT NULL DEFAULT 'a', started_at TEXT NOT NULL, switched_at TEXT, ended_at TEXT, snap TEXT, a_stats TEXT, b_stats TEXT, winner TEXT, note TEXT)`);
}

interface Snap { views: number; watchers: number; sold: number }
interface PhaseStats { days: number; views: number; watchers: number; viewsPerDay: number; sold: boolean }
interface Row { id: number; item_id: number; a: string; b: string; days: number; phase: "a" | "b" | "done"; started_at: string; switched_at: string | null; ended_at: string | null; snap: string | null; a_stats: string | null; b_stats: string | null; winner: string | null; note: string | null }

const DAY = 86400_000;
const snapOf = (db: Db, item: Item): Snap => {
  const live = item.listings.filter((l) => l.status === "active" || l.status === "sold");
  return {
    views: live.reduce((a, l) => a + (l.views ?? 0), 0),
    watchers: live.reduce((a, l) => a + (l.watchers ?? 0), 0),
    sold: (db.prepare("SELECT COUNT(*) AS n FROM sales WHERE item_id = ?").get(item.id) as { n: number }).n,
  };
};
const phaseStats = (from: Snap, to: Snap, ms: number): PhaseStats => {
  const days = Math.max(ms / DAY, 0.01);
  const views = Math.max(0, to.views - from.views);
  return { days: Math.round(days * 10) / 10, views, watchers: Math.max(0, to.watchers - from.watchers), viewsPerDay: Math.round((views / days) * 10) / 10, sold: to.sold > from.sold };
};

function setTitle(db: Db, item: Item, title: string) {
  if (item.title === title) return;
  db.prepare("UPDATE items SET title = ?, updated_at = datetime('now') WHERE id = ?").run(title, item.id);
  const batch = recordChanges(db, item.id, [{ field: "title", old: item.title, new: title }], "title test");
  queueRevise(db, item.id, ["title"], { batch, now: true });
}

const iso = (ms: number) => new Date(ms).toISOString();
const ms = (s: string) => Date.parse(s);

export function startTitleTest(db: Db, itemId: number, b: string, days = 7, now = Date.now()) {
  ensureTitleTests(db);
  const item = getItem(db, itemId);
  if (!item) throw Object.assign(new Error("Not found"), { status: 404 });
  if (!item.listings.some((l) => l.status === "active")) throw Object.assign(new Error("List the item first: a title test needs a live listing to count views."), { status: 400 });
  if (db.prepare("SELECT 1 FROM title_tests WHERE item_id = ? AND phase != 'done'").get(itemId)) throw Object.assign(new Error("A title test is already running for this item."), { status: 400 });
  const title = b.trim();
  if (title.toLowerCase() === item.title.trim().toLowerCase()) throw Object.assign(new Error("Title B is the same as the current title."), { status: 400 });
  db.prepare("INSERT INTO title_tests (item_id, a, b, days, phase, started_at, snap) VALUES (?, ?, ?, ?, 'a', ?, ?)").run(itemId, item.title, title, days, iso(now), JSON.stringify(snapOf(db, item)));
  logActivity(db, "title-test", `Title test started: A for ${days} days, then B`, itemId);
  return titleTestFor(db, itemId, now);
}

function finish(db: Db, t: Row, item: Item, winner: "a" | "b" | null, note: string, bStats: PhaseStats | null, now: number) {
  const keep = winner === "b" ? t.b : t.a;
  if (item.status !== "sold") setTitle(db, item, keep);
  db.prepare("UPDATE title_tests SET phase = 'done', ended_at = ?, winner = ?, note = ?, b_stats = COALESCE(?, b_stats) WHERE id = ?").run(iso(now), winner, note, bStats ? JSON.stringify(bStats) : null, t.id);
  logActivity(db, "title-test", `Title test finished: ${note}`, t.item_id);
}

/** Move running tests along: switch A → B after N days, pick the winner after another N. */
export function titleTestsTick(db: Db, now = Date.now()) {
  ensureTitleTests(db);
  let moved = 0;
  for (const t of db.prepare("SELECT * FROM title_tests WHERE phase != 'done'").all() as unknown as Row[]) {
    const item = getItem(db, t.item_id);
    if (!item) {
      db.prepare("UPDATE title_tests SET phase = 'done', ended_at = ?, note = 'item deleted' WHERE id = ?").run(iso(now), t.id);
      continue;
    }
    const expected = t.phase === "a" ? t.a : t.b;
    const snap = JSON.parse(t.snap ?? "{}") as Snap;
    const cur = snapOf(db, item);
    const since = ms(t.phase === "a" ? t.started_at : t.switched_at!);
    const stats = phaseStats(snap, cur, now - since);
    if (item.title !== expected) {
      db.prepare("UPDATE title_tests SET phase = 'done', ended_at = ?, note = ? WHERE id = ?").run(iso(now), "You changed the title yourself, so the test stopped.", t.id);
      moved++;
      continue;
    }
    if (stats.sold) {
      // A sale settles it.
      if (t.phase === "a") db.prepare("UPDATE title_tests SET a_stats = ? WHERE id = ?").run(JSON.stringify(stats), t.id);
      finish(db, t, item, t.phase as "a" | "b", `It sold with title ${t.phase.toUpperCase()}.`, t.phase === "b" ? stats : null, now);
      moved++;
      continue;
    }
    if (now - since < t.days * DAY) continue;
    if (t.phase === "a") {
      db.prepare("UPDATE title_tests SET phase = 'b', switched_at = ?, a_stats = ?, snap = ? WHERE id = ?").run(iso(now), JSON.stringify(stats), JSON.stringify(cur), t.id);
      setTitle(db, item, t.b);
      logActivity(db, "title-test", `Title test: switched to title B for ${t.days} days`, t.item_id);
    } else {
      const a = JSON.parse(t.a_stats ?? "{}") as PhaseStats;
      const b = stats;
      let winner: "a" | "b" | null;
      let note: string;
      if (!a.views && !b.views) (winner = null), (note = "No views came in for either title, so we couldn't tell. Kept title A.");
      else {
        const diff = a.viewsPerDay ? (b.viewsPerDay - a.viewsPerDay) / a.viewsPerDay : 1;
        if (Math.abs(diff) < 0.1) winner = b.watchers > a.watchers ? "b" : "a";
        else winner = diff > 0 ? "b" : "a";
        const w = winner === "b" ? b : a;
        const l = winner === "b" ? a : b;
        note = Math.abs(diff) < 0.1
          ? `About the same views (${a.viewsPerDay} vs ${b.viewsPerDay}/day); kept ${winner.toUpperCase()} for its watchers.`
          : `Title ${winner.toUpperCase()} won: ${w.viewsPerDay} views/day vs ${l.viewsPerDay}/day.`;
      }
      finish(db, t, item, winner, note, b, now);
    }
    moved++;
  }
  return moved;
}

export function stopTitleTest(db: Db, itemId: number, keep: "a" | "b" = "a", now = Date.now()) {
  ensureTitleTests(db);
  const t = db.prepare("SELECT * FROM title_tests WHERE item_id = ? AND phase != 'done'").get(itemId) as unknown as Row | undefined;
  if (!t) throw Object.assign(new Error("No title test running."), { status: 404 });
  const item = getItem(db, itemId)!;
  finish(db, t, item, null, `Stopped early; kept title ${keep.toUpperCase()}.`, null, now);
  if (keep === "b") {
    setTitle(db, getItem(db, itemId)!, t.b);
    db.prepare("UPDATE title_tests SET winner = 'b' WHERE id = ?").run(t.id);
  }
  return titleTestFor(db, itemId, now);
}

/** The item's latest test, with numbers so far. */
export function titleTestFor(db: Db, itemId: number, now = Date.now()) {
  ensureTitleTests(db);
  const t = db.prepare("SELECT * FROM title_tests WHERE item_id = ? ORDER BY id DESC LIMIT 1").get(itemId) as unknown as Row | undefined;
  if (!t) return null;
  const item = getItem(db, itemId);
  const a = t.a_stats ? (JSON.parse(t.a_stats) as PhaseStats) : null;
  let b = t.b_stats ? (JSON.parse(t.b_stats) as PhaseStats) : null;
  let soFar: PhaseStats | null = null;
  if (t.phase !== "done" && item) {
    soFar = phaseStats(JSON.parse(t.snap ?? "{}") as Snap, snapOf(db, item), now - ms(t.phase === "a" ? t.started_at : t.switched_at!));
    if (t.phase === "b") b = soFar;
  }
  const phaseStart = t.phase === "b" ? t.switched_at! : t.started_at;
  return {
    id: t.id,
    a: t.a,
    b: t.b,
    days: t.days,
    phase: t.phase,
    startedAt: t.started_at,
    nextAt: t.phase === "done" ? null : iso(ms(phaseStart) + t.days * DAY),
    aStats: t.phase === "a" ? soFar : a,
    bStats: b,
    winner: t.winner,
    note: t.note,
    endedAt: t.ended_at,
  };
}
