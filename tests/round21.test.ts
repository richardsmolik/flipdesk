import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspaces } from "../server/workspaces.js";
import { getSetting, setSetting, type Db } from "../server/db.js";
import { setAiCostSink, setAiKeys, setAiRouting } from "../server/services/llm.js";
import { calibrations, correctPrices, recordAiTitle, reportCardIfDue, titleReport } from "../server/services/aiInsights.js";
import type { ListingDraft } from "../server/services/ai.js";
import { resetHealth } from "../server/health.js";

const KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "GEMINI_API_KEY", "DEEPSEEK_API_KEY", "MOONSHOT_API_KEY", "OPENAI_MODEL", "KIMI_MODEL", "GEMINI_MODEL", "DEEPSEEK_MODEL"];
let dir: string;
beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  setAiRouting({ order: [], models: {} });
  setAiKeys({});
  setAiCostSink(null);
  resetHealth();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-r21-"));
});
afterEach(() => {
  for (const k of KEYS) delete process.env[k];
  vi.unstubAllGlobals();
  setAiRouting({ order: [], models: {} });
  fs.rmSync(dir, { recursive: true, force: true });
});

const chat = (content: string) => new Response(JSON.stringify({ model: "m", choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 500 } }), { headers: { "content-type": "application/json" } });
function fakeAi(behave: Record<string, (body: { messages: { content: unknown }[] }) => Response>) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const host = new URL(String(input)).host;
    calls.push(host);
    const f = behave[host];
    return f ? f(init?.body ? JSON.parse(String(init.body)) : { messages: [] }) : new Response("{}");
  });
  return calls;
}
const draft = (price: number): ListingDraft => ({
  title: "Coach Tabby Shoulder Bag 26 Black Leather", short_title: "Coach Tabby 26", description: "Nice.", brand: "Coach", category: "Bags", condition: "used_excellent", color: "Black", size: "",
  item_specifics: [], keywords: ["coach"], flaws: [], verify: [], price: { recommended: price, low: price * 0.8, high: price * 1.2, quick_sale: price * 0.85, confidence: "medium", reasoning: "" }, best_marketplaces: ["ebay"],
});
const backtestWith = (db: Db, scores: { predictor: string; n: number; bias: number | null }[]) =>
  setSetting(db, "backtests", [{ id: "bt1", at: "2026-10-01T00:00:00Z", status: "done", done: 1, total: 1, providers: [], photos: false, cases: [], rows: [], winner: null, cost: 0, scores: scores.map((s) => ({ name: s.predictor, medianAbsPct: 10, mae: 1, within20: 50, daysMedianErr: null, cost: 0, ...s })) }]);
function shop() {
  const shops = new Workspaces({ dataDir: dir, mainDb: path.join(dir, "flipdesk.db"), mainUploads: path.join(dir, "uploads"), password: "" });
  return { shops, db: shops.get("main")!.db, app: express().use(shops.handler()) };
}

describe("self-correcting prices", () => {
  it("uses each AI's measured lean (10+ answers, 5%+), can be turned off", () => {
    const { db } = shop();
    backtestWith(db, [{ predictor: "openai", n: 20, bias: 25 }, { predictor: "kimi", n: 6, bias: -30 }, { predictor: "gemini", n: 30, bias: 2 }, { predictor: "you", n: 20, bias: 10 }]);
    expect(Object.keys(calibrations(db))).toEqual(["openai"]);
    const d = draft(200);
    const c = correctPrices(db, "openai", d)!;
    expect(d.price.recommended).toBe(160);
    expect(c.note).toBe("ChatGPT guessed 25% too high on your past sales, so its price was adjusted from $200.00 to $160.00.");
    expect(correctPrices(db, "kimi", draft(100))).toBeNull(); // too few answers
    setSetting(db, "aiCorrection", { on: false });
    expect(correctPrices(db, "openai", draft(200))).toBeNull();
  });
});

