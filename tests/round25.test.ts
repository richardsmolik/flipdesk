import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspaces } from "../server/workspaces.js";
import { setSetting, type Db } from "../server/db.js";
import { processApiJobs } from "../server/services/jobs.js";
import { resetHealth } from "../server/health.js";
import { titleTestsTick } from "../server/services/titleTest.js";
import { buyerHours, nextBuyerTime } from "../server/services/buyerHours.js";

const KEYS = ["EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "EBAY_ENV", "PUBLIC_BASE_URL"];
let dir: string;
beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  resetHealth();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-r25-"));
});
afterEach(() => {
  for (const k of KEYS) delete process.env[k];
  vi.unstubAllGlobals();
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});
function shop() {
  const shops = new Workspaces({ dataDir: dir, mainDb: path.join(dir, "flipdesk.db"), mainUploads: path.join(dir, "uploads"), password: "" });
  return { shops, db: shops.get("main")!.db, app: express().use(shops.handler()) };
}
/** Fake eBay. `fail.on = true` makes updates fail. */
function ebayOn(db: Db) {
  process.env.EBAY_CLIENT_ID = "id";
  process.env.EBAY_CLIENT_SECRET = "s";
  process.env.EBAY_ENV = "production";
  process.env.PUBLIC_BASE_URL = "https://flip.example.com";
  db.prepare("INSERT INTO connections (marketplace, status, credentials) VALUES ('ebay', 'connected', ?)").run(JSON.stringify({ refresh_token: "r", access_token: "a", expires_at: Date.now() + 3600_000 }));
  const puts: string[] = [];
  const fail = { on: false };
  vi.stubGlobal("fetch", async (u: string, init?: RequestInit) => {
    const url = new URL(u);
    if (url.pathname.endsWith("/oauth2/token")) return new Response(JSON.stringify({ access_token: "a", expires_in: 7200 }));
    if (init?.method === "PUT") {
      if (fail.on) return new Response(JSON.stringify({ errors: [{ message: "Title has words eBay doesn't allow" }] }), { status: 400 });
      puts.push(JSON.parse(String(init.body)).product.title);
    }
    if ((init?.method ?? "GET") === "GET" && url.pathname.endsWith("/offer")) return new Response(JSON.stringify({ offers: [{ offerId: "OF1" }] }));
    return new Response(null, { status: 204 });
  });
  return { puts, fail };
}
function item(db: Db, title = "Old title", price = 60, opts: { brand?: string; ebayOnly?: boolean } = {}) {
  const id = Number(db.prepare("INSERT INTO items (sku, title, price, status, brand) VALUES (?, ?, ?, 'active', ?)").run(`I${Math.random()}`, title, price, opts.brand ?? "").lastInsertRowid);
  db.prepare("INSERT INTO photos (item_id, path, position) VALUES (?, 'https://img.example.com/a.jpg', 0)").run(id);
  db.prepare("INSERT INTO listings (item_id, marketplace, status, price, external_id, listed_at, views, watchers) VALUES (?, 'ebay', 'active', ?, ?, datetime('now', '-10 days'), 100, 2)").run(id, price, `E${id}`);
  if (!opts.ebayOnly) db.prepare("INSERT INTO listings (item_id, marketplace, status, price, listed_at) VALUES (?, 'poshmark', 'active', ?, datetime('now', '-10 days'))").run(id, price);
  return id;
}
const DAY = 86400_000;

describe("undo a whole bulk change", () => {
  it("bulk price change is one undoable group; items changed again since keep their new price", async () => {
    const { app, db } = shop();
    ebayOn(db);
    const a = item(db, "Lamp", 60);
    const b = item(db, "Rug", 40);
    const r = await request(app).post("/api/tools/bulk-price").send({ itemIds: [a, b], pct: -10 }).expect(200);
    expect(r.body).toHaveLength(2);
    const groups = (await request(app).get("/api/bulk-changes").expect(200)).body;
    expect(groups[0]).toMatchObject({ items: 2, fields: ["price"], pctExample: -10, allUndone: false });
    // history shows it once, as a bulk change
    const h = (await request(app).get(`/api/items/${a}/history`).expect(200)).body as { kind: string; title: string }[];
    expect(h.filter((e) => e.kind === "edit" && e.title === "Bulk change")).toHaveLength(1);
    expect(h.some((e) => e.kind === "drop")).toBe(false);
    await request(app).patch(`/api/items/${b}`).send({ price: 33 }).expect(200);
    const u = (await request(app).post(`/api/bulk-changes/${groups[0].grp}/undo`).expect(200)).body;
    expect(u).toMatchObject({ restored: 1, kept: 1, keptItems: [b] });
    expect((await request(app).get(`/api/items/${a}`)).body.price).toBe(60);
    expect((await request(app).get(`/api/items/${b}`)).body.price).toBe(33);
    expect(db.prepare("SELECT price FROM listings WHERE item_id = ? AND marketplace = 'ebay'").get(a)).toEqual({ price: 60 });
    expect((await request(app).get("/api/bulk-changes")).body[0].allUndone).toBe(true);
    await request(app).post(`/api/bulk-changes/${groups[0].grp}/undo`).expect(400);
  });
});

