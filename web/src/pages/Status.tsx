import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { timeAgo } from "../ui";

interface Row { key: string; label: string; state: "ok" | "warn" | "down" | "off"; detail: string; lastOk?: string | null }
interface Status { overall: "ok" | "warn" | "down"; checkedAt: string; services: Row[]; yours: Row[] }

// Status colors carry an icon + word, never color alone.
const BADGE: Record<Row["state"], [string, string, string]> = {
  ok: ["✓", "Working", "bg-green-950 text-green-300 border-green-900"],
  warn: ["!", "Check", "bg-amber-950 text-amber-300 border-amber-900"],
  down: ["✕", "Problem", "bg-red-950 text-red-300 border-red-900"],
  off: ["–", "Not set up", "bg-zinc-900 text-zinc-400 border-zinc-800"],
};
const FIX: Record<string, string> = { ebay: "/connections", sync: "/queue", extension: "/connections", "ai-allowance": "/billing", backup: "/settings" };

function List({ rows }: { rows: Row[] }) {
  return (
    <ul className="divide-y divide-zinc-800">
      {rows.map((r) => {
        const [icon, word, cls] = BADGE[r.state];
        return (
          <li key={r.key} className="flex items-start gap-3 py-3">
            <span className={`mt-0.5 inline-flex w-24 shrink-0 items-center justify-center gap-1 rounded-full border px-2 py-0.5 text-xs ${cls}`}>{icon} {word}</span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-zinc-100">{r.label}</div>
              <div className="text-xs text-zinc-400">{r.detail}</div>
              {r.state === "down" && r.lastOk && <div className="text-xs text-zinc-500">Last worked {timeAgo(r.lastOk)}</div>}
            </div>
            {(r.state === "down" || r.state === "warn") && FIX[r.key] && <Link to={FIX[r.key]} className="btn-ghost shrink-0 px-2 py-1 text-xs">Fix</Link>}
          </li>
        );
      })}
    </ul>
  );
}

/** Is it me or is it FlipDesk? One page that answers before you send feedback. */
export default function StatusPage() {
  const [s, setS] = useState<Status | null>(null);
  const load = () => api.get<Status>("/api/status").then(setS).catch(() => {});
  useEffect(() => {
    void load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);
  if (!s) return <div className="text-zinc-500">Checking…</div>;
  const head = { ok: ["✅", "Everything is working"], warn: ["⚠️", "Mostly working: a few things to check"], down: ["🔴", "Something isn't working right now"] }[s.overall];
  return (
    <div className="max-w-3xl space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">{head[0]} {head[1]}</h1>
        <button className="text-xs text-zinc-400 hover:text-zinc-100" onClick={load}>Checked {timeAgo(s.checkedAt)} · refresh</button>
      </div>
      <section className="card p-4">
        <h2 className="font-semibold">Your shop</h2>
        <List rows={s.yours} />
      </section>
      <section className="card p-4">
        <h2 className="font-semibold">FlipDesk services</h2>
        <List rows={s.services} />
      </section>
      <p className="text-xs text-zinc-500">Updates every 30 seconds. Still stuck? Use 💬 Send feedback in the sidebar (it includes this page).</p>
    </div>
  );
}
