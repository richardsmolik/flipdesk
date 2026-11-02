import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { openDb, setSetting } from "../server/db.js";
import { Workspaces } from "../server/workspaces.js";
import { clearOutbox, outbox } from "../server/services/mailer.js";
import { readZip, ZipWriter } from "../server/services/zip.js";
import { signS3 } from "../server/services/backup.js";
import { verifyWebhook } from "../server/services/billing.js";
import { sendDigest } from "../server/services/digest.js";

let dir: string;
let shops: Workspaces;
let app: express.Express;
const ENV = ["FLIPDESK_INVITE_CODE", "STRIPE_SECRET_KEY", "STRIPE_PRICE_ID", "STRIPE_WEBHOOK_SECRET", "FLIPDESK_TRIAL_DAYS", "FLIPDESK_AI_PAID_LIMIT", "SMTP_HOST", "SMTP_FROM", "PUBLIC_BASE_URL", "BACKUP_S3_ENDPOINT"];

beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-r11-"));
  shops = new Workspaces({ multiuser: true, dataDir: dir });
  app = express().use(shops.handler());
  clearOutbox();
});
afterEach(() => {
  for (const k of ENV) delete process.env[k];
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function owner() {
  const o = request.agent(app);
  await o.post("/api/auth/signup").send({ email: "owner@x.com", password: "owner-pass-1" }).expect(200);
  return o;
}

describe("invite links", () => {
  it("one link per person, works once, records who invited whom, can be turned off", async () => {
    const o = await owner();
    expect((await request(app).get("/api/auth/mode")).body.signupsOpen).toBe(false); // no code, no invites
    const { link } = (await o.post("/api/admin/invites").send({ note: "Sam" }).expect(200)).body;
    const token = new URL(link).searchParams.get("invite")!;
    expect((await request(app).get("/api/auth/mode")).body.signupsOpen).toBe(true);
    expect((await request(app).get(`/api/auth/invite/${token}`)).body).toEqual({ valid: true });

    const sam = request.agent(app);
    await sam.post("/api/auth/signup").send({ email: "sam@x.com", password: "sam-pass-123", invite: token }).expect(200);
    expect((await request(app).post("/api/auth/signup").send({ email: "eve@x.com", password: "eve-pass-123", invite: token })).status).toBe(403); // used
    expect((await request(app).get(`/api/auth/invite/${token}`)).body).toEqual({ valid: false });
    const accts = (await o.get("/api/admin/accounts")).body.accounts;
    expect(accts.find((a: { email: string }) => a.email === "sam@x.com").invitedBy).toBe("owner@x.com");
    const inv = (await o.get("/api/admin/invites")).body.invites[0];
    expect(inv).toMatchObject({ note: "Sam", used_by_email: "sam@x.com" });

    const two = (await o.post("/api/admin/invites").send({ note: "Pat" })).body.invites[0];
    await o.delete(`/api/admin/invites/${two.id}`).expect(200);
    expect((await request(app).post("/api/auth/signup").send({ email: "pat@x.com", password: "pat-pass-123", invite: two.token })).status).toBe(403);
    await sam.post("/api/admin/invites").send({}).expect(403); // owner only
  });
});

describe("billing", () => {
  const sign = (body: string, secret = "whsec_test", t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

  it("checks Stripe signatures", () => {
    const raw = Buffer.from('{"a":1}');
    expect(verifyWebhook(raw, sign('{"a":1}'), "whsec_test")).toBe(true);
    expect(verifyWebhook(raw, sign('{"a":2}'), "whsec_test")).toBe(false);
    expect(verifyWebhook(raw, sign('{"a":1}', "whsec_test", Math.floor(Date.now() / 1000) - 600), "whsec_test")).toBe(false); // too old
    expect(verifyWebhook(raw, undefined, "whsec_test")).toBe(false);
  });

  it("trial → read-only when it ends → subscribe via Checkout → webhook turns it on; owner can comp", async () => {
    const o = await owner();
    process.env.FLIPDESK_INVITE_CODE = "inv";
    const u = request.agent(app);
    await u.post("/api/auth/signup").send({ email: "u@x.com", password: "user-pass-1", invite: "inv" }).expect(200);

    // billing off: everyone free
    expect((await u.get("/api/billing")).body).toMatchObject({ enabled: false, status: "free" });
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    process.env.STRIPE_PRICE_ID = "price_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    process.env.PUBLIC_BASE_URL = "https://flip.example.com";
    expect((await u.get("/api/billing")).body).toMatchObject({ enabled: true, status: "trial", trialDaysLeft: 14, canWrite: true });
    expect((await o.get("/api/billing")).body.status).toBe("owner");

    // trial ends: writes blocked (402), reads + export still fine, AI limit 0
    shops.accounts!.prepare("UPDATE users SET trial_ends_at = datetime('now','-1 day') WHERE email = 'u@x.com'").run();
    const r = await u.post("/api/items").send({ title: "x" });
    expect(r.status).toBe(402);
    expect(r.body.error).toMatch(/trial has ended/);
    await u.get("/api/items").expect(200);
    expect((await u.get("/api/export")).headers["content-type"]).toMatch(/zip/);
    expect((await u.get("/api/billing")).body).toMatchObject({ status: "expired", aiLimit: 0 });

    // Checkout: we call Stripe with the right price and user, and send them to Stripe's page
    const calls: { url: string; body: string }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body) });
      return new Response(JSON.stringify({ url: "https://checkout.stripe.com/c/pay/cs_test_1" }), { status: 200 });
    });
    expect((await u.post("/api/billing/checkout").expect(200)).body.url).toMatch(/checkout\.stripe\.com/);
    const sent = new URLSearchParams(calls[0].body);
    expect(calls[0].url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(sent.get("line_items[0][price]")).toBe("price_123");
    expect(sent.get("client_reference_id")).toBe("2");
    expect(sent.get("customer_email")).toBe("u@x.com");
    expect(sent.get("success_url")).toBe("https://flip.example.com/billing?done=1");
    expect(sent.get("subscription_data[trial_end]")).toBeNull(); // trial already over: charge now

    // Stripe webhooks: checkout completed, then subscription active with a period end
    const send = (ev: unknown) => {
      const body = JSON.stringify(ev);
      return request(app).post("/api/billing/webhook").set("Stripe-Signature", sign(body)).set("Content-Type", "application/json").send(body);
    };
    await request(app).post("/api/billing/webhook").set("Stripe-Signature", "t=1,v1=bad").set("Content-Type", "application/json").send("{}").expect(400);
    await send({ type: "checkout.session.completed", data: { object: { client_reference_id: "2", customer: "cus_1", subscription: "sub_1" } } }).expect(200);
    await send({ type: "customer.subscription.updated", data: { object: { id: "sub_1", customer: "cus_1", status: "active", items: { data: [{ current_period_end: 1893456000 }] } } } }).expect(200);
    const b = (await u.get("/api/billing")).body;
    expect(b).toMatchObject({ status: "active", canWrite: true, hasCustomer: true, aiLimit: 200 });
    expect(b.renewsAt).toMatch(/^2030-01-01/);
    await u.post("/api/items").send({ title: "Back in business" }).expect(201);

    // cancel -> back to read-only (trial long over)
    await send({ type: "customer.subscription.deleted", data: { object: { id: "sub_1", customer: "cus_1", status: "canceled" } } }).expect(200);
    expect((await u.post("/api/items").send({ title: "x" })).status).toBe(402);

    // owner comps them: free forever
    await o.put("/api/admin/accounts/2").send({ comp: true }).expect(200);
    expect((await u.get("/api/billing")).body.status).toBe("free");
    await u.post("/api/items").send({ title: "Comped" }).expect(201);
  });

  it("subscribing during the trial doesn't charge until the trial ends", async () => {
    await owner();
    process.env.FLIPDESK_INVITE_CODE = "inv";
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    process.env.STRIPE_PRICE_ID = "price_123";
    const u = request.agent(app);
    await u.post("/api/auth/signup").send({ email: "early@x.com", password: "user-pass-1", invite: "inv" }).expect(200);
    let body = "";
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => ((body = String(init.body)), new Response(JSON.stringify({ url: "https://checkout.stripe.com/x" }))));
    await u.post("/api/billing/checkout").expect(200);
    const trialEnd = Number(new URLSearchParams(body).get("subscription_data[trial_end]"));
    expect(trialEnd).toBeGreaterThan(Date.now() / 1000 + 13 * 86400);
  });
});

