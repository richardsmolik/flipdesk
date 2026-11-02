import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getItem, openDb, setSetting, type Db } from "../server/db.js";
import { Workspaces } from "../server/workspaces.js";
import { clearOutbox, outbox } from "../server/services/mailer.js";
import { processApiJobs } from "../server/services/jobs.js";
import { getProblem, listProblems } from "../server/services/replay.js";
import { replay } from "../scripts/replay.js";
import { firstWeek, startFirstWeek } from "../server/services/firstWeek.js";
import { timeAll } from "../scripts/perf.js";

const ENV = ["HOST", "PUBLIC_BASE_URL", "FLIPDESK_ALLOWED_HOSTS", "FLIPDESK_INVITE_CODE", "FLIPDESK_OWNER_EMAIL", "EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "SMTP_HOST", "FLIPDESK_PASSWORD"];
let dir: string;
beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-r16-"));
  clearOutbox();
});
afterEach(() => {
  for (const k of ENV) delete process.env[k];
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});
const single = (password = "") => {
  const shops = new Workspaces({ multiuser: false, mainDb: path.join(dir, "f.db"), password });
  return { shops, app: express().use(shops.handler()) };
};

describe("security", () => {
  it("sends protective headers; uploaded files are sandboxed", async () => {
    const { shops, app } = single();
    fs.mkdirSync(shops.get("main")!.uploadDir, { recursive: true });
    fs.writeFileSync(path.join(shops.get("main")!.uploadDir, "pic.jpg"), "x");
    const r = await request(app).get("/api/items").expect(200);
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["content-security-policy"]).toMatch(/frame-ancestors 'none'/);
    expect(r.headers["content-security-policy"]).toMatch(/script-src 'self'(;|$)/);
    const u = await request(app).get("/uploads/pic.jpg").expect(200);
    expect(u.headers["content-security-policy"]).toMatch(/sandbox/);
  });

  it("refuses requests addressed to other host names while local-only (DNS rebinding)", async () => {
    const { app } = single();
    await request(app).get("/api/items").set("Host", "attacker.example").expect(421);
    await request(app).get("/api/items").set("Host", "localhost:8787").expect(200);
    process.env.PUBLIC_BASE_URL = "https://flip.example.com";
    await request(app).get("/api/items").set("Host", "flip.example.com").expect(200);
    process.env.FLIPDESK_ALLOWED_HOSTS = "my-mac.local";
    await request(app).get("/api/items").set("Host", "my-mac.local:8787").expect(200);
    process.env.HOST = "0.0.0.0"; // public/LAN servers rely on sign-in instead (custom domains vary)
    await request(app).get("/api/items").set("Host", "anything.example").expect(200);
  });

  it("blocks changes coming from other websites (CSRF), but not the extension, phone links or webhooks", async () => {
    const { app } = single();
    await request(app).post("/api/items").set("Origin", "https://evil.example").send({ title: "x" }).expect(403);
    await request(app).post("/api/items").set("Sec-Fetch-Site", "cross-site").send({ title: "x" }).expect(403);
    await request(app).post("/api/items").set("Origin", "null").send({ title: "x" }).expect(403);
    const host = "127.0.0.1:8787";
    await request(app).post("/api/items").set("Host", host).set("Origin", `http://${host}`).send({ title: "ok" }).expect(201);
    await request(app).post("/api/items").send({ title: "no origin (curl, tests)" }).expect(201);
    await request(app).get("/api/items").set("Origin", "https://evil.example").expect(200); // reads are fine (no CORS for them anyway)
    expect((await request(app).post("/api/ext/email").set("Origin", "chrome-extension://abc").send("x")).status).toBe(401); // reached the token check
    expect((await request(app).post("/api/billing/webhook").set("Origin", "https://stripe.com").send("{}")).status).not.toBe(403);
  });

  it("rate-limits password guessing per address", async () => {
    const { app } = single("right-password");
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await request(app).post("/api/login").send({ password: "wrong" })).status;
    expect(last).toBe(429);
  });

  it("public hosted server: only FLIPDESK_OWNER_EMAIL can claim the owner account", async () => {
    process.env.HOST = "0.0.0.0";
    const shops = new Workspaces({ multiuser: true, dataDir: dir });
    const app = express().use(shops.handler());
    expect((await request(app).post("/api/auth/signup").send({ email: "eve@x.com", password: "long-enough-1" })).body.error).toMatch(/FLIPDESK_OWNER_EMAIL/);
    process.env.FLIPDESK_OWNER_EMAIL = "me@x.com";
    await request(app).post("/api/auth/signup").send({ email: "eve@x.com", password: "long-enough-1" }).expect(403);
    await request(app).post("/api/auth/signup").send({ email: "ME@x.com", password: "long-enough-1" }).expect(200);
  });

  it("server-wide routes never shadow a shop route (the Inbox bug)", () => {
    const root = fs.readFileSync("server/workspaces.ts", "utf8");
    const shop = fs.readFileSync("server/app.ts", "utf8");
    const rootRoutes = [...root.matchAll(/root\.(get|post|put|delete|patch)\("(\/api\/[^"]+)"/g)].map((m) => `${m[1]} ${m[2]}`);
    const shopRoutes = new Set([...shop.matchAll(/api\.(get|post|put|delete|patch)\("(\/[^"]+)"/g)].map((m) => `${m[1]} /api${m[2]}`));
    const clash = rootRoutes.filter((r) => shopRoutes.has(r) && !/ \/api\/(health|login)$/.test(r));
    expect(clash).toEqual([]);
  });
});

describe("speed", () => {
  it("main screens stay fast with 1,500 items", async () => {
    const rows = await timeAll(1500);
    const slow = rows.filter((r) => r.ms > 1500 || r.status !== 200);
    expect(slow).toEqual([]);
  }, 60_000);

  it("inventory is paged so big shops see everything", async () => {
    const { shops, app } = single();
    const db = shops.get("main")!.db;
    for (let i = 0; i < 620; i++) db.prepare("INSERT INTO items (sku, title, quantity, status) VALUES (?, ?, 1, 'active')").run(`S${i}`, `Item ${i}`);
    const first = await request(app).get("/api/items?view=inventory&limit=300").expect(200);
    expect(first.body).toHaveLength(300);
    expect(first.headers["x-total-count"]).toBe("620");
    const last = await request(app).get("/api/items?view=inventory&limit=300&offset=600").expect(200);
    expect(last.body).toHaveLength(20);
  });
});

describe("problem replay", () => {
  it("a final eBay failure saves a report with the exact requests; replaying it reproduces the error", async () => {
    process.env.EBAY_CLIENT_ID = "id";
    process.env.EBAY_CLIENT_SECRET = "secret";
    const db: Db = openDb(":memory:");
    const id = Number(db.prepare("INSERT INTO items (sku, title, price, quantity, notes, location) VALUES ('RP-1', 'Coach bag', 80, 1, 'bought from Sam', 'Bin A1')").run().lastInsertRowid);
    const lid = Number(db.prepare("INSERT INTO listings (item_id, marketplace, status, external_id, price, quantity) VALUES (?, 'ebay', 'active', '1234', 80, 1)").run(id).lastInsertRowid);
    db.prepare("INSERT INTO connections (marketplace, status, credentials) VALUES ('ebay', 'connected', ?)").run(JSON.stringify({ refresh_token: "r", access_token: "a", expires_at: Date.now() + 3600_000 }));
    db.prepare("INSERT INTO jobs (marketplace, type, item_id, listing_id, status, attempts) VALUES ('ebay', 'update', ?, ?, 'pending', 2)").run(id, lid);
    const answer = JSON.stringify({ errors: [{ errorId: 25002, message: "A user error has occurred. Offer not found." }] });
    vi.stubGlobal("fetch", async () => new Response(answer, { status: 400 }));
    await processApiJobs(db);
    vi.unstubAllGlobals();
    const list = listProblems(db);
    expect(list).toHaveLength(1);
    const report = getProblem(db, list[0].id);
    expect(report.exchanges.length).toBeGreaterThan(0);
    expect(report.exchanges[0]).toMatchObject({ status: 400 });
    expect(JSON.stringify(report)).not.toMatch(/bought from Sam|Bin A1|"a"|refresh/); // no notes, bin, tokens
    expect(report.item.sku).toBe("RP-1");

    const r = await replay(report, { quiet: true });
    expect(r.reproduced).toBe(true);
    expect(r.error).toBe(report.error);
    void getItem;
  });

  it("problem reports download from the Sync queue (one per failed job)", async () => {
    const { shops, app } = single();
    const db = shops.get("main")!.db;
    const id = Number(db.prepare("INSERT INTO items (sku, title) VALUES ('X1','x')").run().lastInsertRowid);
    const lid = Number(db.prepare("INSERT INTO listings (item_id, marketplace, status) VALUES (?, 'poshmark', 'pending')").run(id).lastInsertRowid);
    const jid = Number(db.prepare("INSERT INTO jobs (marketplace, type, item_id, listing_id, status) VALUES ('poshmark', 'publish', ?, ?, 'claimed')").run(id, lid).lastInsertRowid);
    const tok = (await import("../server/app.js")).extensionToken(db);
    await request(app).post(`/api/ext/jobs/${jid}/complete`).set("X-FlipDesk-Token", tok).send({ ok: false, error: "Poshmark said: category required" }).expect(200);
    const jobs = (await request(app).get("/api/jobs")).body;
    const failed = jobs.find((j: { id: number }) => j.id === jid);
    expect(failed.problemId).toBeTruthy();
    const dl = await request(app).get(`/api/problems/${failed.problemId}`).expect(200);
    expect(dl.headers["content-disposition"]).toMatch(/flipdesk-problem-/);
    expect(dl.body).toMatchObject({ error: "Poshmark said: category required", mode: "extension" });
  });
});

describe("first week", () => {
  it("one step a day, ticked off from real activity; welcome email lists the plan", async () => {
    const db: Db = openDb(":memory:");
    expect(firstWeek(db).show).toBe(false);
    startFirstWeek(db);
    let f = firstWeek(db) as Exclude<ReturnType<typeof firstWeek>, { show: false }> & { steps: { key: string; done: boolean }[] };
    expect(f).toMatchObject({ show: true, day: 1, doneCount: 0 });
    expect(f.today?.key).toBe("items");
    for (let i = 0; i < 5; i++) db.prepare("INSERT INTO items (sku, title) VALUES (?, 'x')").run(`F${i}`);
    setSetting(db, "notify", { ntfyTopic: "t" });
    const in3 = new Date(Date.now() + 2.5 * 86400_000);
    f = firstWeek(db, in3) as typeof f;
    expect(f.day).toBe(3);
    expect(f.steps.filter((s) => s.done).map((s) => s.key)).toEqual(["items", "alerts"]);
    expect(f.today?.key).toBe("crosslist"); // catch up on day 2 first
    expect(firstWeek(db, new Date(Date.now() + 11 * 86400_000)).show).toBe(false);

    process.env.SMTP_HOST = "test";
    const shops = new Workspaces({ multiuser: true, dataDir: dir });
    const app = express().use(shops.handler());
    await request(app).post("/api/auth/signup").send({ email: "owner@x.com", password: "long-enough-1" }).expect(200);
    process.env.FLIPDESK_INVITE_CODE = "inv";
    const m = request.agent(app);
    await m.post("/api/auth/signup").send({ email: "new@x.com", password: "long-enough-2", invite: "inv" }).expect(200);
    expect(outbox().find((x) => x.to === "new@x.com")).toMatchObject({ subject: "Welcome to FlipDesk: your first week" });
    expect((await m.get("/api/first-week")).body).toMatchObject({ show: true, day: 1 });
    await m.post("/api/first-week/hide").expect(200);
    expect((await m.get("/api/first-week")).body.show).toBe(false);
  });
});