describe("updates that didn't go through", () => {
  it("shows on the dashboard list with the site's reason, and Retry sends it again", async () => {
    const { app, db } = shop();
    const { puts, fail } = ebayOn(db);
    const id = item(db, "Old title", 60, { ebayOnly: true });
    fail.on = true;
    await request(app).patch(`/api/items/${id}`).send({ title: "New title" }).expect(200);
    for (let i = 0; i < 3; i++) await processApiJobs(db);
    const f = (await request(app).get("/api/failed-updates").expect(200)).body;
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ itemId: id, marketplace: "eBay", fields: ["title"] });
    expect(f[0].error).toMatch(/doesn't allow/);
    expect((await request(app).get("/api/weekly-todo")).body[0]).toMatchObject({ kind: "failed-update" });
    fail.on = false;
    const r = (await request(app).post("/api/failed-updates/retry").send({}).expect(200)).body;
    expect(r).toMatchObject({ retried: 1, stillFailing: [] });
    expect(puts.at(-1)).toBe("New title");
    expect((await request(app).get("/api/weekly-todo")).body.some((t: { kind: string }) => t.kind.startsWith("failed"))).toBe(false);
  });
});

describe("what edits work in your shop", () => {
  it("learns that adding the brand helped and small drops didn't, and suggests it on an item that lacks it", async () => {
    const { app, db } = shop();
    ebayOn(db);
    const brandIds: number[] = [];
    for (const t of ["Glass bowl", "Casserole dish", "Mixing bowl set"]) {
      const id = item(db, t, 30, { brand: "Pyrex" });
      await request(app).patch(`/api/items/${id}`).send({ title: `Pyrex ${t}` }).expect(200);
      brandIds.push(id);
    }
    for (const t of ["Mug", "Plate", "Cup"]) {
      const id = item(db, t, 30);
      await request(app).patch(`/api/items/${id}`).send({ price: 28 }).expect(200);
    }
    db.prepare("UPDATE item_changes SET at = datetime('now','-5 days')").run();
    // brand items: 100 views over 10 days before, then +150 in 5 days (30/day, +200%); the price-drop items got nothing
    for (const id of brandIds) db.prepare("UPDATE listings SET views = 250 WHERE item_id = ? AND marketplace = 'ebay'").run(id);
    const l = (await request(app).get("/api/edit-lessons").expect(200)).body;
    expect(l.cases).toBe(6);
    expect(l.lessons.find((x: { kind: string }) => x.kind === "brand")).toMatchObject({ cases: 3, helped: 3, verdict: "helps", avgViewsPct: 200 });
    expect(l.lessons.find((x: { kind: string }) => x.kind === "drop-small")).toMatchObject({ cases: 3, helped: 0, verdict: "no help" });
    const fresh = item(db, "Pie dish", 20, { brand: "Pyrex" });
    const s = (await request(app).get(`/api/items/${fresh}/edit-suggestions`).expect(200)).body;
    expect(s[0]).toMatchObject({ kind: "brand", how: "Put “Pyrex” in the title" });
    expect(s[0].why).toMatch(/helped 3 of 3/);
    expect(s.some((x: { kind: string }) => x.kind === "drop-small")).toBe(false);
  });
});

