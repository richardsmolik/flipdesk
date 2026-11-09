/**
 * What kinds of edits work in YOUR shop. Every change in item history (3+ days old, not undone) is sorted
 * into kinds ("added the brand to the title", "dropped the price 10%+", ...), and for each kind we count how
 * often views per day went up 20%+ or the item sold within 2 weeks. Then an item page can suggest the kinds
 * that have worked for you and still apply to that item.
 */
import type { Db, Item } from "../db.js";
import { getItem } from "../db.js";
import { ensureHistory, impact } from "./history.js";

export type Kind = "brand" | "size" | "longer" | "shorter" | "reworded" | "drop-small" | "drop-big" | "raise" | "description" | "details";
export const KIND_LABEL: Record<Kind, string> = {
  brand: "Added the brand to the title",
  size: "Added the size to the title",
  longer: "Made the title longer",
  shorter: "Made the title shorter",
  reworded: "Reworded the title",
  "drop-small": "Dropped the price under 10%",
  "drop-big": "Dropped the price 10% or more",
  raise: "Raised the price",
  description: "Rewrote the description",
  details: "Filled in details (brand, size, item specifics, tags)",
};
const MIN_CASES = 3;

const has = (title: string, word: string | null | undefined) => Boolean(word && word.trim().length > 1 && title.toLowerCase().includes(word.trim().toLowerCase()));

/** Which kinds one set of changes was. */
export function kindsOf(rows: { field: string; old: unknown; new: unknown }[], item: Pick<Item, "brand" | "size">): Kind[] {
  const out = new Set<Kind>();
  for (const r of rows) {
    if (r.field === "title" && typeof r.old === "string" && typeof r.new === "string") {
      const before = out.size;
      if (!has(r.old, item.brand) && has(r.new, item.brand)) out.add("brand");
      if (!has(r.old, item.size) && has(r.new, item.size)) out.add("size");
      if (r.new.length >= r.old.length + 10) out.add("longer");
      else if (r.new.length <= r.old.length - 10) out.add("shorter");
      if (out.size === before) out.add("reworded");
    } else if (r.field === "price" && typeof r.old === "number" && typeof r.new === "number" && r.old > 0) {
      const pct = ((r.new - r.old) / r.old) * 100;
      if (pct <= -10) out.add("drop-big");
      else if (pct < -0.5) out.add("drop-small");
      else if (pct > 0.5) out.add("raise");
    } else if (r.field === "description") out.add("description");
    else if (["specifics", "keywords", "brand", "size", "color", "condition"].includes(r.field)) out.add("details");
  }
  return [...out];
}

export interface Lesson { kind: Kind; label: string; cases: number; helped: number; helpedPct: number; avgViewsPct: number | null; soldWithin14: number; verdict: "helps" | "mixed" | "no help" }

