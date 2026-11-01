/**
 * "Didn't I already list this?" Photo fingerprints (difference hash) catch re-shot photos of the same
 * item even at a different size/brightness; title overlap catches retyped listings.
 * Lots and their own items share photos on purpose, so those pairs are ignored.
 */
import sharp from "sharp";
import fs from "node:fs";
import type { Db } from "../db.js";
import { tokens } from "./comps.js";

/** 64-bit difference hash as 16 hex chars. */
export async function dHash(file: string): Promise<string> {
  const px = await sharp(file).rotate().grayscale().resize(9, 8, { fit: "fill" }).raw().toBuffer();
  let bits = "";
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += px[y * 9 + x] > px[y * 9 + x + 1] ? "1" : "0";
  let hex = "";
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

export function hamming(a: string, b: string) {
  let d = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) (d += x & 1), (x >>= 1);
  }
  return d;
}

/** Fill in fingerprints for photos that don't have one yet (cached in photos.phash). */
export async function ensureHashes(db: Db) {
  const rows = db.prepare("SELECT id, path FROM photos WHERE phash IS NULL").all() as { id: number; path: string }[];
  for (const r of rows) {
    let h = "none";
    if (!r.path.startsWith("http") && /\.(jpe?g|png|webp)$/i.test(r.path) && fs.existsSync(r.path)) {
      try {
        h = await dHash(r.path);
      } catch {
        h = "none";
      }
    }
    db.prepare("UPDATE photos SET phash = ? WHERE id = ?").run(h, r.id);
  }
}

export function titleSimilarity(a: string, b: string) {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (A.size < 2 || B.size < 2) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / Math.min(A.size, B.size);
}

export interface DuplicateHit {
  itemId: number;
  sku: string;
  title: string;
  status: string;
  photo: string | null;
  reason: "photo" | "title";
  score: number; // 0..1
}

export async function findDuplicates(db: Db, itemId: number, limit = 5): Promise<DuplicateHit[]> {
  await ensureHashes(db);
  const me = db.prepare("SELECT id, title FROM items WHERE id = ?").get(itemId) as { id: number; title: string } | undefined;
  if (!me) return [];
  const related = new Set(
    (db.prepare("SELECT bundle_id AS a, item_id AS b FROM bundle_items WHERE bundle_id = ? OR item_id = ?").all(itemId, itemId) as { a: number; b: number }[]).flatMap((r) => [r.a, r.b]),
  );
  const myHashes = (db.prepare("SELECT phash FROM photos WHERE item_id = ? AND phash != 'none'").all(itemId) as { phash: string }[]).map((r) => r.phash);
  const others = db
    .prepare(
      `SELECT i.id, i.sku, i.title, i.status, (SELECT path FROM photos p WHERE p.item_id = i.id ORDER BY position LIMIT 1) AS photo
       FROM items i WHERE i.id != ? AND i.status != 'archived'`,
    )
    .all(itemId) as { id: number; sku: string; title: string; status: string; photo: string | null }[];
  const hashesBy = new Map<number, string[]>();
  for (const r of db.prepare("SELECT item_id, phash FROM photos WHERE phash IS NOT NULL AND phash != 'none'").all() as { item_id: number; phash: string }[]) {
    hashesBy.set(r.item_id, [...(hashesBy.get(r.item_id) ?? []), r.phash]);
  }
  const hits: DuplicateHit[] = [];
  for (const o of others) {
    if (related.has(o.id)) continue;
    let best = 64;
    for (const h of myHashes) for (const g of hashesBy.get(o.id) ?? []) best = Math.min(best, hamming(h, g));
    const photo = o.photo ? (o.photo.startsWith("http") ? o.photo : `/uploads/${o.photo.split(/[\\/]/).pop()}`) : null;
    if (best <= 6) {
      hits.push({ itemId: o.id, sku: o.sku, title: o.title, status: o.status, photo, reason: "photo", score: Math.round((1 - best / 64) * 100) / 100 });
      continue;
    }
    const ts = me.title && o.title ? titleSimilarity(me.title, o.title) : 0;
    if (ts >= 0.8) hits.push({ itemId: o.id, sku: o.sku, title: o.title, status: o.status, photo, reason: "title", score: Math.round(ts * 100) / 100 });
  }
  return hits.sort((a, b) => (a.reason === b.reason ? b.score - a.score : a.reason === "photo" ? -1 : 1)).slice(0, limit);
}

/** For imports: how many incoming titles look like items already in inventory. */
export function countTitleMatches(db: Db, titles: string[]) {
  const existing = (db.prepare("SELECT title FROM items WHERE status != 'archived' AND title != ''").all() as { title: string }[]).map((r) => r.title);
  return titles.filter((t) => existing.some((e) => titleSimilarity(t, e) >= 0.9)).length;
}
