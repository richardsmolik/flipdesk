import { beforeEach, describe, expect, it } from "vitest";
import { getItem, openDb, setSetting, type Db } from "../server/db.js";
import { lookupBarcode, normalizeCode } from "../server/services/barcode.js";
import { checkItem } from "../server/services/sourcing.js";
import { createBundle, createMultiBuy, suggestBundles } from "../server/services/bundles.js";
import { claimExtensionJob, completeJob, crosslist, processApiJobs } from "../server/services/jobs.js";
import { recordSale, restock } from "../server/services/sync.js";
import { buildDigest, isoWeek, sendDigest } from "../server/services/digest.js";
import { parseAddress, pirateShipExport, pirateShipImport, providerFor, toShip, updateShipping } from "../server/services/shipping.js";

let db: Db;
beforeEach(() => {
  delete process.env.EBAY_CLIENT_ID;
  delete process.env.ANTHROPIC_API_KEY;
  db = openDb(":memory:");
});

const mk = (title: string, o: Partial<{ brand: string; category: string; size: string; price: number; cost: number; qty: number; age: number; status: string }> = {}) =>
  Number(
    db
      .prepare(
        `INSERT INTO items (sku, title, brand, category, size, price, cost, min_price, quantity, quantity_purchased, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, datetime('now', ?))`,
      )
      .run(`I${Math.random().toString(36).slice(2, 8)}`, title, o.brand ?? "", o.category ?? "", o.size ?? "", o.price ?? 40, o.cost ?? 5, o.qty ?? 1, o.qty ?? 1, o.status ?? "active", `-${o.age ?? 0} days`).lastInsertRowid,
  );

async function goLive(id: number, sites: ("ebay" | "mercari" | "poshmark")[]) {
  crosslist(db, id, sites);
  await processApiJobs(db);
  for (let j; (j = claimExtensionJob(db, ["mercari", "poshmark"])); ) completeJob(db, j.job.id, true, { externalId: `x${j.job.id}` });
}
const status = (id: number, m: string) => getItem(db, id)!.listings.find((l) => l.marketplace === m)?.status;

describe("barcodes", () => {
  it("normalizes and validates UPC / EAN / ISBN-10 -> 13", () => {
    expect(normalizeCode("036000291452")).toEqual({ code: "036000291452", kind: "upc", valid: true });
    expect(normalizeCode("036000291453").valid).toBe(false);
    expect(normalizeCode("0-439-13959-7")).toEqual({ code: "9780439139595", kind: "isbn", valid: true });
    expect(normalizeCode("9780439139595").kind).toBe("isbn");
    expect(normalizeCode("4006381333931").kind).toBe("ean");
  });

  it("looks up books vs products, caches hits, skips invalid codes", async () => {
    let calls = 0;
    const fetcher = {
      isbn: async () => (calls++, { title: "Harry Potter and the Goblet of Fire by J. K. Rowling", brand: "Scholastic", category: "Books", image: null, source: "Open Library" }),
      upc: async () => (calls++, { title: "Stanley Quencher 40oz", brand: "Stanley", category: "Drinkware", image: null, source: "UPCitemdb" }),
    };
    const book = await lookupBarcode(db, "0439139597", fetcher);
    expect(book.found).toBe(true);
    expect(book.source).toBe("Open Library");
    await lookupBarcode(db, "0439139597", fetcher);
    expect(calls).toBe(1); // cached
    expect((await lookupBarcode(db, "036000291452", fetcher)).brand).toBe("Stanley");
    expect((await lookupBarcode(db, "123", fetcher)).source).toBe("invalid");
  });

  it("sourcing by barcode uses the exact product and errors helpfully when unknown", async () => {
    db.prepare("INSERT INTO barcode_cache (code, data) VALUES (?, ?)").run(
      "036000291452",
      JSON.stringify({ code: "036000291452", kind: "upc", found: true, title: "Stanley Quencher H2.0 40oz", brand: "Stanley", category: "Drinkware", image: null, source: "UPCitemdb" }),
    );
    const r = await checkItem(db, { barcode: "036000291452", askPrice: 5 });
    expect(r.identified.name).toBe("Stanley Quencher H2.0 40oz");
    expect(r.barcode?.found).toBe(true);
    await expect(checkItem(db, { barcode: "999" })).rejects.toThrow(/valid UPC/);
  });
});

