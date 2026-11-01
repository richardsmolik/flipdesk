/**
 * Marketplace registry: one place that describes every supported resale site.
 *
 * mode:
 *   "api"       – official seller API; FlipDesk publishes/delists server-side.
 *   "extension" – no public listing API; the FlipDesk Chrome extension fills in
 *                 the site's own forms in your logged-in browser (same approach
 *                 Vendoo / List Perfectly / Crosslist use).
 *
 * FEES: defaults reflect publicly posted seller fees at time of writing and DO
 * change. Every number is overridable in Settings -> Fees, and the profit math
 * always uses your overrides.
 */

export type MarketplaceId =
  | "ebay"
  | "poshmark"
  | "mercari"
  | "depop"
  | "vinted"
  | "grailed"
  | "facebook"
  | "etsy"
  | "shopify"
  | "amazon"
  | "whatnot";

export interface FeeModel {
  /** % of sale price (+ shipping if feeOnShipping) */
  pct: number;
  /** flat per-order fee */
  fixed: number;
  /** extra payment-processing % (some sites split this out) */
  processingPct?: number;
  processingFixed?: number;
  /** below this price, charge flatUnder instead (Poshmark-style) */
  flatUnderThreshold?: number;
  flatUnder?: number;
  /** minimum total fee */
  minFee?: number;
  /** whether the % applies to buyer-paid shipping too (eBay) */
  feeOnShipping?: boolean;
  /** listing/insertion fee charged when you list */
  listingFee?: number;
}

export interface MarketplaceDef {
  id: MarketplaceId;
  name: string;
  mode: "api" | "extension";
  color: string;
  titleMax: number;
  descriptionMax: number;
  maxPhotos: number;
  fees: FeeModel;
  /** Where the extension opens a "new listing" form */
  newListingUrl: string;
  /** Category keywords this marketplace is strongest for (drives recommendations) */
  strengths: string[];
  supportsOffers: boolean;
  /** Can one listing carry quantity > 1? If not, FlipDesk lists 1 unit and auto-relists after each sale. */
  multiQty: boolean;
  /** One listing can hold several variations (sizes/colors). If not, FlipDesk lists each variation separately. */
  variations: boolean;
  notes: string;
}

