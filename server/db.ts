import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  brand TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  condition TEXT NOT NULL DEFAULT 'used_good',
  color TEXT NOT NULL DEFAULT '',
  size TEXT NOT NULL DEFAULT '',
  specifics TEXT NOT NULL DEFAULT '{}',      -- JSON: item specifics / aspects
  keywords TEXT NOT NULL DEFAULT '[]',       -- JSON array
  cost REAL NOT NULL DEFAULT 0,              -- what you paid PER UNIT (weighted average after restocks)
  price REAL NOT NULL DEFAULT 0,             -- your base list price
  min_price REAL,                            -- floor for offers / auto price drops
  quantity INTEGER NOT NULL DEFAULT 1,         -- units LEFT (available to sell)
  quantity_purchased INTEGER NOT NULL DEFAULT 1, -- units ever bought (incl. restocks)
  weight_oz REAL,
  location TEXT NOT NULL DEFAULT '',         -- storage bin / shelf
  source TEXT NOT NULL DEFAULT '',           -- where you bought it
  sourced_at TEXT,
  status TEXT NOT NULL DEFAULT 'draft',      -- draft | active | sold | archived
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  marketplace TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',     -- queued | active | ending | ended | sold | error
  external_id TEXT,
  url TEXT,
  price REAL NOT NULL DEFAULT 0,
  quantity INTEGER NOT NULL DEFAULT 1,       -- units offered on this marketplace
  views INTEGER NOT NULL DEFAULT 0,
  watchers INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  listed_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(item_id, marketplace)
);

CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  marketplace TEXT NOT NULL,
  order_id TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  sale_price REAL NOT NULL,                  -- total for this order line
  shipping_charged REAL NOT NULL DEFAULT 0,
  shipping_cost REAL NOT NULL DEFAULT 0,
  fees REAL NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,              -- snapshot of item cost at sale time
  profit REAL NOT NULL DEFAULT 0,
  buyer TEXT,
  sold_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Work queue. API marketplaces are processed server-side; browser-only
-- marketplaces (Poshmark, Mercari, ...) are claimed by the Chrome extension.
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  marketplace TEXT NOT NULL,
  type TEXT NOT NULL,                        -- publish | delist | update
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  listing_id INTEGER REFERENCES listings(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',    -- pending | claimed | done | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS connections (
  marketplace TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'disconnected', -- disconnected | connected | demo
  username TEXT,
  credentials TEXT NOT NULL DEFAULT '{}',
  connected_at TEXT
);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL DEFAULT (date('now')),
  category TEXT NOT NULL,                    -- supplies | shipping | mileage | fees | other
  amount REAL NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  item_id INTEGER
);

CREATE INDEX IF NOT EXISTS idx_listings_item ON listings(item_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, marketplace);
CREATE INDEX IF NOT EXISTS idx_sales_sold_at ON sales(sold_at);
`;

export function openDb(file = process.env.FLIPDESK_DB ?? "data/flipdesk.db"): Db {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

/** Run fn inside a transaction; rolls back on throw. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function logActivity(db: Db, kind: string, message: string, itemId?: number) {
  db.prepare("INSERT INTO activity (kind, message, item_id) VALUES (?, ?, ?)").run(kind, message, itemId ?? null);
}

export function getSetting<T>(db: Db, key: string, fallback: T): T {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : fallback;
}

export function setSetting(db: Db, key: string, value: unknown) {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    JSON.stringify(value),
  );
}

// ---------- Row types ----------
export interface ItemRow {
  id: number;
  sku: string;
  title: string;
  description: string;
  brand: string;
  category: string;
  condition: string;
  color: string;
  size: string;
  specifics: string;
  keywords: string;
  cost: number;
  price: number;
  min_price: number | null;
  quantity: number;
  quantity_purchased: number;
  weight_oz: number | null;
  location: string;
  source: string;
  sourced_at: string | null;
  status: string;
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface ListingRow {
  id: number;
  item_id: number;
  marketplace: string;
  status: string;
  external_id: string | null;
  url: string | null;
  price: number;
  quantity: number;
  views: number;
  watchers: number;
  error: string | null;
  listed_at: string | null;
  ended_at: string | null;
}

export interface JobRow {
  id: number;
  marketplace: string;
  type: "publish" | "delist" | "update";
  item_id: number;
  listing_id: number | null;
  status: string;
  attempts: number;
  result: string | null;
}

export interface Item extends Omit<ItemRow, "specifics" | "keywords"> {
  quantity_sold: number;
  specifics: Record<string, string>;
  keywords: string[];
  photos: { id: number; url: string }[];
  listings: ListingRow[];
}

export function hydrateItem(db: Db, row: ItemRow): Item {
  const photos = db
    .prepare("SELECT id, path FROM photos WHERE item_id = ? ORDER BY position, id")
    .all(row.id) as { id: number; path: string }[];
  const listings = db.prepare("SELECT * FROM listings WHERE item_id = ? ORDER BY marketplace").all(row.id) as unknown as ListingRow[];
  const sold = db.prepare("SELECT COALESCE(SUM(quantity), 0) AS n FROM sales WHERE item_id = ?").get(row.id) as { n: number };
  return {
    ...row,
    quantity_sold: Number(sold.n),
    specifics: JSON.parse(row.specifics || "{}"),
    keywords: JSON.parse(row.keywords || "[]"),
    photos: photos.map((p) => ({ id: p.id, url: p.path.startsWith("http") ? p.path : `/uploads/${path.basename(p.path)}` })),
    listings,
  };
}

export function getItem(db: Db, id: number): Item | undefined {
  const row = db.prepare("SELECT * FROM items WHERE id = ?").get(id) as ItemRow | undefined;
  return row ? hydrateItem(db, row) : undefined;
}
