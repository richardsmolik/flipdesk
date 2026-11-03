import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspaces } from "../server/workspaces.js";
import { setSetting, type Db } from "../server/db.js";
import { setAiCostSink, setAiKeys, setAiRouting } from "../server/services/llm.js";
import { replay, rulePrice, type DropRule } from "../server/services/dropBacktest.js";
import { scoreByCategory, type Case } from "../server/services/backtest.js";
import { resetHealth } from "../server/health.js";

const KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "MOONSHOT_API_KEY", "OPENAI_MODEL", "KIMI_MODEL", "EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "EBAY_ENV", "PUBLIC_BASE_URL"];
let dir: string;
beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  setAiRouting({ order: [], models: {} });
  setAiKeys({});
  setAiCostSink(null);
  resetHealth();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-r22-"));
});
afterEach(() => {
  for (const k of KEYS) delete process.env[k];
  vi.unstubAllGlobals();
  setAiRouting({ order: [], models: {} });
  fs.rmSync(dir, { recursive: true, force: true });
});
const chat = (content: string) => new Response(JSON.stringify({ model: "served", choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 200 } }), { headers: { "content-type": "application/json" } });
function shop() {
  const shops = new Workspaces({ dataDir: dir, mainDb: path.join(dir, "flipdesk.db"), mainUploads: path.join(dir, "uploads"), password: "" });
  return { shops, db: shops.get("main")!.db, app: express().use(shops.handler()) };
}
const draft = (price: number, category = "Shoes > Men") => ({
  title: "Nike Air Max 90 Mens 10", short_title: "Nike AM90", description: "x", brand: "Nike", category, condition: "used_good", color: "White", size: "10",
  item_specifics: [], keywords: [], flaws: [], verify: [], price: { recommended: price, low: price - 10, high: price + 10, quick_sale: price - 5, confidence: "medium", reasoning: "Similar pairs sold for $55-65." }, best_marketplaces: ["ebay"],
});
const day = (d: number) => new Date(Date.UTC(2026, 0, 1) + d * 86400_000).toISOString().slice(0, 19).replace("T", " ");

describe("price-drop backtest", () => {
  const fast: DropRule = { key: "fast", name: "Fast", afterDays: 7, everyDays: 7, dropPct: 10, floorPct: 60 };
  const none: DropRule = { key: "none", name: "None", afterDays: 10000, everyDays: 10000, dropPct: 0, floorPct: 100 };
  const item = (o: Partial<{ start: number; floor: number | null; soldDay: number; price: number; changes: { at: string; price: number }[] }>) => ({ start: 100, floor: null, listed: day(0), soldAt: day(o.soldDay ?? 30), price: 80, changes: [], ...o });

  it("rule prices step down on schedule and stop at the floor", () => {
    expect([0, 6, 7, 13, 14, 21].map((d) => rulePrice(fast, 100, 60, d))).toEqual([100, 100, 90, 90, 81, 72.9]);
    expect(rulePrice(fast, 100, 60, 70)).toBe(60);
  });

  it("same buyer, same wait after the price reaches what they paid", () => {
    // Really: dropped to $80 on day 25, sold day 30 (buyer came 5 days after). Fast rule reaches ≤$80 on day 21.
    const s = item({ changes: [{ at: day(25), price: 80 }] });
    expect(replay(fast, s)).toEqual({ day: 26, price: 72.9 });
    expect(replay(none, s)).toBeNull(); // never drops to $80: wouldn't have sold
    // Sold by offer below asking: same day, lower of the two prices.
    expect(replay(fast, item({ soldDay: 10, price: 95 }))).toEqual({ day: 10, price: 90 });
    // Already listed at the sale price: no drop needed, same day.
    expect(replay(fast, item({ start: 80, soldDay: 3 }))).toEqual({ day: 3, price: 80 });
  });

  it("compares rules on your real sales, including your own setting", async () => {
    const { app, db } = shop();
    setSetting(db, "autoDrop", { enabled: true, afterDays: 10, everyDays: 10, dropPct: 20 });
    for (let i = 0; i < 12; i++) {
      const id = Number(db.prepare("INSERT INTO items (sku, title, price, original_price, created_at) VALUES (?, 'x', 80, 100, ?)").run(`D${i}`, day(0)).lastInsertRowid);
      db.prepare("INSERT INTO price_changes (item_id, old_price, new_price, at) VALUES (?, 100, 80, ?)").run(id, day(40));
      db.prepare("INSERT INTO sales (item_id, marketplace, quantity, sale_price, sold_at) VALUES (?, 'ebay', 1, 80, ?)").run(id, day(45));
    }
    const r = (await request(app).get("/api/drop-backtest").expect(200)).body;
    expect(r.items).toBe(12);
    expect(r.actual.avgDays).toBe(45);
    const by = Object.fromEntries(r.results.map((x: { rule: { key: string } }) => [x.rule.key, x]));
    expect(by.none).toMatchObject({ sold: 0, unsold: 12 });
    expect(by.yours).toMatchObject({ sold: 12, avgDays: 15, daysSaved: 30, revenueChange: 0 }); // 20% on day 10 = $80 exactly, buyer 5 days later
    expect(r.takeaway).toMatch(/sooner on average/);
  });
});

