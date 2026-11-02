import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspaces } from "../server/workspaces.js";
import { reportHealth, resetHealth, touch } from "../server/health.js";
import { runInWorkspace } from "../server/context.js";
import { clearOutbox, outbox } from "../server/services/mailer.js";

let dir: string;
let shops: Workspaces;
let app: express.Express;
const ENV = ["FLIPDESK_INVITE_CODE", "STRIPE_SECRET_KEY", "STRIPE_PRICE_ID", "STRIPE_WEBHOOK_SECRET", "FLIPDESK_MEMBER_INVITES", "FLIPDESK_PRICE_MONTHLY", "SMTP_HOST", "SMTP_FROM", "EBAY_CLIENT_ID", "ANTHROPIC_API_KEY"];

beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  resetHealth();
  clearOutbox();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-r12-"));
  shops = new Workspaces({ multiuser: true, dataDir: dir });
  app = express().use(shops.handler());
});
afterEach(() => {
  for (const k of ENV) delete process.env[k];
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function setup() {
  const o = request.agent(app);
  await o.post("/api/auth/signup").send({ email: "owner@x.com", password: "owner-pass-1" }).expect(200);
  process.env.FLIPDESK_INVITE_CODE = "inv";
  const m = request.agent(app);
  await m.post("/api/auth/signup").send({ email: "member@x.com", password: "member-pass-1", invite: "inv" }).expect(200);
  return { o, m };
}

describe("announcements", () => {
  it("owner posts; everyone sees it once until they dismiss it; seen counts; archive", async () => {
    const { o, m } = await setup();
    await m.post("/api/admin/announcements").send({ title: "x" }).expect(403);
    expect((await o.post("/api/admin/announcements").send({ title: "Hi", link: "javascript:alert(1)" })).status).toBe(400);
    const list = (await o.post("/api/admin/announcements").send({ title: "New: bundles on phone!", body: "Tap Bundles in More.", link: "/bundles", days: 7 }).expect(200)).body;
    expect(list[0]).toMatchObject({ title: "New: bundles on phone!", seen: 0 });
    const a = (await m.get("/api/announcements")).body;
    expect(a).toHaveLength(1);
    expect((await m.get("/api/announcements")).body).toHaveLength(1); // still there until dismissed
    await m.post(`/api/announcements/${a[0].id}/dismiss`).expect(200);
    expect((await m.get("/api/announcements")).body).toHaveLength(0);
    expect((await o.get("/api/admin/announcements")).body[0]).toMatchObject({ seen: 1, dismissed: 1 });
    await o.delete(`/api/admin/announcements/${a[0].id}`).expect(200);
    expect((await o.get("/api/announcements")).body).toHaveLength(0);
  });
});

describe("usage for the owner", () => {
  it("weekly active sellers, sign-ups, AI calls with a cost estimate, plan mix and conversion", async () => {
    const { o, m } = await setup();
    await m.get("/api/items").expect(200); // activity
    shops.accounts!.prepare("INSERT INTO ai_usage (user_id, day, calls) VALUES (2, date('now'), 25)").run();
    process.env.FLIPDESK_PRICE_MONTHLY = "19";
    const u = (await o.get("/api/admin/usage?weeks=4").expect(200)).body;
    expect(u.weeks).toHaveLength(4);
    const now = u.weeks[3];
    expect(now).toMatchObject({ activeSellers: 1, signups: 1, aiCalls: 25, aiCost: 1 }); // members only (not you)
    expect(u.plans.free).toBe(1); // billing off -> free
    expect(u.mrr).toBe(0);
    await m.get("/api/admin/usage").expect(403);
  });
});

describe("referrals", () => {
  const sign = (body: string) => {
    const t = Math.floor(Date.now() / 1000);
    return `t=${t},v1=${crypto.createHmac("sha256", "whsec_t").update(`${t}.${body}`).digest("hex")}`;
  };
  const hook = (ev: unknown) => {
    const body = JSON.stringify(ev);
    return request(app).post("/api/billing/webhook").set("Stripe-Signature", sign(body)).set("Content-Type", "application/json").send(body);
  };

  it("members invite friends; when a friend starts paying, the inviter gets a free month (trial days or Stripe credit), once", async () => {
    const { m } = await setup();
    expect((await m.get("/api/invites")).body).toEqual({ enabled: false }); // billing off, not turned on
    process.env.STRIPE_SECRET_KEY = "sk_test";
    process.env.STRIPE_PRICE_ID = "price_1";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_t";
    process.env.SMTP_HOST = "test";
    const { link } = (await m.post("/api/invites").send({ note: "Jo" }).expect(200)).body;
    const token = new URL(link).searchParams.get("invite")!;
    const jo = request.agent(app);
    await jo.post("/api/auth/signup").send({ email: "jo@x.com", password: "jo-pass-123", invite: token }).expect(200);
    const before = (shops.accounts!.prepare("SELECT trial_ends_at FROM users WHERE id = 2").get() as { trial_ends_at: string }).trial_ends_at;

    // Jo pays -> member (on trial, no Stripe customer) gets +30 days
    await hook({ type: "customer.subscription.updated", data: { object: { id: "sub_j", customer: "cus_j", status: "active", metadata: { user_id: "3" } } } }).expect(200);
    await vi.waitFor(() => expect(shops.accounts!.prepare("SELECT COUNT(*) AS n FROM referral_rewards").get()).toEqual({ n: 1 }));
    const after = (shops.accounts!.prepare("SELECT trial_ends_at FROM users WHERE id = 2").get() as { trial_ends_at: string }).trial_ends_at;
    expect(Date.parse(after + "Z") - Date.parse(before + "Z")).toBeGreaterThan(29 * 86400_000);
    const mine = (await m.get("/api/invites")).body;
    expect(mine.rewards[0]).toMatchObject({ kind: "trial_days", detail: "+30 days of trial", email: "j…@x.com" });
    expect(mine.invites[0]).toMatchObject({ note: "Jo", used: true });
    expect(outbox().some((x) => x.to === "member@x.com" && /free month/.test(x.subject))).toBe(true);

    // a second "active" event doesn't pay twice
    await hook({ type: "customer.subscription.updated", data: { object: { id: "sub_j", customer: "cus_j", status: "active", metadata: { user_id: "3" } } } }).expect(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(shops.accounts!.prepare("SELECT COUNT(*) AS n FROM referral_rewards").get()).toEqual({ n: 1 });
  });

  it("a paying inviter gets a Stripe credit worth one month", async () => {
    await setup();
    process.env.STRIPE_SECRET_KEY = "sk_test";
    process.env.STRIPE_PRICE_ID = "price_1";
    shops.accounts!.prepare("UPDATE users SET plan = 'active', stripe_customer_id = 'cus_m' WHERE id = 2").run();
    const token = shops.createInvite(2, "Kim");
    await request(app).post("/api/auth/signup").send({ email: "kim@x.com", password: "kim-pass-123", invite: token }).expect(200);
    const calls: { url: string; body?: string }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? String(init.body) : undefined });
      return new Response(JSON.stringify(url.includes("/prices/") ? { unit_amount: 1900, currency: "usd" } : { id: "cbtxn_1" }));
    });
    const g = await shops.grantReferral(3);
    expect(g).toMatchObject({ kind: "credit", detail: "19.00 USD credit" });
    expect(calls[1].url).toBe("https://api.stripe.com/v1/customers/cus_m/balance_transactions");
    expect(new URLSearchParams(calls[1].body).get("amount")).toBe("-1900");
    expect(await shops.grantReferral(3)).toBeNull();
  });
});

