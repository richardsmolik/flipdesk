import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspaces } from "../server/workspaces.js";
import { clearOutbox, outbox } from "../server/services/mailer.js";
import { totpAt } from "../server/services/totp.js";
import { SoftAuthenticator } from "./softAuthenticator.js";

const ENV = ["FLIPDESK_INVITE_CODE", "PUBLIC_BASE_URL", "SMTP_HOST", "SMTP_FROM", "FLIPDESK_SUSPICIOUS_FAILS", "FLY_API_TOKEN", "FLY_APP_NAME", "FLY_MACHINE_ID", "FLY_IMAGE_REF", "FLIPDESK_VERSION", "FLIPDESK_PASSKEY_RESET"];
const ORIGIN = "https://flip.example.com";
const WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
let dir: string;
beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  process.env.PUBLIC_BASE_URL = ORIGIN;
  process.env.SMTP_HOST = "test";
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-r19-"));
  clearOutbox();
});
afterEach(() => {
  for (const k of ENV) delete process.env[k];
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});
type Agent = ReturnType<typeof request.agent>;

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
async function addPasskey(agent: Agent, dev: SoftAuthenticator) {
  const opts = (await agent.post("/api/passkeys/register/options").expect(200)).body;
  return (await agent.post("/api/passkeys/register").send({ response: dev.register(opts) }).expect(200)).body;
}
async function passkeyLogin(agent: Agent, dev: SoftAuthenticator, status: number) {
  const o = (await agent.post("/api/passkeys/login/options").expect(200)).body;
  return agent.post("/api/passkeys/login").send({ ticket: o.ticket, response: dev.login(o.options) }).expect(status);
}
const login = (a: Agent, password: string) => a.post("/api/auth/login").set("User-Agent", WIN).send({ email: "mia@x.com", password });

describe("passkey-only sign-in", () => {
  it("needs two passkeys; then the password stops working, passkeys still do, recovery codes work once and turn it off", async () => {
    const { app, m, o } = await accounts();
    const phone = new SoftAuthenticator(ORIGIN);
    await addPasskey(m, phone);
    expect((await m.post("/api/passkeys/only").send({ on: true }).expect(400)).body.error).toMatch(/second passkey/);
    const laptop = new SoftAuthenticator(ORIGIN);
    const second = (await addPasskey(m, laptop)).passkeys[1];
    const on = (await m.post("/api/passkeys/only").send({ on: true }).expect(200)).body;
    expect(on.recoveryCodes).toHaveLength(10);
    expect((await m.get("/api/passkeys")).body).toMatchObject({ passkeyOnly: true, recoveryLeft: 10 });

    // can't drop below two while it's on
    expect((await m.delete(`/api/passkeys/${second.id}`).expect(400)).body.error).toMatch(/at least two/);

    // the right password is refused; the passkey still works
    const r = await login(request.agent(app), "member-pass-1").expect(403);
    expect(r.body).toMatchObject({ passkeyOnly: true });
    await passkeyLogin(request.agent(app), phone, 200);

    // a password reset never signs in while it's on
    const link = (await o.post("/api/admin/accounts/2/reset-link").expect(200)).body.link as string;
    const resetter = request.agent(app);
    expect((await resetter.post("/api/auth/reset").send({ token: new URL(link).searchParams.get("token"), password: "brand-new-pass-1" }).expect(200)).body).toEqual({ ok: true, signIn: true });
    await resetter.get("/api/account").expect(401);

    // lost everything: a recovery code signs in once and turns passkey-only off
    const lost = request.agent(app);
    await lost.post("/api/passkeys/recover").send({ email: "mia@x.com", code: "nope-nope1" }).expect(401);
    await lost.post("/api/passkeys/recover").send({ email: "mia@x.com", code: on.recoveryCodes[0] }).expect(200);
    expect((await lost.get("/api/account").expect(200)).body.user.email).toBe("mia@x.com");
    expect((await lost.get("/api/passkeys")).body.passkeyOnly).toBe(false);
    await request(app).post("/api/passkeys/recover").send({ email: "mia@x.com", code: on.recoveryCodes[1] }).expect(401); // off now: codes are gone
    await login(request.agent(app), "brand-new-pass-1").expect(200);
    expect(outbox().map((x) => x.subject)).toContain("A FlipDesk recovery code was used");
  });

  it("the owner can switch it off for a member who lost everything; members can't", async () => {
    const { shops, o, m } = await accounts();
    await addPasskey(m, new SoftAuthenticator(ORIGIN));
    await addPasskey(m, new SoftAuthenticator(ORIGIN));
    await m.post("/api/passkeys/only").send({ on: true }).expect(200);
    expect((await o.get("/api/admin/accounts")).body.accounts.find((a: { email: string }) => a.email === "mia@x.com").passkeyOnly).toBe(true);
    await m.post("/api/admin/accounts/2/passkey-only-off").expect(403);
    await o.post("/api/admin/accounts/2/passkey-only-off").expect(200);
    expect(shops.passkeyOnly(2)).toBeNull();
  });

  it("single-password mode works the same, and FLIPDESK_PASSKEY_RESET=1 is the server-side way back", async () => {
    const mk = () => new Workspaces({ dataDir: dir, mainDb: path.join(dir, "main.db"), mainUploads: path.join(dir, "up"), password: "pw-123456" });
    let shops = mk();
    let app = express().use(shops.handler());
    const a = request.agent(app);
    await a.post("/api/login").send({ password: "pw-123456" }).expect(200);
    await addPasskey(a, new SoftAuthenticator(ORIGIN));
    await addPasskey(a, new SoftAuthenticator(ORIGIN));
    await a.post("/api/passkeys/only").send({ on: true }).expect(200);
    await request(app).post("/api/login").send({ password: "pw-123456" }).expect(403);
    process.env.FLIPDESK_PASSKEY_RESET = "1";
    shops = mk();
    app = express().use(shops.handler());
    await request(app).post("/api/login").send({ password: "pw-123456" }).expect(200);
  });
});

