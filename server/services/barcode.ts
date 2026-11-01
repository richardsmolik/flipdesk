/**
 * Barcode (UPC / EAN / ISBN) -> product.
 *   Books: Open Library (free, no key)
 *   Everything else: UPCitemdb free tier (100 lookups/day, no key)
 *   eBay Browse API gtin search when eBay keys are set
 * Results are cached for 30 days.
 */
import type { Db } from "../db.js";
import { ebayHasAppKeys } from "../marketplaces/ebay.js";

export type CodeKind = "isbn" | "upc" | "ean" | "unknown";

function gtinCheckOk(digits: string) {
  // GTIN mod-10 (UPC-A, EAN-8/13, ISBN-13)
  const d = digits.split("").map(Number);
  const check = d.pop()!;
  const sum = d.reverse().reduce((a, n, i) => a + n * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

function isbn10to13(isbn10: string) {
  const core = "978" + isbn10.slice(0, 9);
  const sum = core.split("").reduce((a, n, i) => a + Number(n) * (i % 2 === 0 ? 1 : 3), 0);
  return core + ((10 - (sum % 10)) % 10);
}

export function normalizeCode(raw: string): { code: string; kind: CodeKind; valid: boolean } {
  const s = raw.trim().toUpperCase().replace(/[^0-9X]/g, "");
  if (/^\d{9}[\dX]$/.test(s)) {
    // ISBN-10
    const sum = s.split("").reduce((a, c, i) => a + (c === "X" ? 10 : Number(c)) * (10 - i), 0);
    return { code: isbn10to13(s), kind: "isbn", valid: sum % 11 === 0 };
  }
  const digits = s.replace(/X/g, "");
  if (digits.length === 13) return { code: digits, kind: /^97[89]/.test(digits) ? "isbn" : "ean", valid: gtinCheckOk(digits) };
  if (digits.length === 12) return { code: digits, kind: "upc", valid: gtinCheckOk(digits) };
  if (digits.length === 8) return { code: digits, kind: "ean", valid: gtinCheckOk(digits) };
  return { code: digits, kind: "unknown", valid: false };
}

export interface BarcodeProduct {
  code: string;
  kind: CodeKind;
  found: boolean;
  title: string;
  brand: string;
  category: string;
  image: string | null;
  source: string;
  extra?: Record<string, string>;
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "FlipDesk/0.1 (reseller tool)" }, signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function lookupIsbn(code: string): Promise<Partial<BarcodeProduct> | null> {
  type OL = Record<string, { title: string; subtitle?: string; authors?: { name: string }[]; publishers?: { name: string }[]; publish_date?: string; cover?: { medium?: string } }>;
  const j = await getJson<OL>(`https://openlibrary.org/api/books?bibkeys=ISBN:${code}&format=json&jscmd=data`);
  const b = j?.[`ISBN:${code}`];
  if (!b) return null;
  const author = b.authors?.map((a) => a.name).join(", ") ?? "";
  return {
    title: [b.title, b.subtitle].filter(Boolean).join(": ") + (author ? ` by ${author}` : ""),
    brand: b.publishers?.[0]?.name ?? "",
    category: "Books",
    image: b.cover?.medium ?? null,
    source: "Open Library",
    extra: { Author: author, Publisher: b.publishers?.[0]?.name ?? "", "Publication Year": (b.publish_date ?? "").match(/\d{4}/)?.[0] ?? "" },
  };
}

async function lookupUpc(code: string): Promise<Partial<BarcodeProduct> | null> {
  type U = { items?: { title: string; brand?: string; category?: string; images?: string[]; model?: string }[] };
  const j = await getJson<U>(`https://api.upcitemdb.com/prod/trial/lookup?upc=${code}`);
  const it = j?.items?.[0];
  if (!it) return null;
  return { title: it.title, brand: it.brand ?? "", category: it.category ?? "", image: it.images?.[0] ?? null, source: "UPCitemdb", extra: it.model ? { Model: it.model } : undefined };
}

export async function lookupBarcode(db: Db, raw: string, fetcher?: { isbn?: typeof lookupIsbn; upc?: typeof lookupUpc }): Promise<BarcodeProduct> {
  const { code, kind, valid } = normalizeCode(raw);
  if (!valid) return { code, kind, found: false, title: "", brand: "", category: "", image: null, source: "invalid" };
  const cached = db.prepare("SELECT data FROM barcode_cache WHERE code = ? AND fetched_at >= datetime('now','-30 days')").get(code) as { data: string } | undefined;
  if (cached) return JSON.parse(cached.data);

  const isbnFn = fetcher?.isbn ?? lookupIsbn;
  const upcFn = fetcher?.upc ?? lookupUpc;
  let hit = kind === "isbn" ? await isbnFn(code) : await upcFn(code);
  if (!hit && kind === "isbn") hit = await upcFn(code);
  const result: BarcodeProduct = {
    code,
    kind,
    found: Boolean(hit?.title),
    title: hit?.title ?? "",
    brand: hit?.brand ?? "",
    category: hit?.category ?? "",
    image: hit?.image ?? null,
    source: hit?.source ?? (ebayHasAppKeys() ? "eBay (by barcode)" : "not found"),
    extra: hit?.extra,
  };
  // Only cache real answers so a temporary outage doesn't stick for 30 days.
  if (result.found) db.prepare("INSERT OR REPLACE INTO barcode_cache (code, data) VALUES (?, ?)").run(code, JSON.stringify(result));
  return result;
}

/** Item-specific key eBay expects for this kind of code. */
export function specificKeyFor(kind: CodeKind) {
  return kind === "isbn" ? "ISBN" : kind === "ean" ? "EAN" : "UPC";
}
