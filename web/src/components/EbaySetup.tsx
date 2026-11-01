import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { toast, useFetch } from "../ui";

interface Setup { environment: string; ready: boolean; error: string | null; steps: { key: string; label: string; done: boolean; detail: string; action?: string }[] }

/** Guided, one-time eBay setup. Every step has a button where we can do it for you. */
export default function EbaySetup() {
  const { data, reload } = useFetch<Setup>("/api/ebay/setup");
  const [paste, setPaste] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  if (!data) return null;
  const run = async (action: string) => {
    setBusy(action);
    try {
      if (action === "connect") {
        const r = await api.get<{ url: string }>(`/api/connections/ebay/auth-url?return=${encodeURIComponent(location.origin)}`);
        location.href = r.url; // eBay -> relay page -> back here, connected
        return;
      } else if (action === "optin") {
        await api.post("/api/ebay/optin");
        toast("Business policies turned on (eBay can take a few minutes)");
      } else if (action === "location") {
        await api.post("/api/ebay/location");
        toast("Ship-from location registered");
      } else if (action === "policies") {
        location.href = "/settings#ebay";
        return;
      }
      reload();
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className={`card space-y-3 p-4 ${data.ready ? "border-green-900" : "border-blue-900"}`}>
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">{data.ready ? "✅ eBay is ready to list" : "🛠️ eBay setup"} <span className="text-xs font-normal text-zinc-500">({data.environment})</span></h2>
        <button className="text-xs text-zinc-400 hover:text-zinc-100" onClick={reload}>Re-check</button>
      </div>
      <ol className="space-y-2">
        {data.steps.map((s, i) => (
          <li key={s.key} className="flex items-start gap-3 text-sm">
            <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] ${s.done ? "bg-green-900 text-green-200" : "bg-zinc-800 text-zinc-400"}`}>{s.done ? "✓" : i + 1}</span>
            <div className="min-w-0 flex-1">
              <div className={s.done ? "text-zinc-300" : "text-zinc-100"}>{s.label}</div>
              <div className="text-xs text-zinc-500">{s.detail}</div>
            </div>
            {s.action && (
              <button className="btn-primary shrink-0 py-1 text-xs" disabled={!!busy} onClick={() => run(s.action!)}>
                {busy === s.action ? "…" : s.action === "connect" ? "Connect eBay" : s.action === "optin" ? "Turn on" : s.action === "location" ? "Register" : "Open settings"}
              </button>
            )}
          </li>
        ))}
      </ol>
      {data.steps.find((s) => s.key === "connect" && !s.done) && data.steps[0].done && (
        <details className="text-xs text-zinc-500">
          <summary className="cursor-pointer">Didn't come back to FlipDesk automatically?</summary>
          <div className="mt-2 space-y-1">
          <label className="label">Paste the address from your browser after clicking Agree on eBay</label>
          <div className="flex gap-2">
            <input className="input" placeholder="https://...?code=v%5E1.1%23...&state=..." value={paste} onChange={(e) => setPaste(e.target.value)} />
            <button className="btn-ghost" disabled={!paste} onClick={async () => { try { await api.post("/api/connections/ebay/paste", { url: paste }); toast("eBay connected"); setPaste(""); reload(); } catch (e) { toast((e as Error).message, "err"); } }}>Connect</button>
          </div>
          </div>
        </details>
      )}
      {data.error && <div className="text-xs text-red-300">eBay said: {data.error}</div>}
      {data.ready && <div className="text-xs text-zinc-400">Next: <Link to="/items/new" className="text-brand hover:underline">create a listing</Link>, tick eBay, and crosslist. Start with one real item you want to sell.</div>}
    </div>
  );
}
