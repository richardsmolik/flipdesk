/**
 * eBay Sell API client.
 *
 * Live mode needs EBAY_CLIENT_ID / EBAY_CLIENT_SECRET / EBAY_RU_NAME plus a
 * user refresh token (obtained via the OAuth "Connect eBay" button).
 * Without credentials every call runs in demo mode so the whole app works.
 *
 * APIs used:
 *   Inventory API   – inventory items, offers, publish / withdraw
 *   Account API     – business policies (shipping / payment / returns)
 *   Taxonomy API    – category suggestions
 *   Fulfillment API – orders (sale detection -> auto-delist elsewhere)
 *   Negotiation API – send offers to watchers / interested buyers
 */
import type { Db, Item, ListingRow } from "../db.js";
import { getSetting } from "../db.js";
import { uploadUrl } from "../context.js";

const ENV = () => (process.env.EBAY_ENV === "production" ? "production" : "sandbox");
const API = () => (ENV() === "production" ? "https://api.ebay.com" : "https://api.sandbox.ebay.com");
const AUTH = () => (ENV() === "production" ? "https://auth.ebay.com" : "https://auth.sandbox.ebay.com");
const MARKETPLACE_ID = () => process.env.EBAY_MARKETPLACE_ID ?? "EBAY_US";

export const EBAY_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
  "https://api.ebay.com/oauth/api_scope/sell.marketing",
  "https://api.ebay.com/oauth/api_scope/sell.analytics.readonly",
  "https://api.ebay.com/oauth/api_scope/sell.finances",
];

export function ebayHasAppKeys() {
  return Boolean(process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET);
}

interface EbayCreds {
  refresh_token?: string;
  access_token?: string;
  expires_at?: number;
}

function readCreds(db: Db): EbayCreds {
  const row = db.prepare("SELECT credentials FROM connections WHERE marketplace = 'ebay'").get() as
    | { credentials: string }
    | undefined;
  return row ? JSON.parse(row.credentials) : {};
}

function writeCreds(db: Db, creds: EbayCreds) {
  db.prepare(
    `INSERT INTO connections (marketplace, status, credentials, connected_at) VALUES ('ebay', 'connected', ?, datetime('now'))
     ON CONFLICT(marketplace) DO UPDATE SET credentials = excluded.credentials, status = 'connected'`,
  ).run(JSON.stringify(creds));
}

export function ebayIsLive(db: Db) {
  return ebayHasAppKeys() && Boolean(readCreds(db).refresh_token);
}

const basic = () =>
  "Basic " + Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString("base64");

/** Step 1 of OAuth: URL to send the seller to. */
export function ebayConsentUrl(state: string) {
  const p = new URLSearchParams({
    client_id: process.env.EBAY_CLIENT_ID ?? "",
    redirect_uri: process.env.EBAY_RU_NAME ?? "",
    response_type: "code",
    scope: EBAY_SCOPES.join(" "),
    state,
  });
  return `${AUTH()}/oauth2/authorize?${p}`;
}

/** Step 2 of OAuth: exchange the code for a refresh token. */
export async function ebayExchangeCode(db: Db, code: string) {
  const res = await fetch(`${API()}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: basic(), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: process.env.EBAY_RU_NAME ?? "" }),
  });
  if (!res.ok) throw new Error(`eBay token exchange failed: ${res.status} ${await res.text()}`);
  const j = (await res.json()) as { access_token: string; expires_in: number; refresh_token: string };
  writeCreds(db, { refresh_token: j.refresh_token, access_token: j.access_token, expires_at: Date.now() + j.expires_in * 1000 });
}

async function userToken(db: Db): Promise<string> {
  const creds = readCreds(db);
  if (creds.access_token && creds.expires_at && creds.expires_at - 60_000 > Date.now()) return creds.access_token;
  if (!creds.refresh_token) throw new Error("eBay not connected");
  const res = await fetch(`${API()}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: basic(), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: creds.refresh_token, scope: EBAY_SCOPES.join(" ") }),
  });
  if (!res.ok) throw new Error(`eBay token refresh failed: ${res.status} ${await res.text()}`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  writeCreds(db, { ...creds, access_token: j.access_token, expires_at: Date.now() + j.expires_in * 1000 });
  return j.access_token;
}

