import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, setSetting, type Db } from "../server/db.js";
import { Workspaces } from "../server/workspaces.js";
import { clearOutbox } from "../server/services/mailer.js";
import { totpAt } from "../server/services/totp.js";
import { findRegressions, runSelfCheck } from "../server/services/selfcheck.js";
import { ebaySmokeTest } from "../server/services/ebaySmoke.js";
import { listProblems } from "../server/services/replay.js";

const ENV = ["FLIPDESK_INVITE_CODE", "FLIPDESK_GITHUB_REPO", "GITHUB_TOKEN", "EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "EBAY_ENV", "PUBLIC_BASE_URL", "SMTP_HOST"];
let dir: string;
beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-r17-"));
  clearOutbox();
});
afterEach(() => {
  for (const k of ENV) delete process.env[k];
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});
const code = (secret: string, offset = 0) => totpAt(secret, Math.floor(Date.now() / 30_000) + offset);

async function accounts() {
  const shops = new Workspaces({ multiuser: true, dataDir: dir });
  const app = express().use(shops.handler());
  const o = request.agent(app);
  await o.post("/api/auth/signup").send({ email: "owner@x.com", password: "owner-pass-1" }).expect(200);
  process.env.FLIPDESK_INVITE_CODE = "inv";
  const m = request.agent(app);
  await m.post("/api/auth/signup").send({ email: "mia@x.com", password: "member-pass-1", invite: "inv" }).expect(200);
  clearOutbox();
  return { shops, app, o, m };
}

describe("two-step sign-in (accounts)", () => {
  it("turn on with an authenticator code; sign-in then needs a code; codes can't be reused; recovery codes work once", async () => {
    const { app, o } = await accounts();
    expect((await o.get("/api/2fa")).body).toEqual({ enabled: false, recoveryLeft: 0 });
    const setup = (await o.post("/api/2fa/setup").expect(200)).body;
    expect(setup.otpauth).toMatch(/^otpauth:\/\/totp\/FlipDesk:owner%40x\.com\?secret=[A-Z2-7]+/);
    expect((await o.post("/api/2fa/enable").send({ code: "000000" })).status).toBe(400);
    const on = (await o.post("/api/2fa/enable").send({ code: code(setup.secret) }).expect(200)).body;
    expect(on.recoveryCodes).toHaveLength(10);
    await o.get("/api/items").expect(200); // still signed in on this device

    const fresh = request.agent(app);
    const step1 = (await fresh.post("/api/auth/login").send({ email: "owner@x.com", password: "owner-pass-1" }).expect(200)).body;
    expect(step1.needs2fa).toBe(true);
    await fresh.get("/api/items").expect(401); // the password alone isn't enough
    await fresh.post("/api/login/2fa").send({ ticket: step1.ticket, code: "123456" }).expect(401);
    const c = code(setup.secret, 1);
    await fresh.post("/api/login/2fa").send({ ticket: step1.ticket, code: c }).expect(200);
    await fresh.get("/api/items").expect(200);

    // the same code can't be used twice
    const again = request.agent(app);
    const t2 = (await again.post("/api/auth/login").send({ email: "owner@x.com", password: "owner-pass-1" })).body.ticket;
    await again.post("/api/login/2fa").send({ ticket: t2, code: c }).expect(401);
    // a recovery code works once
    const r = (await again.post("/api/login/2fa").send({ ticket: t2, code: on.recoveryCodes[0] }).expect(200)).body;
    expect(r.recoveryLeft).toBe(9);
    const third = request.agent(app);
    const t3 = (await third.post("/api/auth/login").send({ email: "owner@x.com", password: "owner-pass-1" })).body.ticket;
    await third.post("/api/login/2fa").send({ ticket: t3, code: on.recoveryCodes[0] }).expect(401);

    // a reset link never signs in by itself when two-step is on
    const link = (await o.post("/api/admin/accounts/1/reset-link").expect(200)).body.link;
    const reset = (await request(app).post("/api/auth/reset").send({ token: new URL(link).searchParams.get("token"), password: "new-owner-pass" }).expect(200));
    expect(reset.body).toEqual({ ok: true, signIn: true });
    expect(reset.headers["set-cookie"]).toBeUndefined();

    // turning it off needs a code
    const back = request.agent(app);
    const t4 = (await back.post("/api/auth/login").send({ email: "owner@x.com", password: "new-owner-pass" })).body.ticket;
    await back.post("/api/login/2fa").send({ ticket: t4, code: on.recoveryCodes[1] }).expect(200);
    await back.post("/api/2fa/disable").send({ code: "nope" }).expect(400);
    await back.post("/api/2fa/disable").send({ code: on.recoveryCodes[2] }).expect(200);
    expect((await request(app).post("/api/auth/login").send({ email: "owner@x.com", password: "new-owner-pass" })).body).toEqual({ ok: true });
  });

  it("five wrong codes end the attempt", async () => {
    const { app, o } = await accounts();
    const s = (await o.post("/api/2fa/setup")).body.secret;
    await o.post("/api/2fa/enable").send({ code: code(s) }).expect(200);
    const a = request.agent(app);
    const t = (await a.post("/api/auth/login").send({ email: "owner@x.com", password: "owner-pass-1" })).body.ticket;
    for (let i = 0; i < 5; i++) await a.post("/api/login/2fa").send({ ticket: t, code: "111111" }).expect(401);
    await a.post("/api/login/2fa").send({ ticket: t, code: code(s, 1) }).expect(429);
  });
});

