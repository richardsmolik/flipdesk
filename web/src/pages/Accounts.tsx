import { useEffect, useState } from "react";
import { api } from "../api";
import { timeAgo, toast } from "../ui";
import { WeeklyBars } from "../components/WeeklyBars";

interface Acct {
  id: number; email: string; owner: boolean; createdAt: string; lastLoginAt: string | null; items: number; sales30: number; aiToday: number; aiLimit: number | null; aiLimitCustom: number | null; onLeaderboard: boolean;
  invitedBy: string | null;
  billing: { enabled: boolean; status: string; trialDaysLeft: number | null };
}
interface Invite { id: number; link: string; note: string; created_at: string; used_at: string | null; revoked_at: string | null; used_by_email: string | null }
interface Feedback { id: number; email: string | null; page: string; message: string; context: { browser?: string; errors?: string[]; screen?: string }; created_at: string; resolved_at: string | null }

interface Usage {
  weeks: { week: string; activeSellers: number; signups: number; aiCalls: number; aiCost: number }[];
  costPerCall: number;
  plans: Record<string, number>;
  members: number;
  conversion: { trialsEnded: number; converted: number; pct: number | null };
  mrr: number | null;
  referrals: number;
}

function UsagePanel() {
  const [u, setU] = useState<Usage | null>(null);
  useEffect(() => void api.get<Usage>("/api/admin/usage?weeks=12").then(setU).catch(() => {}), []);
  if (!u) return null;
  const last = u.weeks[u.weeks.length - 1];
  const Tile = ({ label, value, sub }: { label: string; value: string; sub?: string }) => (
    <div className="card p-3">
      <div className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="text-xl font-semibold text-zinc-100">{value}</div>
      {sub && <div className="text-xs text-zinc-500">{sub}</div>}
    </div>
  );
  return (
    <section className="space-y-3">
      <h2 className="font-semibold">📈 How FlipDesk is doing</h2>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Tile label="Members" value={String(u.members)} sub={`${last.activeSellers} active this week`} />
        <Tile label="Paying" value={String((u.plans.active ?? 0) + (u.plans.past_due ?? 0))} sub={`${u.plans.trial ?? 0} on trial · ${u.plans.free ?? 0} free`} />
        <Tile label="Trial → paid" value={u.conversion.pct === null ? "–" : `${u.conversion.pct}%`} sub={`${u.conversion.converted} of ${u.conversion.trialsEnded} finished trials`} />
        <Tile label="Monthly revenue" value={u.mrr === null ? "–" : `$${u.mrr.toLocaleString()}`} sub={u.mrr === null ? "set FLIPDESK_PRICE_MONTHLY" : "estimate"} />
        <Tile label="AI cost this week" value={`$${last.aiCost.toFixed(2)}`} sub={`${last.aiCalls} calls · ~$${u.costPerCall}/call`} />
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <WeeklyBars title="Active sellers per week" data={u.weeks.map((w) => ({ week: w.week, value: w.activeSellers }))} extra={(i) => `${u.weeks[i].signups} new`} />
        <WeeklyBars title="AI requests per week" data={u.weeks.map((w) => ({ week: w.week, value: w.aiCalls }))} extra={(i) => `~$${u.weeks[i].aiCost.toFixed(2)}`} />
      </div>
      <p className="text-xs text-zinc-500">AI cost is an estimate (FLIPDESK_AI_COST_PER_CALL); your Anthropic console has the exact bill. {u.referrals} referral reward{u.referrals === 1 ? "" : "s"} given.</p>
    </section>
  );
}

function OwnerReport() {
  const [r, setR] = useState<{ title: string; body: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => void api.get<{ title: string; body: string }>("/api/admin/owner-report").then(setR).catch(() => {}), []);
  if (!r) return null;
  return (
    <section className="card space-y-2 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">🗞️ Your weekly report</h2>
        <button
          className="btn-ghost px-2 py-1 text-xs"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const x = await api.post<{ pushed: boolean; emailed: boolean }>("/api/admin/owner-report");
            setBusy(false);
            toast(x.pushed || x.emailed ? `Sent${x.pushed ? " to your phone" : ""}${x.emailed ? (x.pushed ? " and email" : " by email") : ""}` : "Set an ntfy topic (Settings) or email (SMTP_*) to receive it", x.pushed || x.emailed ? "ok" : "err");
          }}
        >
          Send it now
        </button>
      </div>
      <p className="text-xs text-zinc-500">Arrives on your weekly-summary day and hour (Settings → Weekly summary), by phone push and email. This is what it says right now:</p>
      <pre className="whitespace-pre-wrap rounded bg-zinc-950 p-3 font-sans text-sm text-zinc-200">{r.title}{"\n\n"}{r.body}</pre>
    </section>
  );
}

interface Ann { id: number; title: string; body: string; link: string; created_at: string; ends_at: string | null; archived_at: string | null; seen: number; dismissed: number }

function Announcements() {
  const [list, setList] = useState<Ann[] | null>(null);
  const [f, setF] = useState({ title: "", body: "", link: "", days: "14" });
  useEffect(() => void api.get<Ann[]>("/api/admin/announcements").then(setList).catch(() => {}), []);
  if (!list) return null;
  const live = (a: Ann) => !a.archived_at && (!a.ends_at || Date.parse(a.ends_at.replace(" ", "T") + "Z") > Date.now());
  return (
    <section className="card space-y-3 p-4">
      <h2 className="font-semibold">📣 Announcements</h2>
      <p className="text-sm text-zinc-400">Shows once at the top of everyone's dashboard until they close it. Good for "New: …" and "Heads up: eBay is slow today".</p>
      <form
        className="grid gap-2 md:grid-cols-[1fr_1fr_8rem_auto]"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            setList(await api.post<Ann[]>("/api/admin/announcements", { title: f.title, body: f.body, link: f.link, days: f.days ? Number(f.days) : null }));
            setF({ title: "", body: "", link: "", days: "14" });
            toast("Posted");
          } catch (x) {
            toast((x as Error).message, "err");
          }
        }}
      >
        <input className="input" maxLength={120} placeholder="Title, e.g. New: bundles on your phone!" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        <input className="input" maxLength={300} placeholder="Link (optional): /bundles or https://…" value={f.link} onChange={(e) => setF({ ...f, link: e.target.value })} />
        <select className="input" value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })}>
          <option value="3">3 days</option><option value="7">1 week</option><option value="14">2 weeks</option><option value="30">1 month</option><option value="">Until removed</option>
        </select>
        <button className="btn-primary" disabled={f.title.trim().length < 3}>Post</button>
        <textarea className="input md:col-span-4" maxLength={1000} placeholder="More detail (optional)" value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />
      </form>
      {list.length > 0 && (
        <ul className="divide-y divide-zinc-800 text-sm">
          {list.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className={live(a) ? "" : "opacity-50"}>
                <b className="text-zinc-200">{a.title}</b> <span className="text-xs text-zinc-500">{timeAgo(a.created_at)} · seen by {a.seen} · closed by {a.dismissed}{live(a) ? "" : " · ended"}</span>
              </span>
              {live(a) && <button className="btn-ghost px-2 py-1 text-xs" onClick={async () => setList((await api.del(`/api/admin/announcements/${a.id}`).then(() => api.get<Ann[]>("/api/admin/announcements"))))}>Remove</button>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

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
      <UsagePanel />
      <OwnerReport />
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
      <Announcements />
      <Invites />
      <FeedbackInbox />
    </div>
  );
}
