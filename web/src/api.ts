export interface Listing {
  id: number;
  item_id: number;
  marketplace: string;
  status: string;
  external_id: string | null;
  url: string | null;
  price: number;
  quantity: number;
  views: number;
  watchers: number;
  error: string | null;
  listed_at: string | null;
}

export interface Item {
  id: number;
  sku: string;
  title: string;
  description: string;
  brand: string;
  category: string;
  condition: string;
  color: string;
  size: string;
  specifics: Record<string, string>;
  keywords: string[];
  cost: number;
  price: number;
  min_price: number | null;
  quantity: number;
  quantity_purchased: number;
  quantity_sold: number;
  weight_oz: number | null;
  location: string;
  source: string;
  status: string;
  notes: string;
  created_at: string;
  updated_at: string;
  photos: { id: number; url: string }[];
  listings: Listing[];
}

export interface Marketplace {
  id: string;
  name: string;
  mode: "api" | "extension";
  color: string;
  titleMax: number;
  maxPhotos: number;
  multiQty: boolean;
  supportsOffers: boolean;
  notes: string;
  newListingUrl: string;
  fees: Record<string, number | boolean>;
  connection: { status: string; username?: string | null };
  live: boolean;
  activeListings: number;
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(url, {
    method,
    headers: body && !isForm ? { "Content-Type": "application/json" } : undefined,
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  get: <T,>(u: string) => req<T>("GET", u),
  post: <T,>(u: string, b?: unknown) => req<T>("POST", u, b ?? {}),
  patch: <T,>(u: string, b: unknown) => req<T>("PATCH", u, b),
  put: <T,>(u: string, b: unknown) => req<T>("PUT", u, b),
  del: (u: string) => req<void>("DELETE", u),
};

export const money = (n: number | null | undefined) =>
  n === null || n === undefined || Number.isNaN(n) ? "-" : n.toLocaleString("en-US", { style: "currency", currency: "USD" });

export const CONDITIONS: Record<string, string> = {
  new_with_tags: "New with tags",
  new_without_tags: "New without tags",
  like_new: "Like new",
  used_excellent: "Used - excellent",
  used_good: "Used - good",
  used_fair: "Used - fair",
  for_parts: "For parts / not working",
};
