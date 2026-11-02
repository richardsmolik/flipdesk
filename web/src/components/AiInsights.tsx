import { useEffect, useState } from "react";
import { api } from "../api";
import { toast } from "../ui";

interface Cal { provider: string; bias: number; factor: number; n: number; at: string }
interface TitleGroup { key: string; name: string; listed: number; sold: number; sellThrough: number | null; medianDays: number | null; priceVsList: number | null }
interface Insights {
  correction: { on: boolean; calibrations: Cal[] };
  secondOpinion: { on: boolean; threshold: number };
  reportCard: { on: boolean; lastRunAt?: string; lastWinner?: string | null };
  titles: { rows: TitleGroup[]; verdict: string | null };
}
interface PerSale { days: number; aiCost: number; aiCalls: number; sales: number; perSale: number | null; profitPerSale: number | null; shareOfProfit: number | null; byTask: { task: string; calls: number; cost: number }[] }
const NAMES: Record<string, string> = { claude: "Claude", openai: "ChatGPT", gemini: "Gemini", kimi: "Kimi", deepseek: "DeepSeek" };
const TASKS: Record<string, string> = { listing: "Listing writer", photo: "Photo fixes", sourcing: "Store scanner", help: "Help answers", "help-article": "Help articles", "whats-new": "Announcements", backtest: "Backtests", "second-opinion": "Second opinions", test: "Connection tests" };

