import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspaces } from "../server/workspaces.js";
import { setSetting, type Db } from "../server/db.js";
import { setAiCostSink, setAiKeys, setAiRouting } from "../server/services/llm.js";
import { claimExtensionJob } from "../server/services/jobs.js";
import { applyAutoPriceDrops } from "../server/services/ebayTools.js";
import { weeklyTodo } from "../server/services/weeklyTodo.js";
import { buildDigest } from "../server/services/digest.js";
import { textPdf } from "../server/services/pdf.js";
import { clearOutbox, outbox } from "../server/services/mailer.js";
import { runInWorkspace } from "../server/context.js";
import { resetHealth } from "../server/health.js";

const KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "MOONSHOT_API_KEY", "OPENAI_MODEL", "KIMI_MODEL", "EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "EBAY_ENV", "PUBLIC_BASE_URL", "SHOPIFY_STORE_DOMAIN", "SHOPIFY_ADMIN_TOKEN", "SMTP_HOST", "FLIPDESK_OWNER_EMAIL"];
let dir: string;
beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  setAiRouting({ order: [], models: {} });
  setAiKeys({});
  setAiCostSink(null);
  resetHealth();
  clearOutbox();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-r23-"));
});
afterEach(() => {
  for (const k of KEYS) delete process.env[k];
  vi.unstubAllGlobals();
  setAiRouting({ order: [], models: {} });
  fs.rmSync(dir, { recursive: true, force: true });
});
function shop() {
  const shops = new Workspaces({ dataDir: dir, mainDb: path.join(dir, "flipdesk.db"), mainUploads: path.join(dir, "uploads"), password: "" });
  return { shops, db: shops.get("main")!.db, app: express().use(shops.handler()) };
}
const live = (db: Db, id: number, m: string, price = 60) => Number(db.prepare("INSERT INTO listings (item_id, marketplace, status, price, external_id, listed_at) VALUES (?, ?, 'active', ?, ?, datetime('now','-10 days'))").run(id, m, price, `${m}-ext-${id}`).lastInsertRowid);
const ebayOn = (db: Db) => {
  process.env.EBAY_CLIENT_ID = "id";
  process.env.EBAY_CLIENT_SECRET = "s";
  process.env.EBAY_ENV = "production";
  process.env.PUBLIC_BASE_URL = "https://flip.example.com";
  db.prepare("INSERT INTO connections (marketplace, status, credentials) VALUES ('ebay', 'connected', ?)").run(JSON.stringify({ refresh_token: "r", access_token: "a", expires_at: Date.now() + 3600_000 }));
};
type Call = { host: string; method: string; path: string; body: string };
function fake(answer: (c: Call) => Response | undefined = () => undefined) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (u: string, init?: RequestInit) => {
    const url = new URL(u);
    const c = { host: url.host, method: init?.method ?? "GET", path: url.pathname, body: String(init?.body ?? "") };
    calls.push(c);
    return (
      answer(c) ??
      (url.pathname.endsWith("/oauth2/token")
        ? new Response(JSON.stringify({ access_token: "a", expires_in: 7200 }))
        : c.method === "GET" && url.pathname.endsWith("/offer")
          ? new Response(JSON.stringify({ offers: [{ offerId: "OF1" }] }))
          : new Response(null, { status: 204 }))
    );
  });
  return calls;
}

