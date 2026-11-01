import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import os from "node:os";
import path from "node:path";
import { openDb, getItem, type Db } from "../server/db.js";
import { createApp, extensionToken } from "../server/app.js";
import { breakdown, calcFees, recommend } from "../server/services/fees.js";
import { MARKETPLACES } from "../server/marketplaces/registry.js";
import { crosslist, processApiJobs, claimExtensionJob, completeJob } from "../server/services/jobs.js";
import { recordSale, restock } from "../server/services/sync.js";
import { bulkPrice, staleListings } from "../server/services/ebayTools.js";

let db: Db;
beforeEach(() => {
  delete process.env.EBAY_CLIENT_ID;
  delete process.env.ANTHROPIC_API_KEY;
  db = openDb(":memory:");
});

function makeItem(over: Partial<{ quantity: number; cost: number; price: number; min_price: number }> = {}) {
  const q = over.quantity ?? 1;
  const r = db
    .prepare("INSERT INTO items (sku, title, cost, price, min_price, quantity, quantity_purchased, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')")
    .run(`T-${Math.random()}`, "Patagonia Better Sweater Mens L", over.cost ?? 10, over.price ?? 50, over.min_price ?? null, q, q);
  return Number(r.lastInsertRowid);
}

const listing = (itemId: number, m: string) => getItem(db, itemId)!.listings.find((l) => l.marketplace === m)!;
const jobs = (itemId: number) =>
  db.prepare("SELECT marketplace, type, status FROM jobs WHERE item_id = ? ORDER BY id").all(itemId) as { marketplace: string; type: string; status: string }[];

describe("fees", () => {
  it("eBay charges % on price + shipping plus per-order fee", () => {
    expect(calcFees(MARKETPLACES.ebay.fees, 100, 10)).toBe(15.36); // 13.6% of 110 + 0.40
  });
  it("Poshmark flat fee under $15, 20% at/above", () => {
    expect(calcFees(MARKETPLACES.poshmark.fees, 10)).toBe(2.95);
    expect(calcFees(MARKETPLACES.poshmark.fees, 50)).toBe(10);
  });
  it("Facebook min fee applies", () => {
    expect(calcFees(MARKETPLACES.facebook.fees, 5)).toBe(0.8);
  });
  it("profit and overrides", () => {
    const b = breakdown("vinted", { price: 40, cost: 10, shippingCost: 0 });
    expect(b.profit).toBe(30);
    expect(breakdown("vinted", { price: 40 }, { vinted: { pct: 5 } }).fees).toBe(2);
  });
  it("recommend favors clothing sites for clothing", () => {
    const r = recommend({ price: 50, cost: 10, category: "Clothing > Mens", title: "streetwear hoodie" });
    expect(["depop", "vinted", "grailed", "poshmark"]).toContain(r[0].marketplace);
  });
});

describe("crosslist + auto-delist (single unit)", () => {
  it("API sites publish server-side; extension sites wait for the extension", async () => {
    const id = makeItem();
    crosslist(db, id, ["ebay", "poshmark", "mercari"]);
    await processApiJobs(db);
    expect(listing(id, "ebay").status).toBe("active");
    expect(listing(id, "ebay").external_id).toBeTruthy();
    expect(listing(id, "poshmark").status).toBe("queued");
    expect(getItem(db, id)!.status).toBe("active");

    const claimed = claimExtensionJob(db, ["poshmark"]);
    expect(claimed?.job.type).toBe("publish");
    completeJob(db, claimed!.job.id, true, { externalId: "p1", url: "https://poshmark.com/listing/p1" });
    expect(listing(id, "poshmark").status).toBe("active");
  });

  it("selling on eBay delists everywhere else; never-published listings are cancelled", async () => {
    const id = makeItem();
    crosslist(db, id, ["ebay", "poshmark", "mercari"]);
    await processApiJobs(db);
    const c = claimExtensionJob(db, ["poshmark"])!;
    completeJob(db, c.job.id, true, { externalId: "p1" });

    const r = recordSale(db, { itemId: id, marketplace: "ebay", salePrice: 45, shippingCost: 5 });
    expect("delisted" in r && r.delisted.sort()).toEqual(["mercari", "poshmark"]);
    expect(listing(id, "ebay").status).toBe("sold");
    expect(listing(id, "poshmark").status).toBe("ending");
    expect(listing(id, "mercari").status).toBe("ended"); // pending publish was cancelled
    expect(getItem(db, id)!.status).toBe("sold");

    // Extension gets the delist first.
    const next = claimExtensionJob(db, ["poshmark", "mercari"])!;
    expect(next.job.type).toBe("delist");
    expect(next.job.marketplace).toBe("poshmark");
  });

  it("dedupes repeat order ids", () => {
    const id = makeItem({ quantity: 3 });
    recordSale(db, { itemId: id, marketplace: "ebay", salePrice: 45, orderId: "o1" });
    expect(recordSale(db, { itemId: id, marketplace: "ebay", salePrice: 45, orderId: "o1" })).toEqual({ duplicate: true });
    expect(getItem(db, id)!.quantity).toBe(2);
  });
});

