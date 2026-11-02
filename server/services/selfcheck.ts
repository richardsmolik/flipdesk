/**
 * Nightly self-check (on the server, no extra tools): times the main screens on a scratch shop of 800 items,
 * runs SQLite's quick check on every database, checks free disk space and recent failures. Results are kept
 * for 14 nights; anything clearly slower than usual (2x the median and over 300 ms) or broken alerts the owner.
 * The phone-size and full test-suite checks run in GitHub Actions instead (.github/workflows/nightly.yml).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { openDb, type Db } from "../db.js";
import { createApp } from "../app.js";

export async function fill(db: Db, n: number) {
  const mps = ["ebay", "poshmark", "mercari", "depop", "etsy"];
  const cats = ["Clothing > Men", "Clothing > Women", "Shoes", "Electronics", "Home > Kitchen", "Collectibles", "Toys", "Books"];
  const brands = ["Nike", "Patagonia", "Levi's", "Coach", "Sony", "Pyrex", "LEGO", "Carhartt", "Lululemon", "Funko"];
  db.exec("BEGIN");
  for (let i = 0; i < n; i++) {
    const age = (i * 7) % 120;
    const status = i % 9 === 0 ? "draft" : i % 4 === 0 ? "sold" : "active";
    const id = Number(
      db
        .prepare(`INSERT INTO items (sku, title, brand, category, size, cost, price, min_price, quantity, quantity_purchased, status, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?), datetime('now', ?))`)
        .run(`P-${i}`, `${brands[i % 10]} item number ${i} size M`, brands[i % 10], cats[i % 8], ["S", "M", "L"][i % 3], 5 + (i % 30), 20 + (i % 150), 15, status === "sold" ? 0 : 1 + (i % 3), 1 + (i % 3), status, ["Goodwill", "Estate sale"][i % 2], `-${age} days`, `-${age} days`).lastInsertRowid,
    );
    for (let p = 0; p < 4; p++) db.prepare("INSERT INTO photos (item_id, path, position) VALUES (?, ?, ?)").run(id, `/tmp/p-${i}-${p}.jpg`, p);
    if (status !== "draft")
      for (const m of mps.slice(0, 2 + (i % 4)))
        db.prepare("INSERT INTO listings (item_id, marketplace, status, external_id, price, quantity, views, watchers, listed_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, datetime('now', ?))").run(id, m, status === "sold" ? "ended" : "active", `${m}-${id}`, 20 + (i % 150), i % 90, m === "ebay" ? i % 4 : 0, `-${age} days`);
    if (status === "sold" || i % 5 === 0)
      db.prepare("INSERT INTO sales (item_id, marketplace, quantity, order_id, sale_price, shipping_cost, fees, cost, profit, sold_at, shipped_at) VALUES (?, ?, 1, ?, ?, 5, 4, ?, ?, datetime('now', ?), CASE WHEN ? THEN datetime('now') END)").run(id, mps[i % 5], `O-${i}`, 30 + (i % 100), 5 + (i % 30), 15 + (i % 60), `-${i % 60} days`, i % 7 ? 1 : 0);
    if (i % 25 === 0) db.prepare("INSERT INTO jobs (marketplace, type, item_id, status, updated_at) VALUES ('poshmark', 'publish', ?, ?, datetime('now'))").run(id, i % 50 ? "pending" : "failed");
  }
  db.exec("COMMIT");
}


export const SELF_CHECK_PATHS = ["/api/items?view=inventory", "/api/items?view=selling", "/api/items?view=unsold", "/api/items?view=sold", "/api/items-counts", "/api/dashboard", "/api/today", "/api/reports", "/api/sales", "/api/shipping", "/api/tools/stale", "/api/bundles/suggestions", "/api/jobs"];

export async function timeScreens(n = 800) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-selfcheck-"));
  const db = openDb(path.join(dir, "check.db"));
  try {
    await fill(db, n);
    const app = createApp(db, { uploadDir: path.join(dir, "uploads"), password: "" });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as AddressInfo).port;
    const out: { path: string; ms: number; ok: boolean }[] = [];
    try {
      for (const p of SELF_CHECK_PATHS) {
        const runs: number[] = [];
        let ok = true;
        for (let k = 0; k < 3; k++) {
          const t = performance.now();
          const r = await fetch(`http://127.0.0.1:${port}${p}`);
          await r.arrayBuffer();
          runs.push(performance.now() - t);
          ok &&= r.ok;
        }
        out.push({ path: p, ms: Math.round(runs.sort((a, b) => a - b)[1]), ok });
      }
    } finally {
      server.close();
    }
    return out;
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export interface SelfCheck {
  at: string;
  ok: boolean;
  speed: { path: string; ms: number; ok: boolean }[];
  regressions: { path: string; ms: number; usual: number }[];
  databases: { name: string; ok: boolean; detail: string }[];
  disk: { freeGB: number; freePct: number } | null;
  problems: string[];
}

export async function runSelfCheck(opts: { dbs: { name: string; db: Db }[]; dataDir: string; history: SelfCheck[]; items?: number }): Promise<SelfCheck> {
  const problems: string[] = [];
  const speed = await timeScreens(opts.items ?? 800);
  for (const s of speed) if (!s.ok) problems.push(`${s.path} answered with an error`);
  const regressions = findRegressions(speed, opts.history);
  for (const r of regressions) problems.push(`${r.path} is slower than usual (${r.ms} ms, usually ${r.usual} ms)`);
  const databases = opts.dbs.map(({ name, db }) => {
    try {
      const r = (db.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check;
      return { name, ok: r === "ok", detail: r };
    } catch (e) {
      return { name, ok: false, detail: (e as Error).message };
    }
  });
  for (const d of databases) if (!d.ok) problems.push(`Database ${d.name}: ${d.detail}`);
  let disk: SelfCheck["disk"] = null;
  try {
    const st = fs.statfsSync(opts.dataDir);
    const free = st.bavail * st.bsize;
    disk = { freeGB: Math.round((free / 1e9) * 10) / 10, freePct: Math.round((st.bavail / st.blocks) * 100) };
    if (disk.freeGB < 1 || disk.freePct < 10) problems.push(`Disk almost full: ${disk.freeGB} GB (${disk.freePct}%) free`);
  } catch {
    /* statfs not available */
  }
  return { at: new Date().toISOString(), ok: problems.length === 0, speed, regressions, databases, disk, problems };
}