describe("two-step sign-in (single password)", () => {
  it("after turning it on, the password alone (or an old cookie) no longer gets in", async () => {
    const shops = new Workspaces({ multiuser: false, mainDb: path.join(dir, "f.db"), password: "pw-123" });
    const app = express().use(shops.handler());
    const a = request.agent(app);
    await a.post("/api/login").send({ password: "pw-123" }).expect(200);
    const oldCookie = (await request(app).post("/api/login").send({ password: "pw-123" })).headers["set-cookie"];
    await a.get("/api/items").expect(200);
    const s = (await a.post("/api/2fa/setup").expect(200)).body.secret;
    await a.post("/api/2fa/enable").send({ code: code(s) }).expect(200);
    await a.get("/api/items").expect(200); // this device got a real session
    await request(app).get("/api/items").set("Cookie", oldCookie).expect(401); // the password-derived cookie is dead
    const b = request.agent(app);
    const t = (await b.post("/api/login").send({ password: "pw-123" }).expect(200)).body;
    expect(t.needs2fa).toBe(true);
    await b.post("/api/login/2fa").send({ ticket: t.ticket, code: code(s, 1) }).expect(200);
    await b.get("/api/items").expect(200);
  });
});

describe("activity log", () => {
  it("records sign-ins, failures and owner actions; only the owner can read it", async () => {
    const { app, o, m } = await accounts();
    await request(app).post("/api/auth/login").send({ email: "mia@x.com", password: "wrong" });
    await o.post("/api/admin/invites").send({ note: "Sam" });
    await o.post("/api/backups").expect(200);
    await m.get("/api/audit").expect(403);
    const log = (await o.get("/api/audit").expect(200)).body as { actor: string; action: string; detail: string }[];
    const actions = log.map((l) => `${l.actor}: ${l.action}`);
    expect(actions).toEqual(expect.arrayContaining(["owner@x.com: owner account created", "mia@x.com: signed up", "mia@x.com: sign-in failed", "owner@x.com: invite link made", "owner@x.com: backup made"]));
    expect((await o.get("/api/audit?q=invite")).body).toHaveLength(1);
  });
});