let appTok: { token: string; exp: number } | null = null;
async function appToken(): Promise<string> {
  if (appTok && appTok.exp > Date.now()) return appTok.token;
  const res = await fetch(`${API()}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: basic(), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: "https://api.ebay.com/oauth/api_scope" }),
  });
  if (!res.ok) throw new Error(`eBay app token failed: ${res.status}`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  appTok = { token: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  return appTok.token;
}

async function call<T>(db: Db, method: string, path: string, body?: unknown, useApp = false): Promise<T> {
  const token = useApp ? await appToken() : await userToken(db);
  const res = await fetch(`${API()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Content-Language": "en-US",
      "Accept-Language": "en-US",
      "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE_ID(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!res.ok) throw new Error(friendlyEbayError(res.status, text, `${method} ${path}`));
  return (text ? JSON.parse(text) : undefined) as T;
}

// ---------------- Mapping ----------------

const CONDITION_MAP: Record<string, string> = {
  new_with_tags: "NEW",
  new_without_tags: "NEW_OTHER",
  like_new: "USED_EXCELLENT",
  used_excellent: "USED_EXCELLENT",
  used_good: "USED_GOOD",
  used_fair: "USED_ACCEPTABLE",
  for_parts: "FOR_PARTS_OR_NOT_WORKING",
};

function photoUrls(item: Item): string[] {
  const base = process.env.PUBLIC_BASE_URL; // eBay must be able to fetch images
  return item.photos
    .map((p) => (p.url.startsWith("http") ? p.url : base ? `${base.replace(/\/$/, "")}${p.url}` : null))
    .filter((u): u is string => Boolean(u))
    .slice(0, 24);
}

export function toInventoryItem(item: Item, imageUrls?: string[]) {
  const aspects: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(item.specifics)) if (v) aspects[k] = [v];
  if (item.brand) aspects["Brand"] ??= [item.brand];
  if (item.color) aspects["Color"] ??= [item.color];
  if (item.size) aspects["Size"] ??= [item.size];
  return {
    availability: { shipToLocationAvailability: { quantity: Math.max(0, item.quantity) } },
    condition: CONDITION_MAP[item.condition] ?? "USED_GOOD",
    product: {
      title: item.title.slice(0, 80),
      description: item.description,
      aspects,
      imageUrls: imageUrls ?? photoUrls(item),
      brand: item.brand || undefined,
      ...(item.specifics["UPC"] ? { upc: [item.specifics["UPC"]] } : {}),
      ...(item.specifics["ISBN"] ? { isbn: [item.specifics["ISBN"]] } : {}),
      ...(item.specifics["EAN"] ? { ean: [item.specifics["EAN"]] } : {}),
    },
    ...(item.weight_oz
      ? { packageWeightAndSize: { weight: { value: item.weight_oz, unit: "OUNCE" } } }
      : {}),
  };
}

// ---------------- Demo helpers ----------------
const demoId = () => String(110000000000 + Math.floor(Math.random() * 899999999999));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------- Operations ----------------

export async function suggestCategory(db: Db, query: string): Promise<{ id: string; name: string }[]> {
  if (!ebayHasAppKeys()) {
    return [{ id: "11450", name: "Clothing, Shoes & Accessories (demo)" }];
  }
  const r = await call<{ categorySuggestions?: { category: { categoryId: string; categoryName: string } }[] }>(
    db,
    "GET",
    `/commerce/taxonomy/v1/category_tree/0/get_category_suggestions?q=${encodeURIComponent(query)}`,
    undefined,
    true,
  );
  return (r.categorySuggestions ?? []).slice(0, 5).map((s) => ({ id: s.category.categoryId, name: s.category.categoryName }));
}

export async function fetchPolicies(db: Db) {
  const mp = MARKETPLACE_ID();
  const [f, p, r] = await Promise.all([
    call<{ fulfillmentPolicies?: { fulfillmentPolicyId: string; name: string }[] }>(db, "GET", `/sell/account/v1/fulfillment_policy?marketplace_id=${mp}`),
    call<{ paymentPolicies?: { paymentPolicyId: string; name: string }[] }>(db, "GET", `/sell/account/v1/payment_policy?marketplace_id=${mp}`),
    call<{ returnPolicies?: { returnPolicyId: string; name: string }[] }>(db, "GET", `/sell/account/v1/return_policy?marketplace_id=${mp}`),
  ]);
  return {
    fulfillment: (f.fulfillmentPolicies ?? []).map((x) => ({ id: x.fulfillmentPolicyId, name: x.name })),
    payment: (p.paymentPolicies ?? []).map((x) => ({ id: x.paymentPolicyId, name: x.name })),
    returns: (r.returnPolicies ?? []).map((x) => ({ id: x.returnPolicyId, name: x.name })),
  };
}

export async function ebayPublish(db: Db, item: Item, price: number): Promise<{ externalId: string; url: string; offerId?: string }> {
  if (!ebayIsLive(db)) {
    await sleep(150);
    const id = demoId();
    return { externalId: id, url: `https://www.ebay.com/itm/${id}` };
  }
  const cfg = getSetting(db, "ebay", {} as {
    fulfillmentPolicyId?: string;
    paymentPolicyId?: string;
    returnPolicyId?: string;
    merchantLocationKey?: string;
    bestOffer?: boolean;
  });
  if (!cfg.fulfillmentPolicyId || !cfg.paymentPolicyId || !cfg.returnPolicyId || !cfg.merchantLocationKey) {
    throw new Error("Set your eBay business policies and location in Settings -> eBay first.");
  }
  const images = await resolveImageUrls(db, item);
  if (!images.length) throw new Error("eBay needs at least one photo. Add a photo to this item first.");
  if (item.variations.length) return ebayPublishGroup(db, item, price, cfg, images);
  const sku = item.sku;
  await call(db, "PUT", `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, toInventoryItem(item, images));

  const categoryId =
    item.specifics["_ebayCategoryId"] || (await suggestCategory(db, `${item.title} ${item.category}`))[0]?.id;
  if (!categoryId) throw new Error("Could not determine an eBay category for this item.");

  const offerBody = {
    sku,
    marketplaceId: MARKETPLACE_ID(),
    format: "FIXED_PRICE",
    availableQuantity: item.quantity,
    categoryId,
    listingDescription: item.description,
    merchantLocationKey: cfg.merchantLocationKey,
    pricingSummary: { price: { value: price.toFixed(2), currency: "USD" } },
    listingPolicies: {
      fulfillmentPolicyId: cfg.fulfillmentPolicyId,
      paymentPolicyId: cfg.paymentPolicyId,
      returnPolicyId: cfg.returnPolicyId,
      ...(cfg.bestOffer && item.min_price
        ? { bestOfferTerms: { bestOfferEnabled: true, autoDeclinePrice: { value: item.min_price.toFixed(2), currency: "USD" } } }
        : {}),
    },
  };
  const offer = await call<{ offerId: string }>(db, "POST", `/sell/inventory/v1/offer`, offerBody);
  const pub = await call<{ listingId: string }>(db, "POST", `/sell/inventory/v1/offer/${offer.offerId}/publish`);
  const host = ENV() === "production" ? "www.ebay.com" : "sandbox.ebay.com";
  return { externalId: pub.listingId, offerId: offer.offerId, url: `https://${host}/itm/${pub.listingId}` };
}

async function offerIdForSku(db: Db, sku: string): Promise<string | undefined> {
  const r = await call<{ offers?: { offerId: string }[] }>(db, "GET", `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}`);
  return r.offers?.[0]?.offerId;
}

export async function ebayDelist(db: Db, item: Item, _listing: ListingRow) {
  if (!ebayIsLive(db)) return sleep(100);
  if (item.variations.length) {
    await call(db, "POST", `/sell/inventory/v1/offer/withdraw_by_inventory_item_group`, { inventoryItemGroupKey: item.sku, marketplaceId: MARKETPLACE_ID() });
    return;
  }
  const offerId = await offerIdForSku(db, item.sku);
  if (offerId) await call(db, "POST", `/sell/inventory/v1/offer/${offerId}/withdraw`);
}

/** Syncs both price and available quantity for the listing. */
export async function ebayUpdatePrice(db: Db, item: Item, listing: ListingRow, price: number) {
  if (!ebayIsLive(db)) return sleep(80);
  if (item.variations.length) {
    // Per-variant stock + price (max 25 per request).
    const reqs = [];
    for (const v of item.variations) {
      reqs.push({
        sku: v.sku,
        shipToLocationAvailability: { quantity: v.quantity },
        offers: [{ offerId: await offerIdForSku(db, v.sku), availableQuantity: v.quantity, price: { value: (v.price ?? price).toFixed(2), currency: "USD" } }],
      });
    }
    for (let i = 0; i < reqs.length; i += 25) await call(db, "POST", `/sell/inventory/v1/bulk_update_price_quantity`, { requests: reqs.slice(i, i + 25) });
    return;
  }
  const offerId = await offerIdForSku(db, item.sku);
  await call(db, "POST", `/sell/inventory/v1/bulk_update_price_quantity`, {
    requests: [
      {
        sku: item.sku,
        shipToLocationAvailability: { quantity: listing.quantity },
        offers: [{ offerId, availableQuantity: listing.quantity, price: { value: price.toFixed(2), currency: "USD" } }],
      },
    ],
  });
}

export interface EbayAddress {
  fullName?: string;
  contactAddress?: { addressLine1?: string; addressLine2?: string; city?: string; stateOrProvince?: string; postalCode?: string; countryCode?: string };
  primaryPhone?: { phoneNumber?: string };
  email?: string;
}

export interface EbayOrder {
  orderId: string;
  creationDate: string;
  buyer?: { username?: string };
  fulfillmentStartInstructions?: { shippingStep?: { shipTo?: EbayAddress } }[];
  lineItems: { lineItemId?: string; sku?: string; quantity?: number; legacyItemId?: string; lineItemCost: { value: string }; deliveryCost?: { shippingCost?: { value: string } } }[];
}

/** Orders since a timestamp (ISO). Used by the sales poller for auto-delist. */
export async function ebayOrdersSince(db: Db, sinceIso: string): Promise<EbayOrder[]> {
  if (!ebayIsLive(db)) return [];
  const filter = encodeURIComponent(`creationdate:[${sinceIso}..]`);
  const r = await call<{ orders?: EbayOrder[] }>(db, "GET", `/sell/fulfillment/v1/order?filter=${filter}&limit=200`);
  return r.orders ?? [];
}

/** Listings with watchers that are eligible for "Send offer to interested buyers". */
export async function ebayEligibleForOffers(db: Db): Promise<string[]> {
  if (!ebayIsLive(db)) return [];
  const r = await call<{ eligibleItems?: { listingId: string }[] }>(db, "GET", `/sell/negotiation/v1/find_eligible_items?limit=200`);
  return (r.eligibleItems ?? []).map((x) => x.listingId);
}

export async function ebaySendOffer(db: Db, listingId: string, price: number, message: string, quantity = 1) {
  if (!ebayIsLive(db)) return { demo: true, offersSent: Math.floor(Math.random() * 5) + 1 };
  return call(db, "POST", `/sell/negotiation/v1/send_offer_to_interested_buyers`, {
    allowCounterOffer: false,
    message: message.slice(0, 2000),
    offerDuration: { unit: "DAY", value: 2 },
    offeredItems: [{ listingId, price: { value: price.toFixed(2), currency: "USD" }, quantity }],
  });
}

/** Active-listing comps via the Browse API (app token only; no seller login needed). */
export async function ebayBrowseSearch(db: Db, q: string, limit = 20, gtin?: string) {
  if (!ebayHasAppKeys()) return null;
  const query = gtin ? `gtin=${encodeURIComponent(gtin)}` : `q=${encodeURIComponent(q)}`;
  const r = await call<{
    itemSummaries?: { title: string; price?: { value: string }; condition?: string; itemWebUrl?: string; image?: { imageUrl: string } }[];
  }>(db, "GET", `/buy/browse/v1/item_summary/search?${query}&limit=${limit}`, undefined, true);
  return (r.itemSummaries ?? [])
    .filter((x) => x.price)
    .map((x) => ({ title: x.title, price: Number(x.price!.value), condition: x.condition, url: x.itemWebUrl, image: x.image?.imageUrl }));
}

type EbayCfg = { fulfillmentPolicyId?: string; paymentPolicyId?: string; returnPolicyId?: string; merchantLocationKey?: string };

/**
 * Multi-variation listing: one inventory item per variation SKU, grouped by the
 * parent SKU, then published together (Inventory API "inventory item group").
 */
async function ebayPublishGroup(db: Db, item: Item, price: number, cfg: EbayCfg, images: string[]) {
  const dims = [...new Set(item.variations.flatMap((v) => Object.keys(v.attrs)))];
  for (const v of item.variations) {
    const inv = toInventoryItem({ ...item, quantity: v.quantity }, images);
    for (const [k, val] of Object.entries(v.attrs)) inv.product.aspects[k] = [val];
    await call(db, "PUT", `/sell/inventory/v1/inventory_item/${encodeURIComponent(v.sku)}`, inv);
  }
  const common = toInventoryItem(item, images).product;
  for (const d of dims) delete common.aspects[d];
  await call(db, "PUT", `/sell/inventory/v1/inventory_item_group/${encodeURIComponent(item.sku)}`, {
    title: common.title,
    description: common.description,
    imageUrls: common.imageUrls,
    aspects: common.aspects,
    variantSKUs: item.variations.map((v) => v.sku),
    variesBy: {
      specifications: dims.map((d) => ({ name: d, values: [...new Set(item.variations.map((v) => v.attrs[d]).filter(Boolean))] })),
    },
  });
  const categoryId = item.specifics["_ebayCategoryId"] || (await suggestCategory(db, `${item.title} ${item.category}`))[0]?.id;
  if (!categoryId) throw new Error("Could not determine an eBay category for this item.");
  for (const v of item.variations) {
    const existing = await offerIdForSku(db, v.sku).catch(() => undefined);
    if (existing) continue;
    await call(db, "POST", `/sell/inventory/v1/offer`, {
      sku: v.sku,
      marketplaceId: MARKETPLACE_ID(),
      format: "FIXED_PRICE",
      availableQuantity: v.quantity,
      categoryId,
      merchantLocationKey: cfg.merchantLocationKey,
      pricingSummary: { price: { value: (v.price ?? price).toFixed(2), currency: "USD" } },
      listingPolicies: { fulfillmentPolicyId: cfg.fulfillmentPolicyId, paymentPolicyId: cfg.paymentPolicyId, returnPolicyId: cfg.returnPolicyId },
    });
  }
  const pub = await call<{ listingId: string }>(db, "POST", `/sell/inventory/v1/offer/publish_by_inventory_item_group`, {
    inventoryItemGroupKey: item.sku,
    marketplaceId: MARKETPLACE_ID(),
  });
  const host = ENV() === "production" ? "www.ebay.com" : "sandbox.ebay.com";
  return { externalId: pub.listingId, url: `https://${host}/itm/${pub.listingId}` };
}

/**
 * Multi-buy ("volume pricing") promotion via the Marketing API: e.g. buy 2 save 10%, 3+ save 15%.
 * Returns the promotion id from the Location header.
 */
export async function ebayCreateVolumeDiscount(db: Db, name: string, listingIds: string[], tiers: { minQuantity: number; pctOff: number }[]) {
  if (!ebayIsLive(db)) return { demo: true, promotionId: `DEMO-PROMO-${Date.now()}` };
  const token = await userToken(db);
  const start = new Date(Date.now() + 60_000);
  const end = new Date(Date.now() + 30 * 86400_000);
  const rules = [{ minQuantity: 1, pctOff: 0 }, ...tiers.sort((a, b) => a.minQuantity - b.minQuantity)].map((t, i) => ({
    ruleOrder: i + 1,
    discountSpecification: { minQuantity: t.minQuantity },
    discountBenefit: { percentageOffOrder: String(t.pctOff) },
  }));
  const res = await fetch(`${API()}/sell/marketing/v1/item_promotion`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE_ID() },
    body: JSON.stringify({
      name: name.slice(0, 90),
      marketplaceId: MARKETPLACE_ID(),
      promotionStatus: "SCHEDULED",
      promotionType: "VOLUME_DISCOUNT",
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      discountRules: rules,
      inventoryCriterion: { inventoryCriterionType: "INVENTORY_BY_VALUE", listingIds },
    }),
  });
  if (!res.ok) throw new Error(`eBay promotion failed: ${res.status} ${(await res.text()).slice(0, 400)}`);
  const loc = res.headers.get("location") ?? "";
  return { demo: false, promotionId: loc.split("/").pop() || "" };
}