/** What FlipDesk learned about the AIs from your own results, and what AI costs per sale. */
export default function AiInsights() {
  const [d, setD] = useState<Insights | null>(null);
  const [cps, setCps] = useState<PerSale | null>(null);
  const [threshold, setThreshold] = useState("");
  useEffect(() => {
    void api.get<Insights>("/api/ai-insights").then((x) => (setD(x), setThreshold(String(x.secondOpinion.threshold)))).catch(() => setD(null));
    void api.get<PerSale>("/api/ai/per-sale").then(setCps).catch(() => setCps(null));
  }, []);
  if (!d) return null;
  const save = async (b: Record<string, unknown>) => {
    try {
      setD(await api.put<Insights>("/api/ai-insights/settings", b));
      toast("Saved");
    } catch (e) {
      toast((e as Error).message, "err");
    }
  };
  return (
    <section className="card space-y-4 p-4">
      <h2 className="font-semibold">🧠 What FlipDesk learned about the AIs</h2>

      {cps && (
        <div className="space-y-1">
          <div className="text-sm font-medium">💵 AI cost per sale (last {cps.days} days)</div>
          {cps.aiCalls === 0 ? (
            <p className="text-sm text-zinc-500">No AI use in this shop in the last {cps.days} days.</p>
          ) : (
            <p className="text-sm">
              ${cps.aiCost.toFixed(2)} on AI ({cps.aiCalls} requests) for {cps.sales} sale{cps.sales === 1 ? "" : "s"}
              {cps.perSale !== null ? <>: <b>${cps.perSale.toFixed(2)} per sale</b></> : ""}
              {cps.profitPerSale !== null ? ` vs $${cps.profitPerSale.toFixed(2)} profit per sale` : ""}
              {cps.shareOfProfit !== null ? ` (${cps.shareOfProfit}% of profit${cps.shareOfProfit < 2 ? ", easily paying for itself" : cps.shareOfProfit > 10 ? ": worth trimming, e.g. cheapest-first for text jobs" : ""})` : ""}.
            </p>
          )}
          {cps.byTask.length > 0 && <p className="text-xs text-zinc-500">{cps.byTask.map((t) => `${TASKS[t.task] ?? t.task} $${t.cost.toFixed(2)}`).join(" · ")}</p>}
        </div>
      )}

      <div className="space-y-1 border-t border-zinc-800 pt-3">
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={d.correction.on} onChange={(e) => void save({ correction: e.target.checked })} />
          <span>
            <span className="font-medium">Correct each AI's known lean</span>
            <span className="block text-xs text-zinc-500">If the backtest shows an AI prices your items too high or too low (10+ items, 5%+ lean), its suggestions are adjusted by that much, with a note on the item.</span>
          </span>
        </label>
        {d.correction.calibrations.length ? (
          <ul className="ml-6 text-xs text-zinc-400">
            {d.correction.calibrations.map((c) => (
              <li key={c.provider}>{NAMES[c.provider] ?? c.provider}: guessed {Math.abs(c.bias)}% {c.bias > 0 ? "too high" : "too low"} on {c.n} sales → prices × {c.factor}</li>
            ))}
          </ul>
        ) : (
          <p className="ml-6 text-xs text-zinc-500">Nothing to correct yet: run “Which AI prices best?” below on 10+ sales.</p>
        )}
      </div>

      <div className="space-y-1">
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={d.secondOpinion.on} onChange={(e) => void save({ secondOpinion: { on: e.target.checked, threshold: Number(threshold) || 100 } })} />
          <span>
            <span className="font-medium">Second opinion on pricier items</span>
            <span className="block text-xs text-zinc-500">When the AI prices something at or above the amount below, a second AI prices it too. If they're more than 25% apart, you see both, so you can check before listing. Needs two AIs set up.</span>
          </span>
        </label>
        <div className="ml-6 flex items-center gap-2 text-sm">
          $<input className="input w-24 py-1" inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
          <button className="btn-ghost px-2 py-1 text-xs" onClick={() => (Number(threshold) >= 0 ? void save({ secondOpinion: { on: d.secondOpinion.on, threshold: Number(threshold) } }) : toast("Use a number", "err"))}>Save</button>
        </div>
      </div>

      <div className="space-y-1">
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={d.reportCard.on} onChange={(e) => void save({ reportCard: e.target.checked })} />
          <span>
            <span className="font-medium">Monthly AI report card</span>
            <span className="block text-xs text-zinc-500">Once a month (after 10+ new sales, with 2+ AIs set up) FlipDesk re-runs the price test on your newest sales and tells you if the best AI changed. Costs about the same as running the test yourself; counts against AI limits.</span>
            {d.reportCard.lastRunAt && <span className="block text-xs text-zinc-400">Last: {new Date(d.reportCard.lastRunAt).toLocaleDateString()}{d.reportCard.lastWinner ? `, best was ${NAMES[d.reportCard.lastWinner] ?? d.reportCard.lastWinner}` : ""}</span>}
          </span>
        </label>
      </div>

      <div className="space-y-2 border-t border-zinc-800 pt-3">
        <div className="text-sm font-medium">✍️ AI titles vs your own (items listed in the last year)</div>
        {d.titles.rows.length ? (
          <>
            {d.titles.verdict && <p className="text-sm">{d.titles.verdict}</p>}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-zinc-500">
                  <tr><th className="py-1 font-normal">Titles by</th><th className="font-normal">Listed</th><th className="font-normal">Sold</th><th className="font-normal" title="Of items listed 30+ days ago">Sell-through</th><th className="font-normal">Days to sell</th><th className="font-normal">Sold at % of list</th></tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {d.titles.rows.map((r) => (
                    <tr key={r.key} className={r.key === "you" ? "text-zinc-300" : ""}>
                      <td className="py-1">{r.name}</td><td>{r.listed}</td><td>{r.sold}</td><td>{r.sellThrough === null ? "-" : `${r.sellThrough}%`}</td><td>{r.medianDays ?? "-"}</td><td>{r.priceVsList === null ? "-" : `${r.priceVsList}%`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-zinc-500">A title counts as the AI's if you kept it or nearly all its words. This shows how items did, not why: price, photos and the item itself matter too. Needs a few sales per group before it means much.</p>
          </>
        ) : (
          <p className="text-sm text-zinc-500">FlipDesk now remembers every title an AI writes. Once those items sell, this shows whether they sold faster than titles you wrote.</p>
        )}
      </div>
    </section>
  );
}
