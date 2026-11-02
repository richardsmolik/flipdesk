import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspaces } from "../server/workspaces.js";
import { clearOutbox, outbox } from "../server/services/mailer.js";
import { totpAt } from "../server/services/totp.js";
import { describeDevice } from "../server/services/passkeys.js";
import { SoftAuthenticator } from "./softAuthenticator.js";
import { openDb, getSetting, setSetting, rehearseUpdate, SCHEMA_VERSION } from "../server/db.js";
import { DatabaseSync } from "node:sqlite";
import { rehearse } from "../scripts/rehearse.js";
import { ebayCheckIfDue, ebayReadOnlyCheck } from "../server/services/ebaySmoke.js";
import { listProblems } from "../server/services/replay.js";
import { compareSpeed, speedLine, speedTrend } from "../server/services/selfcheck.js";

const ENV = ["FLIPDESK_INVITE_CODE", "PUBLIC_BASE_URL", "SMTP_HOST", "SMTP_FROM", "EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "EBAY_ENV"];
const ORIGIN = "https://flip.example.com";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
let dir: string;
beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  process.env.PUBLIC_BASE_URL = ORIGIN;
  process.env.SMTP_HOST = "test";
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-r18-"));
  clearOutbox();
});
afterEach(() => {
  for (const k of ENV) delete process.env[k];
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function accounts() {
  const shops = new Workspaces({ multiuser: true, dataDir: dir });
  const app = express().use(shops.handler());
  const o = request.agent(app);
  await o.post("/api/auth/signup").set("User-Agent", WIN).send({ email: "owner@x.com", password: "owner-pass-1" }).expect(200);
  process.env.FLIPDESK_INVITE_CODE = "inv";
  const m = request.agent(app);
  await m.post("/api/auth/signup").set("User-Agent", IPHONE).send({ email: "mia@x.com", password: "member-pass-1", invite: "inv" }).expect(200);
  clearOutbox();
  return { shops, app, o, m };
}

async function addPasskey(agent: ReturnType<typeof request.agent>, dev: SoftAuthenticator) {
  const opts = (await agent.post("/api/passkeys/register/options").expect(200)).body;
  expect(opts.rp.id).toBe("flip.example.com");
  expect(opts.authenticatorSelection).toMatchObject({ residentKey: "required", userVerification: "required" });
  return (await agent.post("/api/passkeys/register").send({ response: dev.register(opts), name: "My iPhone" }).expect(200)).body;
}
async function passkeyLogin(agent: ReturnType<typeof request.agent>, dev: SoftAuthenticator, status: number, opts?: { origin?: string }) {
  const o = (await agent.post("/api/passkeys/login/options").expect(200)).body;
  return agent.post("/api/passkeys/login").send({ ticket: o.ticket, response: dev.login(o.options, undefined, opts) }).expect(status);
}

describe("passkeys", () => {
  it("add one, sign in with it (no password, no code even with two-step on), rename, remove", async () => {
    const { app, m } = await accounts();
    const phone = new SoftAuthenticator(ORIGIN);
    const r = await addPasskey(m, phone);
    expect(r.passkeys).toMatchObject([{ name: "My iPhone", last_used_at: null }]);

    // turn on two-step: the passkey still signs in by itself (it's both steps)
    const setup = (await m.post("/api/2fa/setup").expect(200)).body;
    await m.post("/api/2fa/enable").send({ code: totpAt(setup.secret, Math.floor(Date.now() / 30_000)) }).expect(200);

    const fresh = request.agent(app);
    expect((await passkeyLogin(fresh, phone, 200)).body).toEqual({ ok: true });
    expect((await fresh.get("/api/account").expect(200)).body.user.email).toBe("mia@x.com");
    const list = (await m.get("/api/passkeys")).body.passkeys;
    expect(list[0].last_used_at).not.toBeNull();

    // a challenge works once
    const o = (await fresh.post("/api/passkeys/login/options")).body;
    const answer = phone.login(o.options);
    await fresh.post("/api/passkeys/login").send({ ticket: o.ticket, response: answer }).expect(200);
    await fresh.post("/api/passkeys/login").send({ ticket: o.ticket, response: answer }).expect(401);
    // a look-alike site can't use it
    expect((await passkeyLogin(request.agent(app), phone, 401, { origin: "https://flip-example.com" })).body.error).toMatch(/didn't work/);

    expect((await m.patch(`/api/passkeys/${list[0].id}`).send({ name: "Work phone" }).expect(200)).body.passkeys[0].name).toBe("Work phone");
    await m.delete(`/api/passkeys/${list[0].id}`).expect(200);
    expect((await passkeyLogin(request.agent(app), phone, 401)).body.error).toMatch(/isn't set up/);
  });

  it("each account only manages its own passkeys; deleting an account removes them", async () => {
    const { app, o, m, shops } = await accounts();
    const k = (await addPasskey(m, new SoftAuthenticator(ORIGIN))).passkeys[0];
    expect((await o.get("/api/passkeys")).body.passkeys).toEqual([]);
    await o.delete(`/api/passkeys/${k.id}`).expect(404);
    shops.deleteAccount(2);
    expect(shops.site.prepare("SELECT COUNT(*) AS n FROM passkeys").get()).toEqual({ n: 0 });
    await request(app).get("/api/passkeys").expect(401);
  });

  it("single-password mode: the owner can add one; without a password it explains why not", async () => {
    const none = new Workspaces({ dataDir: dir, mainDb: path.join(dir, "a.db"), mainUploads: path.join(dir, "ua"), password: "" });
    expect((await request(express().use(none.handler())).get("/api/passkeys").expect(200)).body.unavailable).toMatch(/FLIPDESK_PASSWORD/);

    const d2 = path.join(dir, "b");
    const shops = new Workspaces({ dataDir: d2, mainDb: path.join(d2, "main.db"), mainUploads: path.join(d2, "up"), password: "pw-123456" });
    const app = express().use(shops.handler());
    const a = request.agent(app);
    await a.post("/api/login").send({ password: "pw-123456" }).expect(200);
    const key = new SoftAuthenticator(ORIGIN);
    await addPasskey(a, key);
    const b = request.agent(app);
    await b.get("/api/items").expect(401);
    await passkeyLogin(b, key, 200);
    await b.get("/api/items").expect(200);
  });
});

describe("new-device alerts", () => {
  it("first sign-in on a new browser emails a heads-up with a 'this wasn't me' link; a known browser doesn't", async () => {
    const { app, m } = await accounts();
    const laptop = request.agent(app);
    await laptop.post("/api/auth/login").set("User-Agent", WIN).send({ email: "mia@x.com", password: "member-pass-1" }).expect(200);
    await vi.waitFor(() => expect(outbox()).toHaveLength(1));
    const mail = outbox()[0];
    expect(mail).toMatchObject({ to: "mia@x.com", subject: "New sign-in to FlipDesk: Chrome on Windows" });
    expect(mail.text).toMatch(new RegExp(`${ORIGIN}/not-me\\?t=[\\w-]+`));
    // same browser again: quiet
    await laptop.post("/api/auth/login").set("User-Agent", WIN).send({ email: "mia@x.com", password: "member-pass-1" }).expect(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(outbox()).toHaveLength(1);
    const devs = (await laptop.get("/api/devices").expect(200)).body.devices;
    expect(devs.map((d: { device: string; thisOne: boolean }) => [d.device, d.thisOne])).toEqual(expect.arrayContaining([["Chrome on Windows", true], ["Safari on iPhone", false]]));
    void m;
  });

  it("'this wasn't me' signs every device out, removes passkeys added since, sends a reset link, and works once", async () => {
    process.env.SMTP_FROM = "x@y";
    const { app, m } = await accounts();
    const intruder = request.agent(app);
    await intruder.post("/api/auth/login").set("User-Agent", WIN).send({ email: "mia@x.com", password: "member-pass-1" }).expect(200);
    await vi.waitFor(() => expect(outbox()).toHaveLength(1));
    const token = outbox()[0].text.match(/not-me\?t=([\w-]+)/)![1];
    await addPasskey(intruder, new SoftAuthenticator(ORIGIN)); // the intruder tries to stay in
    clearOutbox();

    // opening the link is harmless; only the button (POST) acts
    await request(app).get(`/not-me?t=${token}`);
    await m.get("/api/account").expect(200);

    const r = (await request(app).post("/api/auth/not-me").send({ token }).expect(200)).body;
    expect(r).toMatchObject({ ok: true, resetSent: true, removedPasskeys: 1 });
    await m.get("/api/account").expect(401);
    await intruder.get("/api/account").expect(401);
    expect(outbox().map((x) => x.subject)).toContain("Reset your FlipDesk password");
    await request(app).post("/api/auth/not-me").send({ token }).expect(410);
  });

  it("'sign out everywhere else' keeps this device", async () => {
    const { app, m } = await accounts();
    const other = request.agent(app);
    await other.post("/api/auth/login").set("User-Agent", WIN).send({ email: "mia@x.com", password: "member-pass-1" }).expect(200);
    await m.post("/api/devices/sign-out-everywhere").expect(200);
    await m.get("/api/account").expect(200);
    await other.get("/api/account").expect(401);
  });

  it("single-password mode: phone alert + Inbox note; signing out everywhere also ends the older password cookie", async () => {
    process.env.SMTP_HOST = "";
    const shops = new Workspaces({ dataDir: dir, mainDb: path.join(dir, "main.db"), mainUploads: path.join(dir, "up"), password: "pw-123456" });
    const app = express().use(shops.handler());
    const pushes: string[] = [];
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => (pushes.push(String((init.headers as Record<string, string>).Title)), new Response("ok")));
    const main = shops.get("main")!;
    main.db.prepare("INSERT INTO settings (key, value) VALUES ('notify', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify({ ntfyTopic: "t" }));
    const a = request.agent(app);
    await a.post("/api/login").set("User-Agent", WIN).send({ password: "pw-123456" }).expect(200);
    const b = request.agent(app);
    await b.post("/api/login").set("User-Agent", IPHONE).send({ password: "pw-123456" }).expect(200);
    await vi.waitFor(() => expect(pushes).toEqual(["New sign-in to FlipDesk: Safari on iPhone"]));
    expect(main.db.prepare("SELECT title FROM alerts WHERE kind = 'security'").all()).toHaveLength(1);

    // a browser still holding the old-style password cookie
    const crypto = await import("node:crypto");
    const legacy = crypto.createHmac("sha256", "pw-123456").update("flipdesk-session").digest("base64url");
    await request(app).get("/api/items").set("Cookie", `fd_session=${legacy}`).expect(200);
    await a.post("/api/devices/sign-out-everywhere").expect(200);
    await request(app).get("/api/items").set("Cookie", `fd_session=${legacy}`).expect(401);
    await b.get("/api/items").expect(401);
    await a.get("/api/items").expect(200);
  });

  it("names devices in plain words", () => {
    expect(describeDevice(IPHONE)).toBe("Safari on iPhone");
    expect(describeDevice(WIN)).toBe("Chrome on Windows");
    expect(describeDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15")).toBe("Safari on Mac");
    expect(describeDevice("Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36 EdgA/140")).toBe("Chrome on Android");
    expect(describeDevice("")).toBe("an unknown device");
  });
});

describe("weekly eBay check", () => {
  const setup = (env: "sandbox" | "production") => {
    process.env.EBAY_CLIENT_ID = "id";
    process.env.EBAY_CLIENT_SECRET = "secret";
    process.env.EBAY_ENV = env;
    const db = openDb(":memory:");
    db.prepare("INSERT INTO connections (marketplace, status, credentials) VALUES ('ebay', 'connected', ?)").run(JSON.stringify({ refresh_token: "r", access_token: "a", expires_at: Date.now() + 3600_000 }));
    setSetting(db, "ebay", { fulfillmentPolicyId: "f", paymentPolicyId: "p", returnPolicyId: "r", merchantLocationKey: "loc" });
    return db;
  };
  const ebay = (o: { policies?: string[]; locations?: string[] } = {}) => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      const u = new URL(input);
      const m = (init?.method ?? "GET").toUpperCase();
      calls.push(`${m} ${u.pathname}`);
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
      const ids = o.policies ?? ["f", "p", "r"];
      if (u.pathname.endsWith("/oauth2/token")) return json({ access_token: "app", expires_in: 7200 });
      if (u.pathname.includes("fulfillment_policy")) return json({ fulfillmentPolicies: ids.includes("f") ? [{ fulfillmentPolicyId: "f", name: "Ship" }] : [] });
      if (u.pathname.includes("payment_policy")) return json({ paymentPolicies: [{ paymentPolicyId: "p", name: "Pay" }] });
      if (u.pathname.includes("return_policy")) return json({ returnPolicies: [{ returnPolicyId: "r", name: "Ret" }] });
      if (u.pathname.endsWith("/location")) return json({ locations: (o.locations ?? ["loc"]).map((k) => ({ merchantLocationKey: k })) });
      if (u.pathname.includes("get_category_suggestions")) return json({ categorySuggestions: [{ category: { categoryId: "1", categoryName: "Athletic Shoes" } }] });
      if (u.pathname.endsWith("/order")) return json({ orders: [{ orderId: "1", lineItems: [] }] });
      return json({});
    });
    return calls;
  };

  it("real account: read-only, never lists or changes anything", async () => {
    const db = setup("production");
    const calls = ebay();
    const r = await ebayReadOnlyCheck(db);
    expect(r.ok).toBe(true);
    expect(r.steps.map((s) => s.name)).toEqual(["eBay connected", "Reach your eBay account", "Your chosen policies still exist", "Ship-from location still exists", "Category lookup works", "Sales feed works"]);
    expect(calls.filter((c) => !c.startsWith("GET ") && !c.endsWith("/oauth2/token"))).toEqual([]);
  });

  it("catches a policy you deleted on eBay (before a listing would fail), files it in the Inbox, clears it when fixed", async () => {
    const db = setup("production");
    ebay({ policies: ["p", "r"] });
    const r = await ebayCheckIfDue(db, path.join(dir, "up"));
    expect(r).toMatchObject({ ok: false, kind: "read-only" });
    expect(r!.steps.find((s) => !s.ok)!.detail).toMatch(/no longer has your chosen shipping policy/);
    const alerts = () => db.prepare("SELECT title FROM alerts WHERE kind = 'ebay-check' AND resolved_at IS NULL").all() as { title: string }[];
    expect(alerts()).toEqual([{ title: "Weekly eBay check failed: Your chosen policies still exist" }]);
    expect(listProblems(db)[0].summary).toMatch(/weekly-check/);
    // not due again for a week
    expect(await ebayCheckIfDue(db, path.join(dir, "up"))).toBeNull();
    ebay();
    expect(await ebayCheckIfDue(db, path.join(dir, "up"), Date.now() + 7 * 86400_000)).toMatchObject({ ok: true });
    expect(alerts()).toEqual([]);
  });

  it("sandbox: runs the full list-and-end test; can be turned off; not connected = nothing", async () => {
    const db = setup("sandbox");
    process.env.PUBLIC_BASE_URL = ORIGIN;
    const calls = ebay();
    const r = await ebayCheckIfDue(db, path.join(dir, "up"));
    expect(r?.kind).toBe("full");
    expect(calls.some((c) => c.endsWith("/publish"))).toBe(true);
    expect(getSetting<{ ok: boolean } | null>(db, "ebaySmoke", null)).not.toBeNull(); // also counts as the end-to-end test

    setSetting(db, "ebayWeekly", { enabled: false, last: null });
    expect(await ebayCheckIfDue(db, path.join(dir, "up"))).toBeNull();
    const fresh = openDb(":memory:");
    expect(await ebayCheckIfDue(fresh, path.join(dir, "up"))).toBeNull();
  });
});

describe("speed: this week vs last week", () => {
  const run = (daysAgo: number, inv: number, dash: number) => ({ at: new Date(Date.now() - daysAgo * 86400_000).toISOString(), speed: [{ path: "/api/items?view=inventory", ms: inv }, { path: "/api/dashboard", ms: dash }] });

  it("compares the median of each week; flags only real slowdowns (25% AND 30 ms)", () => {
    const h = [run(1, 180, 12), run(2, 170, 9), run(3, 175, 10), run(8, 100, 6), run(9, 105, 5), run(10, 95, 5)];
    const t = speedTrend(h)!;
    expect(t.runs).toEqual({ now: 3, before: 3 });
    expect(t.rows.find((r) => r.name === "Inventory")).toMatchObject({ now: 175, before: 100, changePct: 75 });
    expect(t.slower.map((r) => r.name)).toEqual(["Inventory"]); // Dashboard doubled too, but only by 5 ms
    expect(speedLine(t)).toBe("⚡ Screens answer in ~93 ms on average (last week 53 ms, +75%) · slower: Inventory +75%");
  });

  it("first week: no comparison yet; nothing at all before the first check", () => {
    expect(speedLine(speedTrend([run(1, 50, 5)]))).toBe("⚡ Screens answer in ~28 ms on average");
    expect(speedTrend([])).toBeNull();
    expect(compareSpeed([{ path: "/x", ms: 400 }], [{ path: "/x", ms: 100 }], { pct: 50, ms: 50 }).slower).toHaveLength(1);
  });

  it("shows on the owner's weekly report and the Status page (owner only)", async () => {
    const { shops, o, m } = await accounts();
    shops.siteSet("selfChecks", [run(1, 180, 12), run(8, 100, 6)]);
    expect((await o.get("/api/admin/owner-report")).body.body).toMatch(/⚡ Screens answer in ~96 ms on average \(last week 53 ms, \+81%\) · slower: Inventory \+80%/);
    expect((await o.get("/api/selfcheck/trend").expect(200)).body.trend.slower).toHaveLength(1);
    await m.get("/api/selfcheck/trend").expect(403);
  });
});

describe("updates are tried on a copy first", () => {
  const shop = () => {
    const file = path.join(dir, "shop", "flipdesk.db");
    const db = openDb(file);
    for (let i = 1; i <= 3; i++) {
      db.prepare("INSERT INTO items (sku, title, price) VALUES (?, ?, 10)").run(`S${i}`, `Item ${i}`);
      db.prepare("INSERT INTO photos (item_id, path, position) VALUES (?, '/x.jpg', 0)").run(i);
      db.prepare("INSERT INTO sales (item_id, marketplace, quantity, sale_price, sold_at) VALUES (?, 'ebay', 1, 20, datetime('now'))").run(i);
    }
    return { file, db };
  };
  const count = (db: DatabaseSync, t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;

  it("a good update passes on the copy, and a copy of the old data is kept", () => {
    const { file, db } = shop();
    const r = rehearseUpdate(db, file, 5, (d) => d.exec("ALTER TABLE items ADD COLUMN extra TEXT"));
    expect(r).toMatchObject({ ok: true, from: 5, to: SCHEMA_VERSION });
    const kept = new DatabaseSync(r.backup!, { readOnly: true });
    expect(count(kept, "items")).toBe(3);
    kept.close();
    expect(JSON.parse(fs.readFileSync(path.join(dir, "shop", "before-update", "last.json"), "utf8")).ok).toBe(true);
    expect(fs.readdirSync(path.join(dir, "shop", "before-update")).filter((f) => f.includes("trial"))).toEqual([]); // scratch copy cleaned up
    expect(db.prepare("SELECT name FROM pragma_table_info('items') WHERE name = 'extra'").get()).toBeUndefined(); // the real one isn't touched by the rehearsal
  });

  it("an update that would lose your data is stopped, and the real database is left exactly as it was", () => {
    const { file, db } = shop();
    expect(() => rehearseUpdate(db, file, 5, (d) => d.exec("DELETE FROM sales"))).toThrow(/didn't pass: your data would shrink: sales 3 → 0\. Your data was NOT changed/);
    expect(count(db, "sales")).toBe(3);
    expect(() => rehearseUpdate(db, file, 5, () => { throw new Error("Migration to v6 failed: no such column"); })).toThrow(/Migration to v6 failed/);
    expect(() => rehearseUpdate(db, file, 5, (d) => d.exec("PRAGMA foreign_keys = OFF; DELETE FROM items WHERE id = 1; INSERT INTO items (sku, title) VALUES ('N', 'n')"))).toThrow(/2 records would point at things that no longer exist/);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "shop", "before-update", "last.json"), "utf8"))).toMatchObject({ ok: false });
    expect(count(db, "items")).toBe(3);
  });

  it("happens by itself when FlipDesk starts on an older database; keeps the newest 3 old copies", () => {
    const { file, db } = shop();
    const downgrade = (d: DatabaseSync) => d.exec(`DROP TABLE upload_tokens; ALTER TABLE photos DROP COLUMN phash; PRAGMA user_version = ${SCHEMA_VERSION - 1};`);
    downgrade(db);
    db.close();
    for (let i = 0; i < 4; i++) {
      const d = openDb(file);
      expect(d.prepare("SELECT name FROM pragma_table_info('photos') WHERE name = 'phash'").get()).toBeTruthy();
      expect(count(d, "items")).toBe(3);
      downgrade(d);
      d.close();
      // a distinct name each time (copies are named to the second)
      const dirB = path.join(dir, "shop", "before-update");
      for (const f of fs.readdirSync(dirB).filter((x) => /-v5-\d{8}-\d{6}\.db$/.test(x))) fs.renameSync(path.join(dirB, f), path.join(dirB, f.replace(/(\d{6})\.db$/, `$1${i}.db`)));
    }
    expect(fs.readdirSync(path.join(dir, "shop", "before-update")).filter((f) => f.endsWith(".db"))).toHaveLength(3);
  });

  it("the before-you-deploy script: a backup folder updates cleanly and every screen opens", async () => {
    const { db } = shop();
    db.close();
    const r = await rehearse(path.join(dir, "shop"));
    expect(r.ok).toBe(true);
    expect(r.shops[0]).toMatchObject({ items: [3, 3], sales: [3, 3], problems: [] });
    expect(r.shops[0].screens.every((s) => s.status === 200)).toBe(true);
    expect(count(new DatabaseSync(path.join(dir, "shop", "flipdesk.db"), { readOnly: true }), "items")).toBe(3); // the original folder is untouched
  });
});
