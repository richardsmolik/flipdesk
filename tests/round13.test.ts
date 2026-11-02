import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspaces } from "../server/workspaces.js";
import { reportHealth, resetHealth } from "../server/health.js";
import { clearOutbox, outbox } from "../server/services/mailer.js";
import { searchDocs } from "../server/services/help.js";
import { setSetting } from "../server/db.js";

let dir: string;
let shops: Workspaces;
let app: express.Express;
const ENV = ["FLIPDESK_INVITE_CODE", "STRIPE_SECRET_KEY", "STRIPE_PRICE_ID", "SMTP_HOST", "PUBLIC_BASE_URL", "ANTHROPIC_API_KEY", "FLIPDESK_INCIDENT_AFTER", "FLIPDESK_AUTO_ANNOUNCE", "FLIPDESK_ALERT_AFTER_MINUTES"];

beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  resetHealth();
  clearOutbox();
  process.env.SMTP_HOST = "test";
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-r13-"));
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
  clearOutbox(); // ignore the welcome email new members get (round 16)
  return { o, m };
}

describe("owner's weekly report", () => {
  it("summarizes members, AI cost, feedback and backups; sends once per week on your summary day", async () => {
    const { o, m } = await setup();
    await m.get("/api/items");
    await m.post("/api/feedback").send({ message: "Bundles are confusing on phone" }).expect(200);
    shops.accounts!.prepare("INSERT INTO ai_usage (user_id, day, calls) VALUES (2, date('now'), 10)").run();
    const r = (await o.get("/api/admin/owner-report").expect(200)).body;
    expect(r.body).toMatch(/1 member, 1 new this week · 1 active/);
    expect(r.body).toMatch(/10 AI requests \(~\$0\.40\)/);
    expect(r.body).toMatch(/1 open feedback, e\.g\. "Bundles are confusing/);
    expect(r.body).toMatch(/No backup yet/);
    await m.get("/api/admin/owner-report").expect(403);

    // due on the owner's weekly-summary day (Monday 8am UTC here), once per week, by email too
    setSetting(shops.get("u1")!.db, "weekly", { day: 1, hour: 8, timezone: "UTC" });
    expect(await shops.ownerReportIfDue(new Date("2026-11-08T12:00:00Z"))).toBeNull(); // Sunday
    const sent = await shops.ownerReportIfDue(new Date("2026-11-09T09:00:00Z"));
    expect(sent?.emailed).toBe(true);
    expect(outbox().find((x) => x.to === "owner@x.com")?.subject).toMatch(/^FlipDesk this week/);
    expect(await shops.ownerReportIfDue(new Date("2026-11-09T15:00:00Z"))).toBeNull(); // already sent
  });
});

describe("automatic incident alerts", () => {
  it("3 failures in a row: owner told + heads-up for everyone; recovery takes it down", async () => {
    const { m } = await setup();
    process.env.EBAY_CLIENT_ID = "x";
    process.env.FLIPDESK_ALERT_AFTER_MINUTES = "0"; // alert at once (round 14 adds the blip window + quiet hours)
    shops.siteSet("alerts", { quiet: false });
    reportHealth("ebay", false, "eBay error 503");
    reportHealth("ebay", false, "eBay error 503");
    expect(await shops.checkIncidents()).toEqual([]); // 2 isn't enough
    reportHealth("ebay", false, "eBay error 503 on GET /sell/inventory");
    expect(await shops.checkIncidents()).toEqual([{ service: "ebay", kind: "opened" }, { service: "ebay", kind: "alerted" }]);
    expect(await shops.checkIncidents()).toEqual([]); // no repeat alerts
    expect(outbox().find((x) => x.to === "owner@x.com")?.subject).toMatch(/eBay is failing/);
    const ann = (await m.get("/api/announcements")).body;
    expect(ann[0]).toMatchObject({ title: "Heads up: eBay is having trouble right now", link: "/status" });
    expect((await m.get("/api/status")).body.incidents[0]).toMatchObject({ service: "ebay", ended_at: null });

    reportHealth("ebay", true);
    expect(await shops.checkIncidents()).toEqual([{ service: "ebay", kind: "closed" }]);
    expect((await m.get("/api/announcements")).body).toHaveLength(0);
    expect((await m.get("/api/status")).body.incidents[0].ended_at).toBeTruthy();
    delete process.env.EBAY_CLIENT_ID;
  });

  it("FLIPDESK_AUTO_ANNOUNCE=0 tells only the owner", async () => {
    const { m } = await setup();
    process.env.FLIPDESK_AUTO_ANNOUNCE = "0";
    process.env.FLIPDESK_INCIDENT_AFTER = "1";
    process.env.FLIPDESK_ALERT_AFTER_MINUTES = "0";
    shops.siteSet("alerts", { quiet: false });
    reportHealth("ai", false, "overloaded");
    await shops.checkIncidents();
    expect((await m.get("/api/announcements")).body).toHaveLength(0);
    expect(outbox().some((x) => /AI writer is failing/.test(x.subject))).toBe(true);
  });
});

describe("reminder emails", () => {
  it("trial ending: once, with their numbers; quiet members: once a month; opt-out respected", async () => {
    const { m } = await setup();
    await m.post("/api/items").send({ title: "Mug", price: 20 }).expect(201);
    process.env.STRIPE_SECRET_KEY = "sk";
    process.env.STRIPE_PRICE_ID = "price";
    process.env.PUBLIC_BASE_URL = "https://flip.example.com";
    shops.accounts!.prepare("UPDATE users SET trial_ends_at = datetime('now','+47 hours') WHERE id = 2").run();
    let sent = await shops.sendNudges();
    expect(sent).toEqual([{ userId: 2, kind: "trial_ending" }]);
    const mail = outbox().find((x) => x.to === "mia@x.com")!;
    expect(mail.subject).toBe("Your FlipDesk trial ends in 2 days");
    expect(mail.text).toMatch(/added 1 item/);
    expect(mail.text).toMatch(/https:\/\/flip\.example\.com\/billing/);
    expect(await shops.sendNudges()).toEqual([]); // once

    // quiet for 20 days (and not on a trial anymore)
    delete process.env.STRIPE_SECRET_KEY;
    shops.accounts!.prepare("DELETE FROM activity_days").run();
    shops.accounts!.prepare("INSERT INTO activity_days (user_id, day) VALUES (2, date('now','-20 days'))").run();
    sent = await shops.sendNudges();
    expect(sent).toEqual([{ userId: 2, kind: "inactive" }]);
    expect(outbox().at(-1)!.text).toMatch(/It's been 20 days/);
    expect(await shops.sendNudges()).toEqual([]);

    // opt out
    shops.accounts!.prepare("DELETE FROM nudges").run();
    await m.post("/api/account/emails").send({ optOut: true }).expect(200);
    expect((await m.get("/api/account")).body.emailOptOut).toBe(true);
    expect(await shops.sendNudges()).toEqual([]);
  });
});

describe("Ask FlipDesk", () => {
  it("without AI: finds the right doc sections", async () => {
    const hits = searchDocs("how do I print a pirate ship label");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((h) => h.title).join(" ")).toMatch(/Shipping labels|label/i);
    const { m } = await setup();
    const r = (await m.post("/api/help/ask").send({ question: "how do backups work?" }).expect(200)).body;
    expect(r).toMatchObject({ answer: null, demo: true });
    expect(r.sources[0].title).toMatch(/backup/i);
  });

  it("with AI: Claude answers from the docs (cached), counts against the allowance", async () => {
    const { m } = await setup();
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "1. Open [Shipping](/shipping)\n2. Pick Pirate Ship" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 10 } }), { headers: { "content-type": "application/json" } });
    });
    const r = (await m.post("/api/help/ask").send({ question: "how do I use pirate ship?", page: "/shipping", history: [{ role: "user", content: "hi" }, { role: "assistant", content: "Hello!" }] }).expect(200)).body;
    expect(r.answer).toMatch(/Open \[Shipping\]\(\/shipping\)/);
    const sent = bodies[0] as { model: string; system: { text: string; cache_control: unknown }[]; messages: { content: string }[]; fallbacks: string; output_config: { effort: string } };
    expect(sent.model).toBe("claude-opus-5-5");
    expect(sent.fallbacks).toBe("default");
    expect(sent.output_config.effort).toBe("low");
    expect(sent.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(sent.system[0].text).toMatch(/eBay setup guide/);
    expect(sent.messages).toHaveLength(3);
    expect(sent.messages[2].content).toMatch(/I'm on the page \/shipping/);
    expect((await m.get("/api/account")).body.ai.used).toBe(1);
  });
});

