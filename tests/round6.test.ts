import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import sharp from "sharp";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getItem, openDb, type Db } from "../server/db.js";
import { createApp } from "../server/app.js";
import { dHash, findDuplicates, hamming, titleSimilarity } from "../server/services/duplicates.js";
import { importSales, mapMarketplace, previewSales } from "../server/services/salesImport.js";
import { learn } from "../server/services/priceAdvice.js";
import { profitReport } from "../server/services/insights.js";
import { toShip } from "../server/services/shipping.js";

let db: Db;
const dir = path.join(os.tmpdir(), "fd-r6");
beforeEach(() => {
  delete process.env.FLIPDESK_PASSWORD;
  fs.mkdirSync(dir, { recursive: true });
  db = openDb(":memory:");
});
const app = () => createApp(db, { uploadDir: dir });

async function img(color: string, square = "#ffffff", w = 600) {
  return sharp({ create: { width: w, height: w, channels: 3, background: color } })
    .composite([{ input: Buffer.from(`<svg width="${w}" height="${w}"><rect x="${w * 0.3}" y="${w * 0.2}" width="${w * 0.4}" height="${w * 0.5}" fill="${square}"/><circle cx="${w * 0.2}" cy="${w * 0.8}" r="${w * 0.08}" fill="#000"/></svg>`) }])
    .jpeg()
    .toBuffer();
}

