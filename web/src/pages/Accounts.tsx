import { useEffect, useState } from "react";
import { api } from "../api";
import { timeAgo, toast } from "../ui";

interface Acct {
  id: number; email: string; owner: boolean; createdAt: string; lastLoginAt: string | null; items: number; sales30: number; aiToday: number; aiLimit: number | null; aiLimitCustom: number | null; onLeaderboard: boolean;
  invitedBy: string | null;
  billing: { enabled: boolean; status: string; trialDaysLeft: number | null };
}
interface Invite { id: number; link: string; note: string; created_at: string; used_at: string | null; revoked_at: string | null; used_by_email: string | null }
interface Feedback { id: number; email: string | null; page: string; message: string; context: { browser?: string; errors?: string[]; screen?: string }; created_at: string; resolved_at: string | null }

const PLAN: Record<string, string> = { owner: "Owner", free: "Free", trial: "Trial", active: "Paying", past_due: "Payment issue", expired: "Trial ended" };

function Invites() {
  const [list, setList] = useState<Invite[] | null>(null);
  const [note, setNote] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  useEffect(() => void api.get<{ invites: Invite[] }>("/api/admin/invites").then((r) => setList(r.invites)).catch(() => {}), []);
  if (!list) return null;
  return (
    <section className="card space-y-3 p-4">
      <h2 className="font-semibold">🎟️ Invite links</h2>
      <p className="text-sm text-zinc-400">One link per person. Each works once, so you know who joined from which link, and you can turn off a link that hasn't been used.</p>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await api.post<{ link: string; invites: Invite[] }>("/api/admin/invites", { note });
          setList(r.invites);
          setFresh(r.link);
          setNote("");
          navigator.clipboard?.writeText(r.link).then(() => toast("Invite link copied"), () => {});
        }}
      >
        <input className="input max-w-xs" maxLength={80} placeholder="Who is it for? (e.g. Sam from the flea market)" value={note} onChange={(e) => setNote(e.target.value)} />
        <button className="btn-primary">Make invite link</button>
      </form>
      {fresh && <input className="input font-mono text-xs" readOnly value={fresh} onFocus={(e) => e.target.select()} />}
      {list.length > 0 && (
        <ul className="divide-y divide-zinc-800 text-sm">
          {list.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>
                <span className="text-zinc-200">{i.note || "Invite"}</span>{" "}
                <span className="text-xs text-zinc-500">
                  {i.used_at ? `joined as ${i.used_by_email} ${timeAgo(i.used_at)}` : i.revoked_at ? "turned off" : `made ${timeAgo(i.created_at)}, not used yet`}
                </span>
              </span>
              {!i.used_at && !i.revoked_at && (
                <span className="flex gap-1">
                  <button className="btn-ghost px-2 py-1 text-xs" onClick={() => (navigator.clipboard?.writeText(i.link), toast("Copied"))}>Copy link</button>
                  <button className="btn-ghost px-2 py-1 text-xs text-red-300" onClick={async () => setList((await api.del(`/api/admin/invites/${i.id}`).then(() => api.get<{ invites: Invite[] }>("/api/admin/invites"))).invites)}>Turn off</button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function FeedbackInbox() {
  const [f, setF] = useState<Feedback[] | null>(null);
  const load = () => api.get<{ feedback: Feedback[] }>("/api/admin/feedback").then((r) => setF(r.feedback));
  useEffect(() => void load().catch(() => {}), []);
  if (!f) return null;
  return (
    <section className="card space-y-3 p-4">
      <h2 className="font-semibold">💬 Feedback <span className="text-sm font-normal text-zinc-400">{f.filter((x) => !x.resolved_at).length} open</span></h2>
      {!f.length && <p className="text-sm text-zinc-500">Nothing yet. People send it from "💬 Send feedback" in the sidebar; you also get a phone push.</p>}
      <ul className="space-y-2">
        {f.map((x) => (
          <li key={x.id} className={`rounded-md border p-3 text-sm ${x.resolved_at ? "border-zinc-800 opacity-60" : "border-zinc-700"}`}>
            <div className="flex flex-wrap justify-between gap-2 text-xs text-zinc-500">
              <span>{x.email ?? "someone"} · {timeAgo(x.created_at)} · on <code>{x.page || "?"}</code></span>
              <button
                className="text-brand hover:underline"
                onClick={async () => (await api.post(`/api/admin/feedback/${x.id}/resolve`, { resolved: !x.resolved_at }), load())}
              >
                {x.resolved_at ? "Reopen" : "Mark done"}
              </button>
            </div>
            <p className="mt-1 whitespace-pre-wrap text-zinc-200">{x.message}</p>
            {(x.context.errors?.length ?? 0) > 0 && <p className="mt-1 text-xs text-red-300">Errors: {x.context.errors!.join(" | ")}</p>}
            {x.context.browser && <p className="mt-1 truncate text-xs text-zinc-600" title={x.context.browser}>{x.context.screen} · {x.context.browser}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}
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
          {s.inviteCode ? "Anyone with your shared invite code (FLIPDESK_INVITE_CODE) can sign up, plus anyone you send an invite link below." : "Only people you send an invite link (below) can sign up."} Everyone except you gets {s.defaultAiLimit} AI requests a day (FLIPDESK_AI_DAILY_LIMIT); change it per person below.
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
            <tr><th className="p-3 text-left font-medium">Account</th><th className="text-right font-medium">Items</th><th className="text-right font-medium">Sales (30d)</th><th className="text-right font-medium">AI today</th><th className="pl-6 text-left font-medium">Daily AI limit</th><th className="text-left font-medium">Plan</th><th className="text-left font-medium">Last sign-in</th><th /></tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {s.accounts.map((a) => (
              <tr key={a.id}>
                <td className="p-3">
                  <div className="text-zinc-100">{a.email}</div>
                  <div className="text-xs text-zinc-500">{a.owner ? "Owner" : `Joined ${timeAgo(a.createdAt)}`}{a.invitedBy ? ` · invited by ${a.invitedBy}` : ""}{a.onLeaderboard ? " · on leaderboard" : ""}</div>
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
                <td>
                  {a.owner ? (
                    <span className="text-zinc-500">Owner</span>
                  ) : (
                    <label className="flex items-center gap-1.5 text-xs" title="Free forever (friends & family). Doesn't touch an active Stripe subscription.">
                      <input
                        type="checkbox"
                        checked={a.billing.status === "free" && a.billing.enabled}
                        disabled={!a.billing.enabled || a.billing.status === "active" || a.billing.status === "past_due"}
                        onChange={async (e) => setS({ ...s, accounts: (await api.put<{ accounts: Acct[] }>(`/api/admin/accounts/${a.id}`, { comp: e.target.checked })).accounts })}
                      />
                      {PLAN[a.billing.status] ?? a.billing.status}
                      {a.billing.status === "trial" && a.billing.trialDaysLeft !== null ? ` (${a.billing.trialDaysLeft}d)` : ""}
                    </label>
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
      <p className="text-xs text-zinc-500">Plan checkbox = free forever for that person (only when billing is on: STRIPE_SECRET_KEY + STRIPE_PRICE_ID).</p>
      <Invites />
      <FeedbackInbox />
    </div>
  );
}
