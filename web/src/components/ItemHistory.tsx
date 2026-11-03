import { useEffect, useState } from "react";
import { api } from "../api";
import { timeAgo, toast } from "../ui";

interface Impact { ready: boolean; early?: boolean; days: number; viewsPerDayBefore?: number | null; viewsPerDayAfter?: number | null; changePct?: number | null; watchersAdded?: number; soldDaysAfter?: number | null }
interface Event {
  kind: "edit" | "drop" | "listed" | "sold";
  at: string;
  batch?: string;
  source?: string;
  title: string;
  changes?: { field: string; old: string; new: string }[];
  pushes?: { marketplace: string; status: string; error: string | null }[];
  impact?: Impact | null;
  undoneBy?: string | null;
  canUndo?: boolean;
}
const ICON: Record<Event["kind"], string> = { edit: "✏️", drop: "📉", listed: "🟢", sold: "💰" };
const FIELD: Record<string, string> = { title: "Title", description: "Description", price: "Price", keywords: "Tags", specifics: "Details", condition: "Condition", brand: "Brand", size: "Size", color: "Color" };
const STATUS: Record<string, string> = { done: "✓", failed: "✕", pending: "⏳", claimed: "⏳" };
const short = (v: string) => (v.length > 70 ? `${v.slice(0, 70)}…` : v || "(empty)");

function ImpactLine({ i }: { i: Impact }) {
  if (!i.ready) return <div className="text-xs text-zinc-500">📊 Did it help? Check back in {Math.max(1, Math.ceil(3 - i.days))} day{Math.ceil(3 - i.days) === 1 ? "" : "s"}.</div>;
  if (i.soldDaysAfter !== null && i.soldDaysAfter !== undefined) return <div className="text-xs text-green-400">💰 Sold {i.soldDaysAfter} day{i.soldDaysAfter === 1 ? "" : "s"} after this change.</div>;
  return (
    <div className="text-xs text-zinc-400">
      📊 {i.viewsPerDayBefore !== null && i.viewsPerDayAfter !== null ? (
        <>
          Views {i.viewsPerDayBefore}/day before → {i.viewsPerDayAfter}/day after
          {i.changePct !== null && i.changePct !== undefined && <span className={i.changePct > 10 ? "text-green-400" : i.changePct < -10 ? "text-amber-300" : ""}> ({i.changePct > 0 ? "+" : ""}{i.changePct}%)</span>}
        </>
      ) : (
        "Not enough view data yet"
      )}
      {i.watchersAdded ? ` · +${i.watchersAdded} watcher${i.watchersAdded === 1 ? "" : "s"}` : ""}
      {i.early ? " · early (under a week)" : ""}
    </div>
  );
}

/** Timeline of everything that happened to an item, with undo for edits. */
export default function ItemHistory({ itemId, onChanged }: { itemId: number; onChanged: () => void }) {
  const [ev, setEv] = useState<Event[] | null>(null);
  const load = () => api.get<Event[]>(`/api/items/${itemId}/history`).then(setEv).catch(() => setEv(null));
  useEffect(() => void load(), [itemId]);
  if (!ev?.length) return null;
  return (
    <details className="card p-4 text-sm">
      <summary className="cursor-pointer font-semibold">🕘 History ({ev.length})</summary>
      <ol className="mt-3 space-y-3">
        {ev.map((e, i) => (
          <li key={i} className="flex gap-2">
            <span>{ICON[e.kind]}</span>
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className={e.undoneBy ? "text-zinc-500 line-through" : "font-medium"}>{e.title}</span>
                <span className="text-xs text-zinc-500">{timeAgo(e.at)}</span>
              </div>
              {e.changes?.map((c) => (
                <div key={c.field} className="text-xs">
                  <span className="text-zinc-400">{FIELD[c.field] ?? c.field}:</span> <span className="text-zinc-500 line-through">{short(c.old)}</span> → <span>{short(c.new)}</span>
                </div>
              ))}
              {!!e.pushes?.length && (
                <div className="text-xs text-zinc-400">
                  Sent to: {[...new Map(e.pushes.map((p) => [p.marketplace, p])).values()].map((p) => `${p.marketplace} ${STATUS[p.status] ?? p.status}${p.error ? ` (${p.error})` : ""}`).join(" · ")}
                </div>
              )}
              {e.impact && !e.undoneBy && <ImpactLine i={e.impact} />}
              {e.canUndo && (
                <button
                  className="btn-ghost px-2 py-0.5 text-xs"
                  onClick={async () => {
                    if (!confirm("Put the previous values back here and on every live listing?")) return;
                    try {
                      const r = await api.post<{ restored: string[]; skipped: string[] }>(`/api/items/${itemId}/history/${e.batch}/undo`);
                      toast(`Undone: ${r.restored.map((f) => FIELD[f] ?? f).join(", ")}${r.skipped.length ? `. Kept ${r.skipped.join(", ")} (changed again since)` : ""}. Sent to your live listings.`);
                      onChanged();
                      void load();
                    } catch (x) {
                      toast((x as Error).message, "err");
                    }
                  }}
                >
                  ↩️ Undo
                </button>
              )}
            </div>
          </li>
        ))}
      </ol>
      <p className="mt-3 text-xs text-zinc-500">“Did it help?” compares views per day on the live listings before and after each change. Other things change too (season, other sellers), so read it as a hint.</p>
    </details>
  );
}
