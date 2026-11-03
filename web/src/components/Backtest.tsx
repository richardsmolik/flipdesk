import { useEffect, useState } from "react";
import { api } from "../api";
import { toast } from "../ui";
import { useAccount } from "./Account";

interface Score { predictor: string; name: string; n: number; medianAbsPct: number | null; mae: number | null; within20: number | null; bias: number | null; daysMedianErr: number | null; cost: number }
interface Case { saleId: number; title: string; listedAt: string; soldAt: string; actual: number; actualDays: number; yourPrice: number | null; compMedian: number | null }
interface Row { saleId: number; predictor: string; price: number | null; days: number | null; error?: string }
interface CatWin { category: string; n: number; winner: string | null; scores: { predictor: string; medianAbsPct: number | null; n: number }[] }
interface Run { byCategory?: CatWin[]; id: string; at: string; status: "running" | "done" | "failed"; done: number; total: number; providers: string[]; photos: boolean; scores: Score[]; winner: string | null; cost: number; error?: string; cases: Case[] | number; rows: Row[] | number }
interface State { runs: Run[]; sold: number; providers: { id: string; name: string }[] }
const pct = (x: number | null) => (x === null ? "-" : `${x}%`);
const usd = (x: number | null) => (x === null ? "-" : `$${x.toFixed(2)}`);
const short = (n: string) => n.split(" (")[0];