export async function ebayEndPromotion(db: Db, promotionId: string) {
  if (!ebayIsLive(db) || promotionId.startsWith("DEMO")) return;
  await call(db, "DELETE", `/sell/marketing/v1/item_promotion/${encodeURIComponent(promotionId)}`);
}

const FIN_API = () => (ENV() === "production" ? "https://apiz.ebay.com" : "https://apiz.sandbox.ebay.com");

/** Shipping labels bought on eBay since a date (Finances API) -> exact label cost per order. */
export async function ebayLabelTransactions(db: Db, sinceIso: string): Promise<{ orderId: string; amount: number; date: string }[]> {
  if (!ebayIsLive(db)) return [];
  const token = await userToken(db);
  const filter = encodeURIComponent(`transactionType:{SHIPPING_LABEL},transactionDate:[${sinceIso}..]`);
  const res = await fetch(`${FIN_API()}/sell/finances/v1/transaction?filter=${filter}&limit=200`, {
    headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE_ID() },
  });
  if (!res.ok) throw new Error(`eBay finances -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = (await res.json()) as { transactions?: { orderId?: string; amount?: { value: string }; transactionDate: string }[] };
  return (j.transactions ?? []).filter((t) => t.orderId && t.amount).map((t) => ({ orderId: t.orderId!, amount: Math.abs(Number(t.amount!.value)), date: t.transactionDate }));
}

/** Upload tracking to an eBay order (e.g. after buying the label on Pirate Ship). */
export async function ebayAddTracking(db: Db, orderId: string, lineItemId: string, quantity: number, carrier: string, tracking: string) {
  if (!ebayIsLive(db)) return { demo: true };
  return call(db, "POST", `/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}/shipping_fulfillment`, {
    lineItems: [{ lineItemId, quantity }],
    shippedDate: new Date().toISOString(),
    shippingCarrierCode: carrier.toUpperCase(),
    trackingNumber: tracking.replace(/\s+/g, ""),
  });
}

// ---------------- Photos via eBay Picture Services (Media API) ----------------
// eBay must download listing photos from a public URL. Photos on your computer aren't public,
// so unless PUBLIC_BASE_URL is set (hosted / tunnel), we upload each photo to eBay's own image
// hosting and reuse the returned URL until it expires.
const MEDIA_API = () => (ENV() === "production" ? "https://apim.ebay.com" : "https://apim.sandbox.ebay.com");

export async function ebayUploadImage(db: Db, filePath: string): Promise<{ url: string; expires: string | null }> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const token = await userToken(db);
  const form = new FormData();
  const ext = path.extname(filePath).toLowerCase();
  const type = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  form.append("image", new Blob([fs.readFileSync(filePath)], { type }), path.basename(filePath));
  const res = await fetch(`${MEDIA_API()}/commerce/media/v1_beta/image/create_image_from_file`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) throw new Error(`eBay photo upload failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  let body = (await res.json().catch(() => ({}))) as { imageUrl?: string; expirationDate?: string };
  if (!body.imageUrl) {
    const loc = res.headers.get("location");
    if (!loc) throw new Error("eBay photo upload returned no image URL");
    const g = await fetch(loc, { headers: { Authorization: `Bearer ${token}` } });
    body = (await g.json()) as { imageUrl?: string; expirationDate?: string };
  }
  if (!body.imageUrl) throw new Error("eBay photo upload returned no image URL");
  return { url: body.imageUrl, expires: body.expirationDate ?? null };
}

