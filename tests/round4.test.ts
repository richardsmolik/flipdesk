import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import os from "node:os";
import path from "node:path";
import { getItem, openDb, type Db } from "../server/db.js";
import { createApp } from "../server/app.js";
import { claimExtensionJob, completeJob, crosslist, processApiJobs } from "../server/services/jobs.js";
import { cancelSale, recordSale, returnsReport } from "../server/services/sync.js";
import { logTrip, mileageSummary, deleteTrip } from "../server/services/mileage.js";
import { profitReport } from "../server/services/insights.js";
import { buyLabel, getRates } from "../server/services/shippo.js";
import { parseAddress, updateShipping } from "../server/services/shipping.js";

let db: Db;
beforeEach(() => {
  delete process.env.EBAY_CLIENT_ID;
  delete process.env.SHIPPO_API_KEY;
  db = openDb(":memory:");
});
const mk = (title: string, o: Partial<{ status: string; qty: number; source: string; category: string; cost: number }> = {}) =>
  Number(
    db
      .prepare("INSERT INTO items (sku, title, status, quantity, quantity_purchased, source, category, cost, price, location) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 50, 'A1')")
      .run(`R${Math.random().toString(36).slice(2, 8)}`, title, o.status ?? "active", o.qty ?? 1, o.qty ?? 1, o.source ?? "", o.category ?? "", o.cost ?? 5).lastInsertRowid,
  );
const app = () => createApp(db, { uploadDir: path.join(os.tmpdir(), "fd-r4") });

describe("inventory views", () => {
  it("inventory / selling / not sold yet / drafts / sold", async () => {
    const draft = mk("Draft thing", { status: "draft" });
    const live = mk("Live never sold");
    const partial = mk("Live partly sold", { qty: 3 });
    const gone = mk("Sold out");
    for (const id of [live, partial, gone]) {
      crosslist(db, id, ["ebay"]);
    }
    await processApiJobs(db);
    recordSale(db, { itemId: partial, marketplace: "ebay", salePrice: 50 });
    recordSale(db, { itemId: gone, marketplace: "ebay", salePrice: 50 });
    const ids = async (view: string) => ((await request(app()).get(`/api/items?view=${view}`)).body as { id: number }[]).map((i) => i.id).sort();
    expect(await ids("inventory")).toEqual([draft, live, partial].sort());
    expect(await ids("selling")).toEqual([live, partial].sort());
    expect(await ids("unsold")).toEqual([live]);
    expect(await ids("drafts")).toEqual([draft]);
    expect(await ids("sold")).toEqual([partial, gone].sort());
    const counts = (await request(app()).get("/api/items-counts")).body;
    expect(counts).toEqual({ inventory: 3, selling: 2, unsold: 1, drafts: 1, sold: 2 });
  });
});

describe("bins & packing slips", () => {
  it("lists bins, items in a bin, and unshipped orders sorted by bin", async () => {
    const a = mk("Mug");
    db.prepare("UPDATE items SET location = 'B2' WHERE id = ?").run(mk("Plate"));
    const bins = (await request(app()).get("/api/bins")).body as { name: string; items: number }[];
    expect(bins.map((b) => b.name)).toEqual(["A1", "B2"]);
    expect(((await request(app()).get("/api/bins/A1")).body as unknown[]).length).toBe(1);
    recordSale(db, { itemId: a, marketplace: "etsy", salePrice: 20 });
    const slips = (await request(app()).get("/api/print/orders")).body;
    expect(slips.orders[0].location).toBe("A1");
    expect(slips.shop.thankYou).toMatch(/Thank you/);
  });
});