describe("bundles (lots)", () => {
  it("creates a lot: cost = sum, price discounted, capacity = min stock", () => {
    const a = mk("Lululemon Align 6", { brand: "Lululemon", price: 48, cost: 9, qty: 2 });
    const b = mk("Lululemon Define 6", { brand: "Lululemon", price: 60, cost: 12, qty: 1 });
    const lot = createBundle(db, [{ itemId: a }, { itemId: b }], { discountPct: 10 });
    expect(lot.title).toMatch(/^Lot of 2 Lululemon/);
    expect(lot.cost).toBe(21);
    expect(lot.price).toBe(97.2);
    expect(lot.quantity).toBe(1);
    expect(lot.status).toBe("draft");
  });

  it("selling the lot consumes items and delists their own listings", async () => {
    const a = mk("Funko Grogu", { brand: "Funko", qty: 1 });
    const b = mk("Funko Mando", { brand: "Funko", qty: 1 });
    await goLive(a, ["ebay", "mercari"]);
    await goLive(b, ["ebay"]);
    const lot = createBundle(db, [{ itemId: a }, { itemId: b }]);
    await goLive(lot.id, ["ebay", "poshmark"]);
    const r = recordSale(db, { itemId: lot.id, marketplace: "ebay", salePrice: 60 });
    expect("bundles" in r && r.bundles.join(" ")).toMatch(/delisted/);
    expect(getItem(db, a)!.quantity).toBe(0);
    expect(status(a, "ebay")).toBe("ending");
    expect(status(a, "mercari")).toBe("ending");
    expect(status(b, "ebay")).toBe("ending");
    expect(status(lot.id, "poshmark")).toBe("ending");
    // Profit only counted once (on the lot).
    expect((db.prepare("SELECT COUNT(*) AS n FROM sales").get() as { n: number }).n).toBe(1);
  });

  it("selling an item on its own pulls the lot; restocking makes it fillable again", async () => {
    const a = mk("Pyrex bowl red", { brand: "Pyrex" });
    const b = mk("Pyrex bowl blue", { brand: "Pyrex" });
    const lot = createBundle(db, [{ itemId: a }, { itemId: b }]);
    await goLive(lot.id, ["ebay", "mercari"]);
    await goLive(a, ["mercari"]);
    const r = recordSale(db, { itemId: a, marketplace: "mercari", salePrice: 30 });
    expect("bundles" in r && r.bundles.join(" ")).toMatch(/can't be filled/);
    expect(getItem(db, lot.id)!.status).toBe("archived");
    expect(status(lot.id, "ebay")).toBe("ending");
    restock(db, a, 1, 5);
    expect(getItem(db, lot.id)!.quantity).toBe(1);
    expect(getItem(db, lot.id)!.status).toBe("draft");
  });

  it("suggests stale same-brand groups and never re-suggests items already in a live lot", () => {
    const x = mk("Patagonia fleece", { brand: "Patagonia", age: 45 });
    const y = mk("Patagonia vest", { brand: "Patagonia", age: 40 });
    mk("Random thing", { brand: "Acme" });
    const s = suggestBundles(db);
    const pat = s.find((g) => g.reason.includes("Patagonia"))!;
    expect(pat.itemIds.sort()).toEqual([x, y].sort());
    expect(pat.staleCount).toBe(2);
    expect(pat.bundlePrice).toBeLessThan(pat.separatePrice);
    createBundle(db, [{ itemId: x }, { itemId: y }]);
    expect(suggestBundles(db).some((g) => g.reason.includes("Patagonia"))).toBe(false);
  });

  it("refuses a lot from variation items or with too little stock", () => {
    const a = mk("A", { qty: 0 });
    const b = mk("B");
    expect(() => createBundle(db, [{ itemId: a }, { itemId: b }])).toThrow(/enough units/);
  });

  it("eBay multi-buy needs eBay listings; demo returns a promotion", async () => {
    const a = mk("Hot Wheels A", { brand: "Hot Wheels" });
    const b = mk("Hot Wheels B", { brand: "Hot Wheels" });
    await expect(createMultiBuy(db, [a, b], [{ minQuantity: 2, pctOff: 10 }])).rejects.toThrow(/live on eBay/);
    await goLive(a, ["ebay"]);
    await goLive(b, ["ebay"]);
    const r = await createMultiBuy(db, [a, b], [{ minQuantity: 2, pctOff: 10 }]);
    expect(r.demo).toBe(true);
    expect(r.listings).toBe(2);
  });
});

describe("weekly summary", () => {
  it("ISO weeks", () => {
    expect(isoWeek("2026-11-02")).toBe("2026-W45");
    expect(isoWeek("2026-01-01")).toBe("2026-W01");
    expect(isoWeek("2027-01-01")).toBe("2026-W53");
  });

  it("summarizes the week with actions", () => {
    const id = mk("Supreme hoodie", { cost: 100 });
    db.prepare("UPDATE items SET source = 'Goodwill' WHERE id = ?").run(id);
    recordSale(db, { itemId: id, marketplace: "grailed", salePrice: 300 });
    mk("Old jacket", { age: 33 });
    const d = buildDigest(db);
    expect(d.title).toMatch(/profit/);
    expect(d.body).toMatch(/Top sale: Supreme hoodie/);
    expect(d.body).toMatch(/Best source: Goodwill/);
    expect(d.body).toMatch(/Just crossed: Old jacket \(33d\)/);
  });

  it("sends once per week, only at the scheduled local time", async () => {
    setSetting(db, "weekly", { enabled: true, day: 1, hour: 8, timezone: "America/Chicago" });
    const mon7 = new Date("2026-11-02T13:00:00Z"); // 7am Chicago
    const mon9 = new Date("2026-11-02T15:00:00Z"); // 9am Chicago
    expect((await sendDigest(db, { now: mon7 })).sent).toBe(false);
    expect((await sendDigest(db, { now: mon9 })).sent).toBe(true);
    expect((await sendDigest(db, { now: new Date("2026-11-02T18:00:00Z") })).reason).toBe("already sent");
  });
});

describe("shipping", () => {
  it("defaults: prepaid on Poshmark, eBay labels on eBay, Pirate Ship elsewhere; settings override", () => {
    expect(providerFor(db, "poshmark")).toBe("marketplace");
    expect(providerFor(db, "ebay")).toBe("ebay");
    expect(providerFor(db, "etsy")).toBe("pirateship");
    setSetting(db, "shipping", { defaultProvider: "pirateship" });
    expect(providerFor(db, "ebay")).toBe("pirateship");
    setSetting(db, "shipping", { perMarketplace: { mercari: "pirateship" } });
    expect(providerFor(db, "mercari")).toBe("pirateship");
  });

  it("parses pasted addresses", () => {
    expect(parseAddress("Jane Doe\n123 Main St\nApt 4\nAustin, TX 78701")).toMatchObject({ name: "Jane Doe", line1: "123 Main St", line2: "Apt 4", city: "Austin", state: "TX", zip: "78701" });
    expect(parseAddress("just a name")).toBeNull();
  });

  it("Pirate Ship round trip: export with Order ID, import costs + tracking, profit recomputed", async () => {
    setSetting(db, "shipping", { defaultProvider: "pirateship" });
    const id = mk("Le Creuset Dutch Oven", { cost: 40, price: 199 });
    const r = recordSale(db, { itemId: id, marketplace: "etsy", salePrice: 199 });
    const saleId = (r as { saleId: number }).saleId;
    expect(pirateShipExport(db, [saleId]).missing).toHaveLength(1); // no address yet
    updateShipping(db, saleId, { shipTo: parseAddress("Sam Lee\n9 Oak Ave\nDenver, CO 80202")! });
    const exp = pirateShipExport(db, [saleId]);
    expect(exp.count).toBe(1);
    expect(exp.csv).toContain(`FD-${saleId}`);
    expect(exp.csv).toContain("Denver");

    const before = (db.prepare("SELECT profit FROM sales WHERE id = ?").get(saleId) as { profit: number }).profit;
    const history = `Created Date,Recipient,Tracking Number,Cost,Carrier,Order ID,Status\n2026-11-01,Sam Lee,9400111899223197428490,$18.42,USPS,FD-${saleId},Delivered\n2026-11-01,Nobody,9400000000000000000000,$5.00,USPS,,Delivered`;
    const imp = await pirateShipImport(db, history);
    expect(imp.matched).toBe(1);
    expect(imp.unmatched).toEqual(["nobody"]);
    const after = db.prepare("SELECT profit, shipping_cost, tracking, label_source, shipped_at FROM sales WHERE id = ?").get(saleId) as Record<string, unknown>;
    expect(after.shipping_cost).toBe(18.42);
    expect(after.tracking).toBe("9400111899223197428490");
    expect(after.label_source).toBe("pirateship");
    expect(after.profit).toBeCloseTo(before - 18.42, 2);
    expect(toShip(db).find((x) => x.id === saleId)).toBeUndefined(); // shipped
  });
});

describe("cancel / return", () => {
  it("oversold second order: remove the sale, stock stays at 0", async () => {
    const { cancelSale } = await import("../server/services/sync.js");
    const id = mk("Coach bag");
    recordSale(db, { itemId: id, marketplace: "poshmark", salePrice: 180 });
    const r = recordSale(db, { itemId: id, marketplace: "ebay", salePrice: 175 }) as { saleId: number; oversold: boolean };
    expect(r.oversold).toBe(true);
    cancelSale(db, r.saleId, { restock: false });
    expect((db.prepare("SELECT COUNT(*) AS n FROM sales").get() as { n: number }).n).toBe(1);
    expect(getItem(db, id)!.quantity).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE kind = 'oversell'").get() as { n: number }).n).toBe(0);
  });

  it("return: units back in stock without inflating 'purchased'", async () => {
    const { cancelSale } = await import("../server/services/sync.js");
    const id = mk("Jeans", { qty: 2 });
    const r = recordSale(db, { itemId: id, marketplace: "ebay", salePrice: 50 }) as { saleId: number };
    cancelSale(db, r.saleId, { restock: true, reason: "returned" });
    const it = getItem(db, id)!;
    expect(it.quantity).toBe(2);
    expect(it.quantity_purchased).toBe(2);
    expect(it.quantity_sold).toBe(0);
  });
});
