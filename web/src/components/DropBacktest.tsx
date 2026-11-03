import { useEffect, useState } from "react";
import { api } from "../api";

interface Result { rule: { key: string; name: string }; sold: number; unsold: number; avgDays: number | null; avgPrice: number | null; daysSaved: number | null; revenueChange: number; revenueChangePct: number | null }
interface Data { items: number; actual: { revenue: number; avgDays: number | null }; results: Result[]; takeaway: string | null }

/** Would automatic price drops have sold your items sooner, and for how much less? (no AI, free) */
export default function DropBacktest() {
  const [d, setD] = useState<Data | null>(null);
  useEffect(() => void api.get<Data>("/api/drop-backtest").then(setD).catch(() => setD(null)), []);
  if (!d) return null;
  return (
    <section className="card space-y-3 p-4">
      <div>
        <h2 className="font-semibold">📉 Would price drops have sold things sooner?</h2>
        <p className="text-sm text-zinc-400">Replays automatic price-drop rules on items you've already sold. Free: no AI involved.</p>
      </div>
      {d.items < 3 ? (
        <p className="text-sm text-zinc-500">Needs a few sold items first ({d.items} so far).</p>
      ) : (
        <>
          {d.takeaway && <p className="text-sm">{d.takeaway}</p>}
          <p className="text-xs text-zinc-400">What really happened: {d.items} items, {d.actual.avgDays} days to sell on average, ${d.actual.revenue.toFixed(2)} in total.</p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-zinc-500">
                <tr><th className="py-1 font-normal">Rule</th><th className="font-normal">Days to sell</th><th className="font-normal">Sooner by</th><th className="font-normal">Money</th><th className="font-normal">Wouldn't sell</th></tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {d.results.map((r) => (
                  <tr key={r.rule.key} className={r.rule.key === "none" ? "text-zinc-400" : ""}>
                    <td className="py-1">{r.rule.name}</td>
                    <td>{r.avgDays ?? "-"}</td>
                    <td>{r.daysSaved === null ? "-" : r.daysSaved >= 0 ? `${r.daysSaved} days` : `${-r.daysSaved} days later`}</td>
                    <td className={r.revenueChange < 0 ? "text-amber-300" : r.revenueChange > 0 ? "text-green-400" : ""}>{r.revenueChangePct === null ? "-" : `${r.revenueChange >= 0 ? "+" : ""}${r.revenueChangePct}% (${r.revenueChange < 0 ? "-" : ""}$${Math.abs(r.revenueChange).toFixed(2)})`}</td>
                    <td>{r.unsold || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-zinc-500">
            How it's worked out: each buyer pays what they really paid, and turns up as long after the price reaches that amount as they really did. Items that sold by offer sell the same day. "Wouldn't sell" means the rule's floor stayed above what the buyer paid. It's a model, not a promise; set your rule in Settings → Automatic price drops.
          </p>
        </>
      )}
    </section>
  );
}