describe("returns", () => {
  it("records returns with reason and cost; partial refunds keep the sale", () => {
    const a = mk("Dress", { category: "Clothing > Women" });
    const b = mk("Jeans", { category: "Clothing > Men" });
    const c = mk("Lamp", { category: "Home" });
    const sa = recordSale(db, { itemId: a, marketplace: "poshmark", salePrice: 40 }) as { saleId: number };
    recordSale(db, { itemId: b, marketplace: "poshmark", salePrice: 50 });
    const sc = recordSale(db, { itemId: c, marketplace: "ebay", salePrice: 60 }) as { saleId: number };
    cancelSale(db, sa.saleId, { kind: "return", reason: "wrong_size", restock: true, returnShipping: 7.5, feesLost: 2 });
    cancelSale(db, sc.saleId, { kind: "partial_refund", reason: "not_as_described", refund: 15, restock: false });
    expect(getItem(db, a)!.quantity).toBe(1);
    expect((db.prepare("SELECT sale_price FROM sales WHERE id = ?").get(sc.saleId) as { sale_price: number }).sale_price).toBe(45);
    const r = returnsReport(db);
    expect(r.totals.returned).toBe(2);
    expect(r.totals.cost).toBe(9.5);
    const posh = r.byMarketplace.find((m) => m.marketplace === "poshmark")!;
    expect(posh).toMatchObject({ sold: 1, returned: 1, ratePct: 50 });
    expect(r.reasons.map((x) => x.reason).sort()).toEqual(["not_as_described", "wrong_size"]);
  });
});

describe("mileage", () => {
  it("logs trips as deductible expenses, remembers places, and nets them out of source profit", () => {
    const t = logTrip(db, { place: "Goodwill Main St", miles: 12.4, remember: true });
    expect(t.amount).toBe(8.68); // 12.4 * 0.70
    const again = logTrip(db, { place: "Goodwill Main St" }); // one tap: saved miles
    expect(again.miles).toBe(12.4);
    expect(logTrip(db, { place: "Post office", odometerStart: 1000, odometerEnd: 1004.5, purpose: "post office" }).miles).toBe(4.5);
    expect(() => logTrip(db, { place: "Nowhere" })).toThrow(/miles/);
    const s = mileageSummary(db);
    expect(s.trips).toBe(3);
    expect((db.prepare("SELECT COUNT(*) AS n FROM expenses WHERE category = 'mileage'").get() as { n: number }).n).toBe(3);
    const id = mk("Thrifted tee", { source: "Goodwill Main St", cost: 3 });
    recordSale(db, { itemId: id, marketplace: "vinted", salePrice: 30 });
    const src = profitReport(db).bySource.find((x) => x.key === "Goodwill Main St")!;
    expect(src.mileageCost).toBe(17.36);
    expect(src.profitAfterMileage).toBe(9.64);
    deleteTrip(db, again.id);
    expect((db.prepare("SELECT COUNT(*) AS n FROM expenses WHERE category = 'mileage'").get() as { n: number }).n).toBe(2);
  });
});

describe("Shippo labels (demo mode)", () => {
  it("needs an address, returns rates cheapest-first, buying records cost + tracking", async () => {
    const id = mk("Boots");
    const s = recordSale(db, { itemId: id, marketplace: "etsy", salePrice: 90 }) as { saleId: number };
    await expect(getRates(db, s.saleId)).rejects.toThrow(/address/);
    updateShipping(db, s.saleId, { shipTo: parseAddress("Ann Smith\n1 Elm St\nBoise, ID 83702")! });
    const { rates, demo } = await getRates(db, s.saleId);
    expect(demo).toBe(true);
    expect(rates[0].amount).toBeLessThanOrEqual(rates[1].amount);
    const before = (db.prepare("SELECT profit FROM sales WHERE id = ?").get(s.saleId) as { profit: number }).profit;
    const b = await buyLabel(db, s.saleId, rates[0]);
    expect(b.tracking).toMatch(/^DEMO/);
    const row = db.prepare("SELECT shipping_cost, label_source, shipped_at, profit FROM sales WHERE id = ?").get(s.saleId) as Record<string, unknown>;
    expect(row.shipping_cost).toBe(rates[0].amount);
    expect(row.label_source).toBe("shippo");
    expect(row.shipped_at).not.toBeNull();
    expect(row.profit as number).toBeCloseTo(before - rates[0].amount, 2);
  });
});

// Keep the extension flow covered alongside views (claim/complete still works with new columns).
describe("regression", () => {
  it("extension publish still completes", () => {
    const id = mk("Thing");
    crosslist(db, id, ["mercari"]);
    const j = claimExtensionJob(db, ["mercari"])!;
    completeJob(db, j.job.id, true, { externalId: "m1" });
    expect(getItem(db, id)!.listings[0].status).toBe("active");
  });
});
