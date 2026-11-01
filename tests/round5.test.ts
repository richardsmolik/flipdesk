import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import sharp from "sharp";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getItem, openDb, type Db } from "../server/db.js";
import { createApp } from "../server/app.js";
import { adviceToOps, aiAdvice, editPhoto, retouchPhoto, revertPhoto } from "../server/services/photos.js";
import { accountDeletionChallenge, friendlyEbayError, parseEbayRedirect } from "../server/marketplaces/ebay.js";
import { advise, learn } from "../server/services/priceAdvice.js";
import { diagnose, importTrafficCsv, latestTraffic } from "../server/services/traffic.js";
import { crosslist, processApiJobs } from "../server/services/jobs.js";
import { recordSale } from "../server/services/sync.js";

let db: Db;
const dir = path.join(os.tmpdir(), "fd-r5");
beforeEach(() => {
  delete process.env.EBAY_CLIENT_ID;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLIPDROP_API_KEY;
  fs.mkdirSync(dir, { recursive: true });
  db = openDb(":memory:");
});
const app = () => createApp(db, { uploadDir: dir });

async function photoItem() {
  const file = path.join(dir, `p-${Math.random().toString(36).slice(2)}.jpg`);
  await sharp({ create: { width: 400, height: 300, channels: 3, background: "#808080" } })
    .composite([{ input: Buffer.from('<svg width="400" height="300"><rect x="40" y="40" width="40" height="40" fill="#ff0000"/><rect x="300" y="200" width="50" height="50" fill="#0000ff"/></svg>') }])
    .jpeg({ quality: 95 })
    .toFile(file);
  const item = Number(db.prepare("INSERT INTO items (sku, title) VALUES (?, 'Photo item')").run(`PH${Math.random()}`).lastInsertRowid);
  const pid = Number(db.prepare("INSERT INTO photos (item_id, path) VALUES (?, ?)").run(item, file).lastInsertRowid);
  return { item, pid, file };
}
const pixel = async (file: string, x: number, y: number) => {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
};
const photoPath = (pid: number) => (db.prepare("SELECT path FROM photos WHERE id = ?").get(pid) as { path: string }).path;

describe("photo editor", () => {
  it("rotate 90 + crop + square, keeps the original, revert restores it", async () => {
    const { pid, file } = await photoItem();
    await editPhoto(db, pid, [{ type: "rotate", deg: 90 }], dir);
    const m = await sharp(photoPath(pid)).metadata();
    expect([m.width, m.height]).toEqual([300, 400]);
    await editPhoto(db, pid, [{ type: "crop", x: 0, y: 0, w: 0.5, h: 0.5 }, { type: "square", size: 600 }], dir);
    const m2 = await sharp(photoPath(pid)).metadata();
    expect([m2.width, m2.height]).toEqual([600, 600]);
    expect((db.prepare("SELECT original_path FROM photos WHERE id = ?").get(pid) as { original_path: string }).original_path).toBe(file);
    revertPhoto(db, pid);
    expect(photoPath(pid)).toBe(file);
    expect(() => revertPhoto(db, pid)).toThrow(/original/);
  });

  it("brightness raises pixel values", async () => {
    const { pid } = await photoItem();
    const before = await pixel(photoPath(pid), 200, 150);
    await editPhoto(db, pid, [{ type: "adjust", brightness: 1.4 }], dir);
    const after = await pixel(photoPath(pid), 200, 150);
    expect(after[0]).toBeGreaterThan(before[0] + 20);
  });

  it("remove object (basic): painted red square becomes background, blue untouched", async () => {
    const { pid } = await photoItem();
    const mask = await sharp({ create: { width: 400, height: 300, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: Buffer.from('<svg width="400" height="300"><rect x="32" y="32" width="56" height="56" fill="white"/></svg>') }])
      .png()
      .toBuffer();
    const r = await retouchPhoto(db, pid, "removeObject", mask, dir);
    expect(r.engine).toMatch(/basic/);
    const red = await pixel(photoPath(pid), 60, 60);
    expect(red[0] - red[2]).toBeLessThan(25); // no longer red
    const blue = await pixel(photoPath(pid), 325, 225);
    expect(blue[2] - blue[0]).toBeGreaterThan(150); // still blue
  });

  it("background removal needs a key; AI advice demo + safe clamping", async () => {
    const { pid } = await photoItem();
    await expect(editPhoto(db, pid, [{ type: "removeBackground" }], dir)).rejects.toThrow(/KEY/);
    const { demo } = await aiAdvice(db, pid);
    expect(demo).toBe(true);
    const ops = adviceToOps({ rotate: "90", straighten_degrees: 40, crop: { x: 0, y: 0, w: 0.1, h: 0.1 }, brightness: 3, contrast: 1, saturation: 1, warmth: 0, remove_background: true, issues: [], tips: [] }, false);
    expect(ops.find((o) => o.type === "rotate" && o.deg !== 90)).toMatchObject({ deg: 10 }); // straighten clamped
    expect(ops.some((o) => o.type === "crop")).toBe(false); // too aggressive -> skipped
    expect(ops.find((o) => o.type === "adjust")).toMatchObject({ brightness: 1.4 });
    expect(ops.some((o) => o.type === "removeBackground")).toBe(false); // no key
  });

  it("HTTP: edit + capabilities", async () => {
    const { pid, item } = await photoItem();
    expect((await request(app()).get("/api/photos/capabilities")).body).toEqual({ ai: false, backgroundRemoval: false, aiRetouch: false });
    const r = await request(app()).post(`/api/photos/${pid}/edit`).send({ ops: [{ type: "flip", axis: "h" }] }).expect(200);
    expect(r.body.id).toBe(item);
    expect(r.body.photos[0].edited).toBe(true);
    await request(app()).post(`/api/photos/${pid}/edit`).send({ ops: [{ type: "explode" }] }).expect(400);
  });
});

