/**
 * Backups and "download my data".
 *
 * - exportShop: one shop as a .zip: the database, spreadsheets (items, sales, expenses, mileage) and every photo.
 * - backupAll: every real shop + accounts into data/backups/flipdesk-<date>.zip, keeping the newest
 *   BACKUP_KEEP (default 7). With BACKUP_S3_* set, each backup is also uploaded to S3-compatible storage
 *   (Cloudflare R2, Backblaze B2, AWS S3, Wasabi...), so a lost server doesn't mean lost data.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, type Writable } from "node:stream";
import type { Db } from "../db.js";
import { toCsv } from "./reports.js";
import { extractEntry, ZipWriter, zipEntries } from "./zip.js";
import { DatabaseSync } from "node:sqlite";

/** Consistent copy of a live SQLite database (safe while the app is running). */
export function snapshot(db: Db, file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.rmSync(file, { force: true });
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
}

const CSV: Record<string, string> = {
  "items.csv": `SELECT sku, title, brand, category, condition, size, color, quantity_purchased, quantity AS quantity_left, cost AS unit_cost, price, min_price, location, source, sourced_at, status, description, created_at FROM items ORDER BY id`,
  "sales.csv": `SELECT s.sold_at AS date, i.sku, i.title, s.marketplace, s.order_id, s.quantity, s.sale_price, s.shipping_charged, s.fees, s.shipping_cost, s.cost AS cost_of_goods, s.profit, s.tracking, s.shipped_at FROM sales s LEFT JOIN items i ON i.id = s.item_id ORDER BY s.sold_at`,
  "listings.csv": `SELECT i.sku, l.marketplace, l.status, l.external_id, l.url, l.price, l.quantity, l.listed_at, l.ended_at FROM listings l JOIN items i ON i.id = l.item_id ORDER BY i.id`,
  "expenses.csv": `SELECT date, category, amount, note FROM expenses ORDER BY date`,
  "mileage.csv": `SELECT date, place AS destination, purpose, miles, rate, amount, note FROM trips ORDER BY date`,
};

const README = (shop: string) => `FlipDesk export: ${shop}
Made ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC

- items.csv, sales.csv, listings.csv, expenses.csv, mileage.csv: open in Excel, Numbers or Google Sheets.
- photos/: every item photo (and edited versions).
- flipdesk.db: the complete database. To move to another FlipDesk, put it in data/flipdesk.db and the photos in data/uploads/.
`;

function csvRows(db: Db, sql: string) {
  try {
    return db.prepare(sql).all() as Record<string, unknown>[];
  } catch {
    return null; // table missing in an older shop
  }
}

