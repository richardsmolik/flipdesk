/**
 * Learning from results: what the backtest and your sales teach FlipDesk about each AI.
 *
 * - Price correction: if your latest backtest shows an AI leans (e.g. 15% too high), its price suggestions are
 *   adjusted by that lean, with a note saying so. Needs 10+ answers and a lean of at least 5%.
 * - Second opinion: for items over your threshold, a second AI prices it too; a big disagreement is flagged.
 * - Title tracking: every title an AI writes is remembered, so sold items with AI titles can be compared with
 *   titles you wrote yourself (how often and how fast they sell).
 * - Monthly report card: re-runs the backtest on new sales and tells you if the best AI changed.
 */
import fs from "node:fs";
import type { Db } from "../db.js";
import { getSetting, setSetting } from "../db.js";
import { askStructured, plan, PROVIDERS, providerReady, PROVIDER_IDS, type ProviderId } from "./llm.js";
import { normTitle, tokens } from "./comps.js";
import { getBacktest, Prediction, startBacktest, type Backtest } from "./backtest.js";
import { notify, raiseAlert } from "./alerts.js";
import { useAi } from "../context.js";
import type { ListingDraft } from "./ai.js";

const r2 = (n: number) => Math.round(n * 100) / 100;
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ---------------- Price correction ----------------

export interface Calibration { provider: ProviderId; bias: number; factor: number; n: number; from: string; at: string }
export const correctionOn = (db: Db) => getSetting<{ on?: boolean }>(db, "aiCorrection", {}).on !== false;

/** Each AI's lean from the newest backtest that tested it (10+ answers, 5%+ lean). */
export function calibrations(db: Db): Partial<Record<ProviderId, Calibration>> {
  const runs = getSetting<Backtest[]>(db, "backtests", []).filter((b) => b.status === "done");
  const out: Partial<Record<ProviderId, Calibration>> = {};
  for (const b of runs) {
    for (const s of b.scores) {
      const p = s.predictor as ProviderId;
      if (!PROVIDER_IDS.includes(p) || out[p] || s.bias === null) continue;
      if (s.n < 10 || Math.abs(s.bias) < 5) continue;
      out[p] = { provider: p, bias: s.bias, factor: Math.round((1 / (1 + s.bias / 100)) * 1000) / 1000, n: s.n, from: b.id, at: b.at };
    }
  }
  return out;
}

/** Adjust a draft's prices for that AI's measured lean. Returns the note to show, or null. */
export function correctPrices(db: Db, provider: ProviderId | undefined, draft: ListingDraft) {
  if (!provider || !correctionOn(db)) return null;
  const c = calibrations(db)[provider];
  if (!c) return null;
  const before = draft.price.recommended;
  for (const k of ["recommended", "low", "high", "quick_sale"] as const) draft.price[k] = r2(draft.price[k] * c.factor);
  return { ...c, before, after: draft.price.recommended, note: `${PROVIDERS[provider].name.split(" (")[0]} guessed ${Math.abs(c.bias)}% ${c.bias > 0 ? "too high" : "too low"} on your past sales, so its price was adjusted from $${before.toFixed(2)} to $${draft.price.recommended.toFixed(2)}.` };
}

// ---------------- Second opinion ----------------

export const secondOpinionSettings = (db: Db) => ({ on: true, threshold: 100, ...getSetting<{ on?: boolean; threshold?: number }>(db, "secondOpinion", {}) });

/** For pricier items: a second AI prices it from the same photos; flags it when they disagree by more than 25%. */
export async function secondOpinion(db: Db, first: ProviderId | undefined, draft: ListingDraft, photoPaths: string[]) {
  const s = secondOpinionSettings(db);
  if (!s.on || !first || draft.price.recommended < s.threshold) return null;
  const other = plan({ images: photoPaths.length > 0 }).find((p) => p !== first);
  if (!other) return null;
  useAi("second-opinion");
  const images = photoPaths.slice(0, 3).filter((p) => fs.existsSync(p)).map((p) => ({ mediaType: /\.png$/i.test(p) ? "image/png" : "image/jpeg", data: fs.readFileSync(p).toString("base64") }));
  const r = await askStructured(
    {
      task: "second-opinion",
      only: other,
      system: "You are an expert reseller. Give a realistic resale price based on what similar items actually sell for, not asking prices.",
      text: `Title: ${draft.title}\nBrand: ${draft.brand}\nCondition: ${draft.condition.replace(/_/g, " ")}\nSize: ${draft.size}\nFlaws: ${draft.flaws.join("; ") || "none noted"}\nWhat will it most likely sell for (USD, item only)?`,
      images,
      effort: "low",
      maxTokens: 1500,
    },
    Prediction,
  );
  const a = draft.price.recommended;
  const b = r2(r.output.price);
  const diffPct = Math.round((Math.abs(a - b) / Math.max(a, b, 0.01)) * 100);
  return { provider: other, name: PROVIDERS[other].name.split(" (")[0], price: b, quickSale: r2(r.output.quick_sale), diffPct, agree: diffPct <= 25 };
}

