import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import request from "supertest";
import { getItem, openDb, type Db } from "../server/db.js";
import { createApp } from "../server/app.js";
import { detectInventoryColumns, downloadImage, importInventory, mapCondition, parseInventory, previewInventory } from "../server/services/inventoryImport.js";

let db: Db;
const dir = path.join(os.tmpdir(), "fd-imp");
let server: http.Server;
let base = "";

beforeAll(async () => {
  const jpg = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#3a7" } }).jpeg().toBuffer();
  server = http.createServer((req, res) => {
    if (req.url === "/a.jpg" || req.url === "/b.jpg") return void res.writeHead(200, { "content-type": "image/jpeg" }).end(jpg);
    if (req.url === "/page") return void res.writeHead(200, { "content-type": "text/html" }).end("<html>");
    if (req.url === "/redirect-private") return void res.writeHead(302, { location: "http://10.0.0.5/secret" }).end();
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  fs.mkdirSync(dir, { recursive: true });
  db = openDb(":memory:");
});

const VENDOO = () => `Title,Description,Brand,Condition,Price,Cost Price,Quantity,SKU,Bin Location,Image 1,Image 2
"Nike Air Max 90 Infrared",Great shape,Nike,Pre-owned - Excellent,"$95.00",$30,1,VN-1,A3,${base}/a.jpg,${base}/b.jpg
Levi's 501 32x30,,Levi's,NWT,59,8,2,VN-2,B1,,
,missing title row,,,,,,,,,`;

describe("inventory import", () => {
  it("maps Vendoo / List Perfectly / eBay style headers and conditions", () => {
    const m = detectInventoryColumns(["Title", "Cost Price", "Price", "Image 1", "Image 2", "Custom label (SKU)", "Item number", "Available quantity"]);
    expect(m.cost).toEqual([1]);
    expect(m.price).toEqual([2]);
    expect(m.images).toEqual([3, 4]);
    expect(m.sku).toEqual([5]);
    expect(m.ebayId).toEqual([6]);
    expect(m.quantity).toEqual([7]);
    expect(mapCondition("NWT")).toBe("new_with_tags");
    expect(mapCondition("Pre-owned - Excellent")).toBe("used_excellent");
    expect(mapCondition("For parts or not working")).toBe("for_parts");
    expect(parseInventory(VENDOO()).rows[0]).toMatchObject({ title: "Nike Air Max 90 Infrared", price: 95, cost: 30, sku: "VN-1", location: "A3", condition: "used_excellent" });
  });

  it("preview reports counts, duplicates and warnings", () => {
    db.prepare("INSERT INTO items (sku, title) VALUES ('VN-2', 'existing')").run();
    const p = previewInventory(db, VENDOO());
    expect(p.total).toBe(3);
    expect(p.withPhotos).toBe(1);
    expect(p.duplicates).toBe(1);
    expect(p.problems).toBe(1);
    expect(p.warnings.join(" ")).toMatch(/already exists/);
  });

  it("imports items, downloads photos, skips duplicates and bad rows", async () => {
    db.prepare("INSERT INTO items (sku, title) VALUES ('VN-2', 'existing')").run();
    const r = await importInventory(db, VENDOO(), { uploadDir: dir, allowPrivate: true, wait: true });
    expect(r.imported).toBe(1);
    expect(r.skipped.map((s) => s.reason)).toEqual(["SKU VN-2 already exists", "no title"]);
    expect(r.photos).toEqual({ ok: 2, failed: 0 });
    const item = getItem(db, (db.prepare("SELECT id FROM items WHERE sku = 'VN-1'").get() as { id: number }).id)!;
    expect(item.photos).toHaveLength(2);
    expect(item.status).toBe("draft");
    expect(item.quantity_purchased).toBe(1);
  });

  it("eBay active-listings report rows become tracked eBay listings", async () => {
    const csv = `Item number,Title,Custom label (SKU),Available quantity,Current price\n"125512345678","Canon AE-1 Program",CAM-1,1,$219.99`;
    const r = await importInventory(db, csv, { uploadDir: dir, wait: true });
    expect(r.imported).toBe(1);
    const item = getItem(db, (db.prepare("SELECT id FROM items WHERE sku = 'CAM-1'").get() as { id: number }).id)!;
    expect(item.status).toBe("active");
    expect(item.listings[0]).toMatchObject({ marketplace: "ebay", status: "active", external_id: "125512345678", price: 219.99 });
  });

  it("photo downloader refuses private addresses, redirects into them, and non-images", async () => {
    await expect(downloadImage(`${base}/a.jpg`, dir)).rejects.toThrow(/private/); // 127.0.0.1 without allowPrivate
    await expect(downloadImage("http://169.254.169.254/latest/meta-data", dir)).rejects.toThrow(/private/);
    await expect(downloadImage("http://[::1]/x.jpg", dir)).rejects.toThrow(/private/);
    await expect(downloadImage("file:///etc/passwd", dir)).rejects.toThrow(/http/);
    await expect(downloadImage(`${base}/page`, dir, { allowPrivate: true })).rejects.toThrow(/not an image/);
    // allowPrivate only for the first hop in this test server; the redirect target is still checked when not allowed
    await expect(downloadImage(`${base}/redirect-private`, dir, { allowPrivate: false })).rejects.toThrow(/private/);
  });

  it("HTTP: preview + import endpoints", async () => {
    const app = createApp(db, { uploadDir: dir });
    const csv = Buffer.from(`Name,Price,Qty\nStanley Tumbler,39.99,4`);
    const p = await request(app).post("/api/import/inventory/preview").attach("file", csv, "sheet.csv").expect(200);
    expect(p.body.total).toBe(1);
    const r = await request(app).post("/api/import/inventory").attach("file", csv, "sheet.csv").expect(200);
    expect(r.body.imported).toBe(1);
    const items = (await request(app).get("/api/items?view=drafts")).body;
    expect(items[0]).toMatchObject({ title: "Stanley Tumbler", price: 39.99, quantity: 4 });
  });
});