describe("feedback", () => {
  it("goes to the owner's inbox with page + errors; owner can mark it done", async () => {
    const o = await owner();
    process.env.FLIPDESK_INVITE_CODE = "inv";
    const u = request.agent(app);
    await u.post("/api/auth/signup").send({ email: "u@x.com", password: "user-pass-1", invite: "inv" }).expect(200);
    expect((await u.post("/api/feedback").send({ message: "x" })).status).toBe(400);
    await u.post("/api/feedback").send({ message: "The crosslist button did nothing", page: "/items/4", context: { errors: ["TypeError: boom"] } }).expect(200);
    await u.get("/api/admin/feedback").expect(403);
    const f = (await o.get("/api/admin/feedback")).body;
    expect(f.open).toBe(1);
    expect(f.feedback[0]).toMatchObject({ email: "u@x.com", page: "/items/4", message: "The crosslist button did nothing", context: { errors: ["TypeError: boom"] } });
    await o.post(`/api/admin/feedback/${f.feedback[0].id}/resolve`).send({}).expect(200);
    expect((await o.get("/api/admin/feedback")).body.open).toBe(0);
  });
});

describe("weekly email", () => {
  it("emails the summary to your account email when turned on", async () => {
    process.env.SMTP_HOST = "test";
    const db = openDb(":memory:");
    setSetting(db, "accountEmail", "me@x.com");
    let r = await sendDigest(db, { force: true });
    expect((r as { emailed?: boolean }).emailed).toBe(false); // off by default
    setSetting(db, "weekly", { email: true });
    r = await sendDigest(db, { force: true });
    expect((r as { emailed?: boolean }).emailed).toBe(true);
    expect(outbox()[0]).toMatchObject({ to: "me@x.com" });
    expect(outbox()[0].text).toMatch(/Turn this email off/);
  });
});