describe("edits reach every live listing", () => {
  it("a saved title/price change updates eBay now, queues the extension sites, and keeps a listing's own price", async () => {
    const { app, db } = shop();
    ebayOn(db);
    const calls = fake();
    const id = Number(db.prepare("INSERT INTO items (sku, title, price, status) VALUES ('R1', 'old title', 60, 'active')").run().lastInsertRowid);
    db.prepare("INSERT INTO photos (item_id, path, position) VALUES (?, 'https://img.example.com/a.jpg', 0)").run(id);
    live(db, id, "ebay", 60);
    live(db, id, "poshmark", 75); // its own price
    const r = (await request(app).patch(`/api/items/${id}`).send({ title: "New Better Title", price: 50 }).expect(200)).body;
    expect(r.pushed).toEqual([
      { marketplace: "ebay", mode: "api", fields: ["title", "price"] },
      { marketplace: "poshmark", mode: "extension", fields: ["title"] },
    ]);
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.path.endsWith("/inventory_item/R1"))).toBe(true));
    await vi.waitFor(() => expect(calls.some((c) => c.path.endsWith("/bulk_update_price_quantity") && c.body.includes('"50.00"'))).toBe(true));
    expect(JSON.parse(calls.find((c) => c.method === "PUT")!.body).product.title).toBe("New Better Title");
    expect(db.prepare("SELECT marketplace, price FROM listings ORDER BY id").all()).toEqual([{ marketplace: "ebay", price: 50 }, { marketplace: "poshmark", price: 75 }]);
    // the extension gets the poshmark update with what changed
    const work = claimExtensionJob(db, ["poshmark"])!;
    expect(work.job).toMatchObject({ type: "revise", marketplace: "poshmark" });
    expect(JSON.parse((work.job as { payload: string }).payload)).toMatchObject({ fields: ["title"] });
    // nothing changed -> nothing queued; turning auto-push off stops it
    expect((await request(app).patch(`/api/items/${id}`).send({ title: "New Better Title" }).expect(200)).body.pushed).toEqual([]);
    await request(app).put("/api/auto-push").send({ on: false }).expect(200);
    expect((await request(app).patch(`/api/items/${id}`).send({ title: "Another" }).expect(200)).body.pushed).toEqual([]);
  });

  it("a failed update leaves the listing live and says why; edits merge into one pending job", async () => {
    const { app, db } = shop();
    ebayOn(db);
    fake((c) => (c.method === "PUT" ? new Response(JSON.stringify({ errors: [{ message: "Title too long" }] }), { status: 400 }) : undefined));
    const id = Number(db.prepare("INSERT INTO items (sku, title, price, status) VALUES ('R2', 't', 60, 'active')").run().lastInsertRowid);
    db.prepare("INSERT INTO photos (item_id, path, position) VALUES (?, 'https://img.example.com/a.jpg', 0)").run(id);
    live(db, id, "ebay");
    live(db, id, "mercari");
    await request(app).patch(`/api/items/${id}`).send({ title: "x".repeat(70) }).expect(200);
    await request(app).patch(`/api/items/${id}`).send({ description: "longer description" }).expect(200);
    const merc = db.prepare("SELECT payload FROM jobs WHERE marketplace = 'mercari' AND type = 'revise'").all() as { payload: string }[];
    expect(merc).toHaveLength(1);
    expect(JSON.parse(merc[0].payload).fields).toEqual(["title", "description"]);
    const { processApiJobs } = await import("../server/services/jobs.js");
    for (let i = 0; i < 4; i++) await processApiJobs(db); // 3 tries, then it gives up
    expect(db.prepare("SELECT status FROM listings WHERE marketplace = 'ebay'").get()).toEqual({ status: "active" });
    expect(db.prepare("SELECT status FROM jobs WHERE marketplace = 'ebay' AND type = 'revise' ORDER BY id DESC LIMIT 1").get()).toEqual({ status: "failed" });
    expect((db.prepare("SELECT message FROM activity WHERE kind = 'error' ORDER BY id DESC LIMIT 1").get() as { message: string }).message).toMatch(/couldn't update the live listing/);
  });

  it("Shopify price changes now really happen (they were skipped before)", async () => {
    const { app, db } = shop();
    process.env.SHOPIFY_STORE_DOMAIN = "shop.myshopify.com";
    process.env.SHOPIFY_ADMIN_TOKEN = "t";
    const bodies: string[] = [];
    fake((c) => {
      if (c.host !== "shop.myshopify.com") return undefined;
      bodies.push(c.body);
      const q = JSON.parse(c.body).query as string;
      if (q.includes("variants(first: 1)")) return new Response(JSON.stringify({ data: { product: { variants: { nodes: [{ id: "gid://shopify/ProductVariant/9" }] } } } }));
      if (q.includes("productVariantsBulkUpdate")) return new Response(JSON.stringify({ data: { productVariantsBulkUpdate: { userErrors: [] } } }));
      return new Response(JSON.stringify({ data: { productUpdate: { userErrors: [] } } }));
    });
    const id = Number(db.prepare("INSERT INTO items (sku, title, price, status) VALUES ('S1', 't', 60, 'active')").run().lastInsertRowid);
    live(db, id, "shopify");
    await request(app).patch(`/api/items/${id}`).send({ price: 55, title: "Shopify title" }).expect(200);
    await vi.waitFor(() => expect(bodies.some((b) => b.includes("productVariantsBulkUpdate") && b.includes('"55.00"'))).toBe(true));
    expect(bodies.some((b) => b.includes("productUpdate") && b.includes("Shopify title"))).toBe(true);
  });
});