describe("sending problem reports", () => {
  const failJob = (db: Db) => {
    const id = Number(db.prepare("INSERT INTO items (sku, title) VALUES ('P1','Mug')").run().lastInsertRowid);
    const lid = Number(db.prepare("INSERT INTO listings (item_id, marketplace, status) VALUES (?, 'poshmark', 'pending')").run(id).lastInsertRowid);
    return Number(db.prepare("INSERT INTO jobs (marketplace, type, item_id, listing_id, status) VALUES ('poshmark', 'publish', ?, ?, 'claimed')").run(id, lid).lastInsertRowid);
  };

  it("asks in the Inbox; owner's yes files a GitHub issue with the replayable JSON", async () => {
    const shops = new Workspaces({ multiuser: false, mainDb: path.join(dir, "f.db"), password: "" });
    const app = express().use(shops.handler());
    const db = shops.get("main")!.db;
    const jid = failJob(db);
    const tok = (await import("../server/app.js")).extensionToken(db);
    await request(app).post(`/api/ext/jobs/${jid}/complete`).set("X-FlipDesk-Token", tok).send({ ok: false, error: "category required" }).expect(200);
    const alerts = (await request(app).get("/api/alerts")).body;
    const ask = alerts.find((a: { kind: string }) => a.kind === "problem");
    expect(ask.data.problemId).toBeTruthy();
    // not configured: clear message
    expect((await request(app).post(`/api/problems/${ask.data.problemId}/send`).send({})).body.error).toMatch(/GITHUB_TOKEN/);
    process.env.FLIPDESK_GITHUB_REPO = "richardsmolik/flipdesk";
    process.env.GITHUB_TOKEN = "ghp_test";
    let sent: { url: string; body: { title: string; body: string } } | null = null;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => ((sent = { url, body: JSON.parse(String(init.body)) }), new Response(JSON.stringify({ html_url: "https://github.com/richardsmolik/flipdesk/issues/7" }), { status: 201 })));
    const r = (await request(app).post(`/api/problems/${ask.data.problemId}/send`).send({ note: "Happens on every Poshmark item" }).expect(200)).body;
    expect(r.sentTo).toBe("https://github.com/richardsmolik/flipdesk/issues/7");
    expect(sent!.url).toBe("https://api.github.com/repos/richardsmolik/flipdesk/issues");
    expect(sent!.body.title).toMatch(/^\[Problem report\] poshmark publish failed: category required/);
    expect(sent!.body.body).toMatch(/scripts\/replay\.ts/);
    expect(sent!.body.body).toMatch(/Happens on every Poshmark item/);
    expect((await request(app).get("/api/alerts")).body.some((a: { kind: string }) => a.kind === "problem")).toBe(false); // the question is answered
  });

  it("a member's report goes to the owner first, who can forward it", async () => {
    const { shops, o, m } = await accounts();
    const db = shops.get("u2")!.db;
    const jid = failJob(db);
    const { saveProblem } = await import("../server/services/replay.js");
    saveProblem(db, { job: db.prepare("SELECT * FROM jobs WHERE id = ?").get(jid) as never, error: "photo upload failed", mode: "extension" });
    const id = listProblems(db)[0].id;
    expect((await m.post(`/api/problems/${id}/send`).send({}).expect(200)).body.sentTo).toBe("owner");
    const fb = (await o.get("/api/admin/feedback")).body.feedback[0];
    expect(fb.message).toMatch(/Problem report: photo upload failed/);
    process.env.FLIPDESK_GITHUB_REPO = "richardsmolik/flipdesk";
    process.env.GITHUB_TOKEN = "ghp_test";
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ html_url: "https://github.com/x/y/issues/8" }), { status: 201 }));
    expect((await o.post(`/api/admin/feedback/${fb.id}/send-report`).expect(200)).body.sentTo).toBe("https://github.com/x/y/issues/8");
    await m.post(`/api/admin/feedback/${fb.id}/send-report`).expect(403);
  });
});

describe("nightly self-check", () => {
  it("times screens, checks databases and disk; flags only real slowdowns", async () => {
    const db = openDb(path.join(dir, "s.db"));
    const r = await runSelfCheck({ dbs: [{ name: "shop", db }], dataDir: dir, history: [], items: 150 });
    expect(r.ok).toBe(true);
    expect(r.speed.length).toBeGreaterThan(10);
    expect(r.speed.every((s) => s.ok)).toBe(true);
    expect(r.databases).toEqual([{ name: "shop", ok: true, detail: "ok" }]);
    expect(r.disk?.freeGB).toBeGreaterThan(0);
    const hist = [40, 50, 60].map((ms) => ({ speed: [{ path: "/a", ms }, { path: "/b", ms }] }));
    expect(findRegressions([{ path: "/a", ms: 900 }, { path: "/b", ms: 90 }], hist)).toEqual([{ path: "/a", ms: 900, usual: 50 }]);
    expect(findRegressions([{ path: "/a", ms: 900 }], hist.slice(0, 2))).toEqual([]); // not enough history yet
  }, 30_000);

  it("owner can run it; it shows on Status and the launch checklist", async () => {
    const shops = new Workspaces({ multiuser: false, mainDb: path.join(dir, "f.db"), password: "" });
    const app = express().use(shops.handler());
    const r = (await request(app).post("/api/selfcheck").expect(200)).body;
    expect(r.ok).toBe(true);
    const st = (await request(app).get("/api/status")).body;
    expect(st.services.find((x: { key: string }) => x.key === "self-check").state).toBe("ok");
    expect((await request(app).get("/api/launch")).body.checks.find((c: { key: string }) => c.key === "selfcheck").state).toBe("ok");
  }, 30_000);
});

