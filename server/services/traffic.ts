/**
 * eBay traffic: why isn't it selling?
 *   not seen     -> few impressions: title keywords / item specifics / relist (a price drop won't help)
 *   not clicked  -> impressions but low click-through: cover photo or price shown in search
 *   not bought   -> views but no sale: price, shipping cost, description, condition details
 * Sources: Analytics API (automatic when eBay is connected) or Seller Hub > Performance > Traffic CSV.
 */
import { logActivity, type Db } from "../db.js";
import { ebayIsLive, ebayTrafficReport } from "../marketplaces/ebay.js";
import { parseCsv } from "./comps.js";

export interface Traffic {
  impressions: number;
  views: number;
  ctr: number | null;
  sold: number;
  conversion: number | null;
  periodDays: number | null;
  importedAt: string;
}

/** Latest traffic row per eBay listing (keyed by listing id). */
export function latestTraffic(db: Db): Map<number, Traffic> {
  const rows = db
    .prepare(
      `SELECT t.* FROM listing_traffic t
       JOIN (SELECT listing_id, MAX(id) AS id FROM listing_traffic WHERE listing_id IS NOT NULL GROUP BY listing_id) last ON last.id = t.id`,
    )
    .all() as { listing_id: number; impressions: number; views: number; ctr: number | null; sold: number; conversion: number | null; period_days: number | null; imported_at: string }[];
  return new Map(rows.map((r) => [r.listing_id, { impressions: r.impressions, views: r.views, ctr: r.ctr, sold: r.sold, conversion: r.conversion, periodDays: r.period_days, importedAt: r.imported_at }]));
}

export type Diagnosis = { code: "not_seen" | "not_clicked" | "not_bought" | "healthy" | "too_new"; label: string; fix: string };

export function diagnose(t: Traffic, ageDays: number): Diagnosis {
  const ctr = t.ctr ?? (t.impressions ? (t.views / t.impressions) * 100 : 0);
  if (ageDays < 7) return { code: "too_new", label: "Too new to judge", fix: "Give it a week of data." };
  if (t.impressions < 100) return { code: "not_seen", label: "Not being seen", fix: "Buyers aren't finding it: put the words buyers search (brand, model, size, color) at the start of the title, fill every item specific, or relist it." };
  if (ctr < 1 && t.impressions >= 300) return { code: "not_clicked", label: "Seen, not clicked", fix: `Only ${ctr.toFixed(1)}% click. The cover photo and price in search are the problem: clean up the cover photo (white background, item filling the frame) or check the price against sold comps.` };
  if (t.views >= 30 && t.sold === 0) return { code: "not_bought", label: "Clicked, not bought", fix: `${t.views} views, no sale: buyers like it but something stops them. Check the price and shipping cost, add measurements, and show flaws clearly. Or send an offer to watchers.` };
  return { code: "healthy", label: "Healthy traffic", fix: "Traffic looks normal; patience or a small price nudge." };
}

const num = (s: string | undefined) => {
  const n = Number(String(s ?? "").replace(/[%,$\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

/** Import Seller Hub > Performance > Traffic > Download report (CSV). The file has title rows above the header. */
export function importTrafficCsv(db: Db, text: string) {
  const rows = parseCsv(text);
  const hi = rows.findIndex((r) => r.some((c) => /item id/i.test(c)) && r.some((c) => /impression/i.test(c)));
  if (hi < 0) throw new Error("That doesn't look like an eBay traffic report (no 'item ID' / 'impressions' columns). In Seller Hub: Performance, Traffic, Download report.");
  const h = rows[hi].map((c) => c.toLowerCase().trim());
  const col = (...res: RegExp[]) => {
    for (const re of res) {
      const i = h.findIndex((x) => re.test(x));
      if (i >= 0) return i;
    }
    return -1;
  };
  const c = {
    id: col(/ebay item id/, /item id/),
    impressions: col(/^total impressions/, /total impressions/, /impressions/),
    views: col(/^total page views/, /total page views/, /page views/),
    ctr: col(/click-through/, /click through/),
    sold: col(/quantity sold/, /^sold/),
    conversion: col(/conversion/),
  };
  const ins = db.prepare(
    "INSERT INTO listing_traffic (external_id, listing_id, impressions, views, ctr, sold, conversion, period_days, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'csv')",
  );
  let matched = 0;
  let total = 0;
  db.exec("BEGIN");
  try {
    for (const r of rows.slice(hi + 1)) {
      const ext = (r[c.id] ?? "").replace(/\D/g, "");
      if (!ext) continue;
      total++;
      const l = db.prepare("SELECT id FROM listings WHERE marketplace = 'ebay' AND external_id = ?").get(ext) as { id: number } | undefined;
      if (l) matched++;
      const views = c.views >= 0 ? num(r[c.views]) : 0;
      ins.run(ext, l?.id ?? null, c.impressions >= 0 ? num(r[c.impressions]) : 0, views, c.ctr >= 0 ? num(r[c.ctr]) : null, c.sold >= 0 ? num(r[c.sold]) : 0, c.conversion >= 0 ? num(r[c.conversion]) : null, null);
      if (l) db.prepare("UPDATE listings SET views = ? WHERE id = ?").run(views, l.id);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  logActivity(db, "import", `Imported eBay traffic for ${total} listings (${matched} matched to FlipDesk)`);
  return { total, matched };
}

/** Pull traffic from eBay's Analytics API (daily, when connected). */
export async function syncEbayTraffic(db: Db, days = 30) {
  if (!ebayIsLive(db)) return 0;
  const recs = await ebayTrafficReport(db, days);
  if (!recs) return 0;
  let n = 0;
  for (const r of recs) {
    if (!r.externalId) continue;
    const l = db.prepare("SELECT id FROM listings WHERE marketplace = 'ebay' AND external_id = ?").get(r.externalId) as { id: number } | undefined;
    db.prepare("INSERT INTO listing_traffic (external_id, listing_id, impressions, views, ctr, sold, conversion, period_days, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'api')").run(
      r.externalId, l?.id ?? null, r.impressions, r.views, r.ctr, r.sold, r.conversion, r.periodDays,
    );
    if (l) {
      db.prepare("UPDATE listings SET views = ? WHERE id = ?").run(r.views, l.id);
      n++;
    }
  }
  return n;
}