export async function resolveImageUrls(db: Db, item: Item): Promise<string[]> {
  const base = process.env.PUBLIC_BASE_URL;
  const rows = db
    .prepare("SELECT id, path, ebay_url, ebay_url_expires FROM photos WHERE item_id = ? ORDER BY position, id LIMIT 24")
    .all(item.id) as { id: number; path: string; ebay_url: string | null; ebay_url_expires: string | null }[];
  const out: string[] = [];
  for (const r of rows) {
    if (r.path.startsWith("http")) out.push(r.path);
    else if (base) out.push(`${base.replace(/\/$/, "")}${uploadUrl(r.path)}`);
    else if (!/\.(jpe?g|png|webp)$/i.test(r.path)) continue; // eBay rejects svg/gif
    else if (r.ebay_url && (!r.ebay_url_expires || Date.parse(r.ebay_url_expires) > Date.now() + 86400_000)) out.push(r.ebay_url);
    else {
      const up = await ebayUploadImage(db, r.path);
      db.prepare("UPDATE photos SET ebay_url = ?, ebay_url_expires = ? WHERE id = ?").run(up.url, up.expires, r.id);
      out.push(up.url);
    }
  }
  return out;
}

// ---------------- One-time account setup helpers ----------------
export async function ebayOptedInPrograms(db: Db): Promise<string[]> {
  const r = await call<{ programs?: { programType: string }[] }>(db, "GET", `/sell/account/v1/program/get_opted_in_programs`);
  return (r.programs ?? []).map((p) => p.programType);
}

