import { MARKETPLACES, MARKETPLACE_IDS, type FeeModel, type MarketplaceId } from "../marketplaces/registry.js";

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface FeeInput {
  price: number;
  shippingCharged?: number; // what the buyer paid for shipping
  shippingCost?: number; // what you paid for the label
  cost?: number; // what you paid for the item
}

export interface FeeBreakdown {
  marketplace: MarketplaceId;
  price: number;
  fees: number;
  shippingCost: number;
  cost: number;
  net: number; // payout after fees & shipping
  profit: number; // net - cost
  marginPct: number;
  roiPct: number | null;
}

export function calcFees(model: FeeModel, price: number, shippingCharged = 0): number {
  if (price <= 0) return 0;
  const base = model.feeOnShipping ? price + shippingCharged : price;
  let fee: number;
  if (model.flatUnderThreshold !== undefined && price < model.flatUnderThreshold) {
    fee = model.flatUnder ?? 0;
  } else {
    fee = (base * model.pct) / 100 + model.fixed;
  }
  if (model.processingPct) fee += ((price + shippingCharged) * model.processingPct) / 100 + (model.processingFixed ?? 0);
  if (model.listingFee) fee += model.listingFee;
  if (model.minFee !== undefined && fee < model.minFee) fee = model.minFee;
  return round2(fee);
}

export function breakdown(
  marketplace: MarketplaceId,
  input: FeeInput,
  overrides: Partial<Record<MarketplaceId, Partial<FeeModel>>> = {},
): FeeBreakdown {
  const model = { ...MARKETPLACES[marketplace].fees, ...(overrides[marketplace] ?? {}) };
  const shippingCharged = input.shippingCharged ?? 0;
  const shippingCost = input.shippingCost ?? 0;
  const cost = input.cost ?? 0;
  const fees = calcFees(model, input.price, shippingCharged);
  const net = round2(input.price + shippingCharged - fees - shippingCost);
  const profit = round2(net - cost);
  return {
    marketplace,
    price: input.price,
    fees,
    shippingCost,
    cost,
    net,
    profit,
    marginPct: input.price > 0 ? round2((profit / input.price) * 100) : 0,
    roiPct: cost > 0 ? round2((profit / cost) * 100) : null,
  };
}

export interface Recommendation extends FeeBreakdown {
  fitScore: number; // 0..1 how well the category fits this marketplace
  score: number; // combined ranking score
  reason: string;
}

/**
 * Rank marketplaces for an item: net profit at the same price, weighted by how
 * strong each marketplace is for the item's category/keywords.
 */
export function recommend(
  item: { price: number; cost: number; category: string; title: string; keywords?: string[] },
  overrides: Partial<Record<MarketplaceId, Partial<FeeModel>>> = {},
  shippingCost = 0,
): Recommendation[] {
  const haystack = [item.category, item.title, ...(item.keywords ?? [])].join(" ").toLowerCase();
  const rows = MARKETPLACE_IDS.map((id) => {
    const def = MARKETPLACES[id];
    const b = breakdown(id, { price: item.price, cost: item.cost, shippingCost }, overrides);
    const hits = def.strengths.filter((s) => s !== "everything" && haystack.includes(s));
    const fitScore = hits.length ? Math.min(1, 0.5 + hits.length * 0.25) : def.strengths.includes("everything") ? 0.45 : 0.2;
    const keepPct = item.price > 0 ? b.net / item.price : 0;
    const score = round2(keepPct * 0.55 + fitScore * 0.45);
    const reason = hits.length
      ? `Strong for ${hits.slice(0, 3).join(", ")}; you keep ${Math.round(keepPct * 100)}%`
      : `You keep ${Math.round(keepPct * 100)}% after fees`;
    return { ...b, fitScore, score, reason };
  });
  return rows.sort((a, b) => b.score - a.score);
}
