/**
 * Price research. Live: eBay Browse API active listings (sold-comps data via
 * eBay's Marketplace Insights API is restricted to approved partners).
 * Demo: deterministic synthetic comps so the UI is fully explorable.
 */
import type { Db } from "../db.js";
import { ebayBrowseSearch } from "../marketplaces/ebay.js";

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

export async function researchPrice(db: Db, q: string) {
  let comps: Comp[] = [];
  let demo = false;
  try {
    const live = await ebayBrowseSearch(db, q);
    if (live) comps = live.map((c) => ({ ...c, sold: false, source: "ebay-active" }));
  } catch (e) {
    console.warn("[pricing] eBay browse failed:", (e as Error).message);
  }
  if (!comps.length) {
    comps = demoComps(q);
    demo = true;
  }
  const sold = comps.filter((c) => c.sold).map((c) => c.price);
  const active = comps.filter((c) => !c.sold).map((c) => c.price);
  const s = stats(sold.length >= 3 ? sold : comps.map((c) => c.price));
  // Price a touch under the median of sold (or active) comps; quick sale near p25.
  const suggestion = s
    ? { recommended: Math.max(1, Math.round(s.median) - 0.01), quickSale: Math.max(1, Math.round(s.p25) - 0.01), stretch: Math.round(s.p75) - 0.01 }
    : null;
  return { query: q, demo, comps, soldStats: stats(sold), activeStats: stats(active), suggestion };
}
