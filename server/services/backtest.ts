/**
 * AI backtest: "how good would each AI have been on my own past sales?"
 *
 * Takes items you've already sold and, for each AI you pick, asks it to price the item (and guess how many days it
 * would take to sell) using only what was known when you listed it: the item details (and photos if you choose),
 * and sold comps dated BEFORE the listing date. It never sees the sale. Then every guess is scored against what
 * actually happened, next to two baselines: the price you listed at, and FlipDesk's plain comp-median rule.
 *
 * Every AI request goes through the normal switchboard (llm.ts), so it counts against budgets and allowances.
 */
import fs from "node:fs";
import { z } from "zod/v4";
import type { Db } from "../db.js";
import { getSetting, setSetting } from "../db.js";
import { askStructured, PROVIDERS, priceOf, providerReady, type ProviderId } from "./llm.js";
import { findLocalComps } from "./comps.js";
import { useAi } from "../context.js";

export const Prediction = z.object({
  price: z.number().describe("The price (USD, per unit, item only) it will most likely actually sell for"),
  quick_sale: z.number().describe("A price that would sell it within about a week"),
  days_to_sell: z.number().describe("Days from listing to sale at your price"),
  confidence: z.enum(["low", "medium", "high"]),
});
export type Prediction = z.infer<typeof Prediction>;

export interface Case {
  saleId: number;
  itemId: number;
  title: string;
  listedAt: string;
  soldAt: string;
  actual: number;
  actualDays: number;
  yourPrice: number | null;
  compsBefore: { title: string; price: number; sold_at: string }[];
  compMedian: number | null;
  /** Top-level category ("Shoes", "Clothing"…), for per-category winners. */
  category?: string;
}
export interface CategoryWinner { category: string; n: number; winner: string | null; scores: { predictor: string; medianAbsPct: number | null; n: number }[] }
export interface Row { saleId: number; predictor: string; price: number | null; days: number | null; error?: string }
export interface Score { predictor: string; name: string; n: number; medianAbsPct: number | null; mae: number | null; within20: number | null; bias: number | null; daysMedianErr: number | null; cost: number }
export interface Backtest {
  id: string;
  at: string;
  status: "running" | "done" | "failed";
  done: number;
  total: number;
  providers: ProviderId[];
  photos: boolean;
  cases: Case[];
  rows: Row[];
  scores: Score[];
  winner: string | null;
  cost: number;
  error?: string;
  byCategory?: CategoryWinner[];
}

const DAY = 86400_000;
const t = (s: string) => Date.parse(s.includes("T") ? s : s.replace(" ", "T") + "Z");
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const r2 = (n: number) => Math.round(n * 100) / 100;

/** The most recent sold items (one sale each), with what was known at listing time. */
export function pickCases(db: Db, n = 20): Case[] {
  const sales = db
    .prepare(
      `SELECT s.id AS saleId, s.item_id AS itemId, s.sale_price, s.quantity, s.sold_at, i.title, i.category, i.created_at, i.original_price, i.price,
        (SELECT MIN(listed_at) FROM listings l WHERE l.item_id = i.id AND l.listed_at IS NOT NULL) AS listed_at,
        (SELECT old_price FROM price_changes p WHERE p.item_id = i.id ORDER BY p.at, p.id LIMIT 1) AS first_price
       FROM sales s JOIN items i ON i.id = s.item_id
       WHERE s.sale_price > 0 AND i.title != ''
       ORDER BY s.sold_at DESC LIMIT ?`,
    )
    .all(Math.min(500, n * 4)) as { saleId: number; itemId: number; sale_price: number; quantity: number; sold_at: string; title: string; category: string; created_at: string; original_price: number | null; price: number; listed_at: string | null; first_price: number | null }[];
  const seen = new Set<number>();
  const out: Case[] = [];
  for (const s of sales) {
    if (seen.has(s.itemId)) continue;
    seen.add(s.itemId);
    const listedAt = s.listed_at ?? s.created_at;
    if (t(s.sold_at) < t(listedAt)) continue; // imported history with odd dates
    // Only comps that had already sold when the item was listed: no peeking at the future (or at this sale).
    const comps = findLocalComps(db, s.title, 60)
      .filter((c) => c.sold_at && t(c.sold_at) < t(listedAt))
      .slice(0, 15)
      .map((c) => ({ title: c.title, price: c.price, sold_at: c.sold_at! }));
    const your = s.first_price ?? s.original_price ?? (s.price > 0 ? s.price : null);
    out.push({
      saleId: s.saleId,
      itemId: s.itemId,
      title: s.title,
      listedAt,
      soldAt: s.sold_at,
      actual: r2(s.sale_price / Math.max(1, s.quantity)),
      actualDays: Math.max(0, Math.round((t(s.sold_at) - t(listedAt)) / DAY)),
      yourPrice: your && your > 0 ? your : null,
      compsBefore: comps,
      compMedian: comps.length >= 3 ? median(comps.map((c) => c.price)) : null,
      category: topCategory(s.category),
    });
    if (out.length >= n) break;
  }
  return out;
}