describe("backup restore check", () => {
  it("passes for a good backup, fails (and tells the owner) for a damaged one, and shows on Status", async () => {
    const { o } = await setup();
    const name = (await o.post("/api/backups").expect(200)).body.files[0].name;
    const ok = (await o.post(`/api/backups/${name}/check`).expect(200)).body;
    expect(ok.ok).toBe(true);
    expect(ok.databases.map((d: { name: string }) => d.name).sort()).toEqual(["accounts.db", "site.db", "users/1/flipdesk.db", "users/2/flipdesk.db"]);
    expect(ok.databases.find((d: { name: string }) => d.name === "accounts.db").detail).toBe("2 accounts");
    const st = (await o.get("/api/status")).body;
    expect(st.services.find((x: { key: string }) => x.key === "backup-check")).toMatchObject({ state: "ok" });
    expect(await shops.checkBackupIfDue()).toBeNull(); // checked recently

    // damage the file: flip bytes in the middle
    const file = path.join(dir, "backups", name);
    const buf = fs.readFileSync(file);
    for (let i = 200; i < 260; i++) buf[i] ^= 0xff;
    fs.writeFileSync(file, buf);
    const bad = (await o.post(`/api/backups/${name}/check`).expect(200)).body;
    expect(bad.ok).toBe(false);
    expect(bad.problems.length).toBeGreaterThan(0);
    expect(outbox().some((x) => /failed its restore check/.test(x.subject))).toBe(true);
    expect((await o.get("/api/status")).body.services.find((x: { key: string }) => x.key === "backup-check").state).toBe("down");
  });
});
