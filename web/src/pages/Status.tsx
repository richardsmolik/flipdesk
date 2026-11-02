import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { timeAgo } from "../ui";

interface Row { key: string; label: string; state: "ok" | "warn" | "down" | "off"; detail: string; lastOk?: string | null }
interface Incident { service: string; label: string; started_at: string; ended_at: string | null; last_error: string }
interface Status { overall: "ok" | "warn" | "down"; checkedAt: string; services: Row[]; yours: Row[]; incidents?: Incident[] }

// Status colors carry an icon + word, never color alone.
const BADGE: Record<Row["state"], [string, string, string]> = {
  ok: ["✓", "Working", "bg-green-950 text-green-300 border-green-900"],
  warn: ["!", "Check", "bg-amber-950 text-amber-300 border-amber-900"],
  down: ["✕", "Problem", "bg-red-950 text-red-300 border-red-900"],
  off: ["–", "Not set up", "bg-zinc-900 text-zinc-400 border-zinc-800"],
};
const FIX: Record<string, string> = { ebay: "/connections", sync: "/queue", extension: "/connections", "ai-allowance": "/billing", backup: "/settings", "backup-check": "/settings" };

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

interface SpeedRow { path: string; name: string; now: number; before: number | null; changePct: number | null }
interface Trend { rows: SpeedRow[]; now: number; before: number | null; changePct: number | null; slower: SpeedRow[]; faster: SpeedRow[]; runs: { now: number; before: number } }
interface Check { at: string; ok: boolean; problems: string[]; disk: { freeGB: number; freePct: number } | null }

/** Owner: how fast the main screens are this week compared with last week (from the nightly self-check). */
function Speed() {
  const [d, setD] = useState<{ trend: Trend | null; last: Check | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.get<{ trend: Trend | null; last: Check | null }>("/api/selfcheck/trend").then(setD).catch(() => setD(null));
  useEffect(() => void load(), []);
  if (!d) return null;
  const t = d.trend;
  const change = (r: SpeedRow) => {
    if (r.changePct === null) return <span className="text-zinc-500">new</span>;
    const slower = t!.slower.some((x) => x.path === r.path);
    const faster = t!.faster.some((x) => x.path === r.path);
    return <span className={slower ? "text-amber-300" : faster ? "text-green-400" : "text-zinc-400"}>{slower ? "▲ slower " : faster ? "▼ faster " : ""}{r.changePct > 0 ? "+" : ""}{r.changePct}%</span>;
  };
  return (
    <section className="card space-y-3 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">⚡ Speed: this week vs last week</h2>
        <button
          className="btn-ghost text-xs"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.post("/api/selfcheck");
              await load();
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Checking… (about a minute)" : "Run the self-check now"}
        </button>
      </div>
      {d.last && (
        <p className="text-xs text-zinc-400">
          Last self-check {timeAgo(d.last.at)}: {d.last.ok ? "✓ all good" : `✕ ${d.last.problems[0] ?? "problems found"}`}
          {d.last.disk ? ` · ${d.last.disk.freeGB} GB disk free` : ""}
        </p>
      )}
      {!t ? (
        <p className="text-sm text-zinc-500">The self-check runs every night. After the first one, each screen's speed shows here, and from next week how it compares with the week before.</p>
      ) : (
        <>
          <p className="text-sm">
            Screens answer in <b>~{t.now} ms</b> on average
            {t.before !== null ? <> (last week {t.before} ms{t.changePct ? `, ${t.changePct > 0 ? "+" : ""}${t.changePct}%` : ""})</> : " (last week: not enough checks yet)"}.{" "}
            {t.slower.length ? <span className="text-amber-300">▲ {t.slower.length} got slower.</span> : t.before !== null ? <span className="text-green-400">✓ Nothing got slower.</span> : null}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-zinc-500">
                <tr><th className="py-1 font-normal">Screen</th><th className="font-normal">This week</th><th className="font-normal">Last week</th><th className="font-normal">Change</th></tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {[...t.rows].sort((a, b) => b.now - a.now).map((r) => (
                  <tr key={r.path}><td className="py-1">{r.name}</td><td>{r.now} ms</td><td className="text-zinc-400">{r.before ?? "-"}{r.before !== null && " ms"}</td><td>{change(r)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-zinc-500">Measured on a test shop of 800 items, {t.runs.now} check{t.runs.now === 1 ? "" : "s"} this week and {t.runs.before} last week. “Slower” means at least 25% and 30 ms slower.</p>
        </>
      )}
    </section>
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
      <Speed />
      {!!s.incidents?.length && (
        <section className="card p-4">
          <h2 className="font-semibold">Recent problems</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {s.incidents.map((i) => {
              const at = (x: string) => new Date(x.replace(" ", "T") + "Z");
              const mins = Math.round(((i.ended_at ? at(i.ended_at) : new Date()).getTime() - at(i.started_at).getTime()) / 60_000);
              return (
                <li key={i.started_at + i.service} className="flex flex-wrap justify-between gap-2">
                  <span>{i.ended_at ? "✅" : "🔴"} {i.label} {i.ended_at ? "had trouble" : "is having trouble"} <span className="text-xs text-zinc-500">{i.last_error}</span></span>
                  <span className="text-xs text-zinc-500">{timeAgo(at(i.started_at).toISOString())} · {i.ended_at ? `fixed after ${mins < 120 ? `${Math.max(1, mins)} min` : `${Math.round(mins / 60)} h`}` : "ongoing"}</span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <p className="text-xs text-zinc-500">Updates every 30 seconds. Still stuck? Use 💬 Send feedback in the sidebar (it includes this page).</p>
    </div>
  );
}