export const MARKETPLACES: Record<MarketplaceId, MarketplaceDef> = {
  ebay: {
    id: "ebay",
    name: "eBay",
    mode: "api",
    color: "#0064d2",
    titleMax: 80,
    descriptionMax: 500_000,
    maxPhotos: 24,
    fees: { pct: 13.6, fixed: 0.4, feeOnShipping: true },
    newListingUrl: "https://www.ebay.com/sl/sell",
    strengths: ["electronics", "collectibles", "parts", "auto", "media", "cards", "tools", "vintage", "everything"],
    supportsOffers: true,
    multiQty: true,
    variations: true,
    notes: "Sell Inventory, Fulfillment, Negotiation & Taxonomy APIs.",
  },
  poshmark: {
    id: "poshmark",
    name: "Poshmark",
    mode: "extension",
    color: "#7f0353",
    titleMax: 80,
    descriptionMax: 1500,
    maxPhotos: 16,
    fees: { pct: 20, fixed: 0, flatUnderThreshold: 15, flatUnder: 2.95 },
    newListingUrl: "https://poshmark.com/create-listing",
    strengths: ["clothing", "womens", "shoes", "handbags", "accessories", "beauty", "home"],
    supportsOffers: true,
    multiQty: true,
    variations: false,
    notes: "No public API. Extension fills the create-listing form; sharing stays manual by design.",
  },
  mercari: {
    id: "mercari",
    name: "Mercari",
    mode: "extension",
    color: "#ff0211",
    titleMax: 80,
    descriptionMax: 1000,
    maxPhotos: 12,
    fees: { pct: 10, fixed: 0, processingPct: 2.9, processingFixed: 0.5 },
    newListingUrl: "https://www.mercari.com/sell/",
    strengths: ["electronics", "toys", "games", "home", "collectibles", "clothing"],
    supportsOffers: true,
    multiQty: false,
    variations: false,
    notes: "No public API. Verify current seller fee - Mercari has changed it several times.",
  },
  depop: {
    id: "depop",
    name: "Depop",
    mode: "extension",
    color: "#ff2300",
    titleMax: 80,
    descriptionMax: 1000,
    maxPhotos: 8,
    fees: { pct: 0, fixed: 0, processingPct: 3.3, processingFixed: 0.45 },
    newListingUrl: "https://www.depop.com/products/create/",
    strengths: ["clothing", "streetwear", "vintage", "y2k", "womens", "accessories"],
    supportsOffers: true,
    multiQty: true,
    variations: false,
    notes: "US sellers: 0% selling fee + payment processing.",
  },
  vinted: {
    id: "vinted",
    name: "Vinted",
    mode: "extension",
    color: "#09b1ba",
    titleMax: 100,
    descriptionMax: 2000,
    maxPhotos: 20,
    fees: { pct: 0, fixed: 0 },
    newListingUrl: "https://www.vinted.com/items/new",
    strengths: ["clothing", "womens", "kids", "shoes", "accessories"],
    supportsOffers: true,
    multiQty: false,
    variations: false,
    notes: "Buyer pays fees; seller keeps 100%.",
  },
  grailed: {
    id: "grailed",
    name: "Grailed",
    mode: "extension",
    color: "#000000",
    titleMax: 60,
    descriptionMax: 2000,
    maxPhotos: 20,
    fees: { pct: 9, fixed: 0, processingPct: 3.49, processingFixed: 0.49 },
    newListingUrl: "https://www.grailed.com/sell/new",
    strengths: ["mens", "streetwear", "designer", "sneakers", "clothing"],
    supportsOffers: true,
    multiQty: false,
    variations: false,
    notes: "Menswear/designer focused.",
  },
  facebook: {
    id: "facebook",
    name: "Facebook Marketplace",
    mode: "extension",
    color: "#1877f2",
    titleMax: 100,
    descriptionMax: 5000,
    maxPhotos: 10,
    fees: { pct: 10, fixed: 0, minFee: 0.8 },
    newListingUrl: "https://www.facebook.com/marketplace/create/item",
    strengths: ["furniture", "home", "large", "local", "electronics", "tools", "baby"],
    supportsOffers: true,
    multiQty: false,
    variations: false,
    notes: "Fee applies to shipped orders; local pickup is free (set fee to 0 if you only do local).",
  },
  etsy: {
    id: "etsy",
    name: "Etsy",
    mode: "api",
    color: "#f1641e",
    titleMax: 140,
    descriptionMax: 50_000,
    maxPhotos: 20,
    fees: { pct: 6.5, fixed: 0, processingPct: 3, processingFixed: 0.25, listingFee: 0.2, feeOnShipping: true },
    newListingUrl: "https://www.etsy.com/your/shops/me/listing-editor/create",
    strengths: ["vintage", "handmade", "craft", "jewelry", "art", "home"],
    supportsOffers: false,
    multiQty: true,
    variations: false,
    notes: "Open API v3. Vintage items must be 20+ years old.",
  },
  shopify: {
    id: "shopify",
    name: "Shopify",
    mode: "api",
    color: "#5e8e3e",
    titleMax: 255,
    descriptionMax: 100_000,
    maxPhotos: 250,
    fees: { pct: 0, fixed: 0, processingPct: 2.9, processingFixed: 0.3 },
    newListingUrl: "https://admin.shopify.com/products/new",
    strengths: ["everything", "brand", "direct"],
    supportsOffers: false,
    multiQty: true,
    variations: true,
    notes: "Your own store via Admin GraphQL API. Plan fee not included.",
  },
  amazon: {
    id: "amazon",
    name: "Amazon",
    mode: "api",
    color: "#ff9900",
    titleMax: 200,
    descriptionMax: 2000,
    maxPhotos: 9,
    fees: { pct: 15, fixed: 0.99 },
    newListingUrl: "https://sellercentral.amazon.com/abis/listing/syh",
    strengths: ["books", "media", "electronics", "new", "toys"],
    supportsOffers: false,
    multiQty: true,
    variations: false,
    notes: "SP-API (requires approved developer profile). Many categories are gated; used clothing is restricted.",
  },
  whatnot: {
    id: "whatnot",
    name: "Whatnot",
    mode: "extension",
    color: "#f5d90a",
    titleMax: 100,
    descriptionMax: 1000,
    maxPhotos: 10,
    fees: { pct: 8, fixed: 0, processingPct: 2.9, processingFixed: 0.3 },
    newListingUrl: "https://www.whatnot.com/dashboard/inventory/new",
    strengths: ["cards", "collectibles", "toys", "sneakers", "comics", "live"],
    supportsOffers: true,
    multiQty: true,
    variations: false,
    notes: "Live-selling + Buy It Now. Seller API is invite-only, so the extension is used.",
  },
};

export const MARKETPLACE_IDS = Object.keys(MARKETPLACES) as MarketplaceId[];

export function isMarketplaceId(x: string): x is MarketplaceId {
  return x in MARKETPLACES;
}
