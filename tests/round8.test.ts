import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import os from "node:os";
import path from "node:path";
import { getSetting, openDb, type Db } from "../server/db.js";
import { createApp } from "../server/app.js";
import { onboarding } from "../server/services/onboarding.js";
import { recordSale } from "../server/services/sync.js";

let db: Db;
beforeEach(() => {
  delete process.env.EBAY_CLIENT_ID;
  db = openDb(":memory:");
});
const app = () => createApp(db, { uploadDir: path.join(os.tmpdir(), "fd-r8") });

describe("guided first run", () => {
  it("fresh install shows the welcome; the profile sets defaults without overwriting your own", async () => {
    let o = onboarding(db);
    expect(o.showWelcome).toBe(true);
    expect(o.doneCount).toBe(0);
    db.prepare("INSERT INTO settings (key, value) VALUES ('sourcing', ?)").run(JSON.stringify({ minProfit: 25, minRoiPct: 200 }));
    o = (await request(app()).post("/api/onboarding/profile").send({ marketplaces: ["poshmark", "mercari", "nope"], sells: ["clothing"], experience: "new" }).expect(200)).body;
    expect(o.showWelcome).toBe(false);
    expect(o.defaultMarketplaces).toEqual(["poshmark", "mercari"]); // invalid ids dropped
    expect(getSetting(db, "sourcing", null)).toEqual({ minProfit: 25, minRoiPct: 200 }); // kept your tuned targets
    expect(getSetting<{ defaultProvider?: string }>(db, "shipping", {}).defaultProvider).toBe("pirateship"); // no eBay chosen
    // eBay step is left out when you don't sell there; extension step included (Poshmark/Mercari)
    expect(o.steps.map((s: { key: string }) => s.key)).toEqual(["profile", "item", "crosslist", "extension", "notify", "sale"]);
    expect(o.steps[0].done).toBe(true);
  });

  it("steps tick themselves off from real activity", () => {
    const id = Number(db.prepare("INSERT INTO items (sku, title, price, quantity) VALUES ('O1', 'x', 10, 1)").run().lastInsertRowid);
    db.prepare("INSERT INTO photos (item_id, path) VALUES (?, '/tmp/x.jpg')").run(id);
    db.prepare("INSERT INTO listings (item_id, marketplace, status) VALUES (?, 'ebay', 'active')").run(id);
    recordSale(db, { itemId: id, marketplace: "ebay", salePrice: 10 });
    const done = Object.fromEntries(onboarding(db).steps.map((s) => [s.key, s.done]));
    expect(done).toMatchObject({ item: true, crosslist: true, sale: true, notify: false, ebay: false });
  });

  it("skip hides the welcome; hide hides the checklist separately", async () => {
    const a = app();
    let o = (await request(a).post("/api/onboarding/dismiss").send({ dismissed: true })).body;
    expect(o.showWelcome).toBe(false);
    expect(o.checklistHidden).toBe(false);
    o = (await request(a).post("/api/onboarding/dismiss").send({ checklist: true })).body;
    expect(o.checklistHidden).toBe(true);
  });
});

describe("navigation badges", () => {
  it("counts inbox, orders to ship, drafts and failed sync jobs", async () => {
    const id = Number(db.prepare("INSERT INTO items (sku, title, status, quantity) VALUES ('N1', 'x', 'draft', 1)").run().lastInsertRowid);
    db.prepare("INSERT INTO alerts (kind, title) VALUES ('oversell', 't')").run();
    recordSale(db, { itemId: id, marketplace: "etsy", salePrice: 5 });
    db.prepare("INSERT INTO jobs (marketplace, type, item_id, status) VALUES ('poshmark', 'publish', ?, 'failed')").run(id);
    db.prepare("INSERT INTO items (sku, title, status) VALUES ('N2', 'y', 'draft')").run();
    const c = (await request(app()).get("/api/nav-counts").expect(200)).body;
    expect(c).toEqual({ inbox: 1, toShip: 1, drafts: 1, failed: 1 });
  });
});
