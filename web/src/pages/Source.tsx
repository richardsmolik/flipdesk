import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, money, type Item } from "../api";
import { toast } from "../ui";
import BarcodeScanner from "../components/BarcodeScanner";
import { QuickTrip } from "./Mileage";

interface Check {
  demo: boolean;
  barcode: { code: string; kind: string; found: boolean; title: string; image: string | null; source: string; extra?: Record<string, string> } | null;
  identified: { name: string; brand: string; category: string; confidence: string; demand: "slow" | "steady" | "hot"; red_flags: string[]; est_low: number; est_high: number };
  expectedPrice: number;
  priceBasis: string;
  quickSale: number | null;
  soldStats: { count: number; p25: number; p75: number } | null;
  demand: { soldUnits: number; sellThrough: number | null } | null;
  best: { marketplace: string; name: string; net: number; fees: number; reason: string }[];
  maxBuy: number;
  targets: { minProfit: number; minRoiPct: number };
  verdict: "buy" | "maybe" | "pass" | "check";
  why: string;
  photo: string | null;
}

const VERDICT = {
  buy: { label: "BUY", icon: "✅", cls: "border-green-700 bg-green-950/60 text-green-100" },
  maybe: { label: "MAYBE", icon: "🤔", cls: "border-amber-700 bg-amber-950/50 text-amber-100" },
  pass: { label: "PASS", icon: "⛔", cls: "border-red-800 bg-red-950/60 text-red-100" },
  check: { label: "MAX BUY", icon: "🏷️", cls: "border-zinc-700 bg-zinc-900 text-zinc-100" },
};

