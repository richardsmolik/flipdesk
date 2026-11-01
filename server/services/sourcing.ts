/**
 * Sourcing mode: "Should I buy this?" in the aisle.
 * Photo or name -> identify -> sold comps -> best marketplace net -> max buy price -> verdict.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod/v4";
import fs from "node:fs";
import path from "node:path";
import { getSetting, type Db } from "../db.js";
import { MARKETPLACES } from "../marketplaces/registry.js";
import { aiIsLive, MODEL } from "./ai.js";
import { recommend } from "./fees.js";
import { researchPrice } from "./pricing.js";

export const QuickId = z.object({
  name: z.string().describe("What the item is, specific: brand + model/line + type"),
  brand: z.string(),
  category: z.string(),
  search_query: z.string().describe("Best marketplace search query to find sold comps (3-7 words, no filler)"),
  est_low: z.number().describe("Typical low resale price in USD (used, good condition)"),
  est_high: z.number().describe("Typical high resale price in USD"),
  confidence: z.enum(["low", "medium", "high"]),
  demand: z.enum(["slow", "steady", "hot"]).describe("How fast this typically sells on resale marketplaces"),
  red_flags: z.array(z.string()).describe("Authenticity risks, common defects to check, missing parts, recalls, etc."),
});
export type QuickId = z.infer<typeof QuickId>;

export interface SourcingSettings {
  minProfit: number; // dollars you want to clear per item
  minRoiPct: number; // e.g. 100 = double your money
}

function mediaType(file: string) {
  const ext = path.extname(file).toLowerCase();
  return ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : ext === ".gif" ? "image/gif" : "image/jpeg";
}

export async function quickIdentify(photoPath: string | undefined, hint: string | undefined): Promise<{ id: QuickId; demo: boolean }> {
  if (!aiIsLive() || !photoPath) {
    const q = (hint || "").trim() || "item";
    return {
      demo: !aiIsLive(),
      id: { name: q, brand: q.split(/\s+/)[0] ?? "", category: "", search_query: q, est_low: 0, est_high: 0, confidence: "low", demand: "steady", red_flags: [] },
    };
  }
  const client = new Anthropic();
  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    // Low effort: the seller is standing in a store; speed beats depth here.
    output_config: { effort: "low", format: betaZodOutputFormat(QuickId) },
    system:
      "You are a veteran reseller helping someone decide in seconds whether to buy an item to resell. Identify it precisely, estimate realistic resale prices (sold, not asking), and flag risks. If unsure, say so via confidence.",
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType(photoPath), data: fs.readFileSync(photoPath).toString("base64") } },
          { type: "text", text: hint ? `Seller notes: ${hint}` : "Identify this item for resale." },
        ],
      },
    ],
  });
  if (response.stop_reason === "refusal" || !response.parsed_output) throw new Error("Couldn't identify this item - try typing what it is.");
  return { id: response.parsed_output, demo: false };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export async function checkItem(db: Db, input: { photoPath?: string; query?: string; askPrice?: number }) {
  const { id, demo } = await quickIdentify(input.photoPath, input.query);
  const research = await researchPrice(db, id.search_query || input.query || id.name);
  const settings = getSetting<SourcingSettings>(db, "sourcing", { minProfit: 10, minRoiPct: 100 });
  const shipping = getSetting(db, "defaultShippingCost", 0) as number;

  // Expected sale price: real sold median > AI estimate > all comps median.
  const aiMid = id.est_high > 0 ? (id.est_low + id.est_high) / 2 : 0;
  const realSold = research.sources.includes("sold-library") && research.soldStats ? research.soldStats.median : 0;
  const expected = r2(realSold || (aiMid && research.demo ? aiMid : research.soldStats?.median || research.activeStats?.median || aiMid));
  const basis = realSold ? "your sold data" : aiMid && research.demo ? "AI estimate" : research.demo ? "demo comps" : "eBay listings";

  // Only rank sites you actually sell on (connected); your own store (Shopify) has no built-in buyers.
  const connected = new Set((db.prepare("SELECT marketplace FROM connections WHERE status = 'connected'").all() as { marketplace: string }[]).map((r) => r.marketplace));
  const all = recommend({ price: expected, cost: 0, category: `${id.category} ${id.brand}`, title: id.name }, getSetting(db, "feeOverrides", {}), shipping);
  const ranked = connected.size ? all.filter((r) => connected.has(r.marketplace)) : all.filter((r) => r.marketplace !== "shopify");
  const best = ranked[0];
  const net = best ? best.net : 0; // payout after fees + shipping, before cost
  // Max you can pay and still hit BOTH your minimum profit and minimum ROI.
  const maxBuy = r2(Math.max(0, Math.min(net - settings.minProfit, net / (1 + settings.minRoiPct / 100))));

  let verdict: "buy" | "maybe" | "pass" | "check" = "check";
  let why = "Enter the price on the tag to get a verdict.";
  if (input.askPrice !== undefined && expected > 0) {
    const profit = r2(net - input.askPrice);
    if (input.askPrice <= maxBuy) {
      verdict = "buy";
      why = `Expected profit ~$${profit.toFixed(2)} on ${best ? MARKETPLACES[best.marketplace].name : "best site"}.`;
    } else if (profit >= settings.minProfit * 0.5 && input.askPrice <= maxBuy * 1.25) {
      verdict = "maybe";
      why = `Thin: ~$${profit.toFixed(2)} profit. Buy only if it's in great shape or you can negotiate to $${maxBuy.toFixed(2)}.`;
    } else {
      verdict = "pass";
      why = profit > 0 ? `Only ~$${profit.toFixed(2)} profit after fees and shipping - below your target.` : `You'd likely lose money after fees and shipping.`;
    }
    if (verdict === "buy" && id.demand === "slow") why += " Heads up: it usually sells slowly.";
  } else if (expected <= 0) {
    why = "Not enough price data. Import Terapeak sold data or add your AI key for estimates.";
  }

  return {
    demo,
    identified: id,
    expectedPrice: expected,
    priceBasis: basis,
    quickSale: research.suggestion?.quickSale ?? null,
    soldStats: research.soldStats,
    demand: research.demand,
    best: ranked.slice(0, 3).map((r) => ({ marketplace: r.marketplace, name: MARKETPLACES[r.marketplace].name, net: r.net, fees: r.fees, reason: r.reason })),
    maxBuy,
    targets: settings,
    verdict,
    why,
    comps: research.comps.slice(0, 8),
  };
}