describe("suspicious sign-ins", () => {
  it("a new browser right after 3 wrong passwords must type an emailed code; a known browser or a normal sign-in doesn't", async () => {
    const { app, m } = await accounts();
    // normal: new browser, no failures -> straight in
    expect((await login(request.agent(app), "member-pass-1").expect(200)).body).toEqual({ ok: true });

    const attacker = request.agent(app);
    for (let i = 0; i < 3; i++) await login(attacker, `guess-${i}-xx`).expect(401);
    clearOutbox();
    const r = (await login(attacker, "member-pass-1").expect(200)).body;
    expect(r).toMatchObject({ needsCode: true, sentTo: "email" });
    await attacker.get("/api/account").expect(401); // not signed in yet
    const mail = outbox().find((x) => x.subject.startsWith("FlipDesk sign-in code"))!;
    expect(mail.to).toBe("mia@x.com");
    const code = mail.subject.match(/(\d{6})/)![1];
    // the 2fa endpoint doesn't take this ticket, and a wrong code fails
    await attacker.post("/api/login/2fa").send({ ticket: r.ticket, code }).expect(401);
    await attacker.post("/api/login/verify").send({ ticket: r.ticket, code: "000000" === code ? "111111" : "000000" }).expect(401);
    await attacker.post("/api/login/verify").send({ ticket: r.ticket, code }).expect(200);
    await attacker.get("/api/account").expect(200);
    await attacker.post("/api/login/verify").send({ ticket: r.ticket, code }).expect(401); // one use

    // the member's own known browser isn't slowed down by someone else's failures
    expect((await login(m, "member-pass-1").expect(200)).body).toEqual({ ok: true });
  });

  it("with two-step on, the authenticator code is asked instead (no extra email)", async () => {
    const { app, m } = await accounts();
    const setup = (await m.post("/api/2fa/setup")).body;
    await m.post("/api/2fa/enable").send({ code: totpAt(setup.secret, Math.floor(Date.now() / 30_000)) }).expect(200);
    const x = request.agent(app);
    for (let i = 0; i < 3; i++) await login(x, `guess-${i}-xx`).expect(401);
    expect((await login(x, "member-pass-1").expect(200)).body).toMatchObject({ needs2fa: true });
  });

  it("single-password mode sends the code to the owner's phone; no way to send = allowed but logged; can be turned off", async () => {
    const shops = new Workspaces({ dataDir: dir, mainDb: path.join(dir, "main.db"), mainUploads: path.join(dir, "up"), password: "pw-123456" });
    const app = express().use(shops.handler());
    const owner = request.agent(app);
    await owner.post("/api/login").send({ password: "pw-123456" }).expect(200);
    const fail3 = async (a: Agent) => {
      for (let i = 0; i < 3; i++) await a.post("/api/login").send({ password: `bad-${i}` }).expect(401);
    };
    // no phone alerts set up: allowed, with a note in the activity log
    let x = request.agent(app);
    await fail3(x);
    expect((await x.post("/api/login").send({ password: "pw-123456" }).expect(200)).body).toEqual({ ok: true });
    expect(shops.auditList({ q: "suspicious" })).toHaveLength(1);

    const pushes: { title: string; body: string }[] = [];
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => (pushes.push({ title: String((init.headers as Record<string, string>).Title), body: String(init.body) }), new Response("ok")));
    shops.get("main")!.db.prepare("INSERT INTO settings (key, value) VALUES ('notify', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify({ ntfyTopic: "t" }));
    x = request.agent(app);
    await fail3(x);
    const r = (await x.post("/api/login").send({ password: "pw-123456" }).expect(200)).body;
    expect(r).toMatchObject({ needsCode: true, sentTo: "phone" });
    const code = pushes.find((p) => p.title.startsWith("FlipDesk sign-in code"))!.title.match(/(\d{6})/)![1];
    await x.post("/api/login/verify").send({ ticket: r.ticket, code }).expect(200);

    process.env.FLIPDESK_SUSPICIOUS_FAILS = "0";
    x = request.agent(app);
    await fail3(x);
    expect((await x.post("/api/login").send({ password: "pw-123456" }).expect(200)).body).toEqual({ ok: true });
  });
});

