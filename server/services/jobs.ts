import { getItem, logActivity, tx, type Db, type JobRow, type ListingRow } from "../db.js";
import { adapterFor, isExtensionMarketplace } from "../marketplaces/adapters.js";
import { MARKETPLACES, type MarketplaceId } from "../marketplaces/registry.js";

/** Units to offer on a marketplace: all remaining units, or 1 on single-quantity sites. */
export function listingQty(m: MarketplaceId, remaining: number) {
  return MARKETPLACES[m].multiQty ? Math.max(1, remaining) : 1;
}

export function enqueue(db: Db, marketplace: MarketplaceId, type: JobRow["type"], itemId: number, listingId: number | null) {
  // De-dupe: don't stack identical pending jobs.
  const existing = db
    .prepare("SELECT id FROM jobs WHERE marketplace = ? AND type = ? AND item_id = ? AND status IN ('pending','claimed')")
    .get(marketplace, type, itemId) as { id: number } | undefined;
  if (existing) return existing.id;
  const r = db
    .prepare("INSERT INTO jobs (marketplace, type, item_id, listing_id) VALUES (?, ?, ?, ?)")
    .run(marketplace, type, itemId, listingId);
  return Number(r.lastInsertRowid);
}

/** Create (or re-activate) listing rows and queue publish jobs. */
export function crosslist(db: Db, itemId: number, marketplaces: MarketplaceId[], prices: Partial<Record<MarketplaceId, number>> = {}) {
  const item = getItem(db, itemId);
  if (!item) throw new Error("Item not found");
  if (item.quantity < 1) throw new Error("No units left - restock this item before listing it.");
  return tx(db, () => {
    const out: { marketplace: MarketplaceId; listingId: number; jobId: number }[] = [];
    for (const m of marketplaces) {
      const price = prices[m] ?? item.price;
      const qty = listingQty(m, item.quantity);
      const existing = db.prepare("SELECT * FROM listings WHERE item_id = ? AND marketplace = ?").get(itemId, m) as
        | ListingRow
        | undefined;
      if (existing && ["active", "queued"].includes(existing.status)) continue;
      let listingId: number;
      if (existing) {
        db.prepare("UPDATE listings SET status = 'queued', price = ?, quantity = ?, error = NULL, ended_at = NULL WHERE id = ?").run(price, qty, existing.id);
        listingId = existing.id;
      } else {
        listingId = Number(
          db.prepare("INSERT INTO listings (item_id, marketplace, price, quantity, status) VALUES (?, ?, ?, ?, 'queued')").run(itemId, m, price, qty)
            .lastInsertRowid,
        );
      }
      out.push({ marketplace: m, listingId, jobId: enqueue(db, m, "publish", itemId, listingId) });
    }
    if (item.status === "draft" && out.length) db.prepare("UPDATE items SET status = 'active', updated_at = datetime('now') WHERE id = ?").run(itemId);
    if (out.length) logActivity(db, "crosslist", `Queued ${item.sku} to ${out.map((o) => MARKETPLACES[o.marketplace].name).join(", ")}`, itemId);
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
    try {
      if (job.type === "publish") {
        const r = await adapter.publish(db, item, listing.price);
        if ("deferred" in r) continue;
        completeJob(db, job.id, true, r);
      } else if (job.type === "delist") {
        await adapter.delist(db, item, listing);
        completeJob(db, job.id, true);
      } else {
        await adapter.updatePrice(db, item, listing, listing.price);
        completeJob(db, job.id, true);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (job.attempts + 1 < 3) {
        db.prepare("UPDATE jobs SET status = 'pending', result = ? WHERE id = ?").run(JSON.stringify({ error: msg }), job.id);
      } else {
        completeJob(db, job.id, false, { error: msg });
      }
    }
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
  const item = getItem(db, job.item_id);
  const listing = job.listing_id ? db.prepare("SELECT * FROM listings WHERE id = ?").get(job.listing_id) : null;
  return { job, item, listing, marketplace: MARKETPLACES[job.marketplace as MarketplaceId] };
}
