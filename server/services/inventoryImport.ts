/**
 * Import inventory from a spreadsheet: Vendoo, List Perfectly, eBay's active-listings report,
 * or your own Excel/Google Sheet saved as CSV. Columns are detected by name.
 * Rows with an eBay item number are tracked as live eBay listings.
 * Photo URLs are downloaded in the background (public http(s) addresses only).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { getSetting, logActivity, type Db } from "../db.js";
import { parseCsv } from "./comps.js";
import { normalizeImage } from "./uploads.js";
import { countTitleMatches } from "./duplicates.js";

type Field = "title" | "description" | "brand" | "category" | "condition" | "price" | "cost" | "quantity" | "sku" | "location" | "images" | "ebayId" | "size" | "color" | "notes" | "source";

const PATTERNS: [Field, RegExp[]][] = [
  ["ebayId", [/^item ?(number|id)$/, /ebay item (number|id)/, /^ebay ?id$/, /listing id/]],
  ["sku", [/^sku$/, /custom label/, /^sku\b/, /inventory (number|id)/]],
  ["title", [/^title$/, /listing title/, /item title/, /^name$/, /product name/, /item name/]],
  ["description", [/description/]],
  ["brand", [/^brand/, /designer/, /manufacturer/]],
  ["category", [/category/, /department/]],
  ["condition", [/condition/]],
  ["cost", [/^cost/, /purchase price/, /price paid/, /^paid/, /cogs/, /cost of goods/, /buy price/]],
  ["price", [/^price$/, /list(ing)? price/, /current price/, /start price/, /asking/, /^price\b/, /buy it now/]],
  ["quantity", [/available quantity/, /^qty/, /^quantity/, /stock/]],
  ["location", [/^bin/, /location/, /storage/, /shelf/]],
  ["images", [/image/, /photo/, /picture/, /pic url/]],
  ["size", [/^size/]],
  ["color", [/^colou?r/]],
  ["notes", [/notes?$/, /internal/]],
  ["source", [/^source/, /where (bought|purchased)/, /sourced/]],
];

export function detectInventoryColumns(header: string[]) {
  const h = header.map((x) => x.toLowerCase().trim());
  const used = new Set<number>();
  const map: Partial<Record<Field, number[]>> = {};
  for (const [field, res] of PATTERNS) {
    for (const re of res) {
      const idx = h.map((x, i) => (re.test(x) && !used.has(i) ? i : -1)).filter((i) => i >= 0);
      if (idx.length) {
        const take = field === "images" ? idx : [idx[0]]; // several image columns are common (Image 1, Image 2...)
        take.forEach((i) => used.add(i));
        map[field] = take;
        break;
      }
    }
  }
  return map;
}

export function mapCondition(s: string): string {
  const v = s.toLowerCase();
  if (/parts|not working|broken/.test(v)) return "for_parts";
  if (/nwt|new with tag/.test(v)) return "new_with_tags";
  if (/nwot|new without|new other|open box/.test(v)) return "new_without_tags";
  if (/^new$|brand new|^1000$/.test(v)) return "new_with_tags";
  if (/like new|mint/.test(v)) return "like_new";
  if (/excellent|euc/.test(v)) return "used_excellent";
  if (/fair|acceptable|poor|wear/.test(v)) return "used_fair";
  return "used_good";
}

const money = (s?: string) => {
  const n = Number(String(s ?? "").replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) && String(s ?? "").trim() !== "" ? Math.round(n * 100) / 100 : null;
};

export interface ImportRow {
  line: number;
  title: string;
  description: string;
  brand: string;
  category: string;
  condition: string;
  price: number;
  cost: number;
  quantity: number;
  sku: string | null;
  location: string;
  size: string;
  color: string;
  notes: string;
  source: string;
  ebayId: string | null;
  images: string[];
  problem?: string;
}

export function parseInventory(text: string) {
  const rows = parseCsv(text);
  // Some exports have a title row above the header: use the first row that has a title-ish column.
  const hi = rows.findIndex((r) => r.some((c) => /title|name/i.test(c)));
  if (hi < 0) throw new Error("Couldn't find a title/name column. Save your sheet as CSV with a header row (Title, Price, ...).");
  const header = rows[hi];
  const map = detectInventoryColumns(header);
  const cell = (r: string[], f: Field) => (map[f]?.[0] !== undefined ? (r[map[f]![0]] ?? "").trim() : "");
  const body = rows.slice(hi + 1);
  const parsed: (ImportRow & { blank: boolean })[] = body.map((r, k) => {
    const images = (map.images ?? [])
      .flatMap((i) => (r[i] ?? "").split(/[\s,|;]+/))
      .map((u) => u.trim())
      .filter((u) => /^https?:\/\//i.test(u))
      .slice(0, 24);
    const title = cell(r, "title");
    const row: ImportRow = {
      line: hi + 2 + k,
      title: title.slice(0, 255),
      description: cell(r, "description"),
      brand: cell(r, "brand"),
      category: cell(r, "category"),
      condition: mapCondition(cell(r, "condition")),
      price: money(cell(r, "price")) ?? 0,
      cost: money(cell(r, "cost")) ?? 0,
      quantity: Math.max(1, Math.round(money(cell(r, "quantity")) ?? 1)),
      sku: cell(r, "sku") || null,
      location: cell(r, "location"),
      size: cell(r, "size"),
      color: cell(r, "color"),
      notes: cell(r, "notes"),
      source: cell(r, "source"),
      ebayId: cell(r, "ebayId").replace(/\D/g, "") || null,
      images,
    };
    if (!row.title) row.problem = "no title";
    return { ...row, blank: !r.some((c) => c.trim()) };
  });
  const found = Object.fromEntries(Object.entries(map).map(([f, idx]) => [f, idx!.map((i) => header[i])]));
  // Keep rows with any content (so missing titles are reported, not silently dropped).
  return { header, found, rows: parsed.filter((r) => !r.blank).map(({ blank: _b, ...r }) => r) };
}

export function previewInventory(db: Db, text: string) {
  const { found, rows } = parseInventory(text);
  const dupes = rows.filter((r) => r.sku && db.prepare("SELECT 1 FROM items WHERE sku = ?").get(r.sku)).length;
  const warnings: string[] = [];
  if (!found.price) warnings.push("No price column found - items import with price $0 (you can set prices after).");
  if (!found.cost) warnings.push("No cost column found - profit will assume $0 cost until you fill it in.");
  if (dupes) warnings.push(`${dupes} row(s) have a SKU that already exists and will be skipped.`);
  const lookalikes = countTitleMatches(db, rows.filter((r) => !r.sku || !db.prepare("SELECT 1 FROM items WHERE sku = ?").get(r.sku)).map((r) => r.title));
  if (lookalikes) warnings.push(`${lookalikes} item(s) look like things already in your inventory (same title). Check for duplicates after importing.`);
  return {
    columns: found,
    total: rows.length,
    withPhotos: rows.filter((r) => r.images.length).length,
    ebayListings: rows.filter((r) => r.ebayId).length,
    duplicates: dupes,
    problems: rows.filter((r) => r.problem).length,
    sample: rows.slice(0, 8),
    warnings,
  };
}

// ---------- safe photo download ----------

function isPrivateHost(host: string) {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (net.isIPv4(h)) {
    const [a, b] = h.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(h)) return h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80") || h === "::";
  return false;
}

export async function downloadImage(url: string, uploadDir: string, opts: { allowPrivate?: boolean } = {}): Promise<string> {
  // Follow redirects by hand so every hop is checked BEFORE we connect to it.
  let u = new URL(url);
  let res: Response | null = null;
  for (let hop = 0; hop < 4; hop++) {
    if (!/^https?:$/.test(u.protocol)) throw new Error("only http(s) photo links");
    if (!opts.allowPrivate && isPrivateHost(u.hostname)) throw new Error("private network address refused");
    res = await fetch(u, { signal: AbortSignal.timeout(15000), redirect: "manual", headers: { "User-Agent": "FlipDesk/0.1 (inventory import)" } });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      u = new URL(loc, u);
      continue;
    }
    break;
  }
  if (!res) throw new Error("no response");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (!/^image\//.test(type) && !/octet-stream/.test(type)) throw new Error(`not an image (${type})`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > 30 * 1024 * 1024) throw new Error("photo too large");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 30 * 1024 * 1024) throw new Error("photo too large");
  const file = path.join(uploadDir, `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.img`);
  fs.writeFileSync(file, buf);
  try {
    return await normalizeImage(file);
  } catch (e) {
    fs.rmSync(file, { force: true });
    throw new Error("unreadable image");
  }
}

export async function importInventory(db: Db, text: string, opts: { uploadDir: string; downloadPhotos?: boolean; allowPrivate?: boolean; wait?: boolean }) {
  const { rows } = parseInventory(text);
  const prefix = getSetting(db, "skuPrefix", "FD");
  let imported = 0;
  const skipped: { line: number; reason: string }[] = [];
  const photoJobs: { itemId: number; urls: string[] }[] = [];
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      if (r.problem) {
        skipped.push({ line: r.line, reason: r.problem });
        continue;
      }
      if (r.sku && db.prepare("SELECT 1 FROM items WHERE sku = ?").get(r.sku)) {
        skipped.push({ line: r.line, reason: `SKU ${r.sku} already exists` });
        continue;
      }
      let sku = r.sku ?? `${prefix}-I${String(Date.now()).slice(-6)}${imported}`;
      while (db.prepare("SELECT 1 FROM items WHERE sku = ?").get(sku)) sku += "X";
      const id = Number(
        db
          .prepare(
            `INSERT INTO items (sku, title, description, brand, category, condition, color, size, cost, price, original_price, quantity, quantity_purchased, location, source, notes, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(sku, r.title, r.description, r.brand, r.category, r.condition, r.color, r.size, r.cost, r.price, r.price || null, r.quantity, r.quantity, r.location, r.source, r.notes, r.ebayId ? "active" : "draft")
          .lastInsertRowid,
      );
      if (r.ebayId) {
        db.prepare("INSERT INTO listings (item_id, marketplace, status, external_id, url, price, quantity, listed_at) VALUES (?, 'ebay', 'active', ?, ?, ?, ?, datetime('now'))").run(
          id, r.ebayId, `https://www.ebay.com/itm/${r.ebayId}`, r.price, r.quantity,
        );
      }
      if (r.images.length && opts.downloadPhotos !== false) photoJobs.push({ itemId: id, urls: r.images });
      imported++;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  logActivity(db, "import", `Imported ${imported} item(s) from a spreadsheet${skipped.length ? `, skipped ${skipped.length}` : ""}`);

  const downloads = (async () => {
    let ok = 0;
    let failed = 0;
    const queue = photoJobs.flatMap((j) => j.urls.map((url, pos) => ({ ...j, url, pos })));
    const worker = async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        try {
          const file = await downloadImage(job.url, opts.uploadDir, { allowPrivate: opts.allowPrivate });
          db.prepare("INSERT INTO photos (item_id, path, position) VALUES (?, ?, ?)").run(job.itemId, file, job.pos);
          ok++;
        } catch {
          failed++;
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (ok || failed) logActivity(db, "import", `Downloaded ${ok} imported photo(s)${failed ? `, ${failed} couldn't be downloaded` : ""}`);
    return { ok, failed };
  })();
  const photos = opts.wait ? await downloads : null;
  return { imported, skipped, photosQueued: photoJobs.reduce((a, j) => a + j.urls.length, 0), photos };
}
