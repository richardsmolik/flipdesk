/**
 * Price research. Live: eBay Browse API active listings (sold-comps data via
 * eBay's Marketplace Insights API is restricted to approved partners).
 * Demo: deterministic synthetic comps so the UI is fully explorable.
 */
import type { Db } from "../db.js";
import { ebayBrowseSearch } from "../marketplaces/ebay.js";
import { findLocalComps } from "./comps.js";

export interface Comp {
  title: string;
  price: number;
  sold: boolean;
  condition?: string;
  url?: string;
  image?: string;
  source: string;
}

export interface PriceStats {
  count: number;
  median: number;
  p25: number;
  p75: number;
  min: number;
  max: number;
}

export function stats(prices: number[]): PriceStats | null {
  if (!prices.length) return null;
  const s = [...prices].sort((a, b) => a - b);
  const q = (p: number) => {
    const i = (s.length - 1) * p;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return Math.round((s[lo] + (s[hi] - s[lo]) * (i - lo)) * 100) / 100;
  };
  return { count: s.length, median: q(0.5), p25: q(0.25), p75: q(0.75), min: s[0], max: s[s.length - 1] };
}

function hash(str: string) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

function demoComps(q: string): Comp[] {
  let seed = hash(q.toLowerCase());
  const rand = () => ((seed = Math.imul(seed ^ (seed >>> 15), 2246822507) >>> 0) % 10000) / 10000;
  const base = 15 + (hash(q) % 120);
  return Array.from({ length: 12 }, (_, i) => ({
    title: `${q} ${["- Excellent", "Pre-owned", "EUC", "Vintage", "NWT", "Good condition"][i % 6]}`,
    price: Math.round(base * (0.65 + rand() * 0.8) * 100) / 100,
    sold: i % 3 !== 0,
    condition: i % 5 === 0 ? "New" : "Used",
    source: "demo",
  }));
}

export async function researchPrice(db: Db, q: string, gtin?: string) {
  let comps: Comp[] = [];
  let demo = false;

  // 1) Your sold-data library (Terapeak / CSV imports): real SOLD prices.
  const local = findLocalComps(db, q);
  const soldWeighted: number[] = [];
  for (const c of local) {
    comps.push({ title: c.title, price: c.price, sold: true, condition: c.condition ?? undefined, url: c.url ?? undefined, source: "sold-library" });
    for (let i = 0; i < Math.min(c.quantity, 20); i++) soldWeighted.push(c.price); // weight by units sold
  }

  // 2) eBay active listings (what you're competing against right now).
  try {
    const live = await ebayBrowseSearch(db, q, 20, gtin);
    if (live) comps.push(...live.map((c) => ({ ...c, sold: false, source: "ebay-active" })));
  } catch (e) {
    console.warn("[pricing] eBay browse failed:", (e as Error).message);
  }

  // 3) Nothing real? Demo data so the UI is explorable.
  if (!comps.length) {
    comps = demoComps(q);
    demo = true;
  }
  const sold = soldWeighted.length ? soldWeighted : comps.filter((c) => c.sold).map((c) => c.price);
  const active = comps.filter((c) => !c.sold).map((c) => c.price);
  const s = stats(sold.length >= 3 ? sold : comps.map((c) => c.price));
  const suggestion = s
    ? { recommended: Math.max(1, Math.round(s.median) - 0.01), quickSale: Math.max(1, Math.round(s.p25) - 0.01), stretch: Math.round(s.p75) - 0.01 }
    : null;
  const units = local.reduce((a, c) => a + c.quantity, 0);
  return {
    query: q,
    demo,
    comps,
    soldStats: stats(sold),
    activeStats: stats(active),
    suggestion,
    // Sell-through signal: sold units vs active listings (higher = sells faster).
    demand: local.length ? { soldUnits: units, activeListings: active.length, sellThrough: active.length ? Math.round((units / (units + active.length)) * 100) : null } : null,
    sources: [...new Set(comps.map((c) => c.source))],
  };
}