describe("multi-quantity", () => {
  it("lists all units on multi-qty sites and 1 on single-qty sites", async () => {
    const id = makeItem({ quantity: 5 });
    crosslist(db, id, ["ebay", "mercari"]);
    expect(listing(id, "ebay").quantity).toBe(5);
    expect(listing(id, "mercari").quantity).toBe(1);
  });

  it("partial sale syncs quantity elsewhere and keeps listings live", async () => {
    const id = makeItem({ quantity: 5, cost: 4 });
    crosslist(db, id, ["ebay", "etsy", "poshmark"]);
    await processApiJobs(db);
    const r = recordSale(db, { itemId: id, marketplace: "ebay", salePrice: 100, quantity: 2 });
    const item = getItem(db, id)!;
    expect(item.quantity).toBe(3);
    expect(item.quantity_purchased).toBe(5);
    expect(item.quantity_sold).toBe(2);
    expect(item.status).toBe("active");
    expect(listing(id, "ebay").quantity).toBe(3);
    expect(listing(id, "etsy").quantity).toBe(3);
    expect(listing(id, "etsy").status).toBe("active");
    expect("synced" in r && r.synced).toContain("etsy");
    expect(jobs(id).some((j) => j.marketplace === "etsy" && j.type === "update")).toBe(true);
    // cost of goods = unit cost x qty
    const sale = db.prepare("SELECT cost, quantity FROM sales WHERE item_id = ?").get(id) as { cost: number; quantity: number };
    expect(sale).toEqual({ cost: 8, quantity: 2 });
  });

  it("single-qty site sale with units left auto-relists that site", async () => {
    const id = makeItem({ quantity: 3 });
    crosslist(db, id, ["ebay", "mercari"]);
    await processApiJobs(db);
    const c = claimExtensionJob(db, ["mercari"])!;
    completeJob(db, c.job.id, true, { externalId: "m1" });

    const r = recordSale(db, { itemId: id, marketplace: "mercari", salePrice: 40 });
    expect("relisted" in r && r.relisted).toEqual(["mercari"]);
    expect(listing(id, "mercari").status).toBe("queued");
    expect(listing(id, "ebay").quantity).toBe(2);
    expect(claimExtensionJob(db, ["mercari"])!.job.type).toBe("publish");
  });

  it("selling the last unit delists everywhere", async () => {
    const id = makeItem({ quantity: 2 });
    crosslist(db, id, ["ebay", "etsy"]);
    await processApiJobs(db);
    recordSale(db, { itemId: id, marketplace: "ebay", salePrice: 50 });
    const r = recordSale(db, { itemId: id, marketplace: "ebay", salePrice: 50 });
    expect("delisted" in r && r.delisted).toEqual(["etsy"]);
    expect(getItem(db, id)!.status).toBe("sold");
  });

  it("restock averages unit cost and re-activates sold items", async () => {
    const id = makeItem({ quantity: 2, cost: 10 });
    crosslist(db, id, ["ebay"]);
    await processApiJobs(db);
    recordSale(db, { itemId: id, marketplace: "ebay", salePrice: 50 }); // 1 left @ $10
    const item = restock(db, id, 3, 6)!; // +3 @ $6 -> (10 + 18) / 4 = 7
    expect(item.quantity).toBe(4);
    expect(item.quantity_purchased).toBe(5);
    expect(item.cost).toBe(7);
    expect(listing(id, "ebay").quantity).toBe(4);
  });

  it("refuses to crosslist an item with 0 left", () => {
    const id = makeItem({ quantity: 0 });
    expect(() => crosslist(db, id, ["ebay"])).toThrow(/restock/);
  });
});

describe("eBay tools", () => {
  it("bulk price respects the floor", () => {
    const id = makeItem({ price: 20, min_price: 18 });
    const r = bulkPrice(db, [id], { pct: -50 });
    expect(r[0].to).toBe(18);
  });
  it("stale radar suggests actions", async () => {
    const id = makeItem();
    crosslist(db, id, ["ebay"]);
    await processApiJobs(db);
    db.prepare("UPDATE listings SET listed_at = datetime('now','-45 days'), watchers = 3").run();
    const s = staleListings(db, 30);
    expect(s[0].itemId).toBe(id);
    expect(s[0].suggestion).toBe("send_offer");
  });
});

describe("HTTP API", () => {
  it("create item, AI demo draft, crosslist, sell, export", async () => {
    const app = createApp(db, { uploadDir: path.join(os.tmpdir(), "fd-test-uploads") });
    const created = await request(app).post("/api/items").send({ title: "Nike Dunk Low", price: 120, cost: 60, quantity: 4 }).expect(201);
    expect(created.body.quantity_purchased).toBe(4);

    const draft = await request(app).post("/api/ai/generate").field("hint", "nike dunk low panda size 10").expect(200);
    expect(draft.body.demo).toBe(true);
    expect(draft.body.draft.title).toMatch(/Nike/);

    await request(app).post(`/api/items/${created.body.id}/crosslist`).send({ marketplaces: ["ebay", "grailed"] }).expect(200);
    const sold = await request(app).post(`/api/items/${created.body.id}/sold`).send({ marketplace: "ebay", salePrice: 115, quantity: 1 }).expect(200);
    expect(sold.body.item.quantity).toBe(3);
    expect(sold.body.item.quantity_sold).toBe(1);

    const csv = await request(app).get("/api/export/inventory.csv").expect(200);
    expect(csv.text).toContain("quantity_purchased,quantity_sold,quantity_left");

    await request(app).get("/api/ext/next?m=grailed").expect(401);
    const job = await request(app).get("/api/ext/next?m=grailed").set("X-FlipDesk-Token", extensionToken(db)).expect(200);
    expect(job.body.job.marketplace).toBe("grailed");

    const dash = await request(app).get("/api/dashboard").expect(200);
    expect(dash.body.last30.sales).toBe(1);
  });
});