// ---------------- Titles: AI-written vs yours ----------------

function ensureTitles(db: Db) {
  db.exec("CREATE TABLE IF NOT EXISTS ai_titles (id INTEGER PRIMARY KEY, title TEXT NOT NULL, title_norm TEXT NOT NULL, provider TEXT NOT NULL, item_id INTEGER, at TEXT NOT NULL DEFAULT (datetime('now')))");
}
export function recordAiTitle(db: Db, title: string, provider: string, itemId?: number) {
  if (!title.trim()) return;
  ensureTitles(db);
  db.prepare("INSERT INTO ai_titles (title, title_norm, provider, item_id) VALUES (?, ?, ?, ?)").run(title.slice(0, 200), normTitle(title), provider, itemId ?? null);
  if (Math.random() < 0.02) db.prepare("DELETE FROM ai_titles WHERE id NOT IN (SELECT id FROM ai_titles ORDER BY id DESC LIMIT 20000)").run();
}

/** Which AI wrote this item's title (kept it, or kept nearly all of its words), or null if it's yours. */
function authorOf(rows: { title_norm: string; provider: string; item_id: number | null }[], itemId: number, title: string) {
  const tk = tokens(title);
  if (!tk.length) return null;
  const norm = normTitle(title);
  let best: { provider: string; score: number } | null = null;
  for (const r of rows) {
    if (r.item_id !== null && r.item_id !== itemId) continue;
    if (r.title_norm === norm) return r.provider;
    const words = new Set(tokens(r.title_norm));
    const score = tk.filter((t) => words.has(t)).length / Math.max(tk.length, words.size, 1);
    if (score >= 0.85 && (!best || score > best.score)) best = { provider: r.provider, score };
  }
  return best?.provider ?? null;
}

export interface TitleGroup { key: string; name: string; listed: number; sold: number; sellThrough: number | null; medianDays: number | null; priceVsList: number | null }
/**
 * Items listed in the last year, grouped by who wrote the title: sold share (of items listed 30+ days ago),
 * median days to sell, and sale price as a % of list price.
 */
export function titleReport(db: Db) {
  ensureTitles(db);
  const ai = db.prepare("SELECT title_norm, provider, item_id FROM ai_titles ORDER BY id DESC LIMIT 20000").all() as { title_norm: string; provider: string; item_id: number | null }[];
  const items = db
    .prepare(
      `SELECT i.id, i.title, i.price, COALESCE((SELECT MIN(listed_at) FROM listings l WHERE l.item_id = i.id AND l.listed_at IS NOT NULL), i.created_at) AS listed,
        (SELECT MIN(sold_at) FROM sales s WHERE s.item_id = i.id) AS sold_at, (SELECT sale_price / MAX(quantity, 1) FROM sales s WHERE s.item_id = i.id ORDER BY sold_at LIMIT 1) AS sale_price
       FROM items i WHERE i.title != '' AND i.status != 'draft' AND i.created_at >= datetime('now','-365 days')`,
    )
    .all() as { id: number; title: string; price: number; listed: string; sold_at: string | null; sale_price: number | null }[];
  const t = (s: string) => Date.parse(s.includes("T") ? s : s.replace(" ", "T") + "Z");
  const groups = new Map<string, { listed: number; matured: number; soldMatured: number; sold: number; days: number[]; ratio: number[] }>();
  for (const it of items) {
    const who = authorOf(ai, it.id, it.title) ?? "you";
    const keys = who === "you" ? ["you"] : ["ai", who];
    const old = Date.now() - t(it.listed) >= 30 * 86400_000;
    for (const k of keys) {
      const g = groups.get(k) ?? { listed: 0, matured: 0, soldMatured: 0, sold: 0, days: [], ratio: [] };
      g.listed++;
      if (old) g.matured++;
      if (it.sold_at) {
        g.sold++;
        if (old) g.soldMatured++;
        g.days.push(Math.max(0, (t(it.sold_at) - t(it.listed)) / 86400_000));
        if (it.sale_price && it.price > 0) g.ratio.push(it.sale_price / it.price);
      }
      groups.set(k, g);
    }
  }
  const name = (k: string) => (k === "you" ? "Your own titles" : k === "ai" ? "AI-written titles (all)" : `${PROVIDERS[k as ProviderId]?.name.split(" (")[0] ?? k} titles`);
  const rows: TitleGroup[] = [...groups.entries()].map(([k, g]) => ({
    key: k,
    name: name(k),
    listed: g.listed,
    sold: g.sold,
    sellThrough: g.matured >= 5 ? Math.round((g.soldMatured / g.matured) * 100) : null,
    medianDays: g.days.length >= 3 ? Math.round(median(g.days)! * 10) / 10 : null,
    priceVsList: g.ratio.length >= 3 ? Math.round(median(g.ratio)! * 100) : null,
  }));
  const order = ["ai", "you"];
  rows.sort((a, b) => (order.indexOf(a.key) + 1 || 9) - (order.indexOf(b.key) + 1 || 9) || b.listed - a.listed);
  const you = rows.find((r) => r.key === "you");
  const aiRow = rows.find((r) => r.key === "ai");
  let verdict: string | null = null;
  if (you?.medianDays != null && aiRow?.medianDays != null && you.sold >= 5 && aiRow.sold >= 5) {
    const faster = aiRow.medianDays < you.medianDays;
    verdict = `Items with AI-written titles sold in ${aiRow.medianDays} days (typical) vs ${you.medianDays} for your own titles: ${faster ? "AI titles sold faster" : aiRow.medianDays === you.medianDays ? "about the same" : "your titles sold faster"}.`;
  }
  return { rows, verdict };
}

