import { useEffect, useState } from "react";
import { api } from "../api";
import { timeAgo, toast } from "../ui";

interface Acct { id: number; email: string; owner: boolean; createdAt: string; lastLoginAt: string | null; items: number; sales30: number; aiToday: number; aiLimit: number | null; aiLimitCustom: number | null; onLeaderboard: boolean }
interface State { accounts: Acct[]; defaultAiLimit: number; inviteCode: boolean }

/** Owner only: who's using your FlipDesk, their AI use, reset links, limits. */
export default function Accounts() {
  const [s, setS] = useState<State | null>(null);
  const [err, setErr] = useState("");
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);
  const load = () => api.get<State>("/api/admin/accounts").then(setS, (e: Error) => setErr(e.message));
  useEffect(() => void load(), []);
  if (err) return <div className="card p-5 text-sm text-zinc-400">{err}</div>;
  if (!s) return <div className="text-zinc-500">Loading…</div>;
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">👥 Accounts</h1>
        <p className="text-sm text-zinc-400">
          {s.inviteCode ? "People can sign up with your invite code (FLIPDESK_INVITE_CODE)." : "Sign-ups are closed. Set FLIPDESK_INVITE_CODE to invite people."} Everyone except you gets {s.defaultAiLimit} AI requests a day (FLIPDESK_AI_DAILY_LIMIT); change it per person below.
        </p>
      </div>
      {link && (
        <div className="card space-y-2 border-amber-800 p-4 text-sm">
          <div>Reset link for <b>{link.email}</b> (works once, for 24 hours). Send it to them yourself:</div>
          <input className="input font-mono text-xs" readOnly value={link.url} onFocus={(e) => e.target.select()} />
          <div className="flex gap-2">
            <button className="btn-primary" onClick={() => (navigator.clipboard?.writeText(link.url), toast("Copied"))}>Copy</button>
            <button className="btn-ghost" onClick={() => setLink(null)}>Done</button>
          </div>
        </div>
      )}
      <div className="card overflow-x-auto">
        <table className="w-full text-sm tabular-nums">
          <thead className="text-xs text-zinc-500">
            <tr><th className="p-3 text-left font-medium">Account</th><th className="text-right font-medium">Items</th><th className="text-right font-medium">Sales (30d)</th><th className="text-right font-medium">AI today</th><th className="pl-6 text-left font-medium">Daily AI limit</th><th className="text-left font-medium">Last sign-in</th><th /></tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {s.accounts.map((a) => (
              <tr key={a.id}>
                <td className="p-3">
                  <div className="text-zinc-100">{a.email}</div>
                  <div className="text-xs text-zinc-500">{a.owner ? "Owner" : `Joined ${timeAgo(a.createdAt)}`}{a.onLeaderboard ? " · on leaderboard" : ""}</div>
                </td>
                <td className="text-right">{a.items}</td>
                <td className="text-right">{a.sales30}</td>
                <td className="text-right">{a.aiToday}</td>
                <td>
                  {a.owner ? (
                    <span className="pl-6 text-zinc-500">Unlimited</span>
                  ) : (
                    <select
                      className="input ml-6 w-32 py-1"
                      value={a.aiLimitCustom === null ? "" : String(a.aiLimitCustom)}
                      onChange={async (e) => setS({ ...s, accounts: (await api.put<{ accounts: Acct[] }>(`/api/admin/accounts/${a.id}`, { aiLimit: e.target.value === "" ? null : Number(e.target.value) })).accounts })}
                    >
                      <option value="">Default ({s.defaultAiLimit})</option>
                      {[0, 10, 25, 50, 100, 250, 1000].map((n) => <option key={n} value={n}>{n === 0 ? "No AI" : n}</option>)}
                    </select>
                  )}
                </td>
                <td className="text-zinc-400">{a.lastLoginAt ? timeAgo(a.lastLoginAt) : "never"}</td>
                <td className="whitespace-nowrap p-3 text-right">
                  <button className="btn-ghost px-2 py-1 text-xs" onClick={async () => setLink({ email: a.email, url: (await api.post<{ link: string }>(`/api/admin/accounts/${a.id}/reset-link`)).link })}>Reset link</button>
                  {!a.owner && (
                    <button
                      className="btn-ghost ml-1 px-2 py-1 text-xs text-red-300"
                      onClick={async () => {
                        if (!confirm(`Delete ${a.email} and everything in their shop? This can't be undone.`)) return;
                        setS({ ...s, accounts: (await api.del(`/api/admin/accounts/${a.id}`).then(() => api.get<State>("/api/admin/accounts"))).accounts });
                        toast("Account deleted");
                      }}
                    >
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