describe("category re-check for brand-new items", () => {
  it("when another AI is best for the draft's category, it re-checks the price", async () => {
    const { app, db } = shop();
    process.env.OPENAI_API_KEY = "o";
    process.env.OPENAI_MODEL = "gpt-9";
    process.env.MOONSHOT_API_KEY = "k";
    process.env.KIMI_MODEL = "kimi-9";
    setAiRouting({ order: ["openai", "kimi"], models: {} });
    setSetting(db, "secondOpinion", { on: false, threshold: 100 });
    setSetting(db, "aiByCategory", { on: true });
    setSetting(db, "backtests", [{ id: "bt", at: "2026-10-01", status: "done", scores: [], cases: [], rows: [], providers: [], byCategory: [{ category: "Shoes", n: 8, winner: "kimi", scores: [] }] }]);
    const draft = { title: "Nike AM90", short_title: "Nike", description: "", brand: "Nike", category: "Shoes > Men", condition: "used_good", color: "", size: "10", item_specifics: [], keywords: [], flaws: [], verify: [], price: { recommended: 100, low: 80, high: 120, quick_sale: 85, confidence: "medium", reasoning: "" }, best_marketplaces: ["ebay"] };
    const chat = (o: unknown) => new Response(JSON.stringify({ model: "m", choices: [{ message: { content: JSON.stringify(o) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    fake((c) => (c.host === "api.openai.com" ? chat(draft) : c.host === "api.moonshot.ai" ? chat({ price: 70, quick_sale: 60, days_to_sell: 9, confidence: "high" }) : undefined));
    const r = (await request(app).post("/api/ai/generate").field("hint", "nike shoes").expect(200)).body;
    expect(r.recheck).toMatchObject({ provider: "kimi", category: "Shoes", before: 100, after: 70 });
    expect(r.draft.price).toMatchObject({ recommended: 70, low: 56, high: 84, quick_sale: 60 });
    expect(r.correction.note).toMatch(/Kimi is the most accurate AI for Shoes.*\$100\.00 → \$70\.00/);
  });
});

describe("price-drop rules per category", () => {
  it("finds the best rule per category and the automatic drops use it ('none' = never drop there)", async () => {
    const { app, db } = shop();
    const day = (d: number) => new Date(Date.UTC(2026, 0, 1) + d * 86400_000).toISOString().slice(0, 19).replace("T", " ");
    // Fashion: dropping helped (sold 5 days after a drop on day 40). Collectibles: sold at full price.
    for (let i = 0; i < 6; i++) {
      const f = Number(db.prepare("INSERT INTO items (sku, title, category, price, original_price, created_at) VALUES (?, 'f', 'Fashion > Women', 90, 100, ?)").run(`F${i}`, day(0)).lastInsertRowid);
      db.prepare("INSERT INTO price_changes (item_id, old_price, new_price, at) VALUES (?, 100, 90, ?)").run(f, day(40));
      db.prepare("INSERT INTO sales (item_id, marketplace, quantity, sale_price, sold_at) VALUES (?, 'ebay', 1, 90, ?)").run(f, day(45));
      const c = Number(db.prepare("INSERT INTO items (sku, title, category, price, original_price, created_at) VALUES (?, 'c', 'Collectibles', 100, 100, ?)").run(`C${i}`, day(0)).lastInsertRowid);
      db.prepare("INSERT INTO sales (item_id, marketplace, quantity, sale_price, sold_at) VALUES (?, 'ebay', 1, 100, ?)").run(c, day(30));
    }
    const r = (await request(app).get("/api/drop-backtest").expect(200)).body;
    const by = Object.fromEntries(r.byCategory.map((x: { category: string; rule: string }) => [x.category, x.rule]));
    expect(by.Collectibles).toBe("none");
    expect(["gentle", "steady", "fast"]).toContain(by.Fashion);
    await request(app).put("/api/drop-backtest/by-category").send({ Fashion: "fast", Collectibles: "none" }).expect(200);

    setSetting(db, "autoDrop", { enabled: true, afterDays: 21, everyDays: 7, dropPct: 5 });
    const a = Number(db.prepare("INSERT INTO items (sku, title, category, price, status) VALUES ('A1', 'a', 'Fashion', 100, 'active')").run().lastInsertRowid);
    const b = Number(db.prepare("INSERT INTO items (sku, title, category, price, status) VALUES ('B1', 'b', 'Collectibles', 100, 'active')").run().lastInsertRowid);
    const o = Number(db.prepare("INSERT INTO items (sku, title, category, price, status) VALUES ('O1', 'o', 'Toys', 100, 'active')").run().lastInsertRowid);
    for (const [id, days] of [[a, 10], [b, 60], [o, 30]]) db.prepare("INSERT INTO listings (item_id, marketplace, status, price, listed_at) VALUES (?, 'ebay', 'active', 100, datetime('now', ?))").run(id, `-${days} days`);
    const res = applyAutoPriceDrops(db);
    expect(res.map((x) => [x.itemId, x.to]).sort()).toEqual([[a, 90], [o, 95]].sort()); // fashion: fast 10% after 7 days; toys: your 5% rule; collectibles: never
  });
});

describe("this week's 5 things", () => {
  it("ranks what's worth doing and puts it in the Monday summary", () => {
    const { db } = shop();
    const it1 = Number(db.prepare("INSERT INTO items (sku, title, price, status) VALUES ('W1', 'Sold jacket', 50, 'sold')").run().lastInsertRowid);
    db.prepare("INSERT INTO sales (item_id, marketplace, quantity, sale_price, sold_at) VALUES (?, 'ebay', 1, 50, datetime('now','-2 days'))").run(it1);
    const it2 = Number(db.prepare("INSERT INTO items (sku, title, price, status) VALUES ('W2', 'Pricey watch', 300, 'active')").run().lastInsertRowid);
    setSetting(db, `priceWhy.${it2}`, { secondOpinion: { name: "Kimi", price: 180, diffPct: 40, agree: false } });
    db.prepare("INSERT INTO items (sku, title, price, status, created_at) VALUES ('W3', 'Old lamp', 30, 'active', datetime('now','-60 days'))").run();
    db.prepare("INSERT INTO jobs (marketplace, type, item_id, status, updated_at) VALUES ('ebay', 'publish', ?, 'failed', datetime('now'))").run(it2);
    const t = weeklyTodo(db);
    expect(t.map((x) => x.kind).slice(0, 3)).toEqual(["ship", "failed", "price-check"]);
    expect(t.find((x) => x.kind === "price-check")!.detail).toMatch(/Kimi said \$180\.00 \(40% apart\)/);
    expect(t.some((x) => x.kind === "fresh-title" && /Old lamp/.test(x.title))).toBe(true);
    expect(t.length).toBeLessThanOrEqual(5);
    expect(buildDigest(db).body).toMatch(/👉 This week:\n1\. Ship 1 order/);
  });
});

describe("monthly AI summary email", () => {
  it("first week of the month: last month's summary with a PDF, once; can be turned off", async () => {
    process.env.SMTP_HOST = "test";
    process.env.FLIPDESK_OWNER_EMAIL = "me@x.com";
    process.env.PUBLIC_BASE_URL = "https://flip.example.com";
    const { shops, db } = shop();
    for (const t of ["listing", "listing", "photo"]) shops.site.prepare("INSERT INTO ai_calls (at, provider, model, task, ws_key, cost) VALUES ('2026-10-15 12:00:00', 'claude', 'm', ?, 'main', 0.05)").run(t);
    shops.site.prepare("INSERT INTO ai_calls (at, provider, model, task, ws_key, cost) VALUES ('2026-11-02 12:00:00', 'claude', 'm', 'listing', 'main', 9)").run(); // this month: not counted
    expect(await shops.monthlySummaryIfDue(new Date("2026-11-10T09:00:00Z"))).toEqual([]); // past the first week
    const r = await runInWorkspace(shops.get("main")!, () => shops.monthlySummaryIfDue(new Date("2026-11-02T09:00:00Z")));
    expect(r).toEqual([{ key: "main", to: "me@x.com" }]);
    const m = outbox().find((x) => x.subject === "Your AI month: October 2026")!;
    expect(m.text).toMatch(/Spent on AI: \$0\.15 \(3 requests\)/);
    expect(m.text).toMatch(/Wrote 2 listings/);
    expect(m.text).toMatch(/https:\/\/flip\.example\.com\/ai-report\?month=2026-10/);
    const pdf = m.attachments![0];
    expect(pdf).toMatchObject({ filename: "flipdesk-ai-2026-10.pdf", contentType: "application/pdf" });
    expect(pdf.content.subarray(0, 8).toString()).toBe("%PDF-1.4");
    expect(await shops.monthlySummaryIfDue(new Date("2026-11-03T09:00:00Z"))).toEqual([]); // once
    setSetting(db, "aiSummaryEmail", { on: false });
    shops.siteSet("aiSummarySent", {});
    expect(await shops.monthlySummaryIfDue(new Date("2026-11-03T09:00:00Z"))).toEqual([]);
  });

  it("the PDF is well-formed: cross-reference offsets point at each object; long text pages", () => {
    const pdf = textPdf("Title (with parens)", Array.from({ length: 120 }, (_, i) => `Line ${i} — ✨ émoji gone, accents kept: café`));
    const s = pdf.toString("latin1");
    const xrefAt = Number(s.match(/startxref\n(\d+)/)![1]);
    expect(s.slice(xrefAt, xrefAt + 4)).toBe("xref");
    const offsets = [...s.slice(xrefAt).matchAll(/^(\d{10}) 00000 n $/gm)].map((x) => Number(x[1]));
    offsets.forEach((o, i) => expect(s.slice(o, o + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
    expect(s).toMatch(/\/Count 3 /);
    expect(s).toContain("Title \\(with parens\\)");
    expect(s).toContain("caf\xe9");
    expect(s).not.toContain("✨");
  });
});