export function editLessons(db: Db): { lessons: Lesson[]; cases: number; needed: number } {
  ensureHistory(db);
  const rows = db
    .prepare("SELECT batch, item_id, field, old_value, new_value, source, stats, at, id FROM item_changes WHERE undone_by IS NULL AND source NOT LIKE 'undo%' ORDER BY id")
    .all() as { batch: string; item_id: number; field: string; old_value: string; new_value: string; source: string; stats: string | null; at: string; id: number }[];
  const batches = new Map<string, typeof rows>();
  for (const r of rows) batches.set(r.batch, [...(batches.get(r.batch) ?? []), r]);
  const items = new Map<number, Item | undefined>();
  const soldAt = new Map<number, string | null>();
  const acc = new Map<Kind, { cases: number; helped: number; pcts: number[]; sold: number }>();
  let cases = 0;
  for (const rs of batches.values()) {
    const id = rs[0].item_id;
    if (!items.has(id)) {
      items.set(id, getItem(db, id));
      soldAt.set(id, (db.prepare("SELECT MIN(sold_at) AS s FROM sales WHERE item_id = ?").get(id) as { s: string | null }).s);
    }
    const item = items.get(id);
    if (!item) continue;
    const imp = impact(item, rs[0].stats, rs[0].at, soldAt.get(id) ?? null);
    if (!imp?.ready) continue;
    const kinds = kindsOf(rs.map((r) => ({ field: r.field, old: JSON.parse(r.old_value), new: JSON.parse(r.new_value) })), item);
    if (!kinds.length) continue;
    cases++;
    const sold = imp.soldDaysAfter !== null && imp.soldDaysAfter <= 14;
    const helped = sold || (imp.changePct ?? 0) >= 20;
    for (const k of kinds) {
      const a = acc.get(k) ?? { cases: 0, helped: 0, pcts: [], sold: 0 };
      a.cases++;
      if (helped) a.helped++;
      if (sold) a.sold++;
      if (imp.changePct !== null && !sold) a.pcts.push(Math.max(-100, Math.min(300, imp.changePct)));
      acc.set(k, a);
    }
  }
  const lessons: Lesson[] = [...acc.entries()]
    .filter(([, a]) => a.cases >= MIN_CASES)
    .map(([kind, a]) => {
      const helpedPct = Math.round((a.helped / a.cases) * 100);
      const avg = a.pcts.length ? Math.round(a.pcts.reduce((x, y) => x + y, 0) / a.pcts.length) : null;
      const verdict: Lesson["verdict"] = helpedPct >= 50 && (avg === null || avg > 0) ? "helps" : helpedPct < 25 && (avg === null || avg <= 5) ? "no help" : "mixed";
      return { kind, label: KIND_LABEL[kind], cases: a.cases, helped: a.helped, helpedPct, avgViewsPct: avg, soldWithin14: a.sold, verdict };
    })
    .sort((x, y) => y.helpedPct - x.helpedPct || y.cases - x.cases);
  return { lessons, cases, needed: MIN_CASES };
}

/** Kinds that have helped in this shop and still apply to this item, best first. */
export function editSuggestions(db: Db, itemId: number) {
  const item = getItem(db, itemId);
  if (!item) return [];
  const listedDays = Math.max(0, ...item.listings.filter((l) => l.status === "active" && l.listed_at).map((l) => (Date.now() - Date.parse(l.listed_at!.replace(" ", "T") + "Z")) / 86400_000));
  const applies: Record<Kind, { ok: boolean; how: string }> = {
    brand: { ok: Boolean(item.brand) && !has(item.title, item.brand), how: `Put “${item.brand}” in the title` },
    size: { ok: Boolean(item.size) && !has(item.title, item.size), how: `Put the size (${item.size}) in the title` },
    longer: { ok: item.title.length < 60, how: `Use more of the 80 characters (now ${item.title.length}): add model, material, style` },
    shorter: { ok: item.title.length > 70, how: "Trim filler words from the title" },
    reworded: { ok: true, how: "Try a fresh title (✨ Fresh title, or a title test)" },
    "drop-small": { ok: listedDays >= 14, how: "Drop the price a little (under 10%)" },
    "drop-big": { ok: listedDays >= 30, how: "Drop the price 10% or more" },
    raise: { ok: false, how: "" },
    description: { ok: (item.description ?? "").length < 200, how: "Write a fuller description (measurements, flaws, how it fits)" },
    details: { ok: Object.keys(item.specifics ?? {}).length < 5 || !item.brand, how: "Fill in more item details (brand, size, item specifics)" },
  };
  return editLessons(db)
    .lessons.filter((l) => l.verdict === "helps" && applies[l.kind].ok)
    .map((l) => ({ kind: l.kind, how: applies[l.kind].how, why: `${l.label}: helped ${l.helped} of ${l.cases} times in your shop${l.avgViewsPct !== null ? ` (views ${l.avgViewsPct > 0 ? "+" : ""}${l.avgViewsPct}% on average)` : ""}${l.soldWithin14 ? `, ${l.soldWithin14} sold within 2 weeks` : ""}.` }))
    .slice(0, 3);
}