describe("eBay smoke test", () => {
  const setup = () => {
    process.env.EBAY_CLIENT_ID = "id";
    process.env.EBAY_CLIENT_SECRET = "secret";
    process.env.PUBLIC_BASE_URL = "https://flip.example.com"; // photos by URL (no upload) in this test
    const db = openDb(":memory:");
    db.prepare("INSERT INTO connections (marketplace, status, credentials) VALUES ('ebay', 'connected', ?)").run(JSON.stringify({ refresh_token: "r", access_token: "a", expires_at: Date.now() + 3600_000 }));
    setSetting(db, "ebay", { fulfillmentPolicyId: "f", paymentPolicyId: "p", returnPolicyId: "r", merchantLocationKey: "loc" });
    return db;
  };
  const ebay = (fail?: string) => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      const u = new URL(input);
      const m = (init?.method ?? "GET").toUpperCase();
      calls.push(`${m} ${u.pathname}`);
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
      if (fail && u.pathname.includes(fail)) return json({ errors: [{ errorId: 25007, message: "Invalid shipping policy for this category." }] }, 400);
      if (u.pathname.endsWith("/oauth2/token")) return json({ access_token: "app", expires_in: 7200 });
      if (u.pathname.includes("_policy")) return json({ fulfillmentPolicies: [{}], paymentPolicies: [{}], returnPolicies: [{}] });
      if (u.pathname.includes("get_category_suggestions")) return json({ categorySuggestions: [{ category: { categoryId: "1", categoryName: "Collectibles" } }] });
      if (u.pathname.includes("/inventory_item/")) return new Response(null, { status: 204 });
      if (m === "POST" && u.pathname.endsWith("/offer")) return json({ offerId: "OF1" });
      if (u.pathname.endsWith("/publish")) return json({ listingId: "110012345" });
      if (m === "GET" && u.pathname.endsWith("/offer")) return json({ offers: [{ offerId: "OF1" }] });
      if (u.pathname.endsWith("/withdraw")) return json({ listingId: "110012345" });
      return json({});
    });
    return calls;
  };

  it("lists and ends a test item on the sandbox, step by step, and leaves nothing behind", async () => {
    const db = setup();
    const calls = ebay();
    const r = await ebaySmokeTest(db, path.join(dir, "up"));
    expect(r.ok).toBe(true);
    expect(r.env).toBe("sandbox");
    expect(r.steps.map((s) => s.name)).toEqual(["eBay connected", "Safe place to test", "Policies and ship-from location chosen", "Reach your eBay account", "Make a test item", "List it on eBay", "End the listing", "Clean up on eBay"]);
    expect(r.steps.find((s) => s.name === "List it on eBay")!.detail).toBe("Listing 110012345");
    expect(calls.filter((c) => !c.includes("token") && !c.includes("_policy") && !c.includes("category"))).toEqual(expect.arrayContaining(["PUT /sell/inventory/v1/inventory_item/" + calls.find((c) => c.startsWith("PUT"))!.split("/").pop(), "POST /sell/inventory/v1/offer", "POST /sell/inventory/v1/offer/OF1/publish", "POST /sell/inventory/v1/offer/OF1/withdraw"]));
    expect(calls.some((c) => c.startsWith("DELETE /sell/inventory/v1/inventory_item/FDSMOKE-"))).toBe(true);
    expect((db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n).toBe(0);
    expect(fs.readdirSync(path.join(dir, "up"))).toEqual([]);
  });

  it("a failure says which step and why, saves a replayable report, and still cleans up", async () => {
    const db = setup();
    ebay("/offer"); // eBay rejects the offer
    const r = await ebaySmokeTest(db, path.join(dir, "up"));
    expect(r.ok).toBe(false);
    const bad = r.steps.find((s) => !s.ok)!;
    expect(bad.name).toBe("List it on eBay");
    expect(bad.detail).toMatch(/shipping policy/i);
    expect(listProblems(db)[0].summary).toMatch(/smoke-test failed/);
    expect((db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n).toBe(0);
  });

  it("refuses production keys unless you confirm a real listing", async () => {
    const db = setup();
    process.env.EBAY_ENV = "production";
    ebay();
    const r = await ebaySmokeTest(db, path.join(dir, "up"));
    expect(r.ok).toBe(false);
    expect(r.steps.at(-1)).toMatchObject({ name: "Safe place to test", ok: false });
    expect((await ebaySmokeTest(db, path.join(dir, "up"), { allowProduction: true })).ok).toBe(true);
  });
});
