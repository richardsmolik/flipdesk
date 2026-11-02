import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspaces } from "../server/workspaces.js";
import { resetHealth } from "../server/health.js";
import { clearOutbox, outbox } from "../server/services/mailer.js";
import { billingEnabled, setStripeMode, stripeIsTest, stripeKey } from "../server/services/billing.js";
import { searchDocs } from "../server/services/help.js";

let dir: string;
let shops: Workspaces;
let app: express.Express;
const ENV = ["FLIPDESK_INVITE_CODE", "STRIPE_SECRET_KEY", "STRIPE_PRICE_ID", "STRIPE_WEBHOOK_SECRET", "STRIPE_TEST_SECRET_KEY", "STRIPE_TEST_PRICE_ID", "STRIPE_TEST_WEBHOOK_SECRET", "SMTP_HOST", "SMTP_FROM", "PUBLIC_BASE_URL", "ANTHROPIC_API_KEY"];

beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  setStripeMode(null);
  resetHealth();
  clearOutbox();
  process.env.SMTP_HOST = "test";
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-r15-"));
  shops = new Workspaces({ multiuser: true, dataDir: dir });
  app = express().use(shops.handler());
});
afterEach(() => {
  for (const k of ENV) delete process.env[k];
  setStripeMode(null);
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function setup() {
  const o = request.agent(app);
  await o.post("/api/auth/signup").send({ email: "owner@x.com", password: "owner-pass-1" }).expect(200);
  process.env.FLIPDESK_INVITE_CODE = "inv";
  const m = request.agent(app);
  await m.post("/api/auth/signup").send({ email: "mia@x.com", password: "member-pass-1", invite: "inv" }).expect(200);
  return { o, m };
}
const signFor = (secret: string, body: string) => {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
};

describe("help articles from unanswered questions", () => {
  it("owner drafts an article from a 👎 question; Help then finds it; the question leaves the unanswered list", async () => {
    const { o, m } = await setup();
    const q = (await m.post("/api/help/ask").send({ question: "can I schedule listings for later?", page: "/items/new" })).body;
    await m.post("/api/help/feedback").send({ id: q.id, helpful: false });
    let hi = (await o.get("/api/admin/help-insights")).body;
    expect(hi.unanswered.map((u: { question: string }) => u.question)).toContain("can I schedule listings for later?");

    const draft = (await o.post("/api/admin/help-articles/draft").send({ questionId: q.id }).expect(200)).body;
    expect(draft).toMatchObject({ title: "Can I schedule listings for later?", ai: false });
    await m.post("/api/admin/help-articles").send({ title: "x", body: "y" }).expect(403);
    await o
      .post("/api/admin/help-articles")
      .send({ title: "Can I schedule listings for later?", body: "Not yet. Save it as a draft and crosslist it when you're ready: open [Inventory](/inventory?view=drafts).", questionId: q.id })
      .expect(200);
    hi = (await o.get("/api/admin/help-insights")).body;
    expect(hi.unanswered).toHaveLength(0);
    expect(searchDocs("schedule listings later")[0]).toMatchObject({ title: "Can I schedule listings for later?", source: "FlipDesk help" });
    const ask = (await m.post("/api/help/ask").send({ question: "schedule a listing for later" })).body;
    expect(ask.sources[0].source).toBe("FlipDesk help");

    // edit + remove
    const list = (await o.get("/api/admin/help-articles")).body;
    await o.put(`/api/admin/help-articles/${list[0].id}`).send({ title: "Scheduling listings", body: "Save as draft, crosslist later." }).expect(200);
    expect(searchDocs("scheduling listings")[0].title).toBe("Scheduling listings");
    await o.delete(`/api/admin/help-articles/${list[0].id}`).expect(200);
    expect(searchDocs("scheduling listings")[0]?.source).not.toBe("FlipDesk help");
  });

  it("with AI, the article is written from the docs and the articles go into Help's context", async () => {
    const { o, m } = await setup();
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const bodies: { system: { text: string; cache_control?: unknown }[] }[] = [];
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body));
      bodies.push(b);
      const text = b.output_config?.format ? JSON.stringify({ title: "How do I bundle items?", body: "1. Open [Bundles](/bundles)" }) : "Use [Bundles](/bundles).";
      return new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }), { headers: { "content-type": "application/json" } });
    });
    const d = (await o.post("/api/admin/help-articles/draft").send({ question: "bundle?" }).expect(200)).body;
    expect(d).toMatchObject({ ai: true, title: "How do I bundle items?" });
    await o.post("/api/admin/help-articles").send({ title: d.title, body: d.body }).expect(200);
    await m.post("/api/help/ask").send({ question: "how do bundles work" }).expect(200);
    const ask = bodies.at(-1)!;
    expect(ask.system[0].cache_control).toEqual({ type: "ephemeral" }); // docs stay cached
    expect(ask.system[1].text).toMatch(/How do I bundle items\?/); // owner articles after them
  });
});

