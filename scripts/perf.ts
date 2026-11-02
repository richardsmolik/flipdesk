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
import { fill } from "../server/services/selfcheck.js";
export { fill };

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