describe("phone upload links", () => {
  it("token-only access: add photos without logging in, expires, is limited to one item", async () => {
    process.env.FLIPDESK_PASSWORD = "pw";
    const a = app();
    const login = await request(a).post("/api/login").send({ password: "pw" });
    const cookie = login.headers["set-cookie"];
    const item = (await request(a).post("/api/items").set("Cookie", cookie).send({ title: "Phone item" })).body;
    const link = (await request(a).post(`/api/items/${item.id}/phone-link`).set("Cookie", cookie)).body;
    expect(link.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(link.hint).toMatch(/HOST=0.0.0.0/); // bound to localhost -> tells you how to reach it from a phone

    // phone: no cookie
    const info = await request(a).get(`/api/m/${link.token}`).expect(200);
    expect(info.body.title).toBe("Phone item");
    const up = await request(a).post(`/api/m/${link.token}/photos`).attach("photos", await img("#336699"), "IMG_1.jpg").expect(200);
    expect(up.body).toMatchObject({ added: 1, total: 1, autoWriting: false }); // titled item: no auto-write
    expect(getItem(db, item.id)!.photos).toHaveLength(1);
    // the token can't read anything else
    await request(a).get("/api/items").expect(401);
    // bad / expired tokens
    await request(a).get("/api/m/nope").expect(410);
    db.prepare("UPDATE upload_tokens SET expires_at = datetime('now','-1 minute')").run();
    await request(a).post(`/api/m/${link.token}/photos`).attach("photos", await img("#336699"), "IMG_2.jpg").expect(410);
    delete process.env.FLIPDESK_PASSWORD;
  });
});

describe("duplicate detection", () => {
  it("photo fingerprints match re-shot photos and differ for different items", async () => {
    const f1 = path.join(dir, "d1.jpg");
    const f2 = path.join(dir, "d2.jpg");
    const f3 = path.join(dir, "d3.jpg");
    fs.writeFileSync(f1, await img("#884422"));
    fs.writeFileSync(f2, await sharp(await img("#884422", "#ffffff", 1000)).modulate({ brightness: 1.1 }).jpeg({ quality: 70 }).toBuffer()); // bigger, brighter, recompressed
    fs.writeFileSync(f3, await sharp({ create: { width: 600, height: 600, channels: 3, background: "#225588" } }).composite([{ input: Buffer.from('<svg width="600" height="600"><circle cx="450" cy="150" r="120" fill="#fff"/></svg>') }]).jpeg().toBuffer());
    const [h1, h2, h3] = await Promise.all([dHash(f1), dHash(f2), dHash(f3)]);
    expect(hamming(h1, h2)).toBeLessThanOrEqual(6);
    expect(hamming(h1, h3)).toBeGreaterThan(12);
    expect(titleSimilarity("Nike Air Max 90 Infrared Mens 10", "Mens Nike Air Max 90 Infrared size 10")).toBeGreaterThanOrEqual(0.8);
    expect(titleSimilarity("Nike Air Max 90", "Coach Tabby Bag")).toBe(0);
  });

  it("finds photo and title duplicates, but not a lot and its own items", async () => {
    const mk = (title: string) => Number(db.prepare("INSERT INTO items (sku, title, price, quantity) VALUES (?, ?, 20, 1)").run(`D${Math.random()}`, title).lastInsertRowid);
    const addPhoto = (id: number, buf: Buffer) => {
      const f = path.join(dir, `p${Math.random()}.jpg`);
      fs.writeFileSync(f, buf);
      db.prepare("INSERT INTO photos (item_id, path) VALUES (?, ?)").run(id, f);
    };
    const a = mk("Vintage brown leather jacket");
    const b = mk("Something else entirely");
    const c = mk("Vintage Brown Leather Jacket Mens");
    const d = mk("Blue mug");
    addPhoto(a, await img("#884422"));
    addPhoto(b, await sharp(await img("#884422", "#ffffff", 900)).jpeg({ quality: 60 }).toBuffer());
    addPhoto(d, await sharp({ create: { width: 500, height: 500, channels: 3, background: "#225588" } }).composite([{ input: Buffer.from('<svg width="500" height="500"><circle cx="350" cy="150" r="90" fill="#fff"/></svg>') }]).jpeg().toBuffer());
    const hits = await findDuplicates(db, a);
    expect(hits.map((h) => [h.itemId, h.reason])).toEqual([
      [b, "photo"],
      [c, "title"],
    ]);
    // a lot sharing the cover photo is not a duplicate of its parts
    const lot = mk("Lot of 2");
    db.prepare("INSERT INTO bundle_items (bundle_id, item_id) VALUES (?, ?)").run(lot, a);
    const ph = db.prepare("SELECT path FROM photos WHERE item_id = ?").get(a) as { path: string };
    db.prepare("INSERT INTO photos (item_id, path) VALUES (?, ?)").run(lot, ph.path);
    expect((await findDuplicates(db, lot)).some((h) => h.itemId === a)).toBe(false);
    const r = await request(app()).get(`/api/items/${a}/duplicates`).expect(200);
    expect(r.body).toHaveLength(2);
  });
});

describe("sold-history import", () => {
  const CSV = `Order Number,Title,Platform,Sold Date,Date Listed,Sold Price,Shipping Charged,Shipping Cost,Fees,Cost,Brand,Category,Source
A-1,Patagonia Better Sweater M,Poshmark,2026-08-03,2026-07-20,$48.00,,0,$9.60,$6,Patagonia,Clothing > Men,Goodwill
A-2,Nike Dunk Low Panda 10,eBay,08/15/2026,08/01/2026,$110.00,$12.00,$11.50,,$45,Nike,Shoes,Retail
A-3,Mystery thing,Craigslist,2026-08-20,,$20,,,,,,,
A-4,No price thing,Mercari,2026-08-21,,,,,,,,,
`;
  it("maps marketplaces and previews with problems and warnings", () => {
    expect(mapMarketplace("Facebook Marketplace")).toBe("facebook");
    expect(mapMarketplace("POSHMARK")).toBe("poshmark");
    expect(mapMarketplace("Craigslist")).toBeNull();
    const p = previewSales(db, CSV);
    expect(p.ready).toBe(2);
    expect(p.problemCount).toBe(2);
    expect(p.byMarketplace).toEqual({ poshmark: 1, ebay: 1 });
    expect(p.from?.slice(0, 10)).toBe("2026-08-03");
    expect(p.revenue).toBe(170);
  });

  it("imports as quiet history: profit computed, already shipped, feeds reports + price advice, no double import", () => {
    const r = importSales(db, CSV);
    expect(r).toMatchObject({ imported: 2, attached: 0 });
    const sales = db.prepare("SELECT marketplace, sale_price, fees, profit, shipped_at, order_id FROM sales ORDER BY id").all() as Record<string, unknown>[];
    expect(sales[0]).toMatchObject({ marketplace: "poshmark", fees: 9.6, profit: 32.4, order_id: "hist:A-1" });
    // eBay fees estimated (13.6% of 122 + 0.40 = 16.99): 110 + 12 - 16.99 - 11.5 - 45 = 48.51
    expect(sales[1]).toMatchObject({ marketplace: "ebay", fees: 16.99, profit: 48.51 });
    expect(sales.every((s) => s.shipped_at)).toBe(true);
    expect(toShip(db, 3650)).toHaveLength(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM alerts").get() as { n: number }).n).toBe(0);
    const rep = profitReport(db, 3650);
    expect(rep.bySource.find((s) => s.key === "Goodwill")?.unitsSold).toBe(1);
    const model = learn(db, 3650);
    expect(model.overall?.n).toBe(2);
    expect(model.byCategory.find((c) => c.key === "clothing")?.medianDays).toBe(14);
    expect(importSales(db, CSV).imported).toBe(0); // dedupe by order number
  });

  it("attaches history to an existing SKU without touching its stock; needs a marketplace when no column", () => {
    const id = Number(db.prepare("INSERT INTO items (sku, title, quantity, status) VALUES ('KEEP-1', 'Tumbler', 5, 'active')").run().lastInsertRowid);
    const csv = `SKU,Title,Sold Price,Sold Date\nKEEP-1,Tumbler,$30,2026-09-01`;
    expect(previewSales(db, csv).warnings.join(" ")).toMatch(/marketplace/);
    const r = importSales(db, csv, "mercari");
    expect(r).toMatchObject({ imported: 1, attached: 1 });
    expect(getItem(db, id)!.quantity).toBe(5);
    expect(getItem(db, id)!.status).toBe("active");
  });
});