export default function Source() {
  const [photo, setPhoto] = useState<File | null>(null);
  const [q, setQ] = useState("");
  const [barcode, setBarcode] = useState("");
  const [ask, setAsk] = useState("");
  const [busy, setBusy] = useState(false);
  const [r, setR] = useState<Check | null>(null);
  const [bought, setBought] = useState<Item | null>(null);
  const [store, setStore] = useState(() => localStorage.getItem("fd-store") ?? "");
  const [qty, setQty] = useState(1);
  const cam = useRef<HTMLInputElement>(null);

  const check = async (askOverride?: string, codeOverride?: string) => {
    setBusy(true);
    setBought(null);
    try {
      const fd = new FormData();
      if (photo) fd.append("photo", photo);
      if (q) fd.append("q", q);
      const code = codeOverride ?? barcode;
      if (code) fd.append("barcode", code);
      const a = askOverride ?? ask;
      if (a) fd.append("askPrice", a);
      setR(await api.post<Check>("/api/source/check", fd));
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(false);
    }
  };

  const buy = async () => {
    if (!r) return;
    localStorage.setItem("fd-store", store);
    const item = await api.post<Item>("/api/source/buy", {
      name: r.identified.name,
      brand: r.identified.brand,
      category: r.identified.category,
      cost: Number(ask) || 0,
      quantity: qty,
      price: r.expectedPrice || undefined,
      source: store,
      photo: r.photo,
      barcode: r.barcode?.found ? r.barcode.code : undefined,
      specifics: r.barcode?.extra ? Object.fromEntries(Object.entries(r.barcode.extra).filter(([, v]) => v)) : undefined,
      notes: r.identified.red_flags.length ? `Check: ${r.identified.red_flags.join("; ")}` : "",
    });
    setBought(item);
    toast("Added to drafts");
  };

  const reset = () => (setPhoto(null), setQ(""), setBarcode(""), setAsk(""), setR(null), setBought(null));
  const v = r ? VERDICT[r.verdict] : null;
  const [showTrip, setShowTrip] = useState(false);

  return (
    <div className="mx-auto max-w-md space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Sourcing mode</h1>
        <p className="text-sm text-zinc-400">Should I buy this? Snap it, enter the price on the tag, get an answer.</p>
      </div>

      <div className="text-right">
        <button className="text-xs text-zinc-400 hover:text-zinc-100" onClick={() => setShowTrip(!showTrip)}>🚗 {showTrip ? "Hide" : "Log this sourcing trip"}</button>
      </div>
      {showTrip && <div className="card p-3"><QuickTrip defaultPlace={store} onLogged={() => setShowTrip(false)} /></div>}
      <BarcodeScanner onCode={(c) => (setBarcode(c), setPhoto(null), setQ(""), check(undefined, c))} />
      {barcode && <div className="text-xs text-zinc-400">Barcode <span className="tabular-nums text-zinc-200">{barcode}</span> <button className="ml-1 text-zinc-500 hover:text-zinc-200" onClick={() => setBarcode("")}>✕</button></div>}
      <div className="text-center text-[11px] uppercase tracking-wide text-zinc-600">or</div>
      <input ref={cam} type="file" accept="image/*" capture="environment" hidden onChange={(e) => (setPhoto(e.target.files?.[0] ?? null), setR(null))} />
      <button className="card flex h-44 w-full flex-col items-center justify-center gap-2 border-dashed hover:border-brand" onClick={() => cam.current?.click()}>
        {photo ? <img src={URL.createObjectURL(photo)} alt="" className="h-40 rounded-md object-contain" /> : <><span className="text-5xl">📷</span><span className="text-sm text-zinc-300">Tap to snap the item</span></>}
      </button>
      <input className="input py-3 text-base" placeholder="…or type it: e.g. Patagonia Synchilla fleece" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="flex gap-2">
        <div className="relative flex-1">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500">$</span>
          <input className="input py-3 pl-7 text-base" inputMode="decimal" placeholder="Price on the tag" value={ask} onChange={(e) => setAsk(e.target.value)} onBlur={() => r && ask && check()} />
        </div>
        <button className="btn-primary px-6 text-base" disabled={busy || (!photo && !q && !barcode)} onClick={() => check()}>{busy ? "…" : "Check"}</button>
      </div>

      {r && v && (
        <div className="space-y-3">
          <div className={`rounded-xl border-2 p-4 ${v.cls}`}>
            <div className="flex items-center justify-between">
              <div className="text-3xl font-black tracking-tight">{v.icon} {v.label}</div>
              <div className="text-right">
                <div className="text-[11px] uppercase opacity-70">Pay at most</div>
                <div className="text-2xl font-bold tabular-nums">{money(r.maxBuy)}</div>
              </div>
            </div>
            <div className="mt-2 text-sm opacity-90">{r.why}</div>
          </div>

          <div className="card space-y-2 p-4 text-sm">
            <div className="flex items-start gap-3">
              {r.barcode?.image && <img src={r.barcode.image} alt="" className="h-14 w-14 rounded object-contain" />}
              <div>
                <div className="font-medium text-zinc-100">{r.identified.name}</div>
                {r.barcode?.found && <div className="text-[11px] text-zinc-500">Exact match by barcode via {r.barcode.source}</div>}
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div><div className="text-[11px] text-zinc-500">Sells for</div><div className="font-semibold tabular-nums">{money(r.expectedPrice)}</div></div>
              <div><div className="text-[11px] text-zinc-500">Quick sale</div><div className="font-semibold tabular-nums">{money(r.quickSale)}</div></div>
              <div><div className="text-[11px] text-zinc-500">Demand</div><div className="font-semibold">{r.demand?.sellThrough != null ? `${r.demand.sellThrough}% ST` : r.identified.demand}</div></div>
            </div>
            <div className="text-xs text-zinc-500">
              Based on {r.priceBasis}{r.soldStats ? ` (${r.soldStats.count} comps, ${money(r.soldStats.p25)}-${money(r.soldStats.p75)})` : ""}. Targets: ${r.targets.minProfit}+ profit and {r.targets.minRoiPct}%+ return on what you pay (change in Settings).
              {r.demo && " Demo mode: add your AI key for photo identification."}
            </div>
            {r.best[0] && (
              <div className="rounded-md bg-zinc-950 p-2 text-xs text-zinc-300">
                Best site: <b>{r.best[0].name}</b>: you keep {money(r.best[0].net)} after fees and shipping. {r.best.slice(1).map((b) => `${b.name} ${money(b.net)}`).join(" · ")}
              </div>
            )}
            {r.identified.red_flags.length > 0 && (
              <div className="rounded-md border border-amber-900 bg-amber-950/30 p-2 text-xs text-amber-100">
                ⚠ Check before buying: {r.identified.red_flags.join(" · ")}
              </div>
            )}
          </div>

          {bought ? (
            <div className="card flex items-center justify-between p-3 text-sm">
              <span>✓ Saved as draft {bought.sku}</span>
              <span className="flex gap-3">
                <Link className="text-brand hover:underline" to={`/items/${bought.id}`}>Write listing</Link>
                <button className="text-zinc-400 hover:text-zinc-100" onClick={reset}>Next item →</button>
              </span>
            </div>
          ) : (
            <div className="card space-y-2 p-3">
              <div className="flex gap-2">
                <input className="input" placeholder="Store (e.g. Goodwill Main St)" value={store} onChange={(e) => setStore(e.target.value)} />
                <input className="input w-20" type="number" min={1} value={qty} onChange={(e) => setQty(Number(e.target.value))} aria-label="Quantity" />
              </div>
              <div className="flex gap-2">
                <button className="btn-primary flex-1 py-3" onClick={buy} disabled={!ask}>🛒 I bought it{ask ? ` for $${ask}` : ""}</button>
                <button className="btn-ghost py-3" onClick={reset}>Skip</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