describe("day-3 check-in", () => {
  it("emails once when nothing was added by day 3; not if they added items", async () => {
    const { m } = await setup();
    shops.accounts!.prepare("UPDATE users SET created_at = datetime('now','-3 days','-1 hour') WHERE id = 2").run();
    expect(await shops.sendNudges()).toEqual([{ userId: 2, kind: "day3" }]);
    expect(outbox()[0]).toMatchObject({ to: "mia@x.com", subject: "Need a hand getting started with FlipDesk?" });
    expect(outbox()[0].text).toMatch(/Shoot mode/);
    expect(await shops.sendNudges()).toEqual([]);
    // someone who added an item gets nothing
    process.env.FLIPDESK_INVITE_CODE = "inv";
    const k = request.agent(app);
    await k.post("/api/auth/signup").send({ email: "kim@x.com", password: "kim-pass-123", invite: "inv" }).expect(200);
    await k.post("/api/items").send({ title: "Mug" }).expect(201);
    shops.accounts!.prepare("UPDATE users SET created_at = datetime('now','-4 days') WHERE id = 3").run();
    expect(await shops.sendNudges()).toEqual([]);
    void m;
  });
});

describe("cancellation reasons", () => {
  it("from Stripe's cancel page, or one tap in the app; summarized for the owner", async () => {
    const { o, m } = await setup();
    process.env.STRIPE_SECRET_KEY = "sk_live_x";
    process.env.STRIPE_PRICE_ID = "price_live";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_live";
    shops.accounts!.prepare("UPDATE users SET plan = 'active', stripe_customer_id = 'cus_m', stripe_mode = 'live' WHERE id = 2").run();
    // scheduled cancel without a reason -> the app asks
    const ev = { type: "customer.subscription.updated", livemode: true, data: { object: { id: "sub_m", customer: "cus_m", status: "active", cancel_at_period_end: true, metadata: { user_id: "2" } } } };
    const body = JSON.stringify(ev);
    await request(app).post("/api/billing/webhook").set("Stripe-Signature", signFor("whsec_live", body)).set("Content-Type", "application/json").send(body).expect(200);
    let b = (await m.get("/api/billing")).body;
    expect(b.askCancelReason).toBe(true);
    expect(b.cancelReasons.length).toBeGreaterThan(5);
    await m.post("/api/billing/cancel-reason").send({ reason: "too_expensive", comment: "Sales slow in winter" }).expect(200);
    b = (await m.get("/api/billing")).body;
    expect(b.askCancelReason).toBe(false);

    // Stripe also sends its reason later the same day: not double counted
    const ev2 = { ...ev, type: "customer.subscription.deleted", data: { object: { ...ev.data.object, status: "canceled", cancellation_details: { feedback: "missing_features", comment: "" } } } };
    const body2 = JSON.stringify(ev2);
    await request(app).post("/api/billing/webhook").set("Stripe-Signature", signFor("whsec_live", body2)).set("Content-Type", "application/json").send(body2).expect(200);
    const c = (await o.get("/api/admin/cancellations").expect(200)).body;
    expect(c.total).toBe(1);
    expect(c.recent[0]).toMatchObject({ reason: "too_expensive", label: "Too expensive", comment: "Sales slow in winter", email: "mia@x.com", source: "app" });
    expect((await o.get("/api/admin/owner-report")).body.body).toMatch(/💔 1 cancellation: too expensive \(1\)/);
    await m.get("/api/admin/cancellations").expect(403);
  });
});