describe("listing writer: correction + second opinion + remembered titles", () => {
  it("pricier items get a second AI's price; a big gap is flagged; cheap items don't spend on it", async () => {
    const { app, db } = shop();
    process.env.OPENAI_API_KEY = "o";
    process.env.OPENAI_MODEL = "gpt-9";
    process.env.MOONSHOT_API_KEY = "k";
    process.env.KIMI_MODEL = "kimi-9";
    setAiRouting({ order: ["openai", "kimi"], models: {} });
    backtestWith(db, [{ predictor: "openai", n: 20, bias: 25 }]);
    let openaiPrice = 200;
    const calls = fakeAi({
      "api.openai.com": () => chat(JSON.stringify(draft(openaiPrice))),
      "api.moonshot.ai": () => chat(JSON.stringify({ price: 100, quick_sale: 90, days_to_sell: 8, confidence: "medium" })),
    });
    const r = (await request(app).post("/api/ai/generate").field("hint", "coach tabby bag").expect(200)).body;
    expect(r.provider).toBe("openai");
    expect(r.draft.price.recommended).toBe(160); // corrected for the 25% lean
    expect(r.correction.note).toMatch(/adjusted from \$200\.00 to \$160\.00/);
    expect(r.secondOpinion).toMatchObject({ provider: "kimi", name: "Kimi", price: 100, diffPct: 38, agree: false });
    expect(db.prepare("SELECT provider FROM ai_titles").all()).toEqual([{ provider: "openai" }]);

    openaiPrice = 40; // under the $100 threshold: no second AI call
    const before = calls.filter((h) => h === "api.moonshot.ai").length;
    const r2 = (await request(app).post("/api/ai/generate").field("hint", "coach card case").expect(200)).body;
    expect(r2.secondOpinion).toBeNull();
    expect(calls.filter((h) => h === "api.moonshot.ai").length).toBe(before);

    await request(app).put("/api/ai-insights/settings").send({ secondOpinion: { on: true, threshold: 25 } }).expect(200);
    expect((await request(app).post("/api/ai/generate").field("hint", "coach card case").expect(200)).body.secondOpinion).toMatchObject({ provider: "kimi" });
  });
});

describe("AI titles vs your own", () => {
  it("matches kept (or nearly kept) AI titles and compares how fast they sold", () => {
    const { db } = shop();
    const add = (title: string, daysToSell: number | null, listedDaysAgo = 60) => {
      const id = Number(db.prepare("INSERT INTO items (sku, title, price, status, created_at) VALUES (?, ?, 50, ?, datetime('now', ?))").run(`S${Math.random()}`, title, daysToSell === null ? "active" : "sold", `-${listedDaysAgo} days`).lastInsertRowid);
      if (daysToSell !== null) db.prepare("INSERT INTO sales (item_id, marketplace, quantity, sale_price, sold_at) VALUES (?, 'ebay', 1, 45, datetime('now', ?))").run(id, `-${listedDaysAgo - daysToSell} days`);
      return id;
    };
    for (let i = 0; i < 6; i++) {
      const t = `Nike Air Max 90 Mens Size ${8 + i} White Running Shoes`;
      recordAiTitle(db, t, "openai");
      add(i === 0 ? `${t} EUC` : t, 5 + i); // the first one got one word added: still the AI's
    }
    for (let i = 0; i < 6; i++) add(`nike shoes size ${8 + i}`, 20 + i);
    add("nike shoes unsold", null);
    const r = titleReport(db);
    const by = Object.fromEntries(r.rows.map((x) => [x.key, x]));
    expect(by.ai).toMatchObject({ listed: 6, sold: 6, medianDays: 7.5, priceVsList: 90 });
    expect(by.openai.listed).toBe(6);
    expect(by.you).toMatchObject({ listed: 7, sold: 6, sellThrough: 86, medianDays: 22.5 });
    expect(r.verdict).toBe("Items with AI-written titles sold in 7.5 days (typical) vs 22.5 for your own titles: AI titles sold faster.");
  });
});

