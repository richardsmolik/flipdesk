/**
 * AI listing writer: photos (+ optional hint & comps) -> complete listing.
 *
 * Uses Claude (claude-opus-5-5) vision + structured outputs so the result is
 * always valid JSON matching ListingDraft. Refusal fallbacks are enabled
 * (server-side "default" routing) so a rare safety decline gets retried on a
 * fallback model inside the same call.
 *
 * With no ANTHROPIC_API_KEY the writer runs a deterministic demo so the app
 * is fully usable offline.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod/v4";
import fs from "node:fs";
import path from "node:path";
import type { Comp } from "./pricing.js";

export const MODEL = "claude-opus-5-5";

export const CONDITIONS = ["new_with_tags", "new_without_tags", "like_new", "used_excellent", "used_good", "used_fair", "for_parts"] as const;

export const ListingDraft = z.object({
  title: z.string().describe("eBay-optimized title, max 80 chars: Brand + Item + Key features + Size/Color. No filler words, no ALL CAPS spam."),
  short_title: z.string().describe("Max 60 chars version for strict-length sites like Grailed."),
  description: z.string().describe("Buyer-friendly description: 1-line hook, key details as short lines, honest condition notes, measurements placeholder if relevant. Plain text, no HTML."),
  brand: z.string(),
  category: z.string().describe("Category path, e.g. 'Clothing > Men > Jackets & Coats'"),
  condition: z.enum(CONDITIONS),
  color: z.string(),
  size: z.string().describe("Size if visible/applicable, else empty string"),
  item_specifics: z.array(z.object({ name: z.string(), value: z.string() })).describe("eBay-style item specifics (Material, Style, Model, MPN, Era, Pattern, etc). Only include what you can see or confidently infer."),
  keywords: z.array(z.string()).describe("8-13 search keywords/tags buyers actually type"),
  flaws: z.array(z.string()).describe("Visible defects (stains, pilling, scratches, missing parts). Empty if none seen."),
  verify: z.array(z.string()).describe("Things the seller must check before listing that the photos cannot confirm (e.g. 'Check inside tag for size', 'Test power on')."),
  price: z.object({
    recommended: z.number(),
    low: z.number(),
    high: z.number(),
    quick_sale: z.number().describe("Price likely to sell within ~7 days"),
    confidence: z.enum(["low", "medium", "high"]),
    reasoning: z.string(),
  }),
  best_marketplaces: z.array(z.string()).describe("Ranked marketplace ids from: ebay, poshmark, mercari, depop, vinted, grailed, facebook, etsy, shopify, amazon, whatnot"),
});
export type ListingDraft = z.infer<typeof ListingDraft>;

const SYSTEM = `You are an expert reseller who has listed 50,000+ items across eBay, Poshmark, Mercari, Depop, Grailed, Etsy and Facebook Marketplace.
Write listings that rank in marketplace search and convert: precise titles (brand, model, key attributes, size), scannable descriptions, accurate item specifics.
Be honest: never invent brand, model, size or materials you cannot see or reasonably infer; put uncertainties in "verify" and visible defects in "flaws".
Pricing: anchor on the provided comparable listings when present (sold comps outweigh active asks). With no comps, estimate from your knowledge of resale values and set confidence to "low".`;

function mediaType(file: string): "image/jpeg" | "image/png" | "image/webp" | "image/gif" {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/jpeg";
}

export function aiIsLive() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

export interface GenerateInput {
  photoPaths: string[];
  hint?: string;
  cost?: number;
  comps?: Comp[];
}

export async function generateListing(input: GenerateInput): Promise<{ draft: ListingDraft; demo: boolean; model?: string }> {
  if (!aiIsLive()) return { draft: demoDraft(input), demo: true };

  const client = new Anthropic();
  const images = input.photoPaths.slice(0, 8).map((p) => ({
    type: "image" as const,
    source: { type: "base64" as const, media_type: mediaType(p), data: fs.readFileSync(p).toString("base64") },
  }));

  const compsText = input.comps?.length
    ? `Comparable listings:\n${input.comps
        .slice(0, 15)
        .map((c) => `- [${c.sold ? "SOLD" : "ACTIVE"}] $${c.price.toFixed(2)} - ${c.title}${c.condition ? ` (${c.condition})` : ""}`)
        .join("\n")}`
    : "No comparable listings available.";

  const text = [
    "Create a complete resale listing for the item in these photos.",
    input.hint ? `Seller notes: ${input.hint}` : "",
    input.cost ? `Seller paid $${input.cost.toFixed(2)}.` : "",
    compsText,
  ]
    .filter(Boolean)
    .join("\n\n");

  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: betaZodOutputFormat(ListingDraft) },
    system: SYSTEM,
    messages: [{ role: "user", content: [...images, { type: "text", text }] }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("The AI declined to describe these photos. Try different photos or fill the listing in manually.");
  }
  if (response.stop_reason === "max_tokens" || !response.parsed_output) {
    throw new Error("The AI response was incomplete. Please try again.");
  }
  return { draft: response.parsed_output, demo: false, model: response.model };
}

/** Offline demo: plausible draft built from the hint/filename so the UI flow works without a key. */
export function demoDraft(input: GenerateInput): ListingDraft {
  // Stored uploads have random names (timestamp-hex); don't turn those into a title.
  const fromFile = path.basename(input.photoPaths[0] ?? "").replace(/\.[a-z]+$/i, "").replace(/\b(\d{8,}|[0-9a-f]{6,}|ed|img)\b/gi, " ");
  const raw = (input.hint || fromFile).replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim() || "Untitled item";
  const words = raw.split(/\s+/).filter(Boolean);
  const brand = words[0] ? words[0][0].toUpperCase() + words[0].slice(1) : "Unbranded";
  const title = raw.replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 80) || "Item";
  const compPrices = (input.comps ?? []).map((c) => c.price).sort((a, b) => a - b);
  const median = compPrices.length ? compPrices[Math.floor(compPrices.length / 2)] : Math.max(19.99, (input.cost ?? 8) * 3.5);
  const rec = Math.round(median) - 0.01;
  return {
    title,
    short_title: title.slice(0, 60),
    description: `${title}\n\n- Brand: ${brand}\n- Condition: Pre-owned, good condition (see photos)\n- Ships fast & well packaged\n\n(Demo mode: add ANTHROPIC_API_KEY to generate real AI listings from your photos.)`,
    brand,
    category: "",
    condition: "used_good",
    color: "",
    size: "",
    item_specifics: [{ name: "Brand", value: brand }],
    keywords: words.slice(0, 10).map((w) => w.toLowerCase()),
    flaws: [],
    verify: ["Demo mode - review every field", "Confirm size and measurements"],
    price: {
      recommended: rec,
      low: Math.round(rec * 0.8),
      high: Math.round(rec * 1.25),
      quick_sale: Math.round(rec * 0.85),
      confidence: compPrices.length ? "medium" : "low",
      reasoning: compPrices.length ? `Median of ${compPrices.length} comparable listings.` : "Demo estimate (~3.5x cost). Connect eBay + AI for real pricing.",
    },
    best_marketplaces: ["ebay", "mercari", "poshmark"],
  };
}
