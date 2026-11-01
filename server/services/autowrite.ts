/**
 * "AI writes the listing while you shoot": after photos arrive (phone link / Shoot mode),
 * wait for a short pause, then generate the draft and fill ONLY empty fields.
 * Status + the AI notes (flaws, things to verify, price reasoning) are kept so both the
 * phone and the computer can show them.
 */
import fs from "node:fs";
import { getItem, getSetting, logActivity, setSetting, type Db } from "../db.js";
import { generateListing, type ListingDraft } from "./ai.js";
import { researchPrice } from "./pricing.js";

export interface AiStatus {
  state: "idle" | "pending" | "writing" | "done" | "error";
  at: string;
  error?: string;
  demo?: boolean;
}

const timers = new Map<number, NodeJS.Timeout>();
export const AUTO_DELAY_MS = 6000;

export function aiStatus(db: Db, itemId: number): AiStatus & { draft: ListingDraft | null } {
  return {
    ...getSetting<AiStatus>(db, `aiStatus.${itemId}`, { state: "idle", at: "" }),
    draft: getSetting<ListingDraft | null>(db, `aiDraft.${itemId}`, null),
  };
}

function setStatus(db: Db, itemId: number, s: Omit<AiStatus, "at">) {
  setSetting(db, `aiStatus.${itemId}`, { ...s, at: new Date().toISOString() });
}

/** Debounced: every new upload restarts the countdown. */
export function scheduleAutoWrite(db: Db, itemId: number, delayMs = AUTO_DELAY_MS) {
  const item = getItem(db, itemId);
  if (!item || item.title.trim()) return false; // only for untitled drafts
  clearTimeout(timers.get(itemId));
  setStatus(db, itemId, { state: "pending" });
  timers.set(
    itemId,
    setTimeout(() => {
      timers.delete(itemId);
      void runAutoWrite(db, itemId);
    }, delayMs).unref(),
  );
  return true;
}

export async function runAutoWrite(db: Db, itemId: number) {
  const item = getItem(db, itemId);
  if (!item) return;
  const paths = (db.prepare("SELECT path FROM photos WHERE item_id = ? ORDER BY position, id LIMIT 8").all(itemId) as { path: string }[])
    .map((p) => p.path)
    .filter((p) => !p.startsWith("http") && /\.(jpe?g|png|webp)$/i.test(p) && fs.existsSync(p));
  if (!paths.length && !item.notes) return setStatus(db, itemId, { state: "idle" });
  setStatus(db, itemId, { state: "writing" });
  try {
    const comps = item.notes ? (await researchPrice(db, item.notes)).comps.filter((c) => c.source !== "demo") : [];
    const { draft, demo } = await generateListing({ photoPaths: paths, hint: item.notes || undefined, cost: item.cost || undefined, comps: comps.length ? comps : undefined });
    const fresh = getItem(db, itemId)!; // re-read: you may have typed while the AI worked
    const specifics = { ...Object.fromEntries(draft.item_specifics.map((s) => [s.name, s.value])), ...fresh.specifics };
    const upd: Record<string, unknown> = {
      title: fresh.title || draft.title,
      description: fresh.description || draft.description,
      brand: fresh.brand || draft.brand,
      category: fresh.category || draft.category,
      color: fresh.color || draft.color,
      size: fresh.size || draft.size,
      condition: fresh.title ? fresh.condition : draft.condition,
      specifics: JSON.stringify(specifics),
      keywords: JSON.stringify(fresh.keywords.length ? fresh.keywords : draft.keywords),
      price: fresh.price || draft.price.recommended,
      min_price: fresh.min_price ?? Math.round(draft.price.quick_sale * 0.9 * 100) / 100,
    };
    db.prepare(
      `UPDATE items SET title = ?, description = ?, brand = ?, category = ?, color = ?, size = ?, condition = ?, specifics = ?, keywords = ?, price = ?, min_price = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(upd.title as string, upd.description as string, upd.brand as string, upd.category as string, upd.color as string, upd.size as string, upd.condition as string, upd.specifics as string, upd.keywords as string, upd.price as number, upd.min_price as number, itemId);
    setSetting(db, `aiDraft.${itemId}`, draft);
    setStatus(db, itemId, { state: "done", demo });
    logActivity(db, "ai", `AI drafted "${upd.title}" from ${paths.length} photo(s)${demo ? " (demo)" : ""}`, itemId);
  } catch (e) {
    setStatus(db, itemId, { state: "error", error: (e as Error).message });
  }
}