const mediaType = (f: string) => (/\.png$/i.test(f) ? "image/png" : /\.webp$/i.test(f) ? "image/webp" : "image/jpeg");

function ask(db: Db, c: Case, provider: ProviderId, photos: boolean) {
  useAi("backtest"); // every request counts against the budget and allowance, like any other AI use
  const item = db.prepare("SELECT brand, category, condition, size, color, cost, description FROM items WHERE id = ?").get(c.itemId) as { brand: string; category: string; condition: string; size: string; color: string; cost: number; description: string };
  const pics = photos
    ? (db.prepare("SELECT path FROM photos WHERE item_id = ? ORDER BY position LIMIT 3").all(c.itemId) as { path: string }[])
        .filter((p) => !/^https?:/.test(p.path) && fs.existsSync(p.path))
        .map((p) => ({ mediaType: mediaType(p.path), data: fs.readFileSync(p.path).toString("base64") }))
    : [];
  const text = [
    `Today is ${c.listedAt.slice(0, 10)}. A reseller is about to list this item on eBay and other marketplaces.`,
    `Title: ${c.title}`,
    item.brand && `Brand: ${item.brand}`,
    item.category && `Category: ${item.category}`,
    `Condition: ${item.condition.replace(/_/g, " ")}`,
    item.size && `Size: ${item.size}`,
    item.color && `Color: ${item.color}`,
    item.description && `Description: ${item.description.slice(0, 600)}`,
    c.compsBefore.length ? `Comparable items that sold before today:\n${c.compsBefore.map((x) => `- $${x.price.toFixed(2)} on ${x.sold_at.slice(0, 10)}: ${x.title}`).join("\n")}` : "No comparable sold items are available.",
    "Predict what it will actually sell for and how long it will take.",
  ]
    .filter(Boolean)
    .join("\n");
  return askStructured(
    {
      task: "backtest",
      only: provider,
      system: "You are an expert reseller pricing items for eBay, Poshmark, Mercari and similar sites. Give realistic numbers based on what similar items actually sell for, not asking prices.",
      text,
      images: pics,
      effort: "low",
      maxTokens: 2000,
    },
    Prediction,
  );
}

/** Rough cost before running: tokens per request × each AI's price. */
export function estimateCost(n: number, providers: ProviderId[], photos: boolean) {
  const inTok = 900 + (photos ? 3 * 1600 : 0);
  const outTok = 250;
  const per = providers.map((p) => {
    const [pi, po] = priceOf(p);
    return { provider: p, cost: r2(((inTok * pi + outTok * po) / 1e6) * n * 100) / 100 };
  });
  return { requests: n * providers.length, perProvider: per, total: Math.round(per.reduce((a, x) => a + x.cost, 0) * 10000) / 10000 };
}

/** "Clothing > Men > Jackets" -> "Clothing". */
export const topCategory = (c: string | null | undefined) => (c ?? "").split(">")[0].trim() || "Other";

/** Winners per top-level category (5+ items in it, and each AI needs 5+ answers there). */
export function scoreByCategory(cases: Case[], rows: Row[], providers: ProviderId[]): CategoryWinner[] {
  const groups = new Map<string, Case[]>();
  for (const c of cases) groups.set(c.category ?? "Other", [...(groups.get(c.category ?? "Other") ?? []), c]);
  return [...groups.entries()]
    .filter(([, cs]) => cs.length >= 5)
    .map(([category, cs]) => {
      const ids = new Set(cs.map((c) => c.saleId));
      const sc = score(cs, rows.filter((r) => ids.has(r.saleId)), providers);
      return { category, n: cs.length, winner: sc.winner, scores: sc.scores.map((x) => ({ predictor: x.predictor, medianAbsPct: x.medianAbsPct, n: x.n })) };
    })
    .sort((a, b) => b.n - a.n);
}

