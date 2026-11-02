import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspaces } from "../server/workspaces.js";
import { reportHealth, resetHealth } from "../server/health.js";
import { clearOutbox, outbox } from "../server/services/mailer.js";
import { draftWhatsNew, recentChanges, sellerFacing } from "../server/services/changelog.js";
import { setSetting } from "../server/db.js";

let dir: string;
let shops: Workspaces;
let app: express.Express;
const ENV = ["FLIPDESK_INVITE_CODE", "STRIPE_SECRET_KEY", "STRIPE_PRICE_ID", "SMTP_HOST", "PUBLIC_BASE_URL", "ANTHROPIC_API_KEY", "FLIPDESK_ALERT_AFTER_MINUTES", "FLIPDESK_WINBACK_PCT", "EBAY_CLIENT_ID"];

beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  resetHealth();
  clearOutbox();
  process.env.SMTP_HOST = "test";
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-r14-"));
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
  await m.post("/api/auth/signup").send({ email: "mia@x.com", password: "member-pass-1", invite: "inv" }).expect(200);
  setSetting(shops.get("u1")!.db, "weekly", { timezone: "UTC" });
  return { o, m };
}
const ebayFails = () => ["503", "503", "503"].forEach((c) => reportHealth("ebay", false, `eBay error ${c}`));

describe("health endpoint for uptime monitors", () => {
  it("no login; 200 when serving; strict mode shows outages", async () => {
    const r = await request(app).get("/healthz").expect(200);
    expect(r.body).toMatchObject({ ok: true, outages: [] });
    expect(r.headers["cache-control"]).toBe("no-store");
    shops.site.prepare("INSERT INTO incidents (service) VALUES ('ebay')").run();
    await request(app).get("/healthz").expect(200);
    expect((await request(app).get("/healthz?strict=1").expect(503)).body.outages).toEqual(["ebay"]);
    shops.site.close(); // the server can't read its own data
    await request(app).get("/healthz").expect(503);
  });
});

describe("quieter alerts", () => {
  it("blips under 10 min never page; real outages page once, bundled; recovery message", async () => {
    await setup();
    shops.siteSet("alerts", { quiet: false, quietStart: 22, quietEnd: 7 });
    const t0 = new Date("2026-11-04T15:00:00Z");
    const at = (min: number) => new Date(t0.getTime() + min * 60_000);
    ebayFails();
    expect(await shops.checkIncidents(t0)).toEqual([{ service: "ebay", kind: "opened" }]);
    reportHealth("ebay", true);
    expect(await shops.checkIncidents(at(4))).toEqual([{ service: "ebay", kind: "closed" }]); // 4-minute blip
    expect(outbox()).toHaveLength(0);

    // a real one: eBay + AI together for 12 minutes -> one message
    ebayFails();
    ["x", "x", "x"].forEach(() => reportHealth("ai", false, "overloaded"));
    await shops.checkIncidents(at(10));
    expect(outbox()).toHaveLength(0);
    const ev = await shops.checkIncidents(at(23));
    expect(ev.filter((e) => e.kind === "alerted").map((e) => e.service).sort()).toEqual(["ai", "ebay"]);
    expect(outbox()).toHaveLength(1);
    expect(outbox()[0].subject).toBe("🔴 2 things are failing");
    await shops.checkIncidents(at(25));
    expect(outbox()).toHaveLength(1); // no repeats
  });

  it("quiet hours: nothing at night; problems fixed overnight arrive as one morning note", async () => {
    await setup();
    shops.siteSet("alerts", { quiet: true, quietStart: 22, quietEnd: 7 });
    const push: string[] = [];
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => (push.push(String((init.headers as Record<string, string>).Title)), new Response("ok")));
    setSetting(shops.get("u1")!.db, "notify", { ntfyTopic: "owner-topic" });
    ebayFails();
    await shops.checkIncidents(new Date("2026-11-05T02:10:00Z")); // 2:10am UTC
    await shops.checkIncidents(new Date("2026-11-05T02:40:00Z"));
    expect(outbox()).toHaveLength(0);
    expect(push).toHaveLength(0);
    reportHealth("ebay", true);
    await shops.checkIncidents(new Date("2026-11-05T02:45:00Z"));
    expect(push).toHaveLength(0);
    const ev = await shops.checkIncidents(new Date("2026-11-05T07:05:00Z")); // morning
    expect(ev).toEqual([{ service: "ebay", kind: "summarized" }]);
    expect(push).toEqual(["While you were away"]);
    expect(shops.isQuiet(new Date("2026-11-05T23:30:00Z"))).toBe(true);
    expect(shops.isQuiet(new Date("2026-11-05T12:00:00Z"))).toBe(false);
  });

  it("owner can change quiet hours; members can't", async () => {
    const { o, m } = await setup();
    await m.put("/api/alerts").send({ quiet: false, quietStart: 0, quietEnd: 0 }).expect(403);
    const r = (await o.put("/api/alerts").send({ quiet: true, quietStart: 23, quietEnd: 6 }).expect(200)).body;
    expect(r).toMatchObject({ quiet: true, quietStart: 23, quietEnd: 6, afterMinutes: 10, timezone: "UTC" });
  });
});