/** Business policies (shipping/payment/returns as reusable policies) are required by the Inventory API. */
export async function ebayOptInBusinessPolicies(db: Db) {
  await call(db, "POST", `/sell/account/v1/program/opt_in`, { programType: "SELLING_POLICY_MANAGEMENT" });
}

export async function ebayLocations(db: Db): Promise<{ key: string; name?: string }[]> {
  const r = await call<{ locations?: { merchantLocationKey: string; name?: string }[] }>(db, "GET", `/sell/inventory/v1/location?limit=100`);
  return (r.locations ?? []).map((l) => ({ key: l.merchantLocationKey, name: l.name }));
}

export async function ebayCreateLocation(
  db: Db,
  key: string,
  a: { name?: string; street1?: string; street2?: string; city?: string; state?: string; zip?: string; country?: string },
) {
  if (!a.street1 || !a.city || !a.state || !a.zip) throw new Error("Fill in your ship-from address in Settings first.");
  await call(db, "POST", `/sell/inventory/v1/location/${encodeURIComponent(key)}`, {
    name: a.name || "Main",
    merchantLocationStatus: "ENABLED",
    locationTypes: ["WAREHOUSE"],
    location: { address: { addressLine1: a.street1, addressLine2: a.street2 || undefined, city: a.city, stateOrProvince: a.state, postalCode: a.zip, country: a.country || "US" } },
  });
}

