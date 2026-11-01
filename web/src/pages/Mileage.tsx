import { useState } from "react";
import { api, money } from "../api";
import { Stat, toast, useFetch } from "../ui";

interface Place { id: number; name: string; round_trip_miles: number }
interface Trip { id: number; date: string; place: string; purpose: string; miles: number; amount: number; note: string }
interface Data { summary: { year: number; rate: number; trips: number; miles: number; amount: number; byPlace: { place: string; trips: number; miles: number; amount: number }[] }; places: Place[]; trips: Trip[] }

/** One-tap trip logging (also used inside sourcing mode). */
export function QuickTrip({ defaultPlace = "", onLogged }: { defaultPlace?: string; onLogged?: () => void }) {
  const { data, reload } = useFetch<Data>("/api/mileage");
  const [place, setPlace] = useState(defaultPlace);
  const [miles, setMiles] = useState("");
  const [purpose, setPurpose] = useState("sourcing");
  const saved = data?.places.find((p) => p.name.toLowerCase() === place.trim().toLowerCase());
  const log = async (p: string, m?: number) => {
    try {
      const r = await api.post<{ miles: number; amount: number }>("/api/mileage/trips", { place: p, purpose, miles: m, remember: !!m });
      toast(`Logged ${r.miles} mi: ${money(r.amount)} deduction`);
      setMiles("");
      reload();
      onLogged?.();
    } catch (e) {
      toast((e as Error).message, "err");
    }
  };
  return (
    <div className="space-y-2">
      {!!data?.places.length && (
        <div className="flex flex-wrap gap-1.5">
          {data.places.map((p) => (
            <button key={p.id} className="rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1 text-xs hover:border-brand" onClick={() => log(p.name)}>
              🚗 {p.name} · {p.round_trip_miles} mi
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <input className="input min-w-[10rem] flex-1" placeholder="Where (e.g. Goodwill Main St)" value={place} onChange={(e) => setPlace(e.target.value)} list="fd-places" />
        <datalist id="fd-places">{data?.places.map((p) => <option key={p.id} value={p.name} />)}</datalist>
        <input className="input w-28" type="number" step="0.1" placeholder={saved ? `${saved.round_trip_miles} mi` : "Round-trip mi"} value={miles} onChange={(e) => setMiles(e.target.value)} />
        <select className="input w-36" value={purpose} onChange={(e) => setPurpose(e.target.value)}>
          {["sourcing", "post office", "supplies", "other"].map((p) => <option key={p}>{p}</option>)}
        </select>
        <button className="btn-primary" disabled={!place.trim() || (!miles && !saved)} onClick={() => log(place.trim(), miles ? Number(miles) : undefined)}>Log trip</button>
      </div>
      <p className="text-[11px] text-zinc-500">New places are remembered with their miles, so next time it's one tap.</p>
    </div>
  );
}

export default function Mileage() {
  const year = new Date().getFullYear();
  const { data, reload } = useFetch<Data>(`/api/mileage?year=${year}`);
  if (!data) return <div className="text-zinc-500">Loading…</div>;
  const s = data.summary;
  return (
    <div className="max-w-4xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Mileage</h1>
          <p className="text-sm text-zinc-400">Sourcing, post office and supply runs are deductible. The log keeps what the IRS asks for: date, destination, purpose and miles.</p>
        </div>
        <a className="btn-ghost" href={`/api/export/mileage.csv?year=${year}`}>⬇ Mileage log CSV {year}</a>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Stat label={`Miles ${year}`} value={s.miles.toLocaleString()} sub={`${s.trips} trips`} />
        <Stat label="Deduction" value={money(s.amount)} sub={`at $${s.rate.toFixed(3)}/mi`} />
        <Stat label="Top destination" value={s.byPlace[0]?.place ?? "-"} sub={s.byPlace[0] ? `${s.byPlace[0].miles} mi` : undefined} />
      </div>
      <div className="card p-4">
        <h2 className="mb-2 text-sm font-semibold">Log a trip</h2>
        <QuickTrip onLogged={reload} />
      </div>
      <div className="card overflow-x-auto p-4">
        <h2 className="mb-2 text-sm font-semibold">Trips</h2>
        <table className="w-full text-sm tabular-nums">
          <thead className="text-xs text-zinc-500"><tr><th className="pb-2 text-left font-medium">Date</th><th className="text-left font-medium">Where</th><th className="text-left font-medium">Purpose</th><th className="text-right font-medium">Miles</th><th className="text-right font-medium">Deduction</th><th /></tr></thead>
          <tbody className="divide-y divide-zinc-800">
            {data.trips.map((t) => (
              <tr key={t.id}>
                <td className="py-1.5 text-zinc-400">{t.date}</td><td>{t.place}</td><td className="text-zinc-400">{t.purpose}</td>
                <td className="text-right">{t.miles}</td><td className="text-right">{money(t.amount)}</td>
                <td className="text-right"><button className="text-xs text-zinc-600 hover:text-red-400" onClick={async () => (await api.del(`/api/mileage/trips/${t.id}`), reload())}>✕</button></td>
              </tr>
            ))}
            {!data.trips.length && <tr><td colSpan={6} className="py-6 text-center text-zinc-500">No trips yet this year.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
