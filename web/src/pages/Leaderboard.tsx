import { useEffect, useState } from "react";
import { api } from "../api";
import { toast } from "../ui";

interface Row { name: string; me: boolean; goalsPct: number | null; goalsHit: number; goalsSet: number; roiPct: number | null; listed: number; sold: number }
interface LB { available: boolean; optedIn?: boolean; name?: string | null; rows?: Row[] }

/** Friendly weekly leaderboard for people on the same FlipDesk. Opt-in; no dollar amounts are shared. */
export default function Leaderboard() {
  const [lb, setLb] = useState<LB | null>(null);
  const [name, setName] = useState("");
  useEffect(() => void api.get<LB>("/api/leaderboard").then((x) => (setLb(x), setName(x.name ?? ""))).catch(() => {}), []);
  if (!lb) return <div className="text-zinc-500">Loading…</div>;
  if (!lb.available) return <div className="card p-5 text-sm text-zinc-400">Leaderboards are for a FlipDesk you host for friends (accounts mode, see docs/DEPLOY.md).</div>;
  const save = async (n: string | null) => {
    try {
      const r = await api.post<LB>("/api/leaderboard", { name: n });
      setLb(r);
      toast(n ? "You're on the leaderboard" : "You've left the leaderboard");
    } catch (e) {
      toast((e as Error).message, "err");
    }
  };
  const medal = (i: number) => ["🥇", "🥈", "🥉"][i] ?? `${i + 1}`;
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">🏆 This week's leaderboard</h1>
        <p className="text-sm text-zinc-400">Ranked by how close you are to your weekly goals, then by return on cost. Only percentages and counts are shared, never dollars. Resets every Monday.</p>
      </div>
      <div className="card flex flex-wrap items-end gap-2 p-4">
        <label className="flex-1">
          <span className="label">{lb.optedIn ? "Your leaderboard name" : "Join with a nickname (2-24 characters)"}</span>
          <input className="input" maxLength={24} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. ThriftQueen" />
        </label>
        <button className="btn-primary" disabled={name.trim().length < 2} onClick={() => save(name.trim())}>{lb.optedIn ? "Save" : "Join"}</button>
        {lb.optedIn && <button className="btn-ghost" onClick={() => save(null)}>Leave</button>}
      </div>
      {!lb.rows?.length ? (
        <p className="text-sm text-zinc-500">Nobody has joined yet. Be the first, and set weekly goals on the dashboard so you show up with a score.</p>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm tabular-nums">
            <thead className="text-xs text-zinc-500">
              <tr><th className="p-3 text-left font-medium">#</th><th className="text-left font-medium">Seller</th><th className="text-right font-medium">Goals</th><th className="text-right font-medium">Return on cost</th><th className="text-right font-medium">Listed</th><th className="p-3 text-right font-medium">Sold</th></tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {lb.rows.map((r, i) => (
                <tr key={r.name + i} className={r.me ? "bg-blue-950/30" : ""}>
                  <td className="p-3">{medal(i)}</td>
                  <td className="font-medium text-zinc-100">{r.name}{r.me && <span className="ml-1 text-xs text-zinc-400">(you)</span>}</td>
                  <td className="text-right">{r.goalsPct === null ? <span className="text-zinc-500">no goals</span> : <>{r.goalsPct}% <span className="text-xs text-zinc-500">({r.goalsHit}/{r.goalsSet} hit)</span></>}</td>
                  <td className="text-right">{r.roiPct === null ? <span className="text-zinc-500">-</span> : `${r.roiPct}%`}</td>
                  <td className="text-right">{r.listed}</td>
                  <td className="p-3 text-right">{r.sold}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