describe("Help insights", () => {
  it("logs questions, groups by topic, flags unanswered and unhelpful, feeds the weekly report", async () => {
    const { o, m } = await setup();
    const a1 = (await m.post("/api/help/ask").send({ question: "how do I print a pirate ship label?", page: "/shipping" })).body;
    await m.post("/api/help/ask").send({ question: "pirate ship labels cost?" });
    await m.post("/api/help/ask").send({ question: "zzqx flarb" }); // nothing matches
    await m.post("/api/help/feedback").send({ id: a1.id, helpful: false }).expect(200);
    const hi = (await o.get("/api/admin/help-insights").expect(200)).body;
    expect(hi.total).toBe(3);
    expect(hi.topTopics[0].count).toBe(2);
    expect(hi.unanswered.map((u: { question: string }) => u.question)).toEqual(expect.arrayContaining(["zzqx flarb", "how do I print a pirate ship label?"]));
    expect(hi.helpfulPct).toBe(0);
    expect((await o.get("/api/admin/owner-report")).body.body).toMatch(/❓ 3 Help questions, most about .+ \(2\) · 2 without a good answer/);
    await m.get("/api/admin/help-insights").expect(403);
  });
});

describe("win-back offer", () => {
  it("trial ended: one email with N% off, coupon made once in Stripe and applied at checkout", async () => {
    const { m } = await setup();
    process.env.STRIPE_SECRET_KEY = "sk";
    process.env.STRIPE_PRICE_ID = "price_1";
    process.env.PUBLIC_BASE_URL = "https://flip.example.com";
    shops.accounts!.prepare("UPDATE users SET trial_ends_at = datetime('now','-3 days') WHERE id = 2").run();
    const calls: { url: string; body: string }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body) });
      return new Response(JSON.stringify(url.endsWith("/coupons") ? { id: "coupon_wb" } : { url: "https://checkout.stripe.com/x" }));
    });
    expect(await shops.sendNudges()).toEqual([{ userId: 2, kind: "winback" }]);
    expect(calls[0].url).toBe("https://api.stripe.com/v1/coupons");
    expect(new URLSearchParams(calls[0].body).get("percent_off")).toBe("20");
    expect(outbox()[0]).toMatchObject({ to: "mia@x.com", subject: "Come back to FlipDesk: 20% off your first month" });
    expect(await shops.sendNudges()).toEqual([]); // once

    const b = (await m.get("/api/billing")).body;
    expect(b.offer).toMatchObject({ pct: 20 });
    await m.post("/api/billing/checkout").expect(200);
    const co = new URLSearchParams(calls.at(-1)!.body);
    expect(co.get("discounts[0][coupon]")).toBe("coupon_wb");
    expect(co.get("allow_promotion_codes")).toBeNull();
    expect(calls.filter((c) => c.url.endsWith("/coupons"))).toHaveLength(1);
  });

  it("FLIPDESK_WINBACK_PCT=0 turns it off", async () => {
    await setup();
    process.env.STRIPE_SECRET_KEY = "sk";
    process.env.STRIPE_PRICE_ID = "price_1";
    process.env.FLIPDESK_WINBACK_PCT = "0";
    shops.accounts!.prepare("UPDATE users SET trial_ends_at = datetime('now','-3 days') WHERE id = 2").run();
    expect(await shops.sendNudges()).toEqual([]);
  });
});

describe("what's new drafts", () => {
  it("reads recent updates from git, skips internal ones, drafts an announcement, remembers what was announced", async () => {
    const { changes, source } = await recentChanges(null, 10);
    expect(source).toBe("git");
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.every(sellerFacing)).toBe(true);
    expect(changes[0].body).not.toMatch(/Co-Authored-By|Claude-Session/);
    expect(sellerFacing({ sha: "", date: "", subject: "Fix test timing", body: "" })).toBe(false);
    const d = await draftWhatsNew(changes.slice(0, 3));
    expect(d.ai).toBe(false);
    expect(d.body.split("\n")).toHaveLength(3);

    const { o } = await setup();
    const wn = (await o.get("/api/admin/whats-new").expect(200)).body;
    expect(wn.draft.title).toBeTruthy();
    await o.post("/api/admin/announcements").send({ title: wn.draft.title, body: wn.draft.body, commit: wn.latest }).expect(200);
    expect((await o.get("/api/admin/whats-new")).body.changes).toHaveLength(0); // nothing new since
  });

  it("with AI: Claude writes it (structured), links only to app pages", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    let sent: { output_config: { effort: string; format: unknown }; fallbacks: string } | null = null;
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      const out = { title: "New: Ask FlipDesk help", body: "• Tap ❓ Help for answers", link: "https://evil.example" };
      return new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: JSON.stringify(out) }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }), { headers: { "content-type": "application/json" } });
    });
    const d = await draftWhatsNew([{ sha: "a", date: "", subject: "Ask FlipDesk help chat", body: "" }]);
    expect(d).toMatchObject({ ai: true, title: "New: Ask FlipDesk help", link: "" });
    expect(sent!.output_config.effort).toBe("low");
    expect(sent!.fallbacks).toBe("default");
  });
});
