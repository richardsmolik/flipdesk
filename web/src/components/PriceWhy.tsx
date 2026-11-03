import { useEffect, useState } from "react";
import { api } from "../api";
import { toast } from "../ui";

interface Why {
  at: string;
  provider: string | null;
  model: string | null;
  price: number;
  low: number;
  high: number;
  quickSale: number;
  confidence: string;
  reasoning: string;
  comps: { title: string; price: number; sold: boolean; source: string }[];
  correction: string | null;
  secondOpinion: { name: string; price: number; diffPct: number; agree: boolean } | null;
  preferredFor: string | null;
}
const NAMES: Record<string, string> = { claude: "Claude", openai: "ChatGPT", gemini: "Gemini", kimi: "Kimi", deepseek: "DeepSeek" };
const usd = (n: number) => `$${n.toFixed(2)}`;

/** "Why this price": which AI, its reasoning, the comps it saw, and any correction or second opinion. */
export function PriceWhy({ itemId, currentPrice }: { itemId: number; currentPrice: number | undefined }) {
  const [w, setW] = useState<Why | null>(null);
  useEffect(() => void api.get<Why | null>(`/api/items/${itemId}/price-why`).then(setW).catch(() => setW(null)), [itemId]);
  if (!w) return null;
  const changed = currentPrice !== undefined && Math.abs(currentPrice - w.price) >= 0.01;
  return (
    <details className="card p-4 text-sm">
      <summary className="cursor-pointer font-semibold">💡 Why this price{changed ? <span className="font-normal text-zinc-400"> (AI suggested {usd(w.price)}; you changed it)</span> : ""}</summary>
      <div className="mt-3 space-y-2">
        <p>
          <b>{w.provider ? NAMES[w.provider] ?? w.provider : "The AI"}</b> suggested <b>{usd(w.price)}</b> (likely range {usd(w.low)}–{usd(w.high)}, quick sale {usd(w.quickSale)}) with <b>{w.confidence}</b> confidence
          {w.preferredFor ? `, as the most accurate AI for ${w.preferredFor} on your past sales` : ""}.
        </p>
        {w.reasoning && <p className="text-zinc-300">“{w.reasoning}”</p>}
        {w.correction && <p>🎯 {w.correction}</p>}
        {w.secondOpinion && (
          <p className={w.secondOpinion.agree ? "text-green-300" : "text-amber-300"}>
            {w.secondOpinion.agree ? "✓" : "⚠️"} Second opinion: {w.secondOpinion.name} said {usd(w.secondOpinion.price)} ({w.secondOpinion.diffPct}% apart).
          </p>
        )}
        {w.comps.length ? (
          <div>
            <div className="text-xs text-zinc-400">Comparable listings it was shown:</div>
            <ul className="mt-1 space-y-0.5 text-xs">
              {w.comps.map((c, i) => (
                <li key={i} className="flex justify-between gap-2">
                  <span className="truncate">{c.sold ? "✅ sold" : "🏷️ asking"} · {c.title}</span>
                  <span className="shrink-0">{usd(c.price)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-xs text-zinc-500">No comparable listings were available, so the price comes from the AI's own knowledge (that's why confidence may be low). Importing sold comps (Sales → Import) helps.</p>
        )}
        <p className="text-xs text-zinc-500">Written {new Date(w.at).toLocaleDateString()}{w.model ? ` by ${w.model}` : ""}.</p>
      </div>
    </details>
  );
}

/** For listings 30+ days without a sale: the AI suggests a fresh title; you apply it or not. */
export function FreshTitle({ itemId, onApplied }: { itemId: number; onApplied: (title: string) => void }) {
  const [s, setS] = useState<{ title: string; why: string; provider: string } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-2 rounded-md border border-zinc-800 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>🕰️ Listed 30+ days without a sale. A fresh title can help buyers find it.</span>
        <button
          className="btn-ghost text-xs"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              setS(await api.post(`/api/items/${itemId}/fresh-title`));
            } catch (e) {
              toast((e as Error).message, "err");
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Thinking…" : s ? "Another idea" : "✨ Suggest a fresh title"}
        </button>
      </div>
      {s && (
        <div className="space-y-1">
          <div className="font-medium">{s.title}</div>
          <div className="text-xs text-zinc-400">{s.why} ({NAMES[s.provider] ?? s.provider})</div>
          <button
            className="btn-primary text-xs"
            onClick={async () => {
              const r = await api.post<{ ebay: "updated" | "failed" | null; ebayError: string | null; editElsewhere: string[] }>(`/api/items/${itemId}/fresh-title/apply`, { title: s.title, provider: s.provider });
              onApplied(s.title);
              setS(null);
              const parts = ["New title saved."];
              if (r.ebay === "updated") parts.push("Your eBay listing shows it now.");
              if (r.ebay === "failed") parts.push(`eBay didn't take it (${r.ebayError}).`);
              if (r.editElsewhere.length) parts.push(`Change it on ${r.editElsewhere.join(", ")} too (or relist there).`);
              toast(parts.join(" "), r.ebay === "failed" ? "err" : "ok");
            }}
          >
            Use this title
          </button>
        </div>
      )}
    </div>
  );
}
