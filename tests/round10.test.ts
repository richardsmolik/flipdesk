import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import express from "express";
import sharp from "sharp";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInWorkspace, useAi } from "../server/context.js";
import { Workspaces } from "../server/workspaces.js";
import { clearOutbox, outbox } from "../server/services/mailer.js";

let dir: string;
let shops: Workspaces;
let app: express.Express;
const jpg = () => sharp({ create: { width: 120, height: 120, channels: 3, background: "#468" } }).jpeg().toBuffer();
const ENV = ["FLIPDESK_INVITE_CODE", "FLIPDESK_AI_DAILY_LIMIT", "ANTHROPIC_API_KEY", "SMTP_HOST", "SMTP_FROM", "PUBLIC_BASE_URL"];

async function twoAccounts() {
  const owner = request.agent(app);
  const friend = request.agent(app);
  await owner.post("/api/auth/signup").send({ email: "owner@x.com", password: "owner-pass-1" }).expect(200);
  process.env.FLIPDESK_INVITE_CODE = "inv";
  await friend.post("/api/auth/signup").send({ email: "friend@x.com", password: "friend-pass-1", invite: "inv" }).expect(200);
  return { owner, friend };
}

beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-r10-"));
  shops = new Workspaces({ multiuser: true, dataDir: dir });
  app = express().use(shops.handler());
  clearOutbox();
});
afterEach(() => {
  for (const k of ENV) delete process.env[k];
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("AI daily cap", () => {
  it("counts AI requests per account (sample shop included); the owner is unlimited", async () => {
    const { owner, friend } = await twoAccounts();
    process.env.FLIPDESK_AI_DAILY_LIMIT = "3";
    const u2 = shops.get("u2")!;
    for (let i = 0; i < 3; i++) runInWorkspace(u2, () => useAi("listing"));
    expect(() => runInWorkspace(u2, () => useAi("listing"))).toThrow(/today's 3 AI requests/);
    for (let i = 0; i < 10; i++) runInWorkspace(shops.get("u1")!, () => useAi("listing")); // owner: no cap
    expect((await friend.get("/api/account")).body.ai).toEqual({ used: 3, limit: 3 });
    expect((await owner.get("/api/account")).body.ai).toEqual({ used: 10, limit: null }); // counted (for the cost chart) but never capped

    // the sample shop shares the account's allowance
    await friend.post("/api/workspace").send({ action: "enter_demo" }).expect(200);
    expect(() => runInWorkspace(shops.get("u2d")!, () => useAi("photo"))).toThrow(/AI requests/);

    // over the cap, the AI writer answers 429 before calling Claude
    process.env.ANTHROPIC_API_KEY = "sk-test-not-used";
    const r = await friend.post("/api/ai/generate").attach("photos", await jpg(), "a.jpg");
    expect(r.status).toBe(429);
    expect(r.body.error).toMatch(/midnight UTC/);

    // the owner can raise one person's limit
    const list = (await owner.put("/api/admin/accounts/2").send({ aiLimit: 10 }).expect(200)).body.accounts;
    expect(list.find((a: { id: number }) => a.id === 2)).toMatchObject({ aiLimit: 10, aiToday: 3 }); // failed tries over the cap aren't counted
    expect(() => runInWorkspace(u2, () => useAi("listing"))).not.toThrow();
    await friend.get("/api/admin/accounts").expect(403);
  });
});

describe("passwords", () => {
  it("forgot password emails a one-time link (only to PUBLIC_BASE_URL) and never reveals accounts", async () => {
    await twoAccounts();
    // no mail settings: still ok, nothing sent
    expect((await request(app).post("/api/auth/forgot").send({ email: "friend@x.com" }).expect(200)).body).toEqual({ ok: true, emailed: false });
    process.env.SMTP_HOST = "test";
    process.env.SMTP_FROM = "FlipDesk <no-reply@x.com>";
    expect((await request(app).post("/api/auth/forgot").send({ email: "friend@x.com" })).body.emailed).toBe(false); // no PUBLIC_BASE_URL -> no link from the Host header
    process.env.PUBLIC_BASE_URL = "https://flip.example.com/";
    expect((await request(app).post("/api/auth/forgot").send({ email: "nobody@x.com" }).expect(200)).body).toEqual({ ok: true, emailed: true });
    expect(outbox()).toHaveLength(0);
    await request(app).post("/api/auth/forgot").set("Host", "evil.example").send({ email: "friend@x.com" }).expect(421); // round 16: unknown hosts refused outright
    await request(app).post("/api/auth/forgot").send({ email: "friend@x.com" }).expect(200);
    expect(outbox()).toHaveLength(1);
    const link = outbox()[0].text.match(/https:\/\/flip\.example\.com\/reset\?token=([\w-]+)/)!;
    expect(link).toBeTruthy();

    const s = request.agent(app);
    expect((await s.post("/api/auth/reset").send({ token: link[1], password: "short" })).status).toBe(400);
    await s.post("/api/auth/reset").send({ token: link[1], password: "brand-new-pass" }).expect(200);
    await s.get("/api/items").expect(200); // signed in by the reset
    expect((await request(app).post("/api/auth/reset").send({ token: link[1], password: "again-new-pass" })).status).toBe(410); // one use
    await request(app).post("/api/auth/login").send({ email: "friend@x.com", password: "brand-new-pass" }).expect(200);
    await request(app).post("/api/auth/login").send({ email: "friend@x.com", password: "friend-pass-1" }).expect(401);
  });

  it("owner reset links, change password, delete an account", async () => {
    const { owner, friend } = await twoAccounts();
    const { link } = (await owner.post("/api/admin/accounts/2/reset-link").expect(200)).body;
    const token = new URL(link).searchParams.get("token")!;
    await request(app).post("/api/auth/reset").send({ token, password: "from-owner-link" }).expect(200);
    await friend.get("/api/items").expect(401); // resetting signs out everywhere

    const f2 = request.agent(app);
    await f2.post("/api/auth/login").send({ email: "friend@x.com", password: "from-owner-link" }).expect(200);
    expect((await f2.post("/api/auth/password").send({ current: "nope", next: "another-pass-1" })).body.error).toMatch(/current password/);
    await f2.post("/api/auth/password").send({ current: "from-owner-link", next: "another-pass-1" }).expect(200);

    await f2.post("/api/items").send({ title: "Will be deleted" }).expect(201);
    expect(fs.existsSync(path.join(dir, "users", "2"))).toBe(true);
    await owner.delete("/api/admin/accounts/1").expect(400); // not the owner
    const after = (await owner.delete("/api/admin/accounts/2").expect(200)).body.accounts;
    expect(after.map((a: { email: string }) => a.email)).toEqual(["owner@x.com"]);
    expect(fs.existsSync(path.join(dir, "users", "2"))).toBe(false);
    await f2.get("/api/items").expect(401);
  });
});

describe("share your sample shop", () => {
  it("a read-only link: anyone can look, nobody can change anything, and you can turn it off", async () => {
    const { owner } = await twoAccounts();
    const { share } = (await owner.post("/api/workspace/share").expect(200)).body;
    expect(share.path).toMatch(/^\/s\/[\w-]{20,}$/);
    expect((await owner.post("/api/workspace/share")).body.share.path).toBe(share.path); // same link again

    const visitor = request.agent(app);
    await visitor.get("/api/items").expect(401);
    await visitor.post(`/api/share/${share.path.slice(3)}/open`).expect(200);
    const items = (await visitor.get("/api/items").expect(200)).body;
    expect(items.length).toBeGreaterThan(20);
    expect((await visitor.get("/api/workspace")).body).toMatchObject({ shared: true, current: "demo", user: null });
    expect((await visitor.post("/api/items").send({ title: "x" })).status).toBe(403);
    expect((await visitor.post("/api/workspace").send({ action: "leave_demo" })).status).toBe(403);
    await visitor.get("/api/admin/accounts").expect(403);
    expect((await owner.get("/api/workspace/share")).body.share.views).toBe(1);

    await owner.delete("/api/workspace/share").expect(200);
    await visitor.get("/api/items").expect(401);
    await request(app).post(`/api/share/${share.path.slice(3)}/open`).expect(410);
  });
});

describe("leaderboard", () => {
  it("opt-in only, shows goal % and return %, never dollars", async () => {
    const { owner, friend } = await twoAccounts();
    expect((await owner.get("/api/leaderboard")).body).toMatchObject({ available: true, optedIn: false, rows: [] });
    // friend: goal + a sale this week
    await friend.put("/api/goals").send({ sales: 2 }).expect(200);
    const it = (await friend.post("/api/items").send({ title: "Mug", price: 30, cost: 10 })).body;
    await friend.post(`/api/items/${it.id}/sold`).send({ marketplace: "etsy", salePrice: 30 });
    await friend.post("/api/leaderboard").send({ name: "Mugs4Days" }).expect(200);
    await owner.post("/api/leaderboard").send({ name: "Boss" }).expect(200);
    const lb = (await owner.get("/api/leaderboard")).body;
    expect(lb.rows.map((r: { name: string }) => r.name)).toEqual(["Mugs4Days", "Boss"]);
    expect(lb.rows[1].me).toBe(true);
    expect(JSON.stringify(lb)).not.toMatch(/profit"|revenue|\$/);
    await owner.post("/api/leaderboard").send({ name: null }).expect(200);
    expect((await friend.get("/api/leaderboard")).body.rows.map((r: { name: string }) => r.name)).toEqual(["Mugs4Days"]);
    expect((await friend.post("/api/leaderboard").send({ name: "x" })).status).toBe(400);
  });
});

describe("help videos", () => {
  it("the owner sets a video link per step; everyone sees it; https only", async () => {
    const { owner, friend } = await twoAccounts();
    await friend.put("/api/help-videos").send({ ebay: "https://youtu.be/x" }).expect(403);
    expect((await owner.put("/api/help-videos").send({ ebay: "javascript:alert(1)" })).status).toBe(400);
    await owner.put("/api/help-videos").send({ ebay: "https://www.loom.com/share/abc", item: "  " }).expect(200);
    expect((await friend.get("/api/help-videos")).body).toEqual({ ebay: "https://www.loom.com/share/abc" });
  });

  it("single-user: you are the owner", async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "fd-r10s-"));
    const single = new Workspaces({ multiuser: false, mainDb: path.join(d, "f.db"), password: "" });
    const a = express().use(single.handler());
    await request(a).put("/api/help-videos").send({ notify: "https://youtu.be/abc" }).expect(200);
    expect((await request(a).get("/api/account")).body).toMatchObject({ user: null, canEditSite: true });
    expect((await request(a).get("/api/leaderboard")).body).toEqual({ available: false });
    fs.rmSync(d, { recursive: true, force: true });
  });
});
