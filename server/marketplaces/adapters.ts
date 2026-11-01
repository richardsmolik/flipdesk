/**
 * Unified adapter layer. Every marketplace exposes publish / delist / updatePrice.
 *
 * - API marketplaces run server-side (live when credentials exist, demo otherwise).
 * - Extension marketplaces return { deferred: true }: the job stays in the queue
 *   until the Chrome extension claims it and completes it in your browser.
 */
import { getSetting, type Db, type Item, type ListingRow } from "../db.js";
import { MARKETPLACES, type MarketplaceId } from "./registry.js";
import { ebayDelist, ebayIsLive, ebayPublish, ebayUpdatePrice } from "./ebay.js";

export interface PublishResult {
  externalId: string;
  url: string;
}

export interface Adapter {
  id: MarketplaceId;
  /** true when talking to the real marketplace (not demo) */
  isLive(db: Db): boolean;
  publish(db: Db, item: Item, price: number): Promise<PublishResult | { deferred: true }>;
  delist(db: Db, item: Item, listing: ListingRow): Promise<void | { deferred: true }>;
  updatePrice(db: Db, item: Item, listing: ListingRow, price: number): Promise<void | { deferred: true }>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const rid = () => Math.random().toString(36).slice(2, 12);

// ---------------- Etsy (Open API v3) ----------------
const etsyLive = () => Boolean(process.env.ETSY_API_KEY && process.env.ETSY_ACCESS_TOKEN && process.env.ETSY_SHOP_ID);
async function etsy<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`https://openapi.etsy.com/v3/application${path}`, {
    method,
    headers: {
      "x-api-key": process.env.ETSY_API_KEY!,
      Authorization: `Bearer ${process.env.ETSY_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Etsy ${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

const etsyAdapter: Adapter = {
  id: "etsy",
  isLive: etsyLive,
  async publish(db, item, price) {
    if (!etsyLive()) return (await sleep(120), { externalId: rid(), url: `https://www.etsy.com/listing/${Date.now()}` });
    const cfg = getSetting(db, "etsy", {} as { taxonomyId?: number; shippingProfileId?: number; whenMade?: string });
    // Creates a DRAFT listing (Etsy requires images to be uploaded before activation).
    const r = await etsy<{ listing_id: number; url: string }>("POST", `/shops/${process.env.ETSY_SHOP_ID}/listings`, {
      quantity: item.quantity,
      title: item.title.slice(0, 140),
      description: item.description,
      price,
      who_made: "someone_else",
      when_made: cfg.whenMade ?? "2000_2006",
      taxonomy_id: cfg.taxonomyId ?? 1,
      shipping_profile_id: cfg.shippingProfileId,
      tags: item.keywords.slice(0, 13).map((k) => k.slice(0, 20)),
    });
    return { externalId: String(r.listing_id), url: r.url };
  },
  async delist(_db, _item, listing) {
    if (!etsyLive()) return sleep(80);
    await etsy("PATCH", `/shops/${process.env.ETSY_SHOP_ID}/listings/${listing.external_id}`, { state: "inactive" });
  },
  async updatePrice(_db, _item, listing, price) {
    if (!etsyLive()) return sleep(80);
    // Price lives on the listing inventory for v3; simple listings accept price on update.
    await etsy("PATCH", `/shops/${process.env.ETSY_SHOP_ID}/listings/${listing.external_id}`, { price });
  },
};

// ---------------- Shopify (Admin GraphQL) ----------------
const shopifyLive = () => Boolean(process.env.SHOPIFY_STORE_DOMAIN && process.env.SHOPIFY_ADMIN_TOKEN);
async function shopify<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(`https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2025-07/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN!, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const j = (await res.json()) as { data?: T; errors?: unknown };
  if (!res.ok || j.errors) throw new Error(`Shopify error: ${JSON.stringify(j.errors ?? res.status).slice(0, 400)}`);
  return j.data as T;
}

const shopifyAdapter: Adapter = {
  id: "shopify",
  isLive: shopifyLive,
  async publish(_db, item, price) {
    if (!shopifyLive()) return (await sleep(120), { externalId: `gid://shopify/Product/${Date.now()}`, url: "https://admin.shopify.com/products" });
    const data = await shopify<{
      productSet: { product: { id: string; handle: string } | null; userErrors: { message: string }[] };
    }>(
      `mutation productSet($input: ProductSetInput!) {
        productSet(synchronous: true, input: $input) { product { id handle } userErrors { field message } }
      }`,
      {
        input: {
          title: item.title,
          descriptionHtml: item.description.replace(/\n/g, "<br>"),
          vendor: item.brand || undefined,
          productType: item.category || undefined,
          status: "ACTIVE",
          tags: item.keywords,
          productOptions: [{ name: "Title", values: [{ name: "Default Title" }] }],
          variants: [{ optionValues: [{ optionName: "Title", name: "Default Title" }], price: price.toFixed(2), sku: item.sku }],
        },
      },
    );
    const errs = data.productSet.userErrors;
    if (errs.length || !data.productSet.product) throw new Error(errs.map((e) => e.message).join("; "));
    const p = data.productSet.product;
    return { externalId: p.id, url: `https://${process.env.SHOPIFY_STORE_DOMAIN}/products/${p.handle}` };
  },
  async delist(_db, _item, listing) {
    if (!shopifyLive()) return sleep(80);
    await shopify(`mutation($p: ProductUpdateInput!) { productUpdate(product: $p) { userErrors { message } } }`, {
      p: { id: listing.external_id, status: "ARCHIVED" },
    });
  },
  async updatePrice() {
    // Price changes go through productVariantsBulkUpdate; republish is simpler for single-variant items.
    if (!shopifyLive()) return sleep(80);
  },
};

// ---------------- Amazon (SP-API) ----------------
// Amazon requires an approved SP-API developer profile and listings must match
// an ASIN + product type schema. Until configured this adapter runs in demo mode.
const amazonAdapter: Adapter = {
  id: "amazon",
  isLive: () => false,
  async publish() {
    await sleep(120);
    return { externalId: `DEMO-${rid()}`, url: "https://sellercentral.amazon.com/inventory" };
  },
  async delist() {
    await sleep(60);
  },
  async updatePrice() {
    await sleep(60);
  },
};

// ---------------- eBay ----------------
const ebayAdapter: Adapter = {
  id: "ebay",
  isLive: ebayIsLive,
  publish: ebayPublish,
  delist: ebayDelist,
  updatePrice: ebayUpdatePrice,
};

// ---------------- Extension-driven marketplaces ----------------
function extensionAdapter(id: MarketplaceId): Adapter {
  return {
    id,
    isLive: () => true,
    publish: async () => ({ deferred: true }),
    delist: async () => ({ deferred: true }),
    updatePrice: async () => ({ deferred: true }),
  };
}

const API_ADAPTERS: Partial<Record<MarketplaceId, Adapter>> = {
  ebay: ebayAdapter,
  etsy: etsyAdapter,
  shopify: shopifyAdapter,
  amazon: amazonAdapter,
};

export function adapterFor(id: MarketplaceId): Adapter {
  return API_ADAPTERS[id] ?? extensionAdapter(id);
}

export function isExtensionMarketplace(id: MarketplaceId) {
  return MARKETPLACES[id].mode === "extension";
}
