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
      <p className="text-xs text-zinc-500">Cancel any time from "Manage billing". Your data stays yours: Settings → Download all my data.</p>
    </div>
  );
}
