import { getItem, getSetting, logActivity, tx, type Db, type Item, type JobRow, type ListingRow } from "../db.js";
import { adapterFor, isExtensionMarketplace } from "../marketplaces/adapters.js";
import { MARKETPLACES, type MarketplaceId } from "../marketplaces/registry.js";
import { saveProblem, withRecording } from "./replay.js";
import { ebayIsLive } from "../marketplaces/ebay.js";

/** Units to offer on a marketplace: all remaining units, or 1 on single-quantity sites. */
export function listingQty(m: MarketplaceId, remaining: number) {
  return MARKETPLACES[m].multiQty ? Math.max(1, remaining) : 1;
}

/** What can change on a live listing (besides quantity, which has its own job). */
export const REVISE_FIELDS = ["title", "description", "price", "keywords", "specifics", "condition", "brand", "size", "color", "photos"] as const;

function ensurePayload(db: Db) {
  try {
    db.exec("ALTER TABLE jobs ADD COLUMN payload TEXT");
  } catch {
    /* already there */
  }
}

export const autoPushOn = (db: Db) => getSetting<{ on?: boolean }>(db, "autoPush", {}).on !== false;

/**
 * Queue "revise" jobs so live listings show an item's changes. One pending job per listing (fields merged).
 * A listing with its own price (different from the item's old price) keeps it: only listings that followed
 * the item price get the new one.
 */
