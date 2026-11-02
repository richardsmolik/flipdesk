import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { uploadUrl } from "./context.js";

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
CREATE INDEX IF NOT EXISTS idx_sales_item ON sales(item_id);
CREATE INDEX IF NOT EXISTS idx_photos_item ON photos(item_id, position);
CREATE INDEX IF NOT EXISTS idx_items_status ON items(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status, marketplace);
`;

/**
 * Versioned migrations (PRAGMA user_version). SCHEMA above is version 1.
 * Append new migrations; never edit old ones.
 */
const MIGRATIONS: ((db: DatabaseSync) => void)[] = [
  // v2: variations, alerts, sold comps (Terapeak etc), sale emails
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS variations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        sku TEXT UNIQUE NOT NULL,
        attrs TEXT NOT NULL DEFAULT '{}',          -- JSON e.g. {"Size":"M","Color":"Black"}
        quantity INTEGER NOT NULL DEFAULT 0,       -- units left
        quantity_purchased INTEGER NOT NULL DEFAULT 0,
        price REAL,                                -- optional override of item price
        position INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_variations_item ON variations(item_id);

      -- Rebuild listings: add variation_id and widen the uniqueness rule.
      CREATE TABLE listings_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        variation_id INTEGER REFERENCES variations(id) ON DELETE CASCADE,
        marketplace TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        external_id TEXT,
        url TEXT,
        price REAL NOT NULL DEFAULT 0,
        quantity INTEGER NOT NULL DEFAULT 1,
        views INTEGER NOT NULL DEFAULT 0,
        watchers INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        listed_at TEXT,
        ended_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO listings_new (id, item_id, marketplace, status, external_id, url, price, quantity, views, watchers, error, listed_at, ended_at, created_at)
        SELECT id, item_id, marketplace, status, external_id, url, price, quantity, views, watchers, error, listed_at, ended_at, created_at FROM listings;
      DROP TABLE listings;
      ALTER TABLE listings_new RENAME TO listings;
      CREATE UNIQUE INDEX ux_listings ON listings(item_id, marketplace, IFNULL(variation_id, 0));
      CREATE INDEX IF NOT EXISTS idx_listings_item ON listings(item_id);

      ALTER TABLE sales ADD COLUMN variation_id INTEGER REFERENCES variations(id) ON DELETE SET NULL;

      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL DEFAULT (datetime('now')),
        kind TEXT NOT NULL,                        -- oversell | email_review | sync_error
        severity TEXT NOT NULL DEFAULT 'warning',  -- info | warning | critical
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        item_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
        sale_id INTEGER REFERENCES sales(id) ON DELETE CASCADE,
        data TEXT NOT NULL DEFAULT '{}',
        resolved_at TEXT
      );

      CREATE TABLE IF NOT EXISTS sold_comps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,                      -- terapeak | csv | manual
        title TEXT NOT NULL,
        title_norm TEXT NOT NULL,
        price REAL NOT NULL,                       -- average sold price per unit
        quantity INTEGER NOT NULL DEFAULT 1,       -- units sold in this row
        shipping REAL,
        condition TEXT,
        sold_at TEXT,
        url TEXT,
        imported_at TEXT NOT NULL DEFAULT (datetime('now')),
        batch TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sold_comps_norm ON sold_comps(title_norm);

      CREATE TABLE IF NOT EXISTS sale_emails (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT UNIQUE,
        received_at TEXT NOT NULL DEFAULT (datetime('now')),
        sender TEXT NOT NULL DEFAULT '',
        subject TEXT NOT NULL DEFAULT '',
        marketplace TEXT,
        parsed TEXT NOT NULL DEFAULT '{}',         -- JSON: title, price, orderId, quantity, size
        status TEXT NOT NULL DEFAULT 'review',     -- recorded | review | ignored | duplicate
        item_id INTEGER REFERENCES items(id) ON DELETE SET NULL,
        variation_id INTEGER REFERENCES variations(id) ON DELETE SET NULL,
        sale_id INTEGER REFERENCES sales(id) ON DELETE SET NULL,
        confidence REAL,
        note TEXT
      );
    `);
  },
  // v3: barcodes, bundles (lots), shipping details, promotions, weekly digests
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS barcode_cache (
        code TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS bundle_items (
        bundle_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        quantity INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (bundle_id, item_id)
      );
      CREATE INDEX IF NOT EXISTS idx_bundle_items_item ON bundle_items(item_id);
      ALTER TABLE sales ADD COLUMN ship_to TEXT;          -- JSON address
      ALTER TABLE sales ADD COLUMN tracking TEXT;
      ALTER TABLE sales ADD COLUMN carrier TEXT;
      ALTER TABLE sales ADD COLUMN label_source TEXT;     -- ebay | pirateship | marketplace | manual
      ALTER TABLE sales ADD COLUMN shipped_at TEXT;
      CREATE TABLE IF NOT EXISTS promotions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        marketplace TEXT NOT NULL,
        external_id TEXT,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,                               -- volume_discount
        rules TEXT NOT NULL DEFAULT '[]',
        item_ids TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'running',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS digests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        week TEXT UNIQUE NOT NULL,                        -- e.g. 2026-W44
        sent_at TEXT NOT NULL DEFAULT (datetime('now')),
        body TEXT NOT NULL
      );
    `);
  },
  // v4: returns, mileage (saved places + trips), purchased labels
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS returns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER REFERENCES items(id) ON DELETE SET NULL,
        variation_id INTEGER,
        marketplace TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'return',        -- return | cancel | oversell
        reason TEXT NOT NULL DEFAULT '',            -- not_as_described | changed_mind | damaged | wrong_size | never_arrived | other
        sale_price REAL NOT NULL DEFAULT 0,
        refund REAL NOT NULL DEFAULT 0,
        return_shipping REAL NOT NULL DEFAULT 0,    -- what the return cost you
        fees_lost REAL NOT NULL DEFAULT 0,          -- fees the marketplace kept
        restocked INTEGER NOT NULL DEFAULT 0,
        quantity INTEGER NOT NULL DEFAULT 1,
        sku TEXT, title TEXT, brand TEXT, category TEXT,
        sold_at TEXT,
        returned_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS places (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        round_trip_miles REAL NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS trips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL DEFAULT (date('now')),
        place TEXT NOT NULL DEFAULT '',
        purpose TEXT NOT NULL DEFAULT 'sourcing',   -- sourcing | post office | supplies | other
        miles REAL NOT NULL,
        rate REAL NOT NULL,
        amount REAL NOT NULL,
        odometer_start REAL, odometer_end REAL,
        note TEXT NOT NULL DEFAULT '',
        expense_id INTEGER REFERENCES expenses(id) ON DELETE SET NULL
      );
      ALTER TABLE sales ADD COLUMN label_url TEXT;
    `);
  },
  // v5: photo cleanup (originals), eBay-hosted photo URLs, price history, eBay traffic
  (db) => {
    db.exec(`
      ALTER TABLE photos ADD COLUMN original_path TEXT;
      ALTER TABLE photos ADD COLUMN ebay_url TEXT;
      ALTER TABLE photos ADD COLUMN ebay_url_expires TEXT;
      ALTER TABLE items ADD COLUMN original_price REAL;
      UPDATE items SET original_price = price WHERE price > 0;
      CREATE TABLE IF NOT EXISTS price_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        old_price REAL NOT NULL,
        new_price REAL NOT NULL,
        reason TEXT NOT NULL DEFAULT 'manual',   -- manual | bulk | auto_drop | smart_drop
        at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_price_changes_item ON price_changes(item_id);
      CREATE TABLE IF NOT EXISTS listing_traffic (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        external_id TEXT NOT NULL,                -- eBay item ID
        listing_id INTEGER REFERENCES listings(id) ON DELETE SET NULL,
        impressions INTEGER NOT NULL DEFAULT 0,
        views INTEGER NOT NULL DEFAULT 0,
        ctr REAL,                                 -- % of impressions that became views
        sold INTEGER NOT NULL DEFAULT 0,
        conversion REAL,                          -- % of views that became sales
        period_days INTEGER,
        source TEXT NOT NULL DEFAULT 'csv',       -- csv | api
        imported_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_traffic_ext ON listing_traffic(external_id);
    `);
  },
  // v6: phone upload links, photo fingerprints (duplicate detection)
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS upload_tokens (
        token TEXT PRIMARY KEY,
        item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        uploads INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      ALTER TABLE photos ADD COLUMN phash TEXT;
    `);
  },
];

function migrate(db: DatabaseSync) {
  const current = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version || 1;
  for (let v = current + 1; v <= MIGRATIONS.length + 1; v++) {
    db.exec("PRAGMA foreign_keys = OFF; BEGIN");
    try {
      MIGRATIONS[v - 2](db);
      db.exec(`PRAGMA user_version = ${v}; COMMIT; PRAGMA foreign_keys = ON;`);
    } catch (e) {
      db.exec("ROLLBACK; PRAGMA foreign_keys = ON;");
      throw new Error(`Migration to v${v} failed: ${(e as Error).message}`);
    }
  }
}

/** The schema version this copy of FlipDesk expects. */
export const SCHEMA_VERSION = MIGRATIONS.length + 1;

const applyUpdate = (db: DatabaseSync) => {
  db.exec(SCHEMA);
  migrate(db);
};

export function openDb(file = process.env.FLIPDESK_DB ?? "data/flipdesk.db"): Db {
  const existing = file !== ":memory:" && fs.existsSync(file) && fs.statSync(file).size > 0;
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  // An update with database changes: try it on a copy first (and keep a copy of how things were).
  const hasData = version > 0 || Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'items'").get());
  if (existing && hasData && version < SCHEMA_VERSION && process.env.FLIPDESK_REHEARSE !== "0") {
    try {
      rehearseUpdate(db, file, version || 1, applyUpdate);
    } catch (e) {
      db.close();
      throw e;
    }
  }
  applyUpdate(db);
  return db;
}

// ---------------- Try updates on a copy first ----------------

/** Your data: an update must never lose rows from these. */
const PRECIOUS = ["items", "photos", "listings", "sales", "variations", "settings", "connections", "expenses", "returns", "mileage", "bundles", "bundle_items"];

export interface Rehearsal { at: string; file: string; from: number; to: number; ok: boolean; detail: string; backup: string | null; ms: number }

const tableCounts = (d: DatabaseSync) =>
  Object.fromEntries(
    (d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((t) => [t.name, Number((d.prepare(`SELECT COUNT(*) AS n FROM "${t.name.replace(/"/g, '""')}"`).get() as { n: number }).n)]),
  ) as Record<string, number>;