export function score(cases: Case[], rows: Row[], providers: ProviderId[], costs: Record<string, number> = {}): { scores: Score[]; winner: string | null } {
  const byCase = new Map(cases.map((c) => [c.saleId, c]));
  const predictors: { id: string; name: string; get: (c: Case) => { price: number | null; days: number | null } }[] = [
    ...providers.map((p) => ({ id: p, name: PROVIDERS[p].name, get: (c: Case) => rows.find((r) => r.saleId === c.saleId && r.predictor === p) ?? { price: null, days: null } })),
    { id: "you", name: "Your list price", get: (c: Case) => ({ price: c.yourPrice, days: null }) },
    { id: "comps", name: "Comp median (no AI)", get: (c: Case) => ({ price: c.compMedian, days: null }) },
  ];
  const scores = predictors.map((p) => {
    const pts = [...byCase.values()].map((c) => ({ c, g: p.get(c) })).filter((x) => typeof x.g.price === "number" && x.g.price > 0);
    const pct = pts.map(({ c, g }) => (g.price! - c.actual) / c.actual);
    const days = pts.filter(({ g }) => typeof g.days === "number").map(({ c, g }) => Math.abs(g.days! - c.actualDays));
    return {
      predictor: p.id,
      name: p.name,
      n: pts.length,
      medianAbsPct: pts.length ? Math.round(median(pct.map(Math.abs))! * 1000) / 10 : null,
      mae: pts.length ? r2(pts.reduce((a, { c, g }) => a + Math.abs(g.price! - c.actual), 0) / pts.length) : null,
      within20: pts.length ? Math.round((pct.filter((x) => Math.abs(x) <= 0.2).length / pts.length) * 100) : null,
      bias: pts.length ? Math.round((pct.reduce((a, x) => a + x, 0) / pts.length) * 1000) / 10 : null,
      daysMedianErr: days.length ? median(days) : null,
      cost: Math.round((costs[p.id] ?? 0) * 10000) / 10000,
    };
  });
  // The best AI needs enough answers to count (5+, and most of the items).
  const ranked = scores.filter((s) => providers.includes(s.predictor as ProviderId) && s.n >= Math.max(5, Math.ceil(cases.length * 0.6)) && s.medianAbsPct !== null).sort((a, b) => a.medianAbsPct! - b.medianAbsPct!);
  return { scores, winner: ranked[0]?.predictor ?? null };
}

const running = new Map<string, Backtest>();
const KEY = "backtests";
export const listBacktests = (db: Db) => getSetting<Backtest[]>(db, KEY, []).map(({ cases, rows, ...rest }) => ({ ...rest, cases: cases.length, rows: rows.length }));
export const getBacktest = (db: Db, id: string) => running.get(id) ?? getSetting<Backtest[]>(db, KEY, []).find((b) => b.id === id) ?? null;
const save = (db: Db, b: Backtest) => setSetting(db, KEY, [b, ...getSetting<Backtest[]>(db, KEY, []).filter((x) => x.id !== b.id)].slice(0, 5));

/** Start a backtest; it runs in the background (3 requests at a time). Poll getBacktest for progress. */
export function startBacktest(db: Db, opts: { n: number; providers: ProviderId[]; photos: boolean }) {
  const providers = [...new Set(opts.providers)].filter(providerReady);
  if (!providers.length) throw Object.assign(new Error("Pick at least one AI that has a key (Settings → AI)."), { status: 400 });
  const cases = pickCases(db, opts.n);
  if (cases.length < 3) throw Object.assign(new Error(`Only ${cases.length} sold item${cases.length === 1 ? "" : "s"} to test on. Sell a few more (or import your sold history in Sales) and try again.`), { status: 400 });
  // Check the allowance/budget once up front, so a run doesn't start just to stop on the first request.
  useAi("backtest");
  const b: Backtest = { id: `bt${Date.now().toString(36)}`, at: new Date().toISOString(), status: "running", done: 0, total: cases.length * providers.length, providers, photos: opts.photos, cases, rows: [], scores: [], winner: null, cost: 0 };
  running.set(b.id, b);
  const costs: Record<string, number> = {};
  const jobs = cases.flatMap((c) => providers.map((p) => ({ c, p })));
  const worker = async () => {
    for (let job = jobs.shift(); job; job = jobs.shift()) {
      const { c, p } = job;
      try {
        const r = await ask(db, c, p, opts.photos);
        costs[p] = (costs[p] ?? 0) + r.cost;
        const price = r.output.price > 0 && r.output.price < c.actual * 50 + 1000 ? r2(r.output.price) : null;
        b.rows.push({ saleId: c.saleId, predictor: p, price, days: Number.isFinite(r.output.days_to_sell) ? Math.max(0, Math.round(r.output.days_to_sell)) : null });
      } catch (e) {
        b.rows.push({ saleId: c.saleId, predictor: p, price: null, days: null, error: (e as Error).message.slice(0, 200) });
        if ((e as { status?: number }).status === 429) jobs.length = 0; // budget or allowance reached: stop
      }
      b.done++;
    }
  };
  const p = Promise.all([worker(), worker(), worker()]).then(
    () => {
      const s = score(cases, b.rows, providers, costs);
      b.scores = s.scores;
      b.winner = s.winner;
      b.byCategory = scoreByCategory(cases, b.rows, providers);
      b.cost = Math.round(Object.values(costs).reduce((a, x) => a + x, 0) * 10000) / 10000;
      b.status = b.rows.every((r) => r.error) ? "failed" : "done";
      if (b.status === "failed") b.error = b.rows.find((r) => r.error)?.error;
      save(db, b);
      running.delete(b.id);
    },
    (e) => {
      b.status = "failed";
      b.error = (e as Error).message;
      save(db, b);
      running.delete(b.id);
    },
  );
  return { backtest: b, finished: p };
}

