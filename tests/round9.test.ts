import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import express from "express";
import sharp from "sharp";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, setSetting, type Db } from "../server/db.js";
import { createApp, extensionToken } from "../server/app.js";
import { candidates, today } from "../server/services/today.js";
import { goalLine, goalProgress, weekStart } from "../server/services/goals.js";
import { onboarding } from "../server/services/onboarding.js";
import { recordSale } from "../server/services/sync.js";
import { personalEnv, runInWorkspace } from "../server/context.js";
import { Workspaces } from "../server/workspaces.js";

let db: Db;
beforeEach(() => {
  delete process.env.FLIPDESK_PASSWORD;
  delete process.env.EBAY_CLIENT_ID;
  db = openDb(":memory:");
});
const jpg = () => sharp({ create: { width: 200, height: 200, channels: 3, background: "#468" } }).jpeg().toBuffer();
const item = (title: string, price = 50, extra = "") =>
  Number(db.prepare(`INSERT INTO items (sku, title, price, quantity, status, category${extra ? ", " + extra.split("=")[0] : ""}) VALUES (?, ?, ?, 1, 'active', 'Clothing'${extra ? ", ?" : ""})`).run(`S${Math.random()}`, title, price, ...(extra ? [extra.split("=")[1]] : [])).lastInsertRowid);