describe("status page", () => {
  it("shows what's set up, what's failing, and your own shop's problems", async () => {
    const { m } = await setup();
    let st = (await m.get("/api/status").expect(200)).body;
    const svc = (k: string) => st.services.find((x: { key: string }) => x.key === k);
    const mine = (k: string) => st.yours.find((x: { key: string }) => x.key === k);
    expect(svc("ai").state).toBe("off");
    expect(svc("ebay").state).toBe("off");
    expect(svc("backup")).toMatchObject({ state: "ok", detail: "Your shop is backed up every night" }); // members don't get owner chores
    expect(mine("sync")).toMatchObject({ state: "ok", detail: "Nothing waiting" });
    expect(mine("ai-allowance").detail).toMatch(/0 of 40/);

    process.env.ANTHROPIC_API_KEY = "x";
    process.env.EBAY_CLIENT_ID = "x";
    const u2 = shops.get("u2")!;
    runInWorkspace(u2, () => {
      reportHealth("ai", true);
      reportHealth("ebay", false, "eBay error 503 on GET /sell/inventory");
      reportHealth("ebay-login", false, "invalid_grant");
      touch("extension");
    });
    u2.db.prepare("INSERT INTO items (sku, title) VALUES ('S1','x')").run();
    u2.db.prepare("INSERT INTO jobs (marketplace, type, item_id, status, updated_at) VALUES ('poshmark','publish',1,'failed',datetime('now'))").run();
    u2.db.prepare("INSERT INTO settings (key, value) VALUES ('ebay.tokens', ?)").run(JSON.stringify({ access_token: "a", refresh_token: "r", expires_at: Date.now() + 1e6 }));
    st = (await m.get("/api/status")).body;
    expect(svc("ai").state).toBe("ok");
    expect(svc("ebay")).toMatchObject({ state: "down", detail: expect.stringMatching(/503/) });
    expect(mine("sync").state).toBe("down");
    expect(mine("extension")).toMatchObject({ state: "ok", detail: "Last checked in just now" });
    expect(st.overall).toBe("down");
    // the owner's view is about the owner's shop, not the member's
    expect(st.yours.find((x: { key: string }) => x.key === "ebay").label).toBe("Your eBay connection");
  });
});