/** Exchange a pasted redirect URL ("...?code=...&state=...") when the app can't receive eBay's redirect itself. */
export function parseEbayRedirect(url: string) {
  const u = new URL(url.trim());
  const code = u.searchParams.get("code");
  if (!code) throw new Error("That address has no code= in it. Copy the full address from your browser after you click Agree on eBay.");
  return { code, state: u.searchParams.get("state") };
}

export function ebayEnvironment() {
  return ENV();
}

/** Turn eBay's error JSON into something a seller can act on. */
export function friendlyEbayError(status: number, text: string, where = "") {
  try {
    const j = JSON.parse(text) as { errors?: { errorId?: number; message?: string; longMessage?: string; parameters?: { name: string; value: string }[] }[] };
    const msgs = (j.errors ?? []).map((e) => {
      const m = e.longMessage || e.message || "";
      const param = e.parameters?.find((p) => /aspect|name|field/i.test(p.name))?.value;
      if (/item specific|aspect/i.test(m) && param) return `eBay requires the item specific "${param}" for this category. Add it under Item specifics.`;
      if (e.errorId === 1100 || /access denied|insufficient permissions/i.test(m)) return "eBay denied access. Reconnect eBay (Marketplaces page) so FlipDesk gets the newest permissions.";
      if (/business polic/i.test(m)) return "Turn on eBay business policies and choose your shipping, payment and return policies (Marketplaces, eBay setup).";
      if (/location/i.test(m) && /invalid|not found|missing/i.test(m)) return "Register your ship-from location (Marketplaces, eBay setup).";
      return m;
    }).filter(Boolean);
    if (msgs.length) return `eBay: ${[...new Set(msgs)].join(" ")}`;
  } catch {
    /* not JSON */
  }
  return `eBay ${where} -> ${status}: ${text.slice(0, 300)}`;
}

