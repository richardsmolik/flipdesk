/**
 * Fire drill: "if the server died tonight, how long until we're back, and would it work?"
 * Takes a backup (default: the newest), and in a scratch folder does what a real recovery does:
 * unpack everything (databases and every photo), open each shop with this version of FlipDesk (updating it if
 * needed), open every main screen against it, and count what's there. Times each step and estimates the whole
 * recovery, including downloading the backup from cloud storage. Nothing real is touched.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { openDb } from "../db.js";
import { createApp } from "../app.js";
import { SELF_CHECK_PATHS } from "./selfcheck.js";
import { extractEntry, zipEntries } from "./zip.js";

export interface DrillStep { name: string; ms: number; ok: boolean; detail: string }
export interface FireDrill { at: string; backup: string; ok: boolean; steps: DrillStep[]; shops: { name: string; items: number; sales: number; photos: number }[]; problems: string[]; bytes: number; minutes: number; estimate: string }

/** A cloud download at a modest 10 MB/s, plus 3 minutes to start a new server and point it at the files. */
const DOWNLOAD_BPS = 10e6;
const SETUP_MS = 3 * 60_000;

export async function fireDrill(file: string): Promise<FireDrill> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fd-drill-"));
  const steps: DrillStep[] = [];
  const problems: string[] = [];
  const shops: FireDrill["shops"] = [];
  const bytes = fs.statSync(file).size;
  const step = async <T>(name: string, fn: () => Promise<T> | T, detail: (r: T) => string) => {
    const t = performance.now();
    try {
      const r = await fn();
      steps.push({ name, ms: Math.round(performance.now() - t), ok: true, detail: detail(r) });
      return r;
    } catch (e) {
      steps.push({ name, ms: Math.round(performance.now() - t), ok: false, detail: (e as Error).message });
      problems.push(`${name}: ${(e as Error).message}`);
      return null;
    }
  };
  try {
    const unpacked = await step(
      "Unpack the backup (databases and every photo)",
      () => {
        let photos = 0;
        let dbs = 0;
        for (const e of zipEntries(file)) {
          if (e.name.endsWith("/")) continue;
          const out = path.join(tmp, e.name);
          if (!out.startsWith(tmp + path.sep)) throw new Error(`unsafe path in backup: ${e.name}`);
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, extractEntry(file, e));
          if (e.name.endsWith(".db")) dbs++;
          else if (e.name.includes("/uploads/")) photos++;
        }
        if (!dbs) throw new Error("no databases in this backup");
        return { photos, dbs };
      },
      (r) => `${r.dbs} databases, ${r.photos} photos`,
    );
    if (unpacked) {
      const dbFiles: string[] = [];
      const walk = (d: string) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? e.name !== "uploads" && walk(path.join(d, e.name)) : e.name.endsWith(".db") && dbFiles.push(path.join(d, e.name))));
      walk(tmp);
      const shopFiles = dbFiles.filter((f) => {
        const d = new DatabaseSync(f, { readOnly: true });
        try {
          return Boolean(d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'items'").get());
        } finally {
          d.close();
        }
      });
      const opened = await step(
        "Open every shop with this version",
        () =>
          shopFiles.map((f) => {
            const db = openDb(f);
            const n = (t: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
            const name = path.relative(tmp, f).replace(/\/?flipdesk\.db$/, "") || "shop";
            shops.push({ name, items: n("items"), sales: n("sales"), photos: n("photos") });
            return { db, dir: path.dirname(f) };
          }),
        (r) => `${r.length} shop${r.length === 1 ? "" : "s"}, ${shops.reduce((a, s) => a + s.items, 0)} items, ${shops.reduce((a, s) => a + s.sales, 0)} sales`,
      );
      if (opened) {
        await step(
          "Open every main screen",
          async () => {
            let n = 0;
            for (const { db, dir } of opened) {
              const server = createApp(db, { uploadDir: path.join(dir, "uploads"), password: "" }).listen(0, "127.0.0.1");
              await new Promise((r) => server.once("listening", r));
              const port = (server.address() as AddressInfo).port;
              try {
                for (const p of SELF_CHECK_PATHS) {
                  const r = await fetch(`http://127.0.0.1:${port}${p}`);
                  await r.arrayBuffer();
                  if (!r.ok) throw new Error(`${p} answered ${r.status}`);
                  n++;
                }
              } finally {
                server.close();
                db.close();
              }
            }
            return n;
          },
          (n) => `${n} screens answered`,
        );
        // Photos the shops point at should all be in the backup.
        await step(
          "Photos the listings use are all there",
          () => {
            let missing = 0;
            let checked = 0;
            for (const f of shopFiles) {
              const have = new Set<string>();
              const up = path.join(path.dirname(f), "uploads");
              const walk = (d: string) => fs.existsSync(d) && fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : have.add(e.name)));
              walk(up);
              const d = new DatabaseSync(f, { readOnly: true });
              for (const r of d.prepare("SELECT path FROM photos LIMIT 2000").all() as { path: string }[]) {
                if (/^https?:/.test(r.path)) continue;
                checked++;
                if (!have.has(path.basename(r.path))) missing++;
              }
              d.close();
            }
            if (missing) throw new Error(`${missing} of ${checked} photos aren't in the backup`);
            return checked;
          },
          (n) => `${n} checked`,
        );
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const workMs = steps.reduce((a, s) => a + s.ms, 0);
  const totalMs = workMs + (bytes / DOWNLOAD_BPS) * 1000 + SETUP_MS;
  const minutes = Math.max(1, Math.ceil(totalMs / 60_000));
  return {
    at: new Date().toISOString(),
    backup: path.basename(file),
    ok: problems.length === 0,
    steps,
    shops,
    problems,
    bytes,
    minutes,
    estimate: `About ${minutes} minute${minutes === 1 ? "" : "s"}: download ~${Math.max(1, Math.round(bytes / DOWNLOAD_BPS))} s, start a server ~3 min, unpack and open ${Math.round(workMs / 1000)} s.`,
  };
}