describe("eBay real-account helpers", () => {
  it("parses the pasted redirect URL", () => {
    expect(parseEbayRedirect("https://relay.example/?code=v%5E1.1%23abc&state=xyz")).toEqual({ code: "v^1.1#abc", state: "xyz" });
    expect(() => parseEbayRedirect("https://relay.example/?error=declined")).toThrow(/code=/);
  });
  it("turns eBay errors into plain words", () => {
    expect(friendlyEbayError(400, JSON.stringify({ errors: [{ errorId: 25002, message: "A user error has occurred. The item specific Department is missing.", parameters: [{ name: "aspectName", value: "Department" }] }] }))).toMatch(/item specific "Department"/);
    expect(friendlyEbayError(403, JSON.stringify({ errors: [{ errorId: 1100, message: "Access denied" }] }))).toMatch(/Reconnect eBay/);
    expect(friendlyEbayError(500, "oops", "GET /x")).toMatch(/500/);
  });
  it("account deletion challenge = sha256(code + token + endpoint)", async () => {
    process.env.PUBLIC_BASE_URL = "https://fd.example";
    process.env.EBAY_VERIFICATION_TOKEN = "tok123";
    const expected = crypto.createHash("sha256").update("abc" + "tok123" + "https://fd.example/api/ebay/account-deletion").digest("hex");
    expect(await accountDeletionChallenge("abc")).toBe(expected);
    const r = await request(app()).get("/api/ebay/account-deletion?challenge_code=abc").expect(200);
    expect(r.body.challengeResponse).toBe(expected);
    delete process.env.PUBLIC_BASE_URL;
    delete process.env.EBAY_VERIFICATION_TOKEN;
  });
  it("auth state carries the return address so the relay can send eBay's answer home", async () => {
    process.env.EBAY_CLIENT_ID = "id";
    process.env.EBAY_CLIENT_SECRET = "sec";
    process.env.EBAY_RU_NAME = "ru";
    const r = await request(app()).get("/api/connections/ebay/auth-url?return=" + encodeURIComponent("http://localhost:5173")).expect(200);
    const state = new URL(r.body.url).searchParams.get("state")!;
    expect(Buffer.from(state.split(".")[1], "base64url").toString()).toBe("http://localhost:5173");
    await request(app()).get("/api/connections/ebay/auth-url?return=" + encodeURIComponent("javascript:alert(1)")).expect(400);
    await request(app()).post("/api/connections/ebay/paste").send({ url: "https://relay/?code=abc&state=stale" }).expect(400);
    delete process.env.EBAY_CLIENT_ID;
  });
  it("setup checklist without keys points to step 1", async () => {
    const r = await request(app()).get("/api/ebay/setup").expect(200);
    expect(r.body.ready).toBe(false);
    expect(r.body.steps[0]).toMatchObject({ key: "keys", done: false });
  });
});

