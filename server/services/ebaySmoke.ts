/**
 * eBay smoke test: one click proves the whole eBay path works, on eBay's sandbox (test site).
 * It creates a test item with a photo, lists it, ends the listing and cleans everything up, timing each step.
 * A failure saves a problem report (with the exact eBay answers) that can be sent and replayed.
 * On production keys it refuses unless you explicitly allow a real listing for a few seconds.
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { getItem, getSetting, type Db, type JobRow, type ListingRow } from "../db.js";
import { ebayDeleteInventoryItem, ebayDelist, ebayEnvironment, ebayIsLive, ebayPublish, fetchPolicies } from "../marketplaces/ebay.js";
import { saveProblem, withRecording } from "./replay.js";

export interface SmokeStep { name: string; ok: boolean; ms: number; detail: string }

export async function ebaySmokeTest(db: Db, uploadDir: string, opts: { allowProduction?: boolean } = {}) {
  const env = ebayEnvironment();
  const steps: SmokeStep[] = [];
  const step = async <T>(name: string, fn: () => Promise<T> | T, describe: (r: T) => string = () => "OK") => {
    const t = performance.now();
    try {
      const r = await fn();
      steps.push({ name, ok: true, ms: Math.round(performance.now() - t), detail: describe(r) });
      return r;
    } catch (e) {
      steps.push({ name, ok: false, ms: Math.round(performance.now() - t), detail: (e as Error).message });
      throw e;
    }
  };
  let itemId: number | null = null;
  let photo: string | null = null;
  let published = false;
  let error: string | null = null;
  const sku = `FDSMOKE-${Date.now()}`;
  const rec = withRecording(async () => {
    try {
      await step("eBay connected", () => {
        if (!ebayIsLive(db)) throw new Error("Connect eBay first (Marketplaces → Connect eBay).");
      }, () => `Connected (${env === "sandbox" ? "eBay sandbox: test site, nothing real" : "PRODUCTION"})`);
      await step("Safe place to test", () => {
        if (env === "production" && !opts.allowProduction) throw new Error("These are production keys. The smoke test runs on eBay's sandbox (EBAY_ENV=sandbox with sandbox keys). To test on real eBay anyway, confirm a real listing for a few seconds.");
      }, () => (env === "sandbox" ? "eBay sandbox" : "Real eBay (you confirmed)"));
      await step("Policies and ship-from location chosen", () => {
        const c = getSetting<{ fulfillmentPolicyId?: string; paymentPolicyId?: string; returnPolicyId?: string; merchantLocationKey?: string }>(db, "ebay", {});
        const missing = [!c.fulfillmentPolicyId && "shipping policy", !c.paymentPolicyId && "payment policy", !c.returnPolicyId && "return policy", !c.merchantLocationKey && "ship-from location"].filter(Boolean);
        if (missing.length) throw new Error(`Missing: ${missing.join(", ")} (Settings → eBay)`);
      });
      await step("Reach your eBay account", () => fetchPolicies(db), (p) => `${p.fulfillment.length} shipping, ${p.payment.length} payment, ${p.returns.length} return policies`);
      await step("Make a test item", async () => {
        fs.mkdirSync(uploadDir, { recursive: true });
        photo = path.join(uploadDir, `${sku}.jpg`);
        await sharp({ create: { width: 800, height: 800, channels: 3, background: "#3b82f6" } })
          .composite([{ input: Buffer.from(`<svg width="800" height="800"><text x="400" y="420" font-size="64" text-anchor="middle" fill="#fff" font-family="sans-serif">FlipDesk test</text></svg>`) }])
          .jpeg()
          .toFile(photo);
        itemId = Number(
          db
            .prepare("INSERT INTO items (sku, title, description, brand, category, condition, price, quantity, quantity_purchased, status, specifics) VALUES (?, ?, ?, 'Unbranded', 'Collectibles', 'used_good', 9.99, 1, 1, 'draft', ?)")
            .run(sku, "FlipDesk test listing - please do not buy", "Automatic FlipDesk connection test. This listing ends within seconds.", JSON.stringify({ Brand: "Unbranded" })).lastInsertRowid,
        );
        db.prepare("INSERT INTO photos (item_id, path, position) VALUES (?, ?, 0)").run(itemId, photo);
      }, () => sku);
      const listing = await step("List it on eBay", () => ebayPublish(db, getItem(db, itemId!)!, 9.99), (r) => `Listing ${r.externalId}`);
      published = true;
      await step("End the listing", () => ebayDelist(db, getItem(db, itemId!)!, { external_id: listing.externalId } as ListingRow));
      published = false;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      // Always clean up: eBay inventory record, then the local test item and photo.
      if (itemId) {
        if (published) await ebayDelist(db, getItem(db, itemId)!, {} as ListingRow).catch(() => {});
        if (steps.some((s) => s.name === "List it on eBay")) await step("Clean up on eBay", () => ebayDeleteInventoryItem(db, sku)).catch(() => {});
        db.prepare("DELETE FROM photos WHERE item_id = ?").run(itemId);
        db.prepare("DELETE FROM items WHERE id = ?").run(itemId);
      }
      if (photo) fs.rmSync(photo, { force: true });
    }
  });
  await rec.run();
  const ok = !error && steps.every((s) => s.ok);
  if (!ok && steps.some((s) => s.name === "Reach your eBay account")) {
    // Save a replayable report (only when eBay was actually contacted).
    const job = { id: -Date.now(), type: "smoke-test", marketplace: "ebay", item_id: 0, listing_id: null, status: "failed", attempts: 1, result: null } as unknown as JobRow;
    try {
      saveProblem(db, { job, error: error ?? "smoke test failed", exchanges: rec.log, mode: env });
    } catch {
      /* never let reporting break the test */
    }
  }
  return { ok, env, steps, error, ranAt: new Date().toISOString() };
}

