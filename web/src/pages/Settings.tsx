import { useEffect, useState } from "react";
import { api } from "../api";
import { toast, useFetch, useMarketplaces } from "../ui";

interface S {
  notify: { ntfyTopic?: string; onSale?: boolean; onOversell?: boolean; onEmailReview?: boolean } | null;
  minutesPerItem: number | null;
  sourcing: { minProfit: number; minRoiPct: number } | null;
  feeOverrides: Record<string, { pct?: number; fixed?: number }> | null;
  defaultShippingCost: number | null;
  skuPrefix: string | null;
  autoDrop: { enabled: boolean; afterDays: number; everyDays: number; dropPct: number } | null;
  ebay: { fulfillmentPolicyId?: string; paymentPolicyId?: string; returnPolicyId?: string; merchantLocationKey?: string; bestOffer?: boolean } | null;
  descriptionFooter: string | null;
  extensionToken: string;
  status: { ai: boolean; ebayKeys: boolean; ebayLive: boolean };
}

function EmailTester() {
  const [from, setFrom] = useState("support@poshmark.com");
  const [subject, setSubject] = useState("Congratulations! You just made a sale");
  const [text, setText] = useState("");
  const [out, setOut] = useState<string | null>(null);
  return (
    <section className="card space-y-3 p-4">
      <h2 className="font-semibold">📬 Sale emails</h2>
      <p className="text-xs text-zinc-500">
        FlipDesk watches your inbox (IMAP settings in <code>.env</code>) or accepts forwarded emails at <code>POST /api/ext/email</code>. Paste an email below to see what it would do. Nothing gets recorded.
      </p>
      <div className="grid grid-cols-2 gap-2">
        <input className="input" value={from} onChange={(e) => setFrom(e.target.value)} placeholder="From" />
        <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" />
      </div>
      <textarea className="input min-h-24" placeholder="Paste the email body" value={text} onChange={(e) => setText(e.target.value)} />
      <button className="btn-ghost" onClick={async () => setOut(JSON.stringify(await api.post("/api/emails/test", { from, subject, text }), null, 2))}>Test</button>
      {out && <pre className="max-h-64 overflow-auto rounded bg-zinc-950 p-2 text-xs text-zinc-300">{out}</pre>}
    </section>
  );
}