describe("best AI per category", () => {
  it("finds winners within categories with 5+ items", () => {
    const cases: Case[] = [];
    for (let i = 0; i < 6; i++) cases.push({ saleId: i, itemId: i, title: "", listedAt: "", soldAt: "", actual: 100, actualDays: 1, yourPrice: null, compsBefore: [], compMedian: null, category: "Shoes" });
    for (let i = 6; i < 12; i++) cases.push({ saleId: i, itemId: i, title: "", listedAt: "", soldAt: "", actual: 100, actualDays: 1, yourPrice: null, compsBefore: [], compMedian: null, category: "Vintage" });
    cases.push({ saleId: 99, itemId: 99, title: "", listedAt: "", soldAt: "", actual: 100, actualDays: 1, yourPrice: null, compsBefore: [], compMedian: null, category: "Toys" });
    const rows = cases.flatMap((c) => [
      { saleId: c.saleId, predictor: "openai", price: c.category === "Shoes" ? 102 : 140, days: 1 },
      { saleId: c.saleId, predictor: "kimi", price: c.category === "Shoes" ? 130 : 101, days: 1 },
    ]);
    const by = scoreByCategory(cases, rows, ["openai", "kimi"]);
    expect(by.map((c) => [c.category, c.winner])).toEqual([["Shoes", "openai"], ["Vintage", "kimi"]]);
  });

  it("when turned on, an item in that category goes to its best AI first; Why-this-price says so", async () => {
    const { app, db } = shop();
    process.env.OPENAI_API_KEY = "o";
    process.env.OPENAI_MODEL = "gpt-9";
    process.env.MOONSHOT_API_KEY = "k";
    process.env.KIMI_MODEL = "kimi-9";
    setAiRouting({ order: ["openai", "kimi"], models: {} });
    setSetting(db, "backtests", [{ id: "bt", at: "2026-10-01", status: "done", scores: [], cases: [], rows: [], providers: [], byCategory: [{ category: "Shoes", n: 8, winner: "kimi", scores: [] }] }]);
    setSetting(db, "secondOpinion", { on: false, threshold: 100 });
    const hosts: string[] = [];
    vi.stubGlobal("fetch", async (u: string) => (hosts.push(new URL(u).host), chat(JSON.stringify(draft(60)))));
    const id = Number(db.prepare("INSERT INTO items (sku, title, category) VALUES ('N1', '', 'Shoes > Men')").run().lastInsertRowid);
    await request(app).post("/api/ai/generate").field("itemId", String(id)).field("hint", "nike").expect(200);
    expect(hosts.at(-1)).toBe("api.openai.com"); // routing off: your order
    await request(app).put("/api/ai-insights/settings").send({ byCategory: true }).expect(200);
    const r = (await request(app).post("/api/ai/generate").field("itemId", String(id)).field("hint", "nike").expect(200)).body;
    expect(r.provider).toBe("kimi");
    const why = (await request(app).get(`/api/items/${id}/price-why`).expect(200)).body;
    expect(why).toMatchObject({ provider: "kimi", price: 60, low: 50, high: 70, confidence: "medium", reasoning: "Similar pairs sold for $55-65.", preferredFor: "Shoes" });
  });
});

