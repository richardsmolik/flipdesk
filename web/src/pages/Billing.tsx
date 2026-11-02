import { useEffect, useState } from "react";
import { api } from "../api";
import { toast } from "../ui";
import type { BillingInfo } from "../components/Account";

const LABEL: Record<BillingInfo["status"], string> = {
  owner: "Owner (no plan needed)",
  free: "Free",
  trial: "Free trial",
  active: "Subscribed",
  past_due: "Payment problem",
  expired: "Trial ended",
};

interface MyInvites { enabled: boolean; reward?: string | null; invites?: { id: number; note: string; link: string; used: boolean; usedBy: string | null; created_at: string }[]; rewards?: { kind: string; detail: string; created_at: string; email: string }[] }

/** Invite a friend: your own one-use links, and the free months you've earned. */
function InviteFriends() {
  const [d, setD] = useState<MyInvites | null>(null);
  const [note, setNote] = useState("");
  const load = () => api.get<MyInvites>("/api/invites").then(setD).catch(() => {});
  useEffect(() => void load(), []);
  if (!d?.enabled) return null;
  return (
    <div className="card space-y-3 p-5">
      <h2 className="font-semibold">🎁 Invite a friend{d.reward ? `, get ${d.reward}` : ""}</h2>
      <p className="text-sm text-zinc-400">Each link works for one person. {d.reward ? "When they start paying, your free month is added automatically (as credit on your next bill, or extra trial days)." : ""}</p>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const r = await api.post<{ link: string }>("/api/invites", { note });
            setNote("");
            navigator.clipboard?.writeText(r.link).then(() => toast("Link copied: send it to your friend"), () => toast("Link made"));
            void load();
          } catch (x) {
            toast((x as Error).message, "err");
          }
        }}
      >
        <input className="input max-w-xs" maxLength={80} placeholder="Friend's name (just for you)" value={note} onChange={(e) => setNote(e.target.value)} />
        <button className="btn-primary">Make my invite link</button>
      </form>
      {!!d.invites?.length && (
        <ul className="divide-y divide-zinc-800 text-sm">
          {d.invites.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>{i.note || "Invite"} <span className="text-xs text-zinc-500">{i.used ? `joined (${i.usedBy})` : "not used yet"}</span></span>
              {!i.used && <button className="btn-ghost px-2 py-1 text-xs" onClick={() => (navigator.clipboard?.writeText(i.link), toast("Copied"))}>Copy link</button>}
            </li>
          ))}
        </ul>
      )}
      {!!d.rewards?.length && (
        <div className="rounded-md border border-green-900 bg-green-950/30 p-3 text-sm text-green-200">
          {d.rewards.map((r) => <div key={r.created_at + r.email}>🎉 {r.email} subscribed: {r.detail || "thank you!"}</div>)}
        </div>
      )}
    </div>
  );
}

/** Your plan: trial days left, subscribe (Stripe Checkout), manage or cancel (Stripe portal). */
export default function Billing() {
  const [b, setB] = useState<BillingInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const done = new URLSearchParams(location.search).get("done");
  useEffect(() => void api.get<BillingInfo>("/api/billing").then(setB).catch(() => {}), []);
  if (!b) return <div className="text-zinc-500">Loading…</div>;
  const go = async (what: "checkout" | "portal") => {
    setBusy(true);
    try {
      location.href = (await api.post<{ url: string }>(`/api/billing/${what}`)).url;
    } catch (e) {
      toast((e as Error).message, "err");
      setBusy(false);
    }
  };
  return (
    <div className="max-w-2xl space-y-5">
      <h1 className="text-2xl font-semibold">💳 Your plan</h1>
      {done && <div className="rounded-md border border-green-900 bg-green-950/40 p-3 text-sm text-green-200">🎉 Thanks for subscribing! It can take a few seconds to show here.</div>}
      <div className="card space-y-3 p-5">
        <div className="flex items-baseline justify-between">
          <div className="text-lg font-semibold">{LABEL[b.status]}</div>
          {b.price && <div className="text-zinc-400">{b.price}</div>}
        </div>
        {!b.enabled && <p className="text-sm text-zinc-400">This FlipDesk doesn't charge. Enjoy!</p>}
        {b.offer && (
          <div className="rounded-md border border-green-900 bg-green-950/40 p-3 text-sm text-green-200">
            🎁 <b>{b.offer.pct}% off your first month</b>, applied automatically when you subscribe before {new Date(b.offer.endsAt).toLocaleDateString(undefined, { month: "long", day: "numeric" })}.
          </div>
        )}
        {b.enabled && b.status === "trial" && (
          <p className="text-sm text-zinc-300">
            {b.trialDaysLeft === 0 ? "Your trial ends today." : `${b.trialDaysLeft} day${b.trialDaysLeft === 1 ? "" : "s"} left in your free trial.`} Subscribing now won't charge you until the trial is over.
          </p>
        )}
        {b.enabled && b.status === "expired" && <p className="text-sm text-zinc-300">Your shop is read-only: you can look at everything and download your data, but not list, edit or sync new things. Sales still delist everywhere automatically, so nothing oversells.</p>}
        {b.status === "active" && b.renewsAt && <p className="text-sm text-zinc-300">Renews {new Date(b.renewsAt.replace(" ", "T") + "Z").toLocaleDateString()}.</p>}
        {b.status === "past_due" && <p className="text-sm text-amber-300">Your last payment didn't go through. Update your card so nothing stops.</p>}
        <ul className="space-y-1 text-sm text-zinc-400">
          <li>✨ AI requests per day: <b className="text-zinc-200">{b.aiLimit === null ? "unlimited" : b.aiLimit}</b>{b.enabled && b.status !== "active" && b.paidAiLimit ? ` (${b.paidAiLimit} with a plan)` : ""}</li>
          <li>🔒 Cards are handled by Stripe. FlipDesk never sees your card number.</li>
        </ul>
        {b.enabled && (
          <div className="flex flex-wrap gap-2 pt-1">
            {b.status !== "active" && b.status !== "past_due" && b.status !== "owner" && b.status !== "free" && (
              <button className="btn-primary" disabled={busy} onClick={() => go("checkout")}>{busy ? "Opening Stripe…" : "Subscribe"}</button>
            )}
            {b.hasCustomer && <button className="btn-ghost" disabled={busy} onClick={() => go("portal")}>Manage billing / cancel</button>}
          </div>
        )}
      </div>
      <InviteFriends />
      <p className="text-xs text-zinc-500">Cancel any time from "Manage billing". Your data stays yours: Settings → Download all my data.</p>
    </div>
  );
}