describe("title A/B test", () => {
  it("runs A, switches every listing to B, then keeps the one with more views per day", async () => {
    const { app, db } = shop();
    const { puts } = ebayOn(db);
    const id = item(db, "Brass lamp", 40);
    const t0 = (await request(app).post(`/api/items/${id}/title-test`).send({ b: "Vintage Brass Table Lamp Mid Century", days: 7 }).expect(200)).body;
    expect(t0).toMatchObject({ phase: "a", a: "Brass lamp" });
    await request(app).post(`/api/items/${id}/title-test`).send({ b: "Another" }).expect(400); // one at a time
    // A: 8 days, 80 views (10/day)
    db.prepare("UPDATE title_tests SET started_at = ?").run(new Date(Date.now() - 8 * DAY).toISOString());
    db.prepare("UPDATE listings SET views = 180 WHERE marketplace = 'ebay'").run();
    titleTestsTick(db);
    await processApiJobs(db);
    expect(puts.at(-1)).toBe("Vintage Brass Table Lamp Mid Century");
    let t = (await request(app).get(`/api/items/${id}/title-test`)).body;
    expect(t).toMatchObject({ phase: "b", aStats: { views: 80, viewsPerDay: 10 } });
    // B: 8 days, 240 views (30/day)
    db.prepare("UPDATE title_tests SET switched_at = ?").run(new Date(Date.now() - 8 * DAY).toISOString());
    db.prepare("UPDATE listings SET views = 420 WHERE marketplace = 'ebay'").run();
    t = (await request(app).get(`/api/items/${id}/title-test`)).body;
    expect(t).toMatchObject({ phase: "done", winner: "b", bStats: { viewsPerDay: 30 } });
    expect(t.note).toMatch(/B won: 30 views\/day vs 10/);
    expect((await request(app).get(`/api/items/${id}`)).body.title).toBe("Vintage Brass Table Lamp Mid Century");
    const h = (await request(app).get(`/api/items/${id}/history`)).body as { title: string }[];
    expect(h.some((e) => e.title === "Title test")).toBe(true);
  });

  it("goes back to A when A did better; stops if you change the title yourself; a sale wins outright", async () => {
    const { app, db } = shop();
    ebayOn(db);
    const id = item(db, "Good title", 40);
    await request(app).post(`/api/items/${id}/title-test`).send({ b: "Worse title" }).expect(200);
    db.prepare("UPDATE title_tests SET started_at = ?").run(new Date(Date.now() - 8 * DAY).toISOString());
    db.prepare("UPDATE listings SET views = 260 WHERE marketplace = 'ebay'").run(); // A: 160
    titleTestsTick(db);
    db.prepare("UPDATE title_tests SET switched_at = ?").run(new Date(Date.now() - 8 * DAY).toISOString());
    db.prepare("UPDATE listings SET views = 300 WHERE marketplace = 'ebay'").run(); // B: 40
    titleTestsTick(db);
    expect((await request(app).get(`/api/items/${id}/title-test`)).body).toMatchObject({ phase: "done", winner: "a" });
    expect((await request(app).get(`/api/items/${id}`)).body.title).toBe("Good title");

    const id2 = item(db, "Two", 40);
    await request(app).post(`/api/items/${id2}/title-test`).send({ b: "Two B" }).expect(200);
    await request(app).patch(`/api/items/${id2}`).send({ title: "My own" }).expect(200);
    expect((await request(app).get(`/api/items/${id2}/title-test`)).body).toMatchObject({ phase: "done", note: expect.stringMatching(/changed the title yourself/) });

    const id3 = item(db, "Three", 40);
    await request(app).post(`/api/items/${id3}/title-test`).send({ b: "Three B" }).expect(200);
    db.prepare("INSERT INTO sales (item_id, marketplace, quantity, sale_price) VALUES (?, 'ebay', 1, 40)").run(id3);
    expect((await request(app).get(`/api/items/${id3}/title-test`)).body).toMatchObject({ phase: "done", winner: "a", note: "It sold with title A." });
    await request(app).post(`/api/items/${id3}/title-test/stop`).expect(404);
  });
});

describe("send edits when buyers are browsing", () => {
  it("learns the quiet hours from your sales and holds edits made then until they end", async () => {
    const { app, db } = shop();
    ebayOn(db);
    setSetting(db, "weekly", { timezone: "UTC" });
    expect(buyerHours(db)).toMatchObject({ learned: false, quietStart: 23, quietEnd: 7 }); // default until 20 sales
    const id = item(db);
    for (let i = 0; i < 24; i++) db.prepare("INSERT INTO sales (item_id, marketplace, quantity, sale_price, sold_at) VALUES (?, 'ebay', 1, 10, ?)").run(id, `2026-10-${String(1 + i).padStart(2, "0")} 0${1 + (i % 4)}:30:00`);
    const b = buyerHours(db);
    expect(b).toMatchObject({ learned: true, quietStart: 5, quietEnd: 13 });
    expect([1, 2, 3, 4]).toContain(b.busiestHour);
    expect(nextBuyerTime(db, new Date("2026-11-10T06:10:00Z")).toISOString()).toBe("2026-11-10T13:00:00.000Z");
    expect(nextBuyerTime(db, new Date("2026-11-10T02:00:00Z")).toISOString()).toBe("2026-11-10T02:00:00.000Z");

    await request(app).put("/api/auto-push").send({ on: true, delayMinutes: 0, buyerHours: true }).expect(200);
    vi.useFakeTimers({ now: new Date("2026-11-10T06:10:00Z"), toFake: ["Date"] });
    const r = (await request(app).patch(`/api/items/${id}`).send({ title: "Night edit" }).expect(200)).body;
    expect(r.pushed[0].sendAt).toBe("2026-11-10T13:00:00.000Z");
    expect((await request(app).get("/api/auto-push")).body).toMatchObject({ buyerHours: true, hours: { quietStart: 5, quietEnd: 13 } });
  });
});
