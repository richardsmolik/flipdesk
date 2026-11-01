import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { timeAgo, toast, useFetch } from "../ui";
import EmailReview from "../components/EmailReview";

interface Alert {
  id: number;
  sale_id: number | null;
  at: string;
  kind: string;
  severity: "info" | "warning" | "critical";
  title: string;
  body: string;
  item_id: number | null;
  sku: string | null;
  item_title: string | null;
  data: { message?: string; marketplace?: string; buyer?: string | null };
  resolved_at: string | null;
}

const TONE = {
  critical: "border-red-800 bg-red-950/40",
  warning: "border-amber-800 bg-amber-950/30",
  info: "border-zinc-700 bg-zinc-900",
};

export default function Inbox() {
  const [all, setAll] = useState(false);
  const { data, reload } = useFetch<Alert[]>(`/api/alerts${all ? "?all=1" : ""}`);
  return (
    <div className="max-w-4xl space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Inbox</h1>
          <p className="text-sm text-zinc-400">Things that need you: oversells, sale emails to confirm, sync problems.</p>
        </div>
        <label className="flex items-center gap-2 text-sm text-zinc-400">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show resolved
        </label>
      </div>

      <EmailReview />

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-zinc-300">Alerts</h2>
        {data?.length === 0 && <div className="card p-6 text-center text-sm text-zinc-500">All clear. 🎉</div>}
        {data?.map((a) => (
          <div key={a.id} className={`rounded-xl border p-4 ${TONE[a.severity]} ${a.resolved_at ? "opacity-50" : ""}`}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-semibold">{a.severity === "critical" ? "🚨 " : "⚠️ "}{a.title}</div>
                <div className="mt-0.5 text-sm text-zinc-300">{a.body}</div>
                <div className="mt-1 text-xs text-zinc-500">
                  {timeAgo(a.at)}
                  {a.item_id && <> · <Link to={`/items/${a.item_id}`} className="hover:underline">{a.sku} {a.item_title}</Link></>}
                </div>
              </div>
              {!a.resolved_at && (
                <div className="flex shrink-0 flex-col gap-1">
                  {a.kind === "oversell" && a.sale_id && (
                    <button className="btn-ghost text-xs" title="Removes the second sale so your profit stays accurate" onClick={async () => { await api.post(`/api/sales/${a.sale_id}/cancel`, { restock: false, reason: "oversell cancelled" }); toast("Cancelled order removed from your sales"); reload(); }}>
                      Order cancelled, remove sale
                    </button>
                  )}
                  <button className="btn-ghost text-xs" onClick={async () => (await api.post(`/api/alerts/${a.id}/resolve`), reload())}>
                    ✓ Resolved
                  </button>
                </div>
              )}
            </div>
            {a.data.message && (
              <div className="mt-3">
                <div className="mb-1 flex items-center justify-between text-xs text-zinc-400">
                  <span>Message to the buyer{a.data.marketplace === "ebay" ? " (asks them to request the cancellation, so it doesn't count against your seller rating)" : ""}</span>
                  <button className="text-brand hover:underline" onClick={() => (navigator.clipboard.writeText(a.data.message!), toast("Message copied"))}>Copy</button>
                </div>
                <pre className="whitespace-pre-wrap rounded-md border border-zinc-800 bg-zinc-950 p-3 font-sans text-sm text-zinc-200">{a.data.message}</pre>
              </div>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}