/** "Which AI prices best?" Each AI prices items you already sold, knowing only what you knew at listing time. */
export default function Backtest() {
  const acct = useAccount();
  const [s, setS] = useState<State | null>(null);
  const [pick, setPick] = useState<string[]>([]);
  const [n, setN] = useState(20);
  const [photos, setPhotos] = useState(false);
  const [est, setEst] = useState<{ cases: number; total: number; requests: number } | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [open, setOpen] = useState(false);
  const load = () =>
    api.get<State>("/api/backtest").then((x) => {
      setS(x);
      setPick((p) => (p.length ? p : x.providers.map((y) => y.id)));
      const last = x.runs[0];
      if (last) void api.get<Run>(`/api/backtest/${last.id}`).then(setRun);
    });
  useEffect(() => void load().catch(() => setS(null)), []);
  useEffect(() => {
    if (!pick.length) return setEst(null);
    void api.get<{ cases: number; total: number; requests: number }>(`/api/backtest/estimate?n=${n}&providers=${pick.join(",")}&photos=${photos ? 1 : 0}`).then(setEst).catch(() => setEst(null));
  }, [pick, n, photos]);
  // Follow a running test.
  useEffect(() => {
    if (run?.status !== "running") return;
    const t = setInterval(() => void api.get<Run>(`/api/backtest/${run.id}`).then((r) => (setRun(r), r.status !== "running" && void load())), 1500);
    return () => clearInterval(t);
  }, [run?.id, run?.status]);
  if (!s) return null;
  const cases = Array.isArray(run?.cases) ? run!.cases : [];
  const rows = Array.isArray(run?.rows) ? run!.rows : [];
  const winner = run?.scores.find((x) => x.predictor === run.winner);
  const you = run?.scores.find((x) => x.predictor === "you");

  return (
    <section className="card space-y-3 p-4">
      <div>
        <h2 className="font-semibold">🔬 Which AI prices best? (tested on your past sales)</h2>
        <p className="text-sm text-zinc-400">
          Each AI prices items you already sold, using only what was known the day you listed them: the item, and comps that had sold before that day. Then FlipDesk compares each guess with what the item actually sold for, next to your own list price and a plain comp average.
        </p>
      </div>
      {!s.providers.length ? (
        <p className="text-sm text-amber-300">Add an AI key in Settings → AI first.</p>
      ) : s.sold < 3 ? (
        <p className="text-sm text-zinc-400">You need at least 3 sold items. Import your sold history (Sales → Import) to test on more.</p>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-3 text-sm">
            {s.providers.map((p) => (
              <label key={p.id} className="flex items-center gap-1">
                <input type="checkbox" checked={pick.includes(p.id)} onChange={(e) => setPick(e.target.checked ? [...pick, p.id] : pick.filter((x) => x !== p.id))} /> {short(p.name)}
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <label className="flex items-center gap-2">
              Items
              <select className="input w-20 py-1" value={n} onChange={(e) => setN(Number(e.target.value))}>
                {[10, 20, 50, 100].map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={photos} onChange={(e) => setPhotos(e.target.checked)} /> Include photos (more accurate, costs more)</label>
          </div>
          {est && <p className="text-xs text-zinc-500">{est.cases} of your {s.sold} sold items · {est.requests} AI requests · about ${est.total.toFixed(2)}{acct?.user && !acct.user.owner ? " (counts against your AI allowance)" : ""}</p>}
          <button
            className="btn-primary"
            disabled={!pick.length || run?.status === "running"}
            onClick={async () => {
              try {
                const r = await api.post<{ id: string }>("/api/backtest", { n, providers: pick, photos });
                setRun({ id: r.id, at: new Date().toISOString(), status: "running", done: 0, total: (est?.cases ?? n) * pick.length, providers: pick, photos, scores: [], winner: null, cost: 0, cases: [], rows: [] });
              } catch (e) {
                toast((e as Error).message, "err");
              }
            }}
          >
            {run?.status === "running" ? `Testing… ${run.done} of ${run.total}` : "Run the test"}
          </button>
        </div>
      )}

      {run && run.status !== "running" && (
        <div className="space-y-2 border-t border-zinc-800 pt-3">
          {run.status === "failed" ? (
            <p className="text-sm text-red-400">✕ The test didn't work: {run.error}</p>
          ) : (
            <p className="text-sm">
              {winner ? (
                you?.medianAbsPct != null && winner.medianAbsPct! >= you.medianAbsPct ? (
                  <>
                    🧑 <b>Your own list prices were closer</b> ({you.medianAbsPct}% off) than {run.providers.length > 1 ? `the best AI, ${short(winner.name)}` : short(winner.name)} ({winner.medianAbsPct}% off). Keep pricing yourself and use AI prices as a second opinion.
                  </>
                ) : (
                  <>
                    🏆 <b>{short(winner.name)}</b> {run.providers.length > 1 ? "was closest" : "did well"}: typically {winner.medianAbsPct}% off the real price{you?.medianAbsPct != null ? `, vs ${you.medianAbsPct}% for your own list prices` : ""}.
                  </>
                )
              ) : (
                "Not enough answers to pick a winner (each AI needs 5+). Try more items."
              )}{" "}
              <span className="text-xs text-zinc-500">{new Date(run.at).toLocaleDateString()} · {cases.length} items{run.photos ? " with photos" : ""} · cost ${run.cost.toFixed(2)}</span>
            </p>
          )}
          {run.scores.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-zinc-500">
                  <tr>
                    <th className="py-1 font-normal">Who</th>
                    <th className="font-normal" title="Half the guesses were closer than this">Typical miss</th>
                    <th className="font-normal">Within 20%</th>
                    <th className="font-normal" title="+ means it guessed too high on average">Leans</th>
                    <th className="font-normal">Avg miss</th>
                    <th className="font-normal">Days-to-sell miss</th>
                    <th className="font-normal">Answers</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {[...run.scores].sort((a, b) => (a.medianAbsPct ?? 1e9) - (b.medianAbsPct ?? 1e9)).map((x) => (
                    <tr key={x.predictor} className={x.predictor === run.winner ? "text-green-300" : ["you", "comps"].includes(x.predictor) ? "text-zinc-400" : ""}>
                      <td className="py-1">{x.predictor === run.winner ? "🏆 " : ""}{short(x.name)}</td>
                      <td>{pct(x.medianAbsPct)}</td>
                      <td>{pct(x.within20)}</td>
                      <td>{x.bias === null ? "-" : `${x.bias > 0 ? "+" : ""}${x.bias}% ${x.bias > 3 ? "high" : x.bias < -3 ? "low" : ""}`}</td>
                      <td>{usd(x.mae)}</td>
                      <td>{x.daysMedianErr === null ? "-" : `${x.daysMedianErr} days`}</td>
                      <td>{x.n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {run.providers.length > 1 && !!run.byCategory?.length && (
            <div className="text-sm">
              <div className="text-xs text-zinc-400">Best AI by category (5+ items each):</div>
              <ul className="mt-1 space-y-0.5 text-xs">
                {run.byCategory.map((c) => (
                  <li key={c.category}>
                    <b>{c.category}</b> ({c.n}): {c.winner ? `${short(run.scores.find((x) => x.predictor === c.winner)?.name ?? c.winner)} best` : "no clear winner"}{" "}
                    <span className="text-zinc-500">
                      {c.scores.filter((x) => run.providers.includes(x.predictor) && x.medianAbsPct !== null).map((x) => `${short(run.scores.find((y) => y.predictor === x.predictor)?.name ?? x.predictor)} ${x.medianAbsPct}%`).join(" · ")}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-zinc-500">Turn on “Send each category to its best AI” in the 🧠 card above to use these.</p>
            </div>
          )}
          {winner && acct?.canEditSite && run.providers.length > 1 && (
            <button
              className="btn-ghost text-xs"
              onClick={async () => {
                try {
                  const cur = await api.get<{ routing: { order: string[] }; providers: { id: string; ready: boolean }[] }>("/api/ai");
                  const base = cur.routing.order.length ? cur.routing.order : cur.providers.filter((p) => p.ready).map((p) => p.id);
                  await api.put("/api/ai/routing", { order: [run.winner, ...base.filter((x) => x !== run.winner)] });
                  toast(`${short(winner.name)} now goes first (Settings → AI)`);
                } catch (e) {
                  toast((e as Error).message, "err");
                }
              }}
            >
              Use {short(winner.name)} first for listings
            </button>
          )}
          {cases.length > 0 && (
            <details open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)} className="text-sm">
              <summary className="cursor-pointer text-zinc-300">Item by item</summary>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-left text-zinc-500">
                    <tr>
                      <th className="py-1 font-normal">Item</th>
                      <th className="font-normal">Sold for</th>
                      <th className="font-normal">You listed</th>
                      {run.providers.map((p) => <th key={p} className="font-normal">{short(run.scores.find((x) => x.predictor === p)?.name ?? p)}</th>)}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800">
                    {cases.map((c) => (
                      <tr key={c.saleId}>
                        <td className="max-w-[16rem] truncate py-1" title={c.title}>{c.title}<span className="block text-zinc-500">{c.actualDays} days to sell</span></td>
                        <td className="font-medium">${c.actual.toFixed(2)}</td>
                        <td className="text-zinc-400">{usd(c.yourPrice)}</td>
                        {run.providers.map((p) => {
                          const r = rows.find((x) => x.saleId === c.saleId && x.predictor === p);
                          const off = r?.price ? Math.round(((r.price - c.actual) / c.actual) * 100) : null;
                          return (
                            <td key={p} title={r?.error}>
                              {r?.price ? `$${r.price.toFixed(2)}` : r?.error ? "✕" : "-"}
                              {off !== null && <span className={`block ${Math.abs(off) <= 20 ? "text-green-400" : "text-amber-300"}`}>{off > 0 ? "+" : ""}{off}%{r?.days !== null && r?.days !== undefined ? ` · ${r.days}d` : ""}</span>}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
          <p className="text-xs text-zinc-500">
            Fair-test rules: no AI sees the sale or anything after the listing day; comps after that day are left out. AIs still know general prices from their training, and items edited after they sold show their final title. Treat a handful of items as a hint; 50+ items as evidence.
          </p>
        </div>
      )}
    </section>
  );
}