describe("restore from a backup", () => {
  it("lists what's inside, restores one person's shop, keeps an undo backup and the old files", async () => {
    const { o, m } = await setup();
    await m.post("/api/items").send({ title: "Before" }).expect(201);
    fs.writeFileSync(path.join(shops.get("u2")!.uploadDir, "keep.jpg"), "photo-v1");
    const b = (await o.post("/api/backups").expect(200)).body;
    const name = b.files[0].name;

    // things change after the backup
    await m.post("/api/items").send({ title: "After (will be undone)" }).expect(201);
    fs.rmSync(path.join(shops.get("u2")!.uploadDir, "keep.jpg"));
    await o.post("/api/items").send({ title: "Owner's newer item" }).expect(201);

    const parts = (await o.get(`/api/backups/${name}/contents`).expect(200)).body.parts;
    expect(parts.map((p: { part: string }) => p.part).sort()).toEqual(["accounts.db", "site.db", "users/1", "users/2"]);
    expect(parts.find((p: { part: string }) => p.part === "users/2")).toMatchObject({ label: "member@x.com's shop", photos: 1 });

    await m.post(`/api/backups/${name}/restore`).send({ parts: ["users/2"], confirm: "RESTORE" }).expect(403);
    expect((await o.post(`/api/backups/${name}/restore`).send({ parts: ["users/2"] })).status).toBe(400); // must confirm
    const r = (await o.post(`/api/backups/${name}/restore`).send({ parts: ["users/2"], confirm: "RESTORE" }).expect(200)).body;
    expect(r.restored).toEqual(["users/2"]);
    expect(r.undoBackup).toMatch(/^flipdesk-\d{8}-\d{6}(-\d+)?\.zip$/);

    expect((await m.get("/api/items")).body.map((i: { title: string }) => i.title)).toEqual(["Before"]);
    expect(fs.readFileSync(path.join(shops.get("u2")!.uploadDir, "keep.jpg"), "utf8")).toBe("photo-v1");
    expect((await o.get("/api/items")).body.map((i: { title: string }) => i.title)).toEqual(["Owner's newer item"]); // untouched
    const trash = fs.readdirSync(path.join(dir, "restore-trash"));
    expect(fs.existsSync(path.join(dir, "restore-trash", trash[0], "users/2/flipdesk.db"))).toBe(true);
  });

  it("restoring sign-ins and settings reopens them", async () => {
    const { o } = await setup();
    const name = (await o.post("/api/backups").expect(200)).body.files[0].name;
    shops.accounts!.prepare("UPDATE users SET leaderboard_name = 'changed' WHERE id = 1").run();
    await o.post(`/api/backups/${name}/restore`).send({ parts: ["accounts.db", "site.db"], confirm: "RESTORE" }).expect(200);
    expect((shops.accounts!.prepare("SELECT leaderboard_name FROM users WHERE id = 1").get() as { leaderboard_name: string | null }).leaderboard_name).toBeNull();
    // still signed in (session existed in the backup) and the server keeps working
    await o.get("/api/items").expect(200);
    expect((await o.get("/api/backups")).body.files.length).toBeGreaterThanOrEqual(1);
  });
});
