/**
 * Try this version of FlipDesk on a copy of your real data before deploying it.
 * Usage: npx tsx scripts/rehearse.ts <backup.zip | data folder>
 * (Settings → Backups → Download gives you the zip.) Nothing you pass in is changed: everything is copied to a
 * scratch folder first. For every shop it runs the update (tried on a copy first, like the server does), checks
 * nothing was lost, then opens every main screen against the updated data and times it. Exit code 1 = don't deploy.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import request from "supertest";
import { openDb, SCHEMA_VERSION } from "../server/db.js";
import { createApp } from "../server/app.js";
import { SELF_CHECK_PATHS } from "../server/services/selfcheck.js";
import { extractEntry, zipEntries } from "../server/services/zip.js";
import { Workspaces } from "../server/workspaces.js";

export interface ShopResult { name: string; from: number; to: number; items: [number, number]; sales: [number, number]; screens: { path: string; status: number; ms: number }[]; problems: string[] }

function copyIn(src: string, tmp: string) {
  const dbs: string[] = [];
  if (fs.statSync(src).isDirectory()) {
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          if (!["uploads", "backups", "before-update"].includes(e.name)) walk(p);
        } else if (e.name.endsWith(".db")) {
          const out = path.join(tmp, path.relative(src, p));
          fs.mkdirSync(path.dirname(out), { recursive: true });
          // a consistent snapshot even if FlipDesk is running on that folder
          const db = new DatabaseSync(p, { readOnly: true });
          db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
          db.close();
          dbs.push(out);
        }
      }
    };
    walk(src);
  } else {
    for (const e of zipEntries(src).filter((x) => x.name.endsWith(".db"))) {
      const out = path.join(tmp, e.name);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, extractEntry(src, e));
      dbs.push(out);
    }
  }
  return dbs;
}

const count = (db: DatabaseSync, t: string) => {
  try {
    return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
  } catch {
    return 0;
  }
};

export async function rehearse(src: string) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fd-rehearse-"));
  const shops: ShopResult[] = [];
  const problems: string[] = [];
  try {
    const dbs = copyIn(src, tmp);
    for (const file of dbs) {
      const name = path.relative(tmp, file);
      if (/(^|\/)(accounts|site)\.db$/.test(name)) continue;
      const raw = new DatabaseSync(file, { readOnly: true });
      const isShop = Boolean(raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'items'").get());
      const from = (raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version || 1;
      const before: [number, number] = [count(raw, "items"), count(raw, "sales")];
      raw.close();
      if (!isShop) continue;
      const r: ShopResult = { name, from, to: SCHEMA_VERSION, items: [before[0], 0], sales: [before[1], 0], screens: [], problems: [] };
      shops.push(r);
      let db;
      try {
        db = openDb(file); // runs the update (tried on a copy first)
      } catch (e) {
        r.problems.push((e as Error).message);
        continue;
      }
      r.items[1] = count(db, "items");
      r.sales[1] = count(db, "sales");
      if (r.items[1] < r.items[0]) r.problems.push(`items ${r.items[0]} → ${r.items[1]}`);
      if (r.sales[1] < r.sales[0]) r.problems.push(`sales ${r.sales[0]} → ${r.sales[1]}`);
      const app = express().use(createApp(db, { uploadDir: path.join(tmp, "uploads-scratch"), password: "" }));
      for (const p of SELF_CHECK_PATHS) {
        const t = performance.now();
        const res = await request(app).get(p);
        const ms = Math.round(performance.now() - t);
        r.screens.push({ path: p, status: res.status, ms });
        if (res.status >= 400) r.problems.push(`${p} answered ${res.status}`);
      }
      db.close();
    }
    // Server-wide files (sign-ins, settings) open with this version too.
    const accounts = dbs.find((f) => f.endsWith("accounts.db"));
    const site = dbs.find((f) => f.endsWith("site.db"));
    if (accounts || site) {
      try {
        const dir = path.dirname(accounts ?? site!);
        const w = new Workspaces({ multiuser: Boolean(accounts), dataDir: dir, mainDb: path.join(dir, "__none__", "flipdesk.db"), password: "x" });
        w.site.prepare("SELECT COUNT(*) FROM site_settings").get();
        if (w.accounts) w.accounts.prepare("SELECT COUNT(*) FROM users").get();
      } catch (e) {
        problems.push(`accounts/site: ${(e as Error).message}`);
      }
    }
    if (!shops.length) problems.push("No shops found in that backup or folder.");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const ok = !problems.length && shops.every((s) => !s.problems.length);
  return { ok, shops, problems };
}

if (process.argv[1]?.endsWith("rehearse.ts")) {
  const src = process.argv[2];
  if (!src || !fs.existsSync(src)) {
    console.error("Usage: npx tsx scripts/rehearse.ts <backup.zip | data folder>");
    process.exit(2);
  }
  const r = await rehearse(src);
  for (const s of r.shops) {
    const slow = [...s.screens].sort((a, b) => b.ms - a.ms)[0];
    console.log(`${s.problems.length ? "✕" : "✓"} ${s.name}: v${s.from} → v${s.to} · items ${s.items[0]} → ${s.items[1]} · sales ${s.sales[0]} → ${s.sales[1]} · ${s.screens.length} screens OK${slow ? `, slowest ${slow.ms} ms (${slow.path})` : ""}`);
    for (const p of s.problems) console.log(`    ↳ ${p}`);
  }
  for (const p of r.problems) console.log(`✕ ${p}`);
  console.log(r.ok ? "\n✅ Safe to deploy: this version updates your data without losing anything and every screen works." : "\n🔴 Don't deploy this version yet.");
  process.exitCode = r.ok ? 0 : 1;
}
