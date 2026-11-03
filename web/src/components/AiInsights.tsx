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
  byCategory: { on: boolean; winners: Record<string, string> };
  rewrites: { rewritten: number; soldSince: number; medianDaysAfter: number | null; soldWithin30Pct: number | null; otherStaleSoldPct: number | null };
}
interface Stale { id: number; title: string; price: number; days: number; rewritten_at: string | null }
interface PerSale { days: number; aiCost: number; aiCalls: number; sales: number; perSale: number | null; profitPerSale: number | null; shareOfProfit: number | null; byTask: { task: string; calls: number; cost: number }[] }
const NAMES: Record<string, string> = { claude: "Claude", openai: "ChatGPT", gemini: "Gemini", kimi: "Kimi", deepseek: "DeepSeek" };
const TASKS: Record<string, string> = { listing: "Listing writer", photo: "Photo fixes", sourcing: "Store scanner", help: "Help answers", "help-article": "Help articles", "whats-new": "Announcements", backtest: "Backtests", "second-opinion": "Second opinions", test: "Connection tests" };

/** What FlipDesk learned about the AIs from your own results, and what AI costs per sale. */
export default function AiInsights() {
  const [d, setD] = useState<Insights | null>(null);
  const [cps, setCps] = useState<PerSale | null>(null);
  const [threshold, setThreshold] = useState("");
  const [stale, setStale] = useState<Stale[] | null>(null);
  useEffect(() => {
    void api.get<Insights>("/api/ai-insights").then((x) => (setD(x), setThreshold(String(x.secondOpinion.threshold)))).catch(() => setD(null));
    void api.get<PerSale>("/api/ai/per-sale").then(setCps).catch(() => setCps(null));
    void api.get<{ items: Stale[] }>("/api/titles/stale").then((x) => setStale(x.items)).catch(() => setStale(null));
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
      <div className="space-y-1 border-t border-zinc-800 pt-3">
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={d.byCategory.on} onChange={(e) => void save({ byCategory: e.target.checked })} />
          <span>
            <span className="font-medium">Send each category to its best AI</span>
            <span className="block text-xs text-zinc-500">Uses the per-category winners from your latest price test (5+ items in a category). When an item already has a category (rewrites, fresh titles, auto-write after you set it), that AI goes first; the others still back it up.</span>
          </span>
        </label>
        {Object.keys(d.byCategory.winners).length ? (
          <p className="ml-6 text-xs text-zinc-400">{Object.entries(d.byCategory.winners).map(([c, p]) => `${c[0].toUpperCase()}${c.slice(1)}: ${NAMES[p] ?? p}`).join(" · ")}</p>
        ) : (
          <p className="ml-6 text-xs text-zinc-500">No per-category winners yet: run the price test with 2+ AIs on enough sales.</p>
        )}
      </div>

      <div className="space-y-2 border-t border-zinc-800 pt-3">
        <div className="text-sm font-medium">🕰️ Fresh titles for listings that haven't sold in 30+ days</div>
        {d.rewrites.rewritten > 0 && (
          <p className="text-sm">
            {d.rewrites.rewritten} title{d.rewrites.rewritten === 1 ? "" : "s"} refreshed, {d.rewrites.soldSince} sold since{d.rewrites.medianDaysAfter !== null ? ` (typically ${d.rewrites.medianDaysAfter} days after)` : ""}.
            {d.rewrites.soldWithin30Pct !== null && d.rewrites.otherStaleSoldPct !== null && ` ${d.rewrites.soldWithin30Pct}% sold within a month, vs ${d.rewrites.otherStaleSoldPct}% of other old listings.`}
          </p>
        )}
        {stale === null ? null : stale.length ? (
          <ul className="space-y-1 text-sm">
            {stale.slice(0, 8).map((x) => (
              <li key={x.id} className="flex items-center justify-between gap-2">
                <a className="min-w-0 truncate text-brand hover:underline" href={`/items/${x.id}`}>{x.title}</a>
                <span className="shrink-0 text-xs text-zinc-500">{x.days} days{x.rewritten_at ? " · refreshed" : ""}</span>
              </li>
            ))}
            {stale.length > 8 && <li className="text-xs text-zinc-500">…and {stale.length - 8} more</li>}
          </ul>
        ) : (
          <p className="text-sm text-zinc-500">Nothing's been sitting 30+ days. 👍</p>
        )}
        <p className="text-xs text-zinc-500">Open one and press ✨ Suggest a fresh title. Live eBay listings update right away; other sites need the title changed there.</p>
      </div>
    </section>
  );
}