describe("Stripe test vs live", () => {
  it("owner flips modes; test subscriptions never count in live; webhooks are matched by their secret", async () => {
    const { o, m } = await setup();
    process.env.STRIPE_SECRET_KEY = "sk_live_x";
    process.env.STRIPE_PRICE_ID = "price_live";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_live";
    process.env.STRIPE_TEST_SECRET_KEY = "sk_test_x";
    process.env.STRIPE_TEST_PRICE_ID = "price_test";
    process.env.STRIPE_TEST_WEBHOOK_SECRET = "whsec_test";
    expect((await o.get("/api/admin/stripe-mode")).body).toEqual({ live: true, test: true, using: "live", testing: false });
    await m.put("/api/admin/stripe-mode").send({ mode: "test" }).expect(403);
    expect((await o.put("/api/admin/stripe-mode").send({ mode: "test" }).expect(200)).body).toMatchObject({ using: "test", testing: true });
    expect(stripeKey()).toBe("sk_test_x");
    expect((await m.get("/api/billing")).body.testMode).toBe(true);

    // a test-mode purchase (signed with the TEST secret)
    const ev = { type: "customer.subscription.updated", livemode: false, data: { object: { id: "sub_t", customer: "cus_t", status: "active", metadata: { user_id: "2" } } } };
    const body = JSON.stringify(ev);
    await request(app).post("/api/billing/webhook").set("Stripe-Signature", signFor("whsec_test", body)).set("Content-Type", "application/json").send(body).expect(200);
    await request(app).post("/api/billing/webhook").set("Stripe-Signature", signFor("whsec_wrong", body)).set("Content-Type", "application/json").send(body).expect(400);
    expect((await m.get("/api/billing")).body.status).toBe("active");

    // go live: the test subscription doesn't count, checkout uses the live price and no test customer
    await o.put("/api/admin/stripe-mode").send({ mode: "live" }).expect(200);
    const b = (await m.get("/api/billing")).body;
    expect(b).toMatchObject({ status: "trial", testMode: false, hasCustomer: false });
    let sent = "";
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => ((sent = String(init.body)), new Response(JSON.stringify({ url: "https://checkout.stripe.com/x" }))));
    await m.post("/api/billing/checkout").expect(200);
    const p = new URLSearchParams(sent);
    expect(p.get("line_items[0][price]")).toBe("price_live");
    expect(p.get("customer")).toBeNull();
    expect(p.get("customer_email")).toBe("mia@x.com");

    // the choice survives a restart
    setStripeMode(null);
    new Workspaces({ multiuser: true, dataDir: dir });
    expect(stripeIsTest()).toBe(false);
    expect(billingEnabled()).toBe(true);
  });

  it("refuses to switch to a mode without keys", async () => {
    const { o } = await setup();
    process.env.STRIPE_SECRET_KEY = "sk_live_x";
    process.env.STRIPE_PRICE_ID = "price_live";
    expect((await o.put("/api/admin/stripe-mode").send({ mode: "test" })).status).toBe(400);
  });
});

describe("pre-launch checklist", () => {
  it("lists what's missing with fixes, and turns green as things get set up", async () => {
    const { o, m } = await setup();
    await m.get("/api/launch").expect(403);
    let l = (await o.get("/api/launch").expect(200)).body;
    const st = (k: string) => l.checks.find((c: { key: string }) => c.key === k);
    expect(st("https")).toMatchObject({ state: "fail", fix: expect.stringMatching(/PUBLIC_BASE_URL/) });
    expect(st("login").state).toBe("ok");
    expect(st("push").state).toBe("fail");
    expect(st("backup").state).toBe("fail");
    expect(st("uptime").state).toBe("optional");
    expect(l.blockers).toBeGreaterThan(0);

    process.env.PUBLIC_BASE_URL = "https://flip.example.com";
    process.env.SMTP_FROM = "FlipDesk <no-reply@flip.example.com>";
    await o.post("/api/backups").expect(200);
    await request(app).get("/healthz").set("User-Agent", "Mozilla/5.0+(compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)").expect(200);
    const sent = (await o.post("/api/launch/test-email").expect(200)).body;
    expect(sent.to).toBe("owner@x.com");
    expect(outbox().some((x) => x.subject === "FlipDesk test email ✅")).toBe(true);
    l = (await o.get("/api/launch")).body;
    expect(st("https").state).toBe("ok");
    expect(st("backup").state).toBe("ok");
    expect(st("uptime")).toMatchObject({ state: "ok", detail: expect.stringMatching(/UptimeRobot/) });
    expect(st("email").state).toBe("ok");
  });
});