export function queueRevise(db: Db, itemId: number, fields: string[], opts: { oldPrice?: number } = {}) {
  ensurePayload(db);
  const item = getItem(db, itemId);
  if (!item) return [];
  const out: { marketplace: MarketplaceId; mode: "api" | "extension"; fields: string[] }[] = [];
  for (const l of item.listings.filter((x) => x.status === "active")) {
    let f = fields.filter((x) => (REVISE_FIELDS as readonly string[]).includes(x));
    if (f.includes("price")) {
      if (opts.oldPrice === undefined || Math.abs(l.price - opts.oldPrice) < 0.005) db.prepare("UPDATE listings SET price = ? WHERE id = ?").run(item.price, l.id);
      else f = f.filter((x) => x !== "price");
    }
    if (!f.length) continue;
    const m = l.marketplace as MarketplaceId;
    const pending = db.prepare("SELECT id, payload FROM jobs WHERE type = 'revise' AND listing_id = ? AND status = 'pending'").get(l.id) as { id: number; payload: string | null } | undefined;
    if (pending) {
      const merged = [...new Set([...((JSON.parse(pending.payload ?? "{}") as { fields?: string[] }).fields ?? []), ...f])];
      db.prepare("UPDATE jobs SET payload = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify({ fields: merged }), pending.id);
      f = merged;
    } else db.prepare("INSERT INTO jobs (marketplace, type, item_id, listing_id, payload) VALUES (?, 'revise', ?, ?, ?)").run(m, itemId, l.id, JSON.stringify({ fields: f }));
    out.push({ marketplace: m, mode: isExtensionMarketplace(m) ? "extension" : "api", fields: f });
  }
  return out;
}

export function enqueue(db: Db, marketplace: MarketplaceId, type: JobRow["type"], itemId: number, listingId: number | null) {
  // De-dupe: don't stack identical pending jobs for the same listing.
  const existing = db
    .prepare(
      "SELECT id FROM jobs WHERE marketplace = ? AND type = ? AND item_id = ? AND IFNULL(listing_id, 0) = IFNULL(?, 0) AND status IN ('pending','claimed')",
    )
    .get(marketplace, type, itemId, listingId) as { id: number } | undefined;
  if (existing) return existing.id;
  const r = db
    .prepare("INSERT INTO jobs (marketplace, type, item_id, listing_id) VALUES (?, ?, ?, ?)")
    .run(marketplace, type, itemId, listingId);
  return Number(r.lastInsertRowid);
}

/**
 * What a marketplace should see for one listing. For a per-variation listing
 * (sites without variation support) this is the item narrowed to that
 * variation: its SKU, quantity, price, size/color in specifics and title.
 */
export function listingView(item: Item, listing: Pick<ListingRow, "variation_id" | "quantity" | "price">): Item {
  const v = listing.variation_id ? item.variations.find((x) => x.id === listing.variation_id) : undefined;
  if (!v) return item;
  const suffix = Object.values(v.attrs).filter(Boolean).join(" ");
  return {
    ...item,
    sku: v.sku,
    title: suffix && !item.title.toLowerCase().includes(suffix.toLowerCase()) ? `${item.title} ${suffix}`.trim() : item.title,
    size: v.attrs["Size"] ?? item.size,
    color: v.attrs["Color"] ?? item.color,
    specifics: { ...item.specifics, ...v.attrs },
    quantity: v.quantity,
    price: v.price ?? item.price,
    variations: [],
  };
}

type Slot = { variationId: number | null; qty: number; price: number };

/** Which listings an item needs on a marketplace: one combined listing, or one per in-stock variation. */
export function slotsFor(item: Item, m: MarketplaceId, basePrice: number): Slot[] {
  if (!item.variations.length) return [{ variationId: null, qty: listingQty(m, item.quantity), price: basePrice }];
  if (MARKETPLACES[m].variations) return [{ variationId: null, qty: Math.max(1, item.quantity), price: basePrice }];
  return item.variations
    .filter((v) => v.quantity > 0)
    .map((v) => ({ variationId: v.id, qty: listingQty(m, v.quantity), price: v.price ?? basePrice }));
}

/** Create (or re-activate) listing rows and queue publish jobs. Skips listings already live. */
export function crosslist(db: Db, itemId: number, marketplaces: MarketplaceId[], prices: Partial<Record<MarketplaceId, number>> = {}) {
  const item = getItem(db, itemId);
  if (!item) throw new Error("Item not found");
  if (item.quantity < 1) throw new Error("No units left - restock this item before listing it.");
  return tx(db, () => {
    const out: { marketplace: MarketplaceId; listingId: number; jobId: number; variationId: number | null }[] = [];
    for (const m of marketplaces) {
      for (const slot of slotsFor(item, m, prices[m] ?? item.price)) {
        const existing = db
          .prepare("SELECT * FROM listings WHERE item_id = ? AND marketplace = ? AND IFNULL(variation_id, 0) = IFNULL(?, 0)")
          .get(itemId, m, slot.variationId) as ListingRow | undefined;
        if (existing && ["active", "queued", "ending"].includes(existing.status)) continue;
        let listingId: number;
        if (existing) {
          db.prepare(
            "UPDATE listings SET status = 'queued', price = ?, quantity = ?, error = NULL, ended_at = NULL, external_id = NULL, url = NULL WHERE id = ?",
          ).run(slot.price, slot.qty, existing.id);
          listingId = existing.id;
        } else {
          listingId = Number(
            db
              .prepare("INSERT INTO listings (item_id, variation_id, marketplace, price, quantity, status) VALUES (?, ?, ?, ?, ?, 'queued')")
              .run(itemId, slot.variationId, m, slot.price, slot.qty).lastInsertRowid,
          );
        }
        out.push({ marketplace: m, listingId, variationId: slot.variationId, jobId: enqueue(db, m, "publish", itemId, listingId) });
      }
    }
    if (item.status === "draft" && out.length) db.prepare("UPDATE items SET status = 'active', updated_at = datetime('now') WHERE id = ?").run(itemId);
    if (out.length) db.prepare("UPDATE items SET original_price = COALESCE(original_price, price) WHERE id = ? AND price > 0").run(itemId);
    if (out.length) {
      const names = [...new Set(out.map((o) => MARKETPLACES[o.marketplace].name))];
      logActivity(db, "crosslist", `Queued ${item.sku} to ${names.join(", ")}${out.length > names.length ? ` (${out.length} listings incl. variations)` : ""}`, itemId);
    }
    return out;
  });
}

/** Queue delist for one listing. Cancels a still-pending publish instead if it never went live. */
export function requestDelist(db: Db, listing: ListingRow, reason = "manual") {
  const pendingPublish = db
    .prepare("SELECT id FROM jobs WHERE listing_id = ? AND type = 'publish' AND status = 'pending'")
    .get(listing.id) as { id: number } | undefined;
  if (pendingPublish) {
    db.prepare("UPDATE jobs SET status = 'failed', result = ? , updated_at = datetime('now') WHERE id = ?").run(`cancelled: ${reason}`, pendingPublish.id);
    db.prepare("UPDATE listings SET status = 'ended', ended_at = datetime('now') WHERE id = ?").run(listing.id);
    return null;
  }
  db.prepare("UPDATE listings SET status = 'ending' WHERE id = ?").run(listing.id);
  return enqueue(db, listing.marketplace as MarketplaceId, "delist", listing.item_id, listing.id);
}

export function completeJob(db: Db, jobId: number, ok: boolean, data: { externalId?: string; url?: string; error?: string } = {}) {
  const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as JobRow | undefined;
  if (!job) throw new Error("Job not found");
  tx(db, () => {
    db.prepare("UPDATE jobs SET status = ?, result = ?, updated_at = datetime('now') WHERE id = ?").run(
      ok ? "done" : "failed",
      JSON.stringify(data),
      jobId,
    );
    if (!job.listing_id) return;
    const name = MARKETPLACES[job.marketplace as MarketplaceId]?.name ?? job.marketplace;
    if (!ok && job.type === "revise") {
      // The listing is still live, just not updated: keep it active, say what didn't go through.
      logActivity(db, "error", `${name}: couldn't update the live listing: ${data.error ?? "unknown error"}`, job.item_id);
      return;
    }
    if (ok && job.type === "revise") {
      logActivity(db, "revised", `Updated on ${name}: ${(JSON.parse(job.payload ?? "{}") as { fields?: string[] }).fields?.join(", ") ?? "details"}`, job.item_id);
      return;
    }
    if (!ok) {
      db.prepare("UPDATE listings SET status = 'error', error = ? WHERE id = ?").run(data.error ?? "failed", job.listing_id);
      logActivity(db, "error", `${name} ${job.type} failed: ${data.error ?? "unknown error"}`, job.item_id);
      return;
    }
    if (job.type === "publish") {
      db.prepare(
        "UPDATE listings SET status = 'active', external_id = ?, url = ?, listed_at = datetime('now'), error = NULL WHERE id = ?",
      ).run(data.externalId ?? null, data.url ?? null, job.listing_id);
      logActivity(db, "listed", `Listed on ${name}`, job.item_id);
    } else if (job.type === "delist") {
      // keep 'sold' if this was the selling marketplace
      db.prepare("UPDATE listings SET status = CASE status WHEN 'sold' THEN 'sold' ELSE 'ended' END, ended_at = datetime('now') WHERE id = ?").run(
        job.listing_id,
      );
      logActivity(db, "delisted", `Delisted from ${name}`, job.item_id);
    }
  });
}

/** Process pending jobs for API marketplaces (server-side). Extension jobs are left for the extension. */
export async function processApiJobs(db: Db, limit = 20) {
  const jobs = db
    .prepare("SELECT * FROM jobs WHERE status = 'pending' ORDER BY id LIMIT ?")
    .all(limit * 3) as unknown as JobRow[];
  let processed = 0;
  for (const job of jobs) {
    const m = job.marketplace as MarketplaceId;
    if (isExtensionMarketplace(m)) continue;
    if (processed++ >= limit) break;
    db.prepare("UPDATE jobs SET status = 'claimed', attempts = attempts + 1, updated_at = datetime('now') WHERE id = ?").run(job.id);
    const item = getItem(db, job.item_id);
    const listing = job.listing_id
      ? (db.prepare("SELECT * FROM listings WHERE id = ?").get(job.listing_id) as ListingRow | undefined)
      : undefined;
    if (!item || !listing) {
      completeJob(db, job.id, false, { error: "item or listing missing" });
      continue;
    }
    const adapter = adapterFor(m);
    const view = listingView(item, listing);
    const rec = withRecording(async () => {
    try {
      if (job.type === "publish") {
        const r = await adapter.publish(db, view, listing.price);
        if ("deferred" in r) return "deferred" as const;
        completeJob(db, job.id, true, r);
      } else if (job.type === "delist") {
        await adapter.delist(db, view, listing);
        completeJob(db, job.id, true);
      } else if (job.type === "revise") {
        const fields = (JSON.parse(job.payload ?? "{}") as { fields?: string[] }).fields ?? [];
        if (adapter.revise) await adapter.revise(db, view, listing, fields);
        else if (fields.includes("price")) await adapter.updatePrice(db, view, listing, listing.price);
        completeJob(db, job.id, true);
      } else {
        await adapter.updatePrice(db, view, listing, listing.price);
        completeJob(db, job.id, true);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (job.attempts + 1 < 3) {
        db.prepare("UPDATE jobs SET status = 'pending', result = ? WHERE id = ?").run(JSON.stringify({ error: msg }), job.id);
      } else {
        completeJob(db, job.id, false, { error: msg });
        // Final failure: keep a replayable problem report (requests/answers recorded during this attempt).
        try {
          saveProblem(db, { job: { ...job, attempts: job.attempts + 1 }, item, listing, error: msg, exchanges: rec.log, mode: m === "ebay" ? (ebayIsLive(db) ? "live" : "demo") : "api" });
        } catch {
          /* never let reporting break syncing */
        }
      }
    }
    return "ok" as const;
    });
    if ((await rec.run()) !== "ok") continue;
  }
  return processed;
}

/** Extension: claim the next job for any of the given marketplaces. */
export function claimExtensionJob(db: Db, marketplaces: MarketplaceId[]) {
  const ms = marketplaces.filter(isExtensionMarketplace);
  if (!ms.length) return null;
  // Delists first: a sold item still live elsewhere is the costliest mistake (double sale).
  const job = db
    .prepare(
      `SELECT * FROM jobs WHERE status = 'pending' AND marketplace IN (${ms.map(() => "?").join(",")})
       ORDER BY CASE type WHEN 'delist' THEN 0 ELSE 1 END, id LIMIT 1`,
    )
    .get(...ms) as JobRow | undefined;
  if (!job) return null;
  db.prepare("UPDATE jobs SET status = 'claimed', attempts = attempts + 1, updated_at = datetime('now') WHERE id = ?").run(job.id);
  // Re-queue jobs the extension claimed but never reported back on (tab closed, crash).
  db.prepare(
    "UPDATE jobs SET status = 'pending' WHERE status = 'claimed' AND updated_at < datetime('now', '-15 minutes') AND attempts < 3",
  ).run();
  const full = getItem(db, job.item_id);
  const listing = job.listing_id ? (db.prepare("SELECT * FROM listings WHERE id = ?").get(job.listing_id) as ListingRow | undefined) : undefined;
  const item = full && listing ? listingView(full, listing) : full;
  const variation = full && listing?.variation_id ? full.variations.find((v) => v.id === listing.variation_id) : undefined;
  return { job, item, listing: listing ?? null, variation: variation ?? null, marketplace: MARKETPLACES[job.marketplace as MarketplaceId] };
}
