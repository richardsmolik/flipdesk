/**
 * Speed check: fill a scratch shop with N realistic items (listings on several sites, sales, photos,
 * variations, jobs) and time the API behind every main screen.
 * Usage: npx tsx scripts/perf.ts [items] [--save results.json] [--compare previous.json]
 * With --compare it prints a before/after table (and adds it to the GitHub run summary in CI).
 */
import express from "express";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspaces } from "../server/workspaces.js";
import { compareSpeed, fill } from "../server/services/selfcheck.js";
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
  const args = process.argv.slice(2);
  const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const n = Number(args.find((a) => /^\d+$/.test(a))) || 600;
  const rows = await timeAll(n);
  console.log(`\n${n} items`);
  for (const r of [...rows].sort((a, b) => b.ms - a.ms)) console.log(`${String(r.ms).padStart(6)} ms  ${r.status}  ${(r.bytes / 1024).toFixed(0).padStart(6)} KB  ${r.path}`);
  const prevFile = flag("--compare");
  const prev = prevFile && fs.existsSync(prevFile) ? (JSON.parse(fs.readFileSync(prevFile, "utf8")) as { at: string; items: number; rows: { path: string; ms: number }[] }) : null;
  // CI machines vary, so only big changes count there: +50% and +50 ms.
  const c = compareSpeed(rows, prev?.items === n ? prev.rows : null, { pct: 50, ms: 50 });
  const md = [
    `### ⚡ Speed (${n} items)${prev ? ` vs ${prev.at.slice(0, 10)}` : ""}`,
    "",
    c.before !== null ? `Average **${c.now} ms** (before ${c.before} ms, ${c.changePct! > 0 ? "+" : ""}${c.changePct}%). ${c.slower.length ? `▲ **${c.slower.length} slower:** ${c.slower.map((r) => `${r.name} +${r.changePct}%`).join(", ")}` : "✓ Nothing got clearly slower."}` : `Average **${c.now} ms**. (No earlier run to compare with yet.)`,
    "",
    "| Screen | Now | Before | Change |",
    "|---|---:|---:|---:|",
    ...[...c.rows].sort((a, b) => b.now - a.now).map((r) => `| ${r.name} | ${r.now} ms | ${r.before ?? "-"}${r.before !== null ? " ms" : ""} | ${r.changePct === null ? "new" : `${c.slower.includes(r) ? "▲ " : c.faster.includes(r) ? "▼ " : ""}${r.changePct > 0 ? "+" : ""}${r.changePct}%`} |`),
  ].join("\n");
  if (prevFile) console.log(`\n${md}`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
  for (const r of c.slower) if (process.env.GITHUB_ACTIONS) console.log(`::warning title=Slower screen::${r.name} (${r.path}) took ${r.now} ms, was ${r.before} ms (+${r.changePct}%)`);
  const save = flag("--save");
  if (save) {
    fs.mkdirSync(path.dirname(path.resolve(save)), { recursive: true });
    fs.writeFileSync(save, JSON.stringify({ at: new Date().toISOString(), items: n, rows: rows.map(({ path: p, ms }) => ({ path: p, ms })) }, null, 1));
  }
}