describe("today: do these 3 things", () => {
  it("puts oversells and late orders first, then lets you skip until tomorrow", async () => {
    const a = item("Jacket");
    db.prepare("INSERT INTO items (sku, title, status) VALUES ('D1', 'Draft thing', 'draft')").run();
    db.prepare("INSERT INTO alerts (kind, severity, title) VALUES ('oversell', 'critical', 'Sold twice')").run();
    recordSale(db, { itemId: a, marketplace: "etsy", salePrice: 50 });
    db.prepare("UPDATE sales SET sold_at = datetime('now','-3 days')").run();
    let t = today(db);
    expect(t.tasks.map((x) => x.key).slice(0, 2)).toEqual(["oversell", "ship"]);
    expect(t.tasks[1].why).toMatch(/3 days ago/);
    expect(t.tasks.some((x) => x.key === "drafts") || t.more > 0).toBe(true);
    const app = createApp(db, { uploadDir: path.join(os.tmpdir(), "fd-r9") });
    t = (await request(app).post("/api/today/skip").send({ key: "oversell" }).expect(200)).body;
    expect(t.tasks[0].key).toBe("ship");
  });

  it("suggests one price drop with a one-click Do it that updates every listing", async () => {
    const id = item("Old sweater", 40);
    db.prepare("UPDATE items SET min_price = 20 WHERE id = ?").run(id);
    db.prepare("INSERT INTO listings (item_id, marketplace, status, price, quantity, listed_at) VALUES (?, 'mercari', 'active', 40, 1, datetime('now','-40 days'))").run(id);
    const price = candidates(db).find((c) => c.key === `price-${id}`)!;
    expect(price.action?.price).toBeLessThan(40);
    const app = createApp(db, { uploadDir: path.join(os.tmpdir(), "fd-r9") });
    await request(app).post("/api/today/do").send({ key: price.key }).expect(200);
    expect((db.prepare("SELECT price FROM items WHERE id = ?").get(id) as { price: number }).price).toBe(price.action!.price);
    expect((db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type = 'update'").get() as { n: number }).n).toBe(1);
  });
});

describe("weekly goals", () => {
  it("weeks start Monday midnight in your time zone", () => {
    // Wed 2026-11-04 15:00 UTC = 9am Chicago (UTC-6 after DST ends Nov 1)
    expect(weekStart("America/Chicago", new Date("2026-11-04T15:00:00Z")).toISOString()).toBe("2026-11-02T06:00:00.000Z");
    expect(weekStart("UTC", new Date("2026-11-08T23:59:00Z")).toISOString()).toBe("2026-11-02T00:00:00.000Z");
    expect(weekStart("Asia/Tokyo", new Date("2026-11-01T20:00:00Z")).toISOString()).toBe("2026-11-01T15:00:00.000Z"); // already Mon in Tokyo
  });

  it("tracks listed / sold / profit with pace, feeds today and the weekly summary", async () => {
    setSetting(db, "weekly", { timezone: "UTC" });
    const app = createApp(db, { uploadDir: path.join(os.tmpdir(), "fd-r9") });
    let g = (await request(app).put("/api/goals").send({ listed: 10, sales: 2, profit: 0 }).expect(200)).body;
    expect(g.goals).toEqual({ listed: 10, sales: 2 }); // 0 = no goal
    const id = item("Hat", 30);
    db.prepare("INSERT INTO listings (item_id, marketplace, status, price, quantity, listed_at) VALUES (?, 'ebay', 'active', 30, 1, datetime('now'))").run(id);
    recordSale(db, { itemId: id, marketplace: "ebay", salePrice: 30 });
    recordSale(db, { itemId: item("Cap", 20), marketplace: "etsy", salePrice: 20 });
    g = goalProgress(db);
    const byKey = Object.fromEntries(g.rows.map((r: { key: string }) => [r.key, r]));
    expect(byKey.listed).toMatchObject({ done: 1, target: 10 });
    expect(byKey.sales).toMatchObject({ done: 2, status: "done" });
    expect(goalLine(db)).toMatch(/1\/10 listed · 2\/2 sold ✅/);
  });
});

describe("show me how", () => {
  it("every checklist step has plain steps", () => {
    for (const s of onboarding(db).steps) expect(s.how.length).toBeGreaterThan(0);
  });
});

describe("sample shop (single user)", () => {
  let dir: string;
  let shops: Workspaces;
  let app: express.Express;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-ws-"));
    shops = new Workspaces({ multiuser: false, mainDb: path.join(dir, "flipdesk.db"), password: "" });
    app = express().use(shops.handler());
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("opens a full sample shop next to your real one, then goes back, resets and deletes", async () => {
    const agent = request.agent(app);
    await agent.post("/api/items").send({ title: "My real item" }).expect(201);
    let w = (await agent.get("/api/workspace")).body;
    expect(w).toMatchObject({ mode: "single", current: "real", demoExists: false });

    w = (await agent.post("/api/workspace").send({ action: "enter_demo" }).expect(200)).body;
    expect(w.current).toBe("demo");
    const items = (await agent.get("/api/items")).body as { title: string; photos: { url: string }[] }[];
    expect(items.length).toBeGreaterThan(20);
    expect(items.some((i) => i.title === "My real item")).toBe(false);
    expect(items[0].photos[0].url).toMatch(/^\/uploads\/demo\//);
    await agent.get(items[0].photos[0].url).expect(200); // photos are served from the sample shop
    expect((await agent.get("/api/onboarding")).body.showWelcome).toBe(false);
    expect((await agent.get("/api/goals")).body.rows.length).toBe(3);

    // uploads inside the sample shop keep the shop through multer + body parsing
    const it2 = (await agent.post("/api/items").send({ title: "Demo upload" }).expect(201)).body;
    const up = await agent.post(`/api/items/${it2.id}/photos`).attach("photos", await jpg(), "a.jpg").expect(200);
    expect(JSON.stringify(up.body)).toMatch(/\/uploads\/demo\//);
    expect(fs.readdirSync(path.join(dir, "demo", "uploads")).length).toBeGreaterThan(30);
    // no real eBay in the sample shop
    await agent.get("/api/connections/ebay/auth-url").expect(400);

    await agent.post("/api/workspace").send({ action: "leave_demo" }).expect(200);
    expect((await agent.get("/api/items")).body.map((i: { title: string }) => i.title)).toEqual(["My real item"]);

    await agent.post("/api/workspace").send({ action: "reset_demo" }).expect(200);
    expect((await agent.get("/api/items")).body.some((i: { title: string }) => i.title === "Demo upload")).toBe(false);
    await agent.post("/api/workspace").send({ action: "delete_demo" }).expect(200);
    expect(fs.existsSync(path.join(dir, "demo", "flipdesk.db"))).toBe(false);
    expect((await agent.get("/api/workspace")).body).toMatchObject({ current: "real", demoExists: false });
  });

  it("phone links route to the shop that made them; personal .env keys stay out of the sample shop", async () => {
    const agent = request.agent(app);
    await agent.post("/api/workspace").send({ action: "enter_demo" });
    const it = (await agent.post("/api/items").send({ title: "Phone demo" })).body;
    const link = (await agent.post(`/api/items/${it.id}/phone-link`)).body;
    expect(link.token).toMatch(/^demo\./);
    await request(app).get(`/api/m/${link.token}`).expect(200); // no cookie, like a phone
    await request(app).get("/api/m/u9.nope").expect(410);

    process.env.SHIPPO_API_KEY = "shippo_test_x";
    const demo = shops.get("demo")!;
    const main = shops.get("main")!;
    expect(runInWorkspace(demo, () => personalEnv("SHIPPO_API_KEY"))).toBeUndefined();
    expect(runInWorkspace(main, () => personalEnv("SHIPPO_API_KEY"))).toBe("shippo_test_x");
    delete process.env.SHIPPO_API_KEY;
    // extension tokens differ per shop and route to it
    const tDemo = runInWorkspace(demo, () => extensionToken(demo.db));
    const tMain = runInWorkspace(main, () => extensionToken(main.db));
    expect(tDemo).toMatch(/^demo\./);
    expect(tMain).not.toMatch(/\./);
    await request(app).get("/api/ext/ping").set("X-FlipDesk-Token", tDemo).expect(200);
    await request(app).get("/api/ext/ping").set("X-FlipDesk-Token", tMain).expect(200);
    await request(app).get("/api/ext/ping").set("X-FlipDesk-Token", "demo." + tMain).expect(401);
  });

  it("the password covers the sample shop switch too", async () => {
    shops = new Workspaces({ multiuser: false, mainDb: path.join(dir, "p.db"), password: "pw" });
    app = express().use(shops.handler());
    await request(app).post("/api/workspace").send({ action: "enter_demo" }).expect(401);
    const agent = request.agent(app);
    await agent.post("/api/login").send({ password: "pw" }).expect(200);
    await agent.get("/api/workspace").expect(200);
    await agent.get("/api/items").expect(200);
  });
});

describe("hosted accounts", () => {
  let dir: string;
  let shops: Workspaces;
  let app: express.Express;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-mu-"));
    delete process.env.FLIPDESK_INVITE_CODE;
    shops = new Workspaces({ multiuser: true, dataDir: dir });
    app = express().use(shops.handler());
  });
  afterEach(() => {
    delete process.env.FLIPDESK_INVITE_CODE;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("first sign-up is the owner; others need the invite; each shop is private", async () => {
    const a = request.agent(app);
    const b = request.agent(app);
    expect((await request(app).get("/api/auth/mode")).body).toMatchObject({ mode: "accounts", signupsOpen: true, needsInvite: false });
    await a.get("/api/items").expect(401);
    expect((await a.post("/api/auth/signup").send({ email: "owner@x.com", password: "short" })).status).toBe(400);
    expect((await a.post("/api/auth/signup").send({ email: "owner@x.com", password: "long-enough-1" }).expect(200)).body.owner).toBe(true);

    expect((await b.post("/api/auth/signup").send({ email: "b@x.com", password: "long-enough-2" })).status).toBe(403); // closed
    process.env.FLIPDESK_INVITE_CODE = "flip-2026";
    expect((await b.post("/api/auth/signup").send({ email: "b@x.com", password: "long-enough-2", invite: "nope" })).status).toBe(403);
    expect((await b.post("/api/auth/signup").send({ email: "b@x.com", password: "long-enough-2", invite: "flip-2026" }).expect(200)).body.owner).toBe(false);
    expect((await b.post("/api/auth/signup").send({ email: "B@x.com", password: "long-enough-2", invite: "flip-2026" })).status).toBe(409);

    const mine = (await a.post("/api/items").send({ title: "Owner's jacket" }).expect(201)).body;
    const up = (await a.post(`/api/items/${mine.id}/photos`).attach("photos", await jpg(), "p.jpg").expect(200)).body;
    const url = JSON.stringify(up).match(/\/uploads\/u1\/[^"]+/)![0];
    await request(app).get(url).expect(200); // public photo URL (marketplaces fetch it)
    expect((await b.get("/api/items")).body).toEqual([]); // B can't see A's stock
    await b.post("/api/items").send({ title: "B's mug" }).expect(201);
    expect((await a.get("/api/items")).body.map((i: { title: string }) => i.title)).toEqual(["Owner's jacket"]);

    // each person gets their own sample shop
    await b.post("/api/workspace").send({ action: "enter_demo" }).expect(200);
    expect((await b.get("/api/items")).body.length).toBeGreaterThan(20);
    expect((await a.get("/api/workspace")).body).toMatchObject({ current: "real", demoExists: false });

    // only the owner's real shop may use personal .env keys
    process.env.IMAP_HOST = "imap.example.com";
    expect(runInWorkspace(shops.get("u1")!, () => personalEnv("IMAP_HOST"))).toBe("imap.example.com");
    expect(runInWorkspace(shops.get("u2")!, () => personalEnv("IMAP_HOST"))).toBeUndefined();
    delete process.env.IMAP_HOST;

    // extension tokens route to the right person
    const u1 = shops.get("u1")!;
    const extA = runInWorkspace(u1, () => extensionToken(u1.db));
    expect(extA.startsWith("u1.")).toBe(true);
    await request(app).get("/api/ext/ping").set("X-FlipDesk-Token", extA).expect(200);
    await request(app).get("/api/ext/ping").set("X-FlipDesk-Token", "u2." + extA.slice(3)).expect(401);
  });

  it("login, wrong password, logout", async () => {
    await request(app).post("/api/auth/signup").send({ email: "me@x.com", password: "long-enough-1" }).expect(200);
    const s = request.agent(app);
    expect((await s.post("/api/auth/login").send({ email: "me@x.com", password: "wrong-pass" })).status).toBe(401);
    await s.post("/api/auth/login").send({ email: "ME@x.com", password: "long-enough-1" }).expect(200);
    await s.get("/api/items").expect(200);
    await s.post("/api/auth/logout").expect(200);
    await s.get("/api/items").expect(401);
    for (let i = 0; i < 10; i++) await s.post("/api/auth/login").send({ email: "me@x.com", password: "bad" });
    expect((await s.post("/api/auth/login").send({ email: "me@x.com", password: "long-enough-1" })).status).toBe(429);
  });
});