import { listVersions, markGood, noteStart, previousGood } from "../server/services/versions.js";
import { safeMode } from "../server/safeMode.js";
import { mergeDay, realTrend, recordTiming, resetRealSpeed, screenOf, currentDay, type RealDay } from "../server/services/realSpeed.js";

describe("going back to the previous version", () => {
  const fly = () => {
    process.env.FLY_API_TOKEN = "tok";
    process.env.FLY_APP_NAME = "flipdesk";
    process.env.FLY_MACHINE_ID = "m1";
    const calls: { method: string; url: string; body?: unknown }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({ config: { image: process.env.FLY_IMAGE_REF, env: { A: "1" }, guest: { cpus: 1 } } }));
    });
    return calls;
  };
  const start = (image: string, version: string, good = true) => {
    process.env.FLY_IMAGE_REF = image;
    process.env.FLIPDESK_VERSION = version;
    noteStart(dir);
    if (good) markGood(dir);
  };

  it("remembers each version that ran; the owner's button switches the machine to the last good image, keeping its settings", async () => {
    start("reg/flipdesk:v1", "aaa111");
    start("reg/flipdesk:v2", "bbb222");
    expect(listVersions(dir).map((v) => v.version)).toEqual(["bbb222", "aaa111"]);
    expect(previousGood(dir)?.image).toBe("reg/flipdesk:v1");

    const { o, m } = await accounts();
    const calls = fly();
    expect((await o.get("/api/versions").expect(200)).body).toMatchObject({ current: "reg/flipdesk:v2", canSwitch: true, previous: { version: "aaa111" } });
    await m.post("/api/versions/rollback").expect(403);
    await o.post("/api/versions/rollback").send({ image: "evil/image:latest" }).expect(400); // only versions that ran here
    const r = (await o.post("/api/versions/rollback").expect(200)).body;
    expect(r).toMatchObject({ ok: true, image: "reg/flipdesk:v1" });
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("https://api.machines.dev/v1/apps/flipdesk/machines/m1");
    expect(post.body).toEqual({ config: { image: "reg/flipdesk:v1", env: { A: "1" }, guest: { cpus: 1 } } });
  });

  it("without a Fly token it explains how instead", async () => {
    start("reg/flipdesk:v1", "aaa111");
    start("reg/flipdesk:v2", "bbb222");
    const { o } = await accounts();
    expect((await o.get("/api/versions")).body.canSwitch).toBe(false);
    expect((await o.post("/api/versions/rollback").expect(400)).body.error).toMatch(/FLY_API_TOKEN/);
  });

  it("an update that can't open the data: safe-mode page, and it goes back to the last good version by itself", async () => {
    start("reg/flipdesk:v1", "aaa111");
    start("reg/flipdesk:v2", "bbb222", false);
    const calls = fly();
    const safe = await safeMode(dir, new Error("FlipDesk tried this update on a copy of your data first, and it didn't pass: your data would shrink: sales 3 → 0."));
    expect(safe.action).toMatch(/Going back to the last version that worked \(aaa111\) by itself/);
    expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({ config: { image: "reg/flipdesk:v1" } });
    expect(listVersions(dir)[0].failed).toMatch(/would shrink/);
    const a = request(safe.app);
    await a.get("/healthz").expect(503);
    expect((await a.get("/inventory").expect(503)).text).toMatch(/your data wasn't changed/);
    await a.get("/api/items").expect(503);
  });
});