describe("monthly AI report card", () => {
  it("off by default; when on: needs 2 AIs and 10 new sales, re-tests, tells you if the best AI changed, then waits a month", async () => {
    const { db, shops } = shop();
    for (let i = 1; i <= 12; i++) {
      const title = `Vintage Levis 501 jeans lot ${i}`;
      const id = Number(db.prepare("INSERT INTO items (sku, title, price, original_price, status, created_at) VALUES (?, ?, 50, 50, 'sold', '2026-03-01 10:00:00')").run(`L${i}`, title).lastInsertRowid);
      db.prepare("INSERT INTO sales (item_id, marketplace, quantity, sale_price, sold_at) VALUES (?, 'ebay', 1, ?, '2026-03-20 10:00:00')").run(id, 40 + i);
    }
    process.env.OPENAI_API_KEY = "o";
    process.env.OPENAI_MODEL = "gpt-9";
    process.env.MOONSHOT_API_KEY = "k";
    process.env.KIMI_MODEL = "kimi-9";
    const actualOf = (t: string) => 40 + Number(t.match(/lot (\d+)/)![1]);
    fakeAi({
      "api.openai.com": (b) => chat(JSON.stringify({ price: actualOf(String(b.messages.at(-1)!.content)) * 1.4, quick_sale: 1, days_to_sell: 5, confidence: "low" })),
      "api.moonshot.ai": (b) => chat(JSON.stringify({ price: actualOf(String(b.messages.at(-1)!.content)) * 1.02, quick_sale: 1, days_to_sell: 5, confidence: "low" })),
    });
    expect(reportCardIfDue(db)).toBeNull(); // off
    setSetting(db, "aiReportCard", { on: true, lastWinner: "openai" });
    const ws = shops.get("main")!;
    const { runInWorkspace } = await import("../server/context.js");
    const id = await runInWorkspace(ws, () => reportCardIfDue(db));
    expect(id).toMatch(/^bt/);
    const alert = db.prepare("SELECT title, body FROM alerts WHERE kind = 'ai-report'").get() as { title: string; body: string };
    expect(alert.title).toBe("🔬 New best AI for pricing: Kimi");
    expect(alert.body).toMatch(/Last month it was ChatGPT/);
    expect(getSetting<{ lastWinner: string }>(db, "aiReportCard", { lastWinner: "" }).lastWinner).toBe("kimi");
    expect(reportCardIfDue(db)).toBeNull(); // not again this month
  });
});

describe("AI cost per sale", () => {
  it("this shop's AI spend over its sales and profit (last 30 days), by feature", async () => {
    const { app, db, shops } = shop();
    for (const [task, cost] of [["listing", 0.3], ["listing", 0.3], ["help", 0.1]] as const) shops.site.prepare("INSERT INTO ai_calls (provider, model, task, ws_key, cost) VALUES ('claude', 'm', ?, 'main', ?)").run(task, cost);
    shops.site.prepare("INSERT INTO ai_calls (provider, model, task, ws_key, cost) VALUES ('claude', 'm', 'listing', 'u9', 5)").run(); // another shop
    for (let i = 0; i < 4; i++) {
      const id = Number(db.prepare("INSERT INTO items (sku, title) VALUES (?, 'x')").run(`C${i}`).lastInsertRowid);
      db.prepare("INSERT INTO sales (item_id, marketplace, quantity, sale_price, profit) VALUES (?, 'ebay', 1, 50, 20)").run(id);
    }
    const r = (await request(app).get("/api/ai/per-sale").expect(200)).body;
    expect(r).toMatchObject({ aiCost: 0.7, aiCalls: 3, sales: 4, perSale: 0.18, profitPerSale: 20, shareOfProfit: 0.9 });
    expect(r.byTask[0]).toMatchObject({ task: "listing", calls: 2 });
  });
});
