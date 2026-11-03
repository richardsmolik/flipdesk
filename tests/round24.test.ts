import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspaces } from "../server/workspaces.js";
import { setSetting, type Db } from "../server/db.js";
import { claimExtensionJob, processApiJobs } from "../server/services/jobs.js";
import { resetHealth } from "../server/health.js";

const KEYS = ["EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "EBAY_ENV", "PUBLIC_BASE_URL"];
let dir: string;
beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  resetHealth();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-r24-"));
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
function ebayOn(db: Db) {
  process.env.EBAY_CLIENT_ID = "id";
  process.env.EBAY_CLIENT_SECRET = "s";
  process.env.EBAY_ENV = "production";
  process.env.PUBLIC_BASE_URL = "https://flip.example.com";
  db.prepare("INSERT INTO connections (marketplace, status, credentials) VALUES ('ebay', 'connected', ?)").run(JSON.stringify({ refresh_token: "r", access_token: "a", expires_at: Date.now() + 3600_000 }));
  const puts: string[] = [];
  vi.stubGlobal("fetch", async (u: string, init?: RequestInit) => {
    const url = new URL(u);
    if (init?.method === "PUT") puts.push(JSON.parse(String(init.body)).product.title);
    if (url.pathname.endsWith("/oauth2/token")) return new Response(JSON.stringify({ access_token: "a", expires_in: 7200 }));
    if ((init?.method ?? "GET") === "GET" && url.pathname.endsWith("/offer")) return new Response(JSON.stringify({ offers: [{ offerId: "OF1" }] }));
    return new Response(null, { status: 204 });
  });
  return puts;
}
function item(db: Db, title = "Old title", price = 60, listedDaysAgo = 10) {
  const id = Number(db.prepare("INSERT INTO items (sku, title, price, status) VALUES (?, ?, ?, 'active')").run(`I${Math.random()}`, title, price).lastInsertRowid);
  db.prepare("INSERT INTO photos (item_id, path, position) VALUES (?, 'https://img.example.com/a.jpg', 0)").run(id);
  db.prepare("INSERT INTO listings (item_id, marketplace, status, price, external_id, listed_at, views, watchers) VALUES (?, 'ebay', 'active', ?, 'E1', datetime('now', ?), 100, 2)").run(id, price, `-${listedDaysAgo} days`);
  db.prepare("INSERT INTO listings (item_id, marketplace, status, price, listed_at) VALUES (?, 'poshmark', 'active', ?, datetime('now', ?))").run(id, price, `-${listedDaysAgo} days`);
  return id;
}

describe("history and undo", () => {
  it("every edit is in the item's history with where it went; undo puts the old values back everywhere", async () => {
    const { app, db } = shop();
    const puts = ebayOn(db);
    const id = item(db);
    await request(app).patch(`/api/items/${id}`).send({ title: "Shiny New Title", price: 55 }).expect(200);
    await processApiJobs(db);
    let h = (await request(app).get(`/api/items/${id}/history`).expect(200)).body;
    const edit = h.find((e: { kind: string }) => e.kind === "edit");
    expect(edit.changes).toEqual([{ field: "title", old: "Old title", new: "Shiny New Title" }, { field: "price", old: "$60.00", new: "$55.00" }]);
    expect(edit.pushes).toEqual(expect.arrayContaining([{ marketplace: "eBay", status: "done", error: null }, expect.objectContaining({ marketplace: "Poshmark", status: "pending" })]));
    expect(edit.canUndo).toBe(true);
    expect(h.some((e: { kind: string; title: string }) => e.kind === "listed" && /eBay/.test(e.title))).toBe(true);

    const u = (await request(app).post(`/api/items/${id}/history/${edit.batch}/undo`).expect(200)).body;
    expect(u).toMatchObject({ restored: ["title", "price"], skipped: [] });
    expect(u.item).toMatchObject({ title: "Old title", price: 60 });
    expect(puts.at(-1)).toBe("Old title"); // eBay got the old title back
    expect(db.prepare("SELECT price FROM listings WHERE marketplace = 'ebay'").get()).toEqual({ price: 60 });
    h = (await request(app).get(`/api/items/${id}/history`)).body;
    expect(h.find((e: { batch?: string }) => e.batch === edit.batch)).toMatchObject({ canUndo: false });
    expect(h[0]).toMatchObject({ title: "Undone" });
    await request(app).post(`/api/items/${id}/history/${edit.batch}/undo`).expect(400); // already undone
  });

  it("undo keeps fields you changed again since", async () => {
    const { app, db } = shop();
    ebayOn(db);
    const id = item(db);
    await request(app).patch(`/api/items/${id}`).send({ title: "Second", price: 50 }).expect(200);
    await request(app).patch(`/api/items/${id}`).send({ title: "Third" }).expect(200);
    const h = (await request(app).get(`/api/items/${id}/history`)).body as { batch: string; changes?: { field: string }[]; canUndo: boolean }[];
    const first = h.filter((e) => e.changes).at(-1)!;
    expect(first.canUndo).toBe(false); // title moved on, so the whole change isn't cleanly undoable from the list…
    const r = await request(app).post(`/api/items/${id}/history/${first.batch}/undo`).expect(200); // …but asking still restores what it can
    expect(r.body).toMatchObject({ restored: ["price"], skipped: ["title"] });
    expect(r.body.item).toMatchObject({ title: "Third", price: 60 });
  });

  it("did it help: views per day before vs after, watchers added, or 'sold N days after'", async () => {
    const { app, db } = shop();
    ebayOn(db);
    const id = item(db, "Lamp", 40, 10); // 100 views over 10 days = 10/day
    await request(app).patch(`/api/items/${id}`).send({ title: "Vintage Brass Lamp Mid Century" }).expect(200);
    // pretend the change was 5 days ago and the listing got 150 more views and 3 watchers since
    db.prepare("UPDATE item_changes SET at = datetime('now','-5 days')").run();
    db.prepare("UPDATE listings SET views = 250, watchers = 5 WHERE marketplace = 'ebay'").run();
    let imp = (await request(app).get(`/api/items/${id}/history`)).body.find((e: { kind: string }) => e.kind === "edit").impact;
    expect(imp).toMatchObject({ ready: true, early: true, viewsPerDayBefore: 10, viewsPerDayAfter: 30, changePct: 200, watchersAdded: 3 });
    db.prepare("INSERT INTO sales (item_id, marketplace, quantity, sale_price, sold_at) VALUES (?, 'ebay', 1, 40, datetime('now','-1 days'))").run(id);
    imp = (await request(app).get(`/api/items/${id}/history`)).body.find((e: { kind: string }) => e.kind === "edit").impact;
    expect(imp.soldDaysAfter).toBe(4);
    // too soon to tell
    const id2 = item(db, "Rug", 30);
    await request(app).patch(`/api/items/${id2}`).send({ title: "Wool Rug 5x7" }).expect(200);
    expect((await request(app).get(`/api/items/${id2}/history`)).body.find((e: { kind: string }) => e.kind === "edit").impact).toMatchObject({ ready: false });
  });
});

describe("batched pushes", () => {
  it("with batching on, edits wait (merged into one update) until the batch time; 'Push changes' sends now", async () => {
    const { app, db } = shop();
    const puts = ebayOn(db);
    await request(app).put("/api/auto-push").send({ on: true, delayMinutes: 60 }).expect(200);
    const id = item(db);
    const r1 = (await request(app).patch(`/api/items/${id}`).send({ title: "A" }).expect(200)).body;
    expect(r1.pushed[0].sendAt).toBeTruthy();
    await request(app).patch(`/api/items/${id}`).send({ title: "AB", description: "new" }).expect(200);
    await processApiJobs(db);
    expect(puts).toEqual([]); // nothing sent yet
    expect(claimExtensionJob(db, ["poshmark"])).toBeNull(); // the extension waits too
    const jobs = db.prepare("SELECT payload FROM jobs WHERE type = 'revise' AND marketplace = 'ebay'").all() as { payload: string }[];
    expect(jobs).toHaveLength(1);
    expect(JSON.parse(jobs[0].payload)).toMatchObject({ fields: ["title", "description"] });
    expect(JSON.parse(jobs[0].payload).batches).toHaveLength(2);
    // Push now
    await request(app).post(`/api/items/${id}/push`).expect(200);
    expect(puts).toEqual(["AB"]);
    expect(claimExtensionJob(db, ["poshmark"])?.job.type).toBe("revise");
  });

  it("after the batch time passes the waiting update goes out by itself", async () => {
    const { app, db } = shop();
    const puts = ebayOn(db);
    setSetting(db, "autoPush", { on: true, delayMinutes: 15 });
    const id = item(db);
    await request(app).patch(`/api/items/${id}`).send({ title: "Later" }).expect(200);
    await processApiJobs(db);
    expect(puts).toEqual([]);
    db.prepare("UPDATE jobs SET payload = json_set(payload, '$.notBefore', ?) WHERE type = 'revise'").run(new Date(Date.now() - 1000).toISOString());
    await processApiJobs(db);
    expect(puts).toEqual(["Later"]);
  });
});
