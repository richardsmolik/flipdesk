import { useEffect, useState } from "react";

interface Pub {
  name: string;
  overall: "ok" | "degraded";
  services: { key: string; label: string; state: "ok" | "down"; uptime30: number }[];
  incidents: { label: string; startedAt: string; endedAt: string | null; minutes: number }[];
  updatedAt: string;
}
const dur = (m: number) => (m < 120 ? `${m} min` : `${Math.round(m / 60)} h`);

/** /uptime: a public page anyone can open (no sign-in) to see if FlipDesk is working. The owner turns it on. */
export default function Uptime() {
  const [p, setP] = useState<Pub | null | "off">(null);
  useEffect(() => {
    const load = () => fetch("/api/public-status").then((r) => (r.ok ? r.json().then(setP) : setP("off")), () => setP("off"));
    void load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);
  if (p === null) return <div className="p-6 text-zinc-500">Checking…</div>;
  if (p === "off") return <div className="flex min-h-screen items-center justify-center p-4 text-zinc-400">This status page isn't turned on.</div>;
  return (
    <div className="mx-auto max-w-2xl space-y-5 p-4 sm:p-8">
      <div>
        <div className="text-lg font-bold">📦 {p.name} status</div>
        <h1 className="mt-2 text-2xl font-semibold">{p.overall === "ok" ? "✅ Everything is working" : "⚠️ Something isn't working right now"}</h1>
        <p className="text-xs text-zinc-500">Updated {new Date(p.updatedAt).toLocaleTimeString()} · refreshes every minute</p>
      </div>
      <ul className="card divide-y divide-zinc-800">
        {p.services.map((s) => (
          <li key={s.key} className="flex items-center justify-between gap-3 p-3">
            <span>{s.label}</span>
            <span className="text-right text-sm">
              <span className={s.state === "ok" ? "text-green-400" : "text-red-400"}>{s.state === "ok" ? "✓ Working" : "✕ Having trouble"}</span>
              <span className="block text-xs text-zinc-500">{s.uptime30}% the last 30 days</span>
            </span>
          </li>
        ))}
      </ul>
      <section className="space-y-2">
        <h2 className="font-semibold">Last 30 days</h2>
        {p.incidents.length ? (
          <ul className="space-y-1 text-sm">
            {p.incidents.map((i) => (
              <li key={i.startedAt + i.label} className="flex flex-wrap justify-between gap-2">
                <span>{i.endedAt ? "✅" : "🔴"} {i.label} {i.endedAt ? "had trouble" : "is having trouble"}</span>
                <span className="text-xs text-zinc-500">{new Date(i.startedAt).toLocaleString()} · {i.endedAt ? `fixed after ${dur(i.minutes)}` : `for ${dur(i.minutes)} so far`}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-zinc-400">No problems. 🎉</p>
        )}
      </section>
    </div>
  );
}