/** Required item specifics for a category that this item doesn't have yet (checked before listing). */
export async function ebayRequiredAspects(db: Db, categoryId: string) {
  if (!ebayHasAppKeys()) return [];
  const r = await call<{
    aspects?: { localizedAspectName: string; aspectConstraint?: { aspectRequired?: boolean; aspectUsage?: string }; aspectValues?: { localizedValue: string }[] }[];
  }>(db, "GET", `/commerce/taxonomy/v1/category_tree/0/get_item_aspects_for_category?category_id=${encodeURIComponent(categoryId)}`, undefined, true);
  return (r.aspects ?? [])
    .filter((a) => a.aspectConstraint?.aspectRequired)
    .map((a) => ({ name: a.localizedAspectName, values: (a.aspectValues ?? []).slice(0, 12).map((v) => v.localizedValue) }));
}

/** Marketplace Account Deletion: eBay's required notification endpoint for production keysets. */
export async function accountDeletionChallenge(challengeCode: string) {
  const crypto = await import("node:crypto");
  const endpoint = `${(process.env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "")}/api/ebay/account-deletion`;
  const token = process.env.EBAY_VERIFICATION_TOKEN ?? "";
  return crypto.createHash("sha256").update(challengeCode + token + endpoint).digest("hex");
}

/** Listing traffic for the last N days (Analytics API, sell.analytics.readonly). */
export async function ebayTrafficReport(db: Db, days = 30) {
  if (!ebayIsLive(db)) return null;
  const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
  const end = new Date(Date.now() - 86400_000); // eBay wants a completed day
  const start = new Date(end.getTime() - (days - 1) * 86400_000);
  const metrics = ["LISTING_IMPRESSION_TOTAL", "LISTING_VIEWS_TOTAL", "CLICK_THROUGH_RATE", "SALES_CONVERSION_RATE", "TRANSACTION"];
  const filter = encodeURIComponent(`marketplace_ids:{${MARKETPLACE_ID()}},date_range:[${ymd(start)}..${ymd(end)}]`);
  const r = await call<{
    header?: { metrics?: { key: string }[] };
    records?: { dimensionValues: { value: string }[]; metricValues: { value: number | string | null }[] }[];
  }>(db, "GET", `/sell/analytics/v1/traffic_report?dimension=LISTING&metric=${metrics.join(",")}&filter=${filter}`);
  const keys = (r.header?.metrics ?? []).map((m) => m.key);
  const get = (rec: { metricValues: { value: number | string | null }[] }, k: string) => Number(rec.metricValues[keys.indexOf(k)]?.value ?? 0) || 0;
  return (r.records ?? []).map((rec) => ({
    externalId: rec.dimensionValues[0]?.value,
    impressions: get(rec, "LISTING_IMPRESSION_TOTAL"),
    views: get(rec, "LISTING_VIEWS_TOTAL"),
    ctr: get(rec, "CLICK_THROUGH_RATE") * (get(rec, "CLICK_THROUGH_RATE") <= 1 ? 100 : 1),
    conversion: get(rec, "SALES_CONVERSION_RATE") * (get(rec, "SALES_CONVERSION_RATE") <= 1 ? 100 : 1),
    sold: get(rec, "TRANSACTION"),
    periodDays: days,
  }));
}