describe("speed from real use", () => {
  beforeEach(() => resetRealSpeed());
  it("groups requests by screen (ids and tokens folded, ?view kept), never sign-in or private links", () => {
    expect(screenOf("/api/items/123/photos?x=1")).toBe("/api/items/:id/photos");
    expect(screenOf("/api/items?view=selling&q=nike")).toBe("/api/items?view=selling");
    expect(screenOf("/api/m/abcdefghijklmnopqrstuvwx/photos")).toBeNull();
    expect(screenOf("/api/auth/mode")).toBeNull();
    expect(screenOf("/healthz")).toBeNull();
  });

  it("today vs usual: flags a real slowdown (50% and 100 ms, 20+ uses) and anything with 1 in 20 over 2 s", () => {
    for (let i = 0; i < 30; i++) recordTiming("/api/items?view=inventory", 400 + i, true);
    for (let i = 0; i < 30; i++) recordTiming("/api/sales", i < 27 ? 100 : 2500, true);
    for (let i = 0; i < 5; i++) recordTiming("/api/reports", 900, true); // too few uses to judge
    const day = (d: string, inv: number, sales: number): RealDay => ({ day: d, rows: [{ path: "/api/items?view=inventory", n: 50, p50: inv, p95: inv * 2, errors: 0 }, { path: "/api/sales", n: 50, p50: sales, p95: sales * 2, errors: 0 }, { path: "/api/reports", n: 50, p50: 100, p95: 200, errors: 0 }] });
    let h: RealDay[] = [day("2026-10-30", 200, 100), day("2026-10-31", 210, 110), day("2026-11-01", 190, 100)];
    h = mergeDay(h, { ...currentDay(), day: "2026-11-02" });
    const t = realTrend(h)!;
    expect(t.slower.map((r) => r.name)).toEqual(["Inventory"]);
    expect(t.tooSlow.map((r) => r.name)).toEqual(["Sales"]);
    expect(t.rows.find((r) => r.name === "Reports")).toMatchObject({ slower: false, n: 5 });
  });

  it("is measured on every real screen load, shown to the owner only, alerts once a day and goes in the weekly report", async () => {
    const { shops, o, m } = await accounts();
    for (let i = 0; i < 3; i++) await m.get("/api/items?view=inventory").expect(200);
    shops.siteSet("realSpeed", [{ day: "2026-01-01", rows: [{ path: "/api/items?view=inventory", n: 40, p50: 1, p95: 2, errors: 0 }] }]);
    const r = (await o.get("/api/real-speed").expect(200)).body;
    expect(r.trend.rows.find((x: { path: string }) => x.path === "/api/items?view=inventory").n).toBe(3);
    await m.get("/api/real-speed").expect(403);
    expect((await o.get("/api/admin/owner-report")).body.body).toMatch(/🧭 Real use \(\d{4}-\d\d-\d\d\): \d+ screen loads/);

    const pushes: string[] = [];
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => (pushes.push(String((init.headers as Record<string, string>).Title)), new Response("ok")));
    const ownerDb = shops.get("u1")!.db;
    ownerDb.prepare("INSERT INTO settings (key, value) VALUES ('notify', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify({ ntfyTopic: "t" }));
    for (let i = 0; i < 25; i++) recordTiming("/api/sales", 3000, true);
    await shops.flushRealSpeed();
    await shops.flushRealSpeed();
    expect(pushes.filter((p) => p.includes("slow for real users"))).toHaveLength(1);
  });
});
