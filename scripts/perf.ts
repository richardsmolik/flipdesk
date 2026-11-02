/**
 * Speed check: fill a scratch shop with N realistic items (listings on several sites, sales, photos,
 * variations, jobs) and time the API behind every main screen. Usage: npx tsx scripts/perf.ts [items]
 */
import express from "express";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspaces } from "../server/workspaces.js";

export async function fill(db: import("../server/db.js").Db, n: number) {
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

const ENDPOINTS = [
  "/api/items?view=inventory", "/api/items?view=selling", "/api/items?view=unsold", "/api/items?view=drafts", "/api/items?view=sold", "/api/items?q=nike",
  "/api/items-counts", "/api/dashboard", "/api/today", "/api/nav-counts", "/api/reports", "/api/goals", "/api/onboarding", "/api/sales", "/api/shipping",
  "/api/tools/stale", "/api/bundles/suggestions", "/api/alerts", "/api/jobs", "/api/status",
];

export async function timeAll(n: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-perf-"));
  const shops = new Workspaces({ multiuser: false, mainDb: path.join(dir, "f.db"), password: "" });
  await fill(shops.get("main")!.db, n);
  const app = express().use(shops.handler());
  const out: { path: string; ms: number; status: number; bytes: number }[] = [];
  for (const p of ENDPOINTS) {
    const runs: number[] = [];
    let status = 0;
    let bytes = 0;
    for (let k = 0; k < 3; k++) {
      const t = performance.now();
      const r = await request(app).get(p);
      runs.push(performance.now() - t);
      status = r.status;
      bytes = r.text?.length ?? 0;
    }
    runs.sort((a, b) => a - b);
    out.push({ path: p, ms: Math.round(runs[1]), status, bytes });
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

if (process.argv[1]?.endsWith("perf.ts")) {
  const n = Number(process.argv[2]) || 600;
  const rows = await timeAll(n);
  console.log(`\n${n} items`);
  for (const r of rows.sort((a, b) => b.ms - a.ms)) console.log(`${String(r.ms).padStart(6)} ms  ${r.status}  ${(r.bytes / 1024).toFixed(0).padStart(6)} KB  ${r.path}`);
}