/** Write one shop as a zip to `out` (an HTTP response or a file). */
export async function exportShop(db: Db, uploadDir: string, out: Writable, label = "My shop") {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fd-export-"));
  try {
    const zip = new ZipWriter(out);
    await zip.add("README.txt", Buffer.from(README(label)));
    for (const [name, sql] of Object.entries(CSV)) {
      const rows = csvRows(db, sql);
      if (rows) await zip.add(name, Buffer.from(rows.length ? toCsv(rows) : "", "utf8"));
    }
    snapshot(db, path.join(tmp, "flipdesk.db"));
    await zip.addFile("flipdesk.db", path.join(tmp, "flipdesk.db"));
    await zip.addDir("photos", uploadDir);
    return await zip.finish();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export interface BackupSource {
  name: string; // folder inside the zip
  db: Db;
  uploadDir?: string;
}

export interface BackupResult {
  file: string;
  bytes: number;
  files: number;
  at: string;
  uploaded: string | null;
  error?: string;
}

export const backupDir = (dataDir: string) => path.join(dataDir, "backups");
export const s3Configured = () => Boolean(process.env.BACKUP_S3_ENDPOINT && process.env.BACKUP_S3_BUCKET && process.env.BACKUP_S3_ACCESS_KEY && process.env.BACKUP_S3_SECRET_KEY);

export async function backupAll(dataDir: string, sources: BackupSource[], now = new Date()): Promise<BackupResult> {
  const dir = backupDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  // Never overwrite an existing backup (e.g. the undo copy made right before restoring this one).
  let file = path.join(dir, `flipdesk-${stamp}.zip`);
  for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `flipdesk-${stamp}-${i}.zip`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fd-backup-"));
  const partial = `${file}.partial`;
  try {
    const out = fs.createWriteStream(partial);
    const zip = new ZipWriter(out);
    await zip.add("README.txt", Buffer.from(`FlipDesk backup ${now.toISOString()}\nEach folder is one shop: flipdesk.db + photos. accounts.db / site.db = sign-ins and server settings.\nTo restore: stop FlipDesk, copy the files back into data/ (same folder names), start FlipDesk.\n`));
    for (const s of sources) {
      const snap = path.join(tmp, s.name.replace(/[^\w.-]/g, "_") + ".db");
      snapshot(s.db, snap);
      await zip.addFile(`${s.name}`.endsWith(".db") ? s.name : `${s.name}/flipdesk.db`, snap);
      if (s.uploadDir) await zip.addDir(`${s.name}/uploads`, s.uploadDir);
    }
    const r = await zip.finish();
    fs.renameSync(partial, file);
    // Keep the newest N local copies.
    const keep = Math.max(1, Number(process.env.BACKUP_KEEP) || 7);
    const all = fs.readdirSync(dir).filter((f) => /^flipdesk-\d{8}-\d{4,6}(-\d+)?\.zip$/.test(f)).sort((a, b) => order(a).localeCompare(order(b)));
    for (const old of all.slice(0, Math.max(0, all.length - keep))) fs.rmSync(path.join(dir, old), { force: true });
    const res: BackupResult = { file, bytes: r.bytes, files: r.files, at: now.toISOString(), uploaded: null };
    if (s3Configured()) {
      try {
        res.uploaded = await s3Put(path.basename(file), file);
      } catch (e) {
        res.error = `Saved on the server, but the upload failed: ${(e as Error).message}`;
      }
    }
    return res;
  } finally {
    fs.rmSync(partial, { force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------- S3-compatible upload (AWS Signature V4, no SDK) ----------------

const hmac = (key: Buffer | string, s: string) => crypto.createHmac("sha256", key).update(s).digest();
const sha256hex = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export function signS3(opts: { method: string; url: URL; region: string; accessKey: string; secretKey: string; now?: Date; contentLength?: number }): Record<string, string> {
  const now = opts.now ?? new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = { host: opts.url.host, "x-amz-content-sha256": "UNSIGNED-PAYLOAD", "x-amz-date": amzDate };
  if (opts.contentLength !== undefined) headers["content-length"] = String(opts.contentLength);
  const names = Object.keys(headers).sort();
  const canonical = [opts.method, opts.url.pathname, opts.url.searchParams.toString(), names.map((n) => `${n}:${headers[n]}\n`).join(""), names.join(";"), "UNSIGNED-PAYLOAD"].join("\n");
  const scope = `${day}/${opts.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${opts.secretKey}`, day), opts.region), "s3"), "aws4_request");
  const sig = crypto.createHmac("sha256", key).update(toSign).digest("hex");
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${opts.accessKey}/${scope}, SignedHeaders=${names.join(";")}, Signature=${sig}` };
}

async function s3Put(key: string, file: string) {
  const prefix = (process.env.BACKUP_S3_PREFIX ?? "flipdesk/").replace(/^\/+/, "");
  const base = process.env.BACKUP_S3_ENDPOINT!.replace(/\/$/, "");
  const url = new URL(`${base}/${process.env.BACKUP_S3_BUCKET}/${prefix}${key}`);
  const size = fs.statSync(file).size;
  const headers = signS3({ method: "PUT", url, region: process.env.BACKUP_S3_REGION || "auto", accessKey: process.env.BACKUP_S3_ACCESS_KEY!, secretKey: process.env.BACKUP_S3_SECRET_KEY!, contentLength: size });
  delete (headers as Record<string, string>).host;
  const r = await fetch(url, {
    method: "PUT",
    headers: { ...headers, "content-type": "application/zip" },
    body: Readable.toWeb(fs.createReadStream(file)) as unknown as BodyInit,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  if (!r.ok) throw new Error(`storage answered ${r.status} ${(await r.text()).slice(0, 200)}`);
  return url.toString().replace(/\?.*$/, "");
}

const order = (f: string) => {
  const m = f.match(/^flipdesk-(\d{8}-\d{4,6})(?:-(\d+))?\.zip$/)!;
  return `${m[1]}-${(m[2] ?? "1").padStart(4, "0")}`;
};
export function listBackups(dataDir: string) {
  const dir = backupDir(dataDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^flipdesk-\d{8}-\d{4,6}(-\d+)?\.zip$/.test(f))
    // Newest first. Two made in the same second are "-2", "-3"… (a plain text sort would put those before the first).
    .sort((a, b) => order(b).localeCompare(order(a)))
    .map((f) => ({ name: f, bytes: fs.statSync(path.join(dir, f)).size }));
}

export interface BackupCheck { name: string; at: string; ok: boolean; databases: { name: string; ok: boolean; detail: string }[]; photosChecked: number; photosTotal: number; problems: string[] }

/**
 * Restore drill: unpack a backup into a scratch folder and prove it would work. Every database must open and
 * pass SQLite's integrity check; photos are read back and their checksums verified (up to 300 of them).
 */
export function verifyBackup(file: string): BackupCheck {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fd-check-"));
  const res: BackupCheck = { name: path.basename(file), at: new Date().toISOString(), ok: true, databases: [], photosChecked: 0, photosTotal: 0, problems: [] };
  try {
    const entries = zipEntries(file);
    const photos = entries.filter((e) => e.name.includes("/uploads/"));
    res.photosTotal = photos.length;
    for (const e of entries.filter((x) => x.name.endsWith(".db"))) {
      const out = path.join(tmp, e.name.replace(/[\\/]/g, "_"));
      try {
        fs.writeFileSync(out, extractEntry(file, e));
        const db = new DatabaseSync(out, { readOnly: true });
        try {
          const check = (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
          const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name));
          const count = (t: string) => (tables.has(t) ? Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n) : null);
          const items = count("items");
          const users = count("users");
          const ok = check === "ok";
          res.databases.push({ name: e.name, ok, detail: ok ? (items !== null ? `${items} items, ${count("sales")} sales` : users !== null ? `${users} accounts` : "opens fine") : `integrity check: ${check}` });
          if (!ok) res.problems.push(`${e.name}: ${check}`);
        } finally {
          db.close();
        }
      } catch (err) {
        res.databases.push({ name: e.name, ok: false, detail: (err as Error).message });
        res.problems.push(`${e.name}: ${(err as Error).message}`);
      }
    }
    // Spread the photo sample across the whole backup.
    const step = Math.max(1, Math.ceil(photos.length / 300));
    for (let i = 0; i < photos.length; i += step) {
      try {
        extractEntry(file, photos[i]);
        res.photosChecked++;
      } catch (err) {
        res.problems.push(`${photos[i].name}: ${(err as Error).message}`);
      }
    }
    if (!res.databases.length) res.problems.push("No databases in this backup");
  } catch (err) {
    res.problems.push((err as Error).message);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  res.ok = res.problems.length === 0;
  return res;
}