const healthy = (d: DatabaseSync) => (d.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check;
const brokenLinks = (d: DatabaseSync) => d.prepare("PRAGMA foreign_key_check").all().length;
const rmDb = (f: string) => ["", "-wal", "-shm"].forEach((x) => fs.rmSync(f + x, { force: true }));

/**
 * Before an update changes the database: 1) save a copy of it as it is now (kept in before-update/),
 * 2) run the update on a second copy, 3) check that copy (healthy, no broken links, none of your rows lost).
 * Only if all that passes is the real database updated. Otherwise it's left exactly as it was, and FlipDesk
 * stops with a plain explanation instead of starting with damaged data.
 */
export function rehearseUpdate(db: DatabaseSync, file: string, from: number, apply: (d: DatabaseSync) => void): Rehearsal {
  const t0 = performance.now();
  const dir = path.join(path.dirname(file), "before-update");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  const base = path.basename(file).replace(/\.db$/, "");
  const backup = path.join(dir, `${base}-v${from}-${stamp}.db`);
  const trial = path.join(dir, `${base}-trial-${process.pid}.db`);
  const to = SCHEMA_VERSION;
  const record = (r: Omit<Rehearsal, "at" | "file" | "from" | "to" | "ms">) => {
    const out: Rehearsal = { at: new Date().toISOString(), file: path.basename(file), from, to, ms: Math.round(performance.now() - t0), ...r };
    try {
      fs.writeFileSync(path.join(dir, "last.json"), JSON.stringify(out, null, 1));
    } catch {
      /* best effort */
    }
    return out;
  };
  rmDb(backup);
  db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  fs.copyFileSync(backup, trial);
  const t = new DatabaseSync(trial);
  let problem: string | null = null;
  try {
    t.exec("PRAGMA foreign_keys = ON;");
    const before = tableCounts(t);
    const wasHealthy = healthy(t) === "ok";
    const linksBefore = brokenLinks(t);
    try {
      apply(t);
    } catch (e) {
      problem = (e as Error).message;
    }
    if (!problem) {
      const h = healthy(t);
      if (wasHealthy && h !== "ok") problem = `the updated copy failed its health check (${h})`;
      const links = brokenLinks(t);
      if (!problem && links > linksBefore) problem = `${links - linksBefore} records would point at things that no longer exist`;
      const after = tableCounts(t);
      const lost = PRECIOUS.filter((k) => before[k] > 0 && (after[k] ?? 0) < before[k]).map((k) => `${k} ${before[k]} → ${after[k] ?? 0}`);
      if (!problem && lost.length) problem = `your data would shrink: ${lost.join(", ")}`;
    }
  } finally {
    t.close();
    rmDb(trial);
  }
  if (problem) {
    const r = record({ ok: false, detail: problem, backup });
    console.error(`[update] tried the update on a copy of ${r.file} first and it failed: ${problem}`);
    throw new Error(
      `FlipDesk tried this update on a copy of your data first, and it didn't pass: ${problem}. Your data was NOT changed (a copy is also in ${backup}). ` +
        `Go back to the previous version of FlipDesk (e.g. fly releases rollback) and report this.`,
    );
  }
  // Keep the newest 3 "before" copies of each database.
  const mine = fs.readdirSync(dir).filter((f) => f.startsWith(`${base}-v`) && f.endsWith(".db")).sort();
  for (const f of mine.slice(0, Math.max(0, mine.length - 3))) rmDb(path.join(dir, f));
  const r = record({ ok: true, detail: `Tried on a copy first: passed. Updated from v${from} to v${to}.`, backup });
  console.log(`[update] ${r.file}: tried on a copy first (passed, ${r.ms} ms); copy of the old data in ${backup}`);
  return r;
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
  original_price?: number | null;
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
  variation_id: number | null;
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

export interface Variation {
  id: number;
  item_id: number;
  sku: string;
  attrs: Record<string, string>;
  name: string; // "Size: M / Color: Black"
  quantity: number;
  quantity_purchased: number;
  quantity_sold: number;
  price: number | null;
  position: number;
}

export interface Item extends Omit<ItemRow, "specifics" | "keywords"> {
  quantity_sold: number;
  variations: Variation[];
  specifics: Record<string, string>;
  keywords: string[];
  photos: { id: number; url: string; edited?: boolean }[];
  listings: ListingRow[];
}

export function hydrateItem(db: Db, row: ItemRow): Item {
  const photos = db
    .prepare("SELECT id, path, original_path FROM photos WHERE item_id = ? ORDER BY position, id")
    .all(row.id) as { id: number; path: string; original_path: string | null }[];
  const listings = db.prepare("SELECT * FROM listings WHERE item_id = ? ORDER BY marketplace").all(row.id) as unknown as ListingRow[];
  const sold = db.prepare("SELECT COALESCE(SUM(quantity), 0) AS n FROM sales WHERE item_id = ?").get(row.id) as { n: number };
  return {
    ...row,
    quantity_sold: Number(sold.n),
    variations: getVariations(db, row.id),
    specifics: JSON.parse(row.specifics || "{}"),
    keywords: JSON.parse(row.keywords || "[]"),
    photos: photos.map((p) => ({ id: p.id, url: p.path.startsWith("http") ? p.path : uploadUrl(p.path), edited: Boolean(p.original_path) })),
    listings,
  };
}

/**
 * Hydrate many items at once: 4 queries total instead of 4 per item (lists of hundreds of items stay fast).
 * Same shape as hydrateItem.
 */
export function hydrateItems(db: Db, rows: ItemRow[]): Item[] {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => "?").join(",");
  const group = <T extends { item_id: number }>(list: T[]) => {
    const m = new Map<number, T[]>();
    for (const x of list) (m.get(x.item_id) ?? m.set(x.item_id, []).get(x.item_id)!).push(x);
    return m;
  };
  const photos = group(db.prepare(`SELECT id, item_id, path, original_path FROM photos WHERE item_id IN (${marks}) ORDER BY position, id`).all(...ids) as { id: number; item_id: number; path: string; original_path: string | null }[]);
  const listings = group(db.prepare(`SELECT * FROM listings WHERE item_id IN (${marks}) ORDER BY marketplace`).all(...ids) as unknown as ListingRow[]);
  const sold = new Map((db.prepare(`SELECT item_id, COALESCE(SUM(quantity), 0) AS n FROM sales WHERE item_id IN (${marks}) GROUP BY item_id`).all(...ids) as { item_id: number; n: number }[]).map((r) => [r.item_id, Number(r.n)]));
  const varRows = db
    .prepare(
      `SELECT v.*, (SELECT COALESCE(SUM(s.quantity), 0) FROM sales s WHERE s.variation_id = v.id) AS quantity_sold
       FROM variations v WHERE v.item_id IN (${marks}) ORDER BY v.position, v.id`,
    )
    .all(...ids) as unknown as (Omit<Variation, "attrs" | "name"> & { attrs: string })[];
  const vars = group(
    varRows.map((r) => {
      const attrs = JSON.parse(r.attrs || "{}");
      return { ...r, quantity_sold: Number(r.quantity_sold), attrs, name: variationName(attrs) } as Variation;
    }),
  );
  return rows.map((row) => ({
    ...row,
    quantity_sold: sold.get(row.id) ?? 0,
    variations: vars.get(row.id) ?? [],
    specifics: JSON.parse(row.specifics || "{}"),
    keywords: JSON.parse(row.keywords || "[]"),
    photos: (photos.get(row.id) ?? []).map((p) => ({ id: p.id, url: p.path.startsWith("http") ? p.path : uploadUrl(p.path), edited: Boolean(p.original_path) })),
    listings: listings.get(row.id) ?? [],
  }));
}

export function variationName(attrs: Record<string, string>) {
  return Object.entries(attrs)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join(" / ");
}

export function getVariations(db: Db, itemId: number): Variation[] {
  const rows = db
    .prepare(
      `SELECT v.*, (SELECT COALESCE(SUM(s.quantity), 0) FROM sales s WHERE s.variation_id = v.id) AS quantity_sold
       FROM variations v WHERE v.item_id = ? ORDER BY v.position, v.id`,
    )
    .all(itemId) as unknown as (Omit<Variation, "attrs" | "name"> & { attrs: string })[];
  return rows.map((r) => {
    const attrs = JSON.parse(r.attrs || "{}");
    return { ...r, quantity_sold: Number(r.quantity_sold), attrs, name: variationName(attrs) };
  });
}

/** Keep item totals = sum of its variations (no-op for items without variations). */
export function recomputeItemTotals(db: Db, itemId: number) {
  const t = db
    .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(quantity),0) AS q, COALESCE(SUM(quantity_purchased),0) AS p FROM variations WHERE item_id = ?")
    .get(itemId) as { n: number; q: number; p: number };
  if (!t.n) return;
  db.prepare(
    `UPDATE items SET quantity = ?, quantity_purchased = ?,
       status = CASE WHEN ? = 0 AND status = 'active' THEN 'sold' WHEN ? > 0 AND status = 'sold' THEN 'active' ELSE status END,
       updated_at = datetime('now') WHERE id = ?`,
  ).run(t.q, t.p, t.q, t.q, itemId);
}

export function getItem(db: Db, id: number): Item | undefined {
  const row = db.prepare("SELECT * FROM items WHERE id = ?").get(id) as ItemRow | undefined;
  return row ? hydrateItem(db, row) : undefined;
}