describe("fresh titles for stale listings", () => {
  const setupEbay = (db: Db) => {
    process.env.EBAY_CLIENT_ID = "id";
    process.env.EBAY_CLIENT_SECRET = "secret";
    process.env.EBAY_ENV = "production";
    process.env.PUBLIC_BASE_URL = "https://flip.example.com";
    db.prepare("INSERT INTO connections (marketplace, status, credentials) VALUES ('ebay', 'connected', ?)").run(JSON.stringify({ refresh_token: "r", access_token: "a", expires_at: Date.now() + 3600_000 }));
  };
  it("lists 30+ day unsold items, suggests a title from similar sold titles, applies it (eBay listing updated live), and tracks results", async () => {
    const { app, db } = shop();
    process.env.OPENAI_API_KEY = "o";
    process.env.OPENAI_MODEL = "gpt-9";
    setupEbay(db);
    const id = Number(db.prepare("INSERT INTO items (sku, title, brand, price, status, created_at) VALUES ('OLD1', 'nike shoes 10', 'Nike', 60, 'active', datetime('now','-45 days'))").run().lastInsertRowid);
    db.prepare("INSERT INTO photos (item_id, path, position) VALUES (?, 'https://img.example.com/a.jpg', 0)").run(id);
    for (const m of ["ebay", "poshmark"]) db.prepare("INSERT INTO listings (item_id, marketplace, status, price, listed_at) VALUES (?, ?, 'active', 60, datetime('now','-45 days'))").run(id, m);
    db.prepare("INSERT INTO items (sku, title, status, created_at) VALUES ('NEW1', 'fresh item', 'active', datetime('now','-3 days'))").run();
    db.prepare("INSERT INTO sold_comps (source, title, title_norm, price, sold_at) VALUES ('csv', 'Nike Air Max 90 Mens Size 10 White', 'nike air max 90 mens size 10 white', 70, '2026-09-01')").run();
    const calls: { host: string; method: string; path: string; body: string }[] = [];
    vi.stubGlobal("fetch", async (u: string, init?: RequestInit) => {
      const url = new URL(u);
      calls.push({ host: url.host, method: init?.method ?? "GET", path: url.pathname, body: String(init?.body ?? "") });
      if (url.host === "api.openai.com") return chat(JSON.stringify({ title: "Nike Air Max 90 Mens Size 10 White Running Shoes", why: "Adds the model and color buyers search for." }));
      if (url.pathname.endsWith("/oauth2/token")) return new Response(JSON.stringify({ access_token: "a", expires_in: 7200 }));
      return new Response(null, { status: 204 });
    });
    const st = (await request(app).get("/api/titles/stale").expect(200)).body;
    expect(st.items.map((x: { title: string }) => x.title)).toEqual(["nike shoes 10"]);
    const sug = (await request(app).post(`/api/items/${id}/fresh-title`).expect(200)).body;
    expect(sug).toMatchObject({ title: "Nike Air Max 90 Mens Size 10 White Running Shoes", provider: "openai" });
    const ai = calls.find((c) => c.host === "api.openai.com")!;
    expect(ai.body).toMatch(/Nike Air Max 90 Mens Size 10 White \(\$70\)/); // similar sold titles were shown
    const ap = (await request(app).post(`/api/items/${id}/fresh-title/apply`).send({ title: sug.title, provider: "openai" }).expect(200)).body;
    expect(ap).toMatchObject({ ebay: "updated", editElsewhere: ["poshmark"] });
    expect(ap.item.title).toBe(sug.title);
    const put = calls.find((c) => c.method === "PUT" && c.path.endsWith("/inventory_item/OLD1"))!;
    expect(JSON.parse(put.body).product.title).toBe(sug.title);
    const rep = (await request(app).get("/api/ai-insights").expect(200)).body.rewrites;
    expect(rep).toMatchObject({ rewritten: 1, soldSince: 0 });
    // counts as an AI-written title from now on
    expect(db.prepare("SELECT provider FROM ai_titles").all()).toEqual([{ provider: "openai" }]);
  });
});

describe("one-page AI summary", () => {
  it("this month for the shop: what AI did, cost, time saved (stated assumptions), accuracy, lessons", async () => {
    const { app, db, shops } = shop();
    for (const [task, provider, cost] of [["listing", "claude", 0.05], ["listing", "claude", 0.05], ["listing", "openai", 0.03], ["photo", "claude", 0.01], ["help", "deepseek", 0.001]] as const)
      shops.site.prepare("INSERT INTO ai_calls (provider, model, task, ws_key, cost) VALUES (?, 'm', ?, 'main', ?)").run(provider, task, cost);
    setSetting(db, "backtests", [{ id: "bt", at: "2026-10-20T00:00:00Z", status: "done", winner: "claude", cases: new Array(20).fill({}), rows: [], providers: [], scores: [{ predictor: "claude", name: "Claude (Anthropic)", medianAbsPct: 9, n: 20 }, { predictor: "you", name: "Your list price", medianAbsPct: 12, n: 20 }] }]);
    const s = (await request(app).get("/api/ai/summary").expect(200)).body;
    expect(s).toMatchObject({ requests: 5, cost: 0.14, listingsWritten: 3, photosFixed: 1, helpAnswers: 1, minutesSaved: 3 * 8 + 2 + 3 });
    expect(s.byProvider.find((x: { provider: string }) => x.provider === "claude")).toMatchObject({ name: "Claude", calls: 3 });
    expect(s.accuracy).toMatchObject({ items: 20, winner: "claude" });
    expect(s.costPerHourSaved).toBeCloseTo(0.14 / (29 / 60), 2);
  });
});