describe("zip, export and backups", () => {
  it("zip round-trips text, binary and empty files", async () => {
    const out = new PassThrough();
    const chunks: Buffer[] = [];
    out.on("data", (c) => chunks.push(c));
    const z = new ZipWriter(out);
    const bin = crypto.randomBytes(5000);
    await z.add("a.txt", Buffer.from("hello ".repeat(100)));
    await z.add("photos/b.bin", bin);
    await z.add("empty.csv", Buffer.alloc(0));
    await z.finish();
    const files = readZip(Buffer.concat(chunks));
    expect(files.get("a.txt")!.toString()).toBe("hello ".repeat(100));
    expect(files.get("photos/b.bin")!.equals(bin)).toBe(true);
    expect(files.get("empty.csv")!.length).toBe(0);
  });

  it("download all my data: spreadsheets, photos and a working database", async () => {
    const o = await owner();
    const it = (await o.post("/api/items").send({ title: "Export me", price: 12 })).body;
    fs.mkdirSync(shops.get("u1")!.uploadDir, { recursive: true });
    fs.writeFileSync(path.join(shops.get("u1")!.uploadDir, "p1.jpg"), Buffer.from("fake-jpeg"));
    const r = await o.get("/api/export").buffer(true).parse((res, cb) => {
      const c: Buffer[] = [];
      res.on("data", (d: Buffer) => c.push(d));
      res.on("end", () => cb(null, Buffer.concat(c)));
    });
    expect(r.headers["content-disposition"]).toMatch(/flipdesk-export-\d{4}-\d{2}-\d{2}\.zip/);
    const files = readZip(r.body as Buffer);
    expect(files.get("items.csv")!.toString()).toMatch(/Export me/);
    expect(files.get("photos/p1.jpg")!.toString()).toBe("fake-jpeg");
    expect(files.has("README.txt")).toBe(true);
    const tmp = path.join(dir, "restored.db");
    fs.writeFileSync(tmp, files.get("flipdesk.db")!);
    const db = openDb(tmp);
    expect((db.prepare("SELECT title FROM items WHERE id = ?").get(it.id) as { title: string }).title).toBe("Export me");
  });

  it("nightly backup of every real shop + accounts, keeps the newest, owner only", async () => {
    const o = await owner();
    process.env.FLIPDESK_INVITE_CODE = "inv";
    const u = request.agent(app);
    await u.post("/api/auth/signup").send({ email: "u@x.com", password: "user-pass-1", invite: "inv" }).expect(200);
    await u.post("/api/items").send({ title: "Friend's item" }).expect(201);
    await u.post("/api/workspace").send({ action: "enter_demo" }).expect(200); // sample shops are skipped
    await u.get("/api/backups").expect(403);

    const b = (await o.post("/api/backups").expect(200)).body;
    expect(b.files).toHaveLength(1);
    expect(b.last.bytes).toBeGreaterThan(1000);
    const zip = readZip(fs.readFileSync(path.join(dir, "backups", b.files[0].name)));
    const names = [...zip.keys()];
    expect(names).toEqual(expect.arrayContaining(["users/1/flipdesk.db", "users/2/flipdesk.db", "accounts.db", "site.db", "README.txt"]));
    expect(names.some((n) => n.startsWith("users/2d"))).toBe(false);
    // not due again for 23h
    expect(await shops.backupIfDue()).toBeNull();
    await o.get(`/api/backups/${b.files[0].name}`).expect(200);
    await o.get("/api/backups/..%2Faccounts.db").expect(400);
  });

  it("signs S3 uploads the AWS way (known test vector shape)", () => {
    const h = signS3({ method: "PUT", url: new URL("https://acct.r2.cloudflarestorage.com/bucket/flipdesk/x.zip"), region: "auto", accessKey: "AK", secretKey: "SK", now: new Date("2026-11-02T03:04:05Z"), contentLength: 10 });
    expect(h["x-amz-date"]).toBe("20261102T030405Z");
    expect(h.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AK\/20261102\/auto\/s3\/aws4_request, SignedHeaders=content-length;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  });
});