/** Slower than usual = more than twice this screen's median over recent nights (3+ needed), and over 300 ms. */
export function findRegressions(speed: { path: string; ms: number }[], history: { speed: { path: string; ms: number }[] }[]) {
  const out: SelfCheck["regressions"] = [];
  for (const s of speed) {
    const past = history.map((h) => h.speed.find((x) => x.path === s.path)?.ms).filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
    if (past.length < 3) continue;
    const usual = past[Math.floor(past.length / 2)];
    if (s.ms > 300 && s.ms > usual * 2) out.push({ path: s.path, ms: s.ms, usual });
  }
  return out;
}

/** Plain names for the screens behind each API (for reports). */
export const SCREEN_NAMES: Record<string, string> = {
  "/api/items?view=inventory": "Inventory", "/api/items?view=selling": "Selling", "/api/items?view=unsold": "Not sold", "/api/items?view=drafts": "Drafts", "/api/items?view=sold": "Sold",
  "/api/items?q=nike": "Search", "/api/items-counts": "Inventory tabs", "/api/dashboard": "Dashboard", "/api/today": "Today", "/api/nav-counts": "Menu counts", "/api/reports": "Reports",
  "/api/goals": "Goals", "/api/onboarding": "Get started", "/api/sales": "Sales", "/api/shipping": "Shipping", "/api/tools/stale": "Stale listings", "/api/bundles/suggestions": "Bundles",
  "/api/alerts": "Inbox", "/api/jobs": "Queue", "/api/status": "Status",
};
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

export interface SpeedRow { path: string; name: string; now: number; before: number | null; changePct: number | null }
export interface SpeedComparison { rows: SpeedRow[]; now: number; before: number | null; changePct: number | null; slower: SpeedRow[]; faster: SpeedRow[] }

/**
 * Compare two sets of timings screen by screen. "Slower" needs both a real percentage (default +25%) and a
 * real amount of time (default +30 ms), so tiny screens jittering from 4 to 6 ms never count.
 */
export function compareSpeed(now: { path: string; ms: number }[], before: { path: string; ms: number }[] | null, opts: { pct?: number; ms?: number } = {}): SpeedComparison {
  const pct = opts.pct ?? 25;
  const minMs = opts.ms ?? 30;
  const rows = now.map((n) => {
    const b = before?.find((x) => x.path === n.path)?.ms ?? null;
    return { path: n.path, name: SCREEN_NAMES[n.path] ?? n.path, now: n.ms, before: b, changePct: b ? Math.round(((n.ms - b) / Math.max(1, b)) * 100) : null };
  });
  const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
  const both = rows.filter((r) => r.before !== null);
  const nowAvg = avg(rows.map((r) => r.now));
  const beforeAvg = both.length ? avg(both.map((r) => r.before!)) : null;
  const nowBoth = avg(both.map((r) => r.now));
  return {
    rows,
    now: nowAvg,
    before: beforeAvg,
    changePct: beforeAvg ? Math.round(((nowBoth - beforeAvg) / Math.max(1, beforeAvg)) * 100) : null,
    slower: both.filter((r) => r.changePct! >= pct && r.now - r.before! >= minMs).sort((a, b) => b.changePct! - a.changePct!),
    faster: both.filter((r) => r.changePct! <= -pct && r.before! - r.now >= minMs).sort((a, b) => a.changePct! - b.changePct!),
  };
}

/** This week vs last week from the nightly self-checks (median per screen of each week's runs). */
export function speedTrend(history: { at: string; speed: { path: string; ms: number }[] }[], now = Date.now()) {
  const week = (from: number, to: number) => history.filter((h) => {
    const age = now - Date.parse(h.at);
    return age >= from * 86400_000 && age < to * 86400_000;
  });
  const summarize = (runs: typeof history) => {
    const paths = [...new Set(runs.flatMap((r) => r.speed.map((s) => s.path)))];
    return paths.map((p) => ({ path: p, ms: median(runs.map((r) => r.speed.find((s) => s.path === p)?.ms).filter((x): x is number => typeof x === "number"))! }));
  };
  const thisWeek = week(0, 7);
  const lastWeek = week(7, 14);
  if (!thisWeek.length) return null;
  return { ...compareSpeed(summarize(thisWeek), lastWeek.length ? summarize(lastWeek) : null), runs: { now: thisWeek.length, before: lastWeek.length } };
}

/** One line for the weekly report: "⚡ Screens ~42 ms on average (last week 40 ms) · slower: Inventory +60%". */
export function speedLine(t: ReturnType<typeof speedTrend>) {
  if (!t) return null;
  const vs = t.before !== null ? ` (last week ${t.before} ms${t.changePct ? `, ${t.changePct > 0 ? "+" : ""}${t.changePct}%` : ""})` : "";
  const slow = t.slower.length ? ` · slower: ${t.slower.slice(0, 3).map((r) => `${r.name} +${r.changePct}%`).join(", ")}` : "";
  return `⚡ Screens answer in ~${t.now} ms on average${vs}${slow}`;
}