export default function Settings() {
  const { data } = useFetch<S>("/api/settings");
  const { marketplaces } = useMarketplaces();
  const [s, setS] = useState<S | null>(null);
  const [policies, setPolicies] = useState<{ fulfillment: { id: string; name: string }[]; payment: { id: string; name: string }[]; returns: { id: string; name: string }[] } | null>(null);
  useEffect(() => void (data && setS(data)), [data]);
  if (!s) return <div className="text-zinc-500">Loading…</div>;
  const autoDrop = s.autoDrop ?? { enabled: false, afterDays: 21, everyDays: 7, dropPct: 5 };
  const ebay = s.ebay ?? {};
  const fees = s.feeOverrides ?? {};
  const sourcing = s.sourcing ?? { minProfit: 10, minRoiPct: 100 };
  const notifyS = s.notify ?? { onSale: true, onOversell: true, onEmailReview: true };
  const save = async () => {
    await api.put("/api/settings", { notify: notifyS, sourcing, minutesPerItem: s.minutesPerItem ?? 20, feeOverrides: s.feeOverrides ?? {}, defaultShippingCost: s.defaultShippingCost ?? 0, skuPrefix: s.skuPrefix || "FD", autoDrop, ebay, descriptionFooter: s.descriptionFooter ?? "" });
    toast("Settings saved");
  };

  return (
    <div className="max-w-3xl space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Settings</h1>
        <button className="btn-primary" onClick={save}>Save settings</button>
      </div>

      <section className="card space-y-3 p-4">
        <h2 className="font-semibold">Status</h2>
        <ul className="text-sm text-zinc-300">
          <li>{s.status.ai ? "✅" : "⚠️"} AI listing writer {s.status.ai ? "live (Claude)" : "in demo mode - set ANTHROPIC_API_KEY in .env"}</li>
          <li>{s.status.ebayLive ? "✅" : "⚠️"} eBay {s.status.ebayLive ? "connected" : s.status.ebayKeys ? "keys found - click Connect eBay on Marketplaces" : "in demo mode - add eBay keys to .env"}</li>
        </ul>
        <div>
          <label className="label">Chrome extension token</label>
          <input className="input font-mono" readOnly value={s.extensionToken} onFocus={(e) => e.target.select()} />
          <p className="mt-1 text-xs text-zinc-500">Paste this into the FlipDesk extension popup along with the server URL (http://localhost:8787).</p>
        </div>
      </section>

      <section className="card space-y-3 p-4">
        <h2 className="font-semibold">📱 Phone notifications</h2>
        <p className="text-xs text-zinc-500">
          Free via <a className="text-brand hover:underline" href="https://ntfy.sh" target="_blank" rel="noreferrer">ntfy</a>: install the ntfy app, subscribe to a hard-to-guess topic name (e.g. flipdesk-7f3k9q), and enter the same name here.
        </p>
        <div className="flex gap-2">
          <input className="input" placeholder="your-private-topic" value={notifyS.ntfyTopic ?? ""} onChange={(e) => setS({ ...s, notify: { ...notifyS, ntfyTopic: e.target.value } })} />
          <button className="btn-ghost shrink-0" onClick={async () => { await save(); try { await api.post("/api/notify/test"); toast("Test sent - check your phone"); } catch (e) { toast((e as Error).message, "err"); } }}>Send test</button>
        </div>
        <div className="flex flex-wrap gap-4 text-sm">
          {([["onSale", "Every sale"], ["onOversell", "Oversells (urgent)"], ["onEmailReview", "Sale emails to confirm"]] as const).map(([k, label]) => (
            <label key={k} className="flex items-center gap-2"><input type="checkbox" checked={notifyS[k] !== false} onChange={(e) => setS({ ...s, notify: { ...notifyS, [k]: e.target.checked } })} /> {label}</label>
          ))}
        </div>
      </section>

      <section className="card space-y-3 p-4">
        <h2 className="font-semibold">Listing defaults</h2>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label">SKU prefix</label><input className="input" value={s.skuPrefix ?? "FD"} onChange={(e) => setS({ ...s, skuPrefix: e.target.value })} /></div>
          <div><label className="label">Typical shipping label cost ($)</label><input className="input" type="number" step="0.01" value={s.defaultShippingCost ?? 0} onChange={(e) => setS({ ...s, defaultShippingCost: Number(e.target.value) })} /></div>
        </div>
        <div><label className="label">Description footer (added on extension sites)</label><textarea className="input min-h-20" value={s.descriptionFooter ?? ""} placeholder="Ships within 1 business day · Smoke-free home · Bundle to save!" onChange={(e) => setS({ ...s, descriptionFooter: e.target.value })} /></div>
      </section>

      <section className="card space-y-3 p-4">
        <h2 className="font-semibold">🛒 Sourcing targets and your time</h2>
        <div className="grid grid-cols-3 gap-3 text-sm">
          <div><label className="label">Min profit per item ($)</label><input className="input" type="number" value={sourcing.minProfit} onChange={(e) => setS({ ...s, sourcing: { ...sourcing, minProfit: Number(e.target.value) } })} /></div>
          <div><label className="label">Min return on cost (%)</label><input className="input" type="number" value={sourcing.minRoiPct} onChange={(e) => setS({ ...s, sourcing: { ...sourcing, minRoiPct: Number(e.target.value) } })} /></div>
          <div><label className="label">Minutes per item</label><input className="input" type="number" value={s.minutesPerItem ?? 20} onChange={(e) => setS({ ...s, minutesPerItem: Number(e.target.value) })} /></div>
        </div>
        <p className="text-xs text-zinc-500">Sourcing mode's "pay at most" price must meet both the profit and return targets. Minutes per item (sourcing, photos, listing, shipping) is used for profit per hour in Reports.</p>
      </section>

      <section className="card space-y-3 p-4">
        <h2 className="font-semibold">Automatic price drops</h2>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={autoDrop.enabled} onChange={(e) => setS({ ...s, autoDrop: { ...autoDrop, enabled: e.target.checked } })} /> Enabled (never below each item's floor price)</label>
        <div className="grid grid-cols-3 gap-3 text-sm">
          <div><label className="label">Start after (days)</label><input className="input" type="number" value={autoDrop.afterDays} onChange={(e) => setS({ ...s, autoDrop: { ...autoDrop, afterDays: Number(e.target.value) } })} /></div>
          <div><label className="label">Repeat every (days)</label><input className="input" type="number" value={autoDrop.everyDays} onChange={(e) => setS({ ...s, autoDrop: { ...autoDrop, everyDays: Number(e.target.value) } })} /></div>
          <div><label className="label">Drop by %</label><input className="input" type="number" value={autoDrop.dropPct} onChange={(e) => setS({ ...s, autoDrop: { ...autoDrop, dropPct: Number(e.target.value) } })} /></div>
        </div>
      </section>

      <section className="card space-y-3 p-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">eBay listing policies</h2>
          <button className="btn-ghost text-xs" disabled={!s.status.ebayLive} onClick={async () => { try { setPolicies(await api.get("/api/ebay/policies")); } catch (e) { toast((e as Error).message, "err"); } }}>Load from eBay</button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {([["fulfillmentPolicyId", "Shipping policy", policies?.fulfillment], ["paymentPolicyId", "Payment policy", policies?.payment], ["returnPolicyId", "Return policy", policies?.returns]] as const).map(([k, label, opts]) => (
            <div key={k}>
              <label className="label">{label}</label>
              {opts ? (
                <select className="input" value={ebay[k] ?? ""} onChange={(e) => setS({ ...s, ebay: { ...ebay, [k]: e.target.value } })}>
                  <option value="">Choose…</option>
                  {opts.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              ) : (
                <input className="input" placeholder="policy id" value={ebay[k] ?? ""} onChange={(e) => setS({ ...s, ebay: { ...ebay, [k]: e.target.value } })} />
              )}
            </div>
          ))}
          <div><label className="label">Inventory location key</label><input className="input" value={ebay.merchantLocationKey ?? ""} onChange={(e) => setS({ ...s, ebay: { ...ebay, merchantLocationKey: e.target.value } })} /></div>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!ebay.bestOffer} onChange={(e) => setS({ ...s, ebay: { ...ebay, bestOffer: e.target.checked } })} /> Enable Best Offer (auto-decline below each item's floor)</label>
      </section>

      <EmailTester />

      <section className="card space-y-3 p-4">
        <h2 className="font-semibold">Fee overrides</h2>
        <p className="text-xs text-zinc-500">Marketplaces change fees often. Override the % and per-order fee here; all profit math uses these.</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {marketplaces.map((m) => (
            <div key={m.id} className="flex items-center gap-2 text-sm">
              <span className="w-36 truncate">{m.name}</span>
              <input className="input w-20" type="number" step="0.1" placeholder={String(m.fees.pct)} value={fees[m.id]?.pct ?? ""} onChange={(e) => setS({ ...s, feeOverrides: { ...fees, [m.id]: { ...fees[m.id], pct: e.target.value === "" ? undefined : Number(e.target.value) } } })} />%
              <input className="input w-20" type="number" step="0.01" placeholder={String(m.fees.fixed)} value={fees[m.id]?.fixed ?? ""} onChange={(e) => setS({ ...s, feeOverrides: { ...fees, [m.id]: { ...fees[m.id], fixed: e.target.value === "" ? undefined : Number(e.target.value) } } })} />$
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