describe("smart price advice", () => {
  function soldItem(cat: string, daysToSell: number, original: number, sold: number) {
    const id = Number(
      db
        .prepare("INSERT INTO items (sku, title, category, price, original_price, quantity, quantity_purchased, created_at) VALUES (?, 't', ?, ?, ?, 1, 1, datetime('now', ?))")
        .run(`S${Math.random()}`, cat, sold, original, `-${daysToSell + 5} days`).lastInsertRowid,
    );
    db.prepare("INSERT INTO listings (item_id, marketplace, status, price, listed_at) VALUES (?, 'ebay', 'sold', ?, datetime('now', ?))").run(id, sold, `-${daysToSell + 5} days`);
    db.prepare("INSERT INTO sales (item_id, marketplace, sale_price, sold_at) VALUES (?, 'ebay', ?, datetime('now', '-5 days'))").run(id, sold);
  }
  it("learns days-to-sell and discount per category and advises unsold items", () => {
    for (const d of [10, 12, 14, 16, 20, 30]) soldItem("Clothing > Men", d, 50, 40); // 20% below original
    const model = learn(db);
    const c = model.byCategory.find((x) => x.key === "clothing")!;
    expect(c.n).toBe(6);
    expect(c.medianDays).toBe(15);
    expect(c.medianDiscountPct).toBe(20);
    const listing = (age: number) => [{ id: 1, item_id: 1, variation_id: null, marketplace: "ebay", status: "active", external_id: null, url: null, price: 50, quantity: 1, views: 0, watchers: 0, error: null, listed_at: new Date(Date.now() - age * 86400_000).toISOString().replace("T", " ").slice(0, 19), ended_at: null }];
    const base = { id: 1, price: 50, original_price: 50, min_price: 30, category: "Clothing > Women", created_at: "2026-01-01 00:00:00" };
    expect(advise(db, { ...base, listings: listing(5) }, model).action).toBe("wait");
    expect(advise(db, { ...base, listings: listing(16) }, model).action).toBe("small_drop");
    const late = advise(db, { ...base, listings: listing(40) }, model);
    expect(late).toMatchObject({ action: "drop", pct: 20, newPrice: 40 });
    expect(advise(db, { ...base, price: 30, listings: listing(40) }, model).action).toBe("at_floor");
    expect(advise(db, { ...base, listings: listing(20) }, model, { impressions: 12, views: 1 }).action).toBe("fix_visibility");
  });
  it("records price history on edits", async () => {
    const id = Number(db.prepare("INSERT INTO items (sku, title, price) VALUES ('H1', 'x', 50)").run().lastInsertRowid);
    await request(app()).patch(`/api/items/${id}`).send({ price: 45 }).expect(200);
    const pc = db.prepare("SELECT old_price, new_price, reason FROM price_changes WHERE item_id = ?").get(id);
    expect(pc).toEqual({ old_price: 50, new_price: 45, reason: "manual" });
    expect(getItem(db, id)!.original_price).toBe(50);
  });
});

describe("eBay traffic", () => {
  it("imports the Seller Hub report (with title rows), diagnoses listings", async () => {
    const id = Number(db.prepare("INSERT INTO items (sku, title, price, cost, quantity, quantity_purchased, status) VALUES ('T1', 'Jacket', 80, 10, 1, 1, 'active')").run().lastInsertRowid);
    crosslist(db, id, ["ebay"]);
    await processApiJobs(db);
    const ext = getItem(db, id)!.listings[0].external_id!;
    const csv = `"Listings traffic report"\n"Oct 01, 2026 - Oct 31, 2026"\n\n"Listing title","eBay item ID","Item Start Date","Total impressions","Click-through rate = Page views from eBay site/Total impressions","Quantity sold","Sales conversion rate = Quantity sold/Total page views","Total page views"\n"Jacket","${ext}","Oct 01, 2026","2,450","0.6%","0","0%","15"\n"Other","999","Oct 02, 2026","50","2%","0","0%","1"`;
    const r = importTrafficCsv(db, csv);
    expect(r).toEqual({ total: 2, matched: 1 });
    const t = latestTraffic(db).get(getItem(db, id)!.listings[0].id)!;
    expect(t).toMatchObject({ impressions: 2450, views: 15, ctr: 0.6 });
    expect(diagnose(t, 30).code).toBe("not_clicked");
    expect(diagnose({ ...t, impressions: 40 }, 30).code).toBe("not_seen");
    expect(diagnose({ ...t, ctr: 3, views: 60 }, 30).code).toBe("not_bought");
    expect(diagnose(t, 3).code).toBe("too_new");
    expect(() => importTrafficCsv(db, "a,b\n1,2")).toThrow(/traffic report/);
  });
  it("stale radar includes diagnosis + advice", async () => {
    const id = Number(db.prepare("INSERT INTO items (sku, title, price, cost, quantity, quantity_purchased, status) VALUES ('T2', 'Bag', 80, 10, 1, 1, 'active')").run().lastInsertRowid);
    crosslist(db, id, ["ebay"]);
    await processApiJobs(db);
    db.prepare("UPDATE listings SET listed_at = datetime('now','-40 days')").run();
    const ext = getItem(db, id)!.listings[0].external_id!;
    importTrafficCsv(db, `eBay item ID,Total impressions,Total page views,Quantity sold\n${ext},30,2,0`);
    recordSale(db, { itemId: Number(db.prepare("INSERT INTO items (sku, title, price, quantity) VALUES ('Z', 'z', 10, 1)").run().lastInsertRowid), marketplace: "ebay", salePrice: 10 });
    const rows = (await request(app()).get("/api/tools/stale?days=30")).body as { diagnosis: { code: string }; advice: { action: string } }[];
    expect(rows[0].diagnosis.code).toBe("not_seen");
    expect(rows[0].advice.action).toBe("fix_visibility");
  });
});