// ---------------- Monthly report card ----------------

export const reportCardSettings = (db: Db) => ({ on: false, ...getSetting<{ on?: boolean; lastRunAt?: string; lastRunId?: string; lastWinner?: string | null; lastSales?: number }>(db, "aiReportCard", {}) });

/** Due monthly (when on), with 2+ AIs and 10+ new sales since last time. Starts the backtest; returns its id. */
export function reportCardIfDue(db: Db, now = Date.now()) {
  const s = reportCardSettings(db);
  if (!s.on) return null;
  if (s.lastRunAt && now - Date.parse(s.lastRunAt) < 30 * 86400_000) return null;
  const providers = PROVIDER_IDS.filter(providerReady);
  if (providers.length < 2) return null;
  const sales = (db.prepare("SELECT COUNT(DISTINCT item_id) AS n FROM sales WHERE sale_price > 0").get() as { n: number }).n;
  if (sales - (s.lastSales ?? 0) < 10) return null;
  const { backtest, finished } = startBacktest(db, { n: 30, providers, photos: false });
  setSetting(db, "aiReportCard", { ...s, lastRunAt: new Date(now).toISOString(), lastRunId: backtest.id, lastSales: sales });
  return finished.then(() => announceReportCard(db, backtest.id, s.lastWinner ?? null)).then(() => backtest.id);
}

export async function announceReportCard(db: Db, id: string, previousWinner: string | null) {
  const b = getBacktest(db, id);
  if (!b || b.status !== "done") return;
  const s = reportCardSettings(db);
  setSetting(db, "aiReportCard", { ...s, lastWinner: b.winner });
  const w = b.scores.find((x) => x.predictor === b.winner);
  const you = b.scores.find((x) => x.predictor === "you");
  const nm = (p: string | null) => (p ? (PROVIDERS[p as ProviderId]?.name.split(" (")[0] ?? p) : "none");
  const changed = Boolean(previousWinner && b.winner && previousWinner !== b.winner);
  const title = changed ? `🔬 New best AI for pricing: ${nm(b.winner)}` : `🔬 Monthly AI report card: ${w ? `${nm(b.winner)} is still best` : "not enough data"}`;
  const body = w
    ? `${nm(b.winner)} was typically ${w.medianAbsPct}% off on your last ${b.cases.length} sales${you?.medianAbsPct != null ? ` (your own list prices: ${you.medianAbsPct}%)` : ""}.${changed ? ` Last month it was ${nm(previousWinner)}. Reports → Which AI prices best? has a button to put it first.` : ""}`
    : "Not enough answers to compare the AIs this month.";
  raiseAlert(db, { kind: "ai-report", severity: "info", title, body });
  await notify(db, "weekly", title, body).catch(() => false);
}
