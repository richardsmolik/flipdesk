/**
 * Sold-comps library: import Terapeak (eBay's free sold-data research tool,
 * included with an eBay Store) or any sold-listings CSV, then use it for
 * pricing everywhere (item pricing, AI writer, sourcing mode).
 */
import type { Db } from "../db.js";

// ---------- CSV ----------
export function parseCsv(text: string): string[][] {
  text = text.replace(/^﻿/, "");
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const delim = [",", "\t", ";"].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === delim) row.push(field), (field = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

const money = (s: string | undefined) => {
  if (!s) return NaN;
  const n = Number(s.replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : NaN;
};

const STOP = new Set(["the", "and", "for", "with", "new", "used", "a", "an", "of", "in", "on", "lot", "free", "shipping", "nwt", "nwot", "euc", "vtg", "size", "mens", "womens", "men", "women"]);
export function normTitle(t: string) {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
export function tokens(t: string) {
  return [...new Set(normTitle(t).split(" ").filter((w) => w.length >= 2 && !STOP.has(w)))];
}

/** Map arbitrary export headers to our fields. */
export function detectColumns(header: string[]) {
  const h = header.map((x) => x.toLowerCase().trim());
  const find = (...res: RegExp[]) => {
    for (const re of res) {
      const i = h.findIndex((x) => re.test(x));
      if (i >= 0) return i;
    }
    return -1;
  };
  return {
    title: find(/listing title|item title|^title$|title/, /item name|product name|^name$/),
    avgPrice: find(/avg\.? ?sold ?price|average sold price|avg price|sold price|^price$|item price|sale price/),
    totalSales: find(/item sales|total sales|revenue|gross/),
    quantity: find(/total sold|quantity sold|units sold|qty sold|^sold$|^quantity$|^qty$/),
    shipping: find(/avg\.? ?shipping|shipping/),
    date: find(/date last sold|last sold|sold date|date sold|end date|^date$/),
    condition: find(/condition/),
    url: find(/url|link/),
  };
}

export function importComps(db: Db, csvText: string, source = "terapeak", batch = new Date().toISOString().slice(0, 16)) {
  const rows = parseCsv(csvText);
  if (rows.length < 2) throw new Error("That file has no data rows.");
  const cols = detectColumns(rows[0]);
  if (cols.title < 0 || (cols.avgPrice < 0 && cols.totalSales < 0)) {
    throw new Error(`Couldn't find title and price columns. Found headers: ${rows[0].join(", ")}`);
  }
  const ins = db.prepare(
    "INSERT INTO sold_comps (source, title, title_norm, price, quantity, shipping, condition, sold_at, url, batch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  let imported = 0;
  let skipped = 0;
  db.exec("BEGIN");
  try {
    for (const r of rows.slice(1)) {
      const title = (r[cols.title] ?? "").trim();
      const qty = cols.quantity >= 0 ? Math.max(1, Math.round(money(r[cols.quantity])) || 1) : 1;
      let price = cols.avgPrice >= 0 ? money(r[cols.avgPrice]) : NaN;
      if (!Number.isFinite(price) && cols.totalSales >= 0) price = money(r[cols.totalSales]) / qty;
      if (!title || !Number.isFinite(price) || price <= 0) {
        skipped++;
        continue;
      }
      const date = cols.date >= 0 ? new Date(r[cols.date]) : null;
      ins.run(
        source,
        title,
        normTitle(title),
        Math.round(price * 100) / 100,
        qty,
        cols.shipping >= 0 && Number.isFinite(money(r[cols.shipping])) ? money(r[cols.shipping]) : null,
        cols.condition >= 0 ? r[cols.condition] || null : null,
        date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : null,
        cols.url >= 0 ? r[cols.url] || null : null,
        batch,
      );
      imported++;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  const found = Object.entries(cols)
    .filter(([, i]) => i >= 0)
    .map(([k, i]) => `${k} <- "${rows[0][i]}"`);
  return { imported, skipped, batch, columns: found };
}

export interface LocalComp {
  title: string;
  price: number;
  quantity: number;
  sold_at: string | null;
  url: string | null;
  condition: string | null;
  score: number;
}

/** Sold comps from the local library whose titles overlap the query. */
export function findLocalComps(db: Db, query: string, limit = 40): LocalComp[] {
  const tk = tokens(query);
  if (!tk.length) return [];
  // Prefilter on the two most distinctive (longest) tokens, then score overlap.
  const key = [...tk].sort((a, b) => b.length - a.length).slice(0, 2);
  const rows = db
    .prepare(`SELECT title, title_norm, price, quantity, sold_at, url, condition FROM sold_comps WHERE ${key.map(() => "title_norm LIKE ?").join(" AND ")} LIMIT 3000`)
    .all(...key.map((k) => `%${k}%`)) as unknown as (LocalComp & { title_norm: string })[];
  return rows
    .map((r) => {
      const words = new Set(r.title_norm.split(" "));
      const score = tk.filter((t) => words.has(t)).length / tk.length;
      return { title: r.title, price: r.price, quantity: r.quantity, sold_at: r.sold_at, url: r.url, condition: r.condition, score };
    })
    .filter((r) => r.score >= 0.6)
    .sort((a, b) => b.score - a.score || (b.sold_at ?? "").localeCompare(a.sold_at ?? ""))
    .slice(0, limit);
}

export function compsLibrary(db: Db) {
  return {
    total: (db.prepare("SELECT COUNT(*) AS n FROM sold_comps").get() as { n: number }).n,
    batches: db
      .prepare("SELECT batch, source, COUNT(*) AS rows, SUM(quantity) AS units, MIN(imported_at) AS imported_at FROM sold_comps GROUP BY batch, source ORDER BY imported_at DESC")
      .all(),
  };
}
