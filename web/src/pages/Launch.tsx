import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { toast } from "../ui";

interface Check { key: string; group: string; label: string; state: "ok" | "warn" | "fail" | "optional"; detail: string; fix?: string; href?: string }
interface Launch { checks: Check[]; ready: number; total: number; blockers: number }

const BADGE: Record<Check["state"], [string, string]> = {
  ok: ["✓ Ready", "bg-green-950 text-green-300 border-green-900"],
  warn: ["! Check", "bg-amber-950 text-amber-300 border-amber-900"],
  fail: ["✕ Missing", "bg-red-950 text-red-300 border-red-900"],
  optional: ["– Optional", "bg-zinc-900 text-zinc-400 border-zinc-800"],
};

/** Owner: is this FlipDesk ready for real use? Each item says how to fix it. */
export default function LaunchPage() {
  const [l, setL] = useState<Launch | null>(null);
  const [to, setTo] = useState("");
  const load = () => api.get<Launch>("/api/launch").then(setL).catch((e: Error) => toast(e.message, "err"));
  useEffect(() => void load(), []);
  if (!l) return <div className="text-zinc-500">Checking…</div>;
  const groups = [...new Set(l.checks.map((c) => c.group))];
  const pct = Math.round((l.ready / Math.max(1, l.total)) * 100);
  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">🚀 Launch checklist</h1>
        <p className="text-sm text-zinc-400">Everything FlipDesk needs before real selling (and before inviting anyone). It checks live settings, so fix something and press Re-check.</p>
      </div>
      <div className="card space-y-2 p-4">
        <div className="flex items-baseline justify-between">
          <b>{l.blockers ? `${l.blockers} thing${l.blockers === 1 ? "" : "s"} to fix` : "✅ Ready to launch"}</b>
          <button className="text-xs text-zinc-400 hover:text-zinc-100" onClick={load}>{l.ready} of {l.total} ready · Re-check</button>
        </div>
        <div className="h-2 rounded bg-zinc-800"><div className={`h-2 rounded ${l.blockers ? "bg-brand" : "bg-green-500"}`} style={{ width: `${pct}%` }} /></div>
      </div>
      {groups.map((g) => (
        <section key={g} className="card p-4">
          <h2 className="font-semibold">{g}</h2>
          <ul className="divide-y divide-zinc-800">
            {l.checks.filter((c) => c.group === g).map((c) => (
              <li key={c.key} className="flex items-start gap-3 py-3">
                <span className={`mt-0.5 inline-flex w-24 shrink-0 justify-center rounded-full border px-2 py-0.5 text-xs ${BADGE[c.state][1]}`}>{BADGE[c.state][0]}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-zinc-100">{c.label}</div>
                  <div className="text-xs text-zinc-400">{c.detail}</div>
                  {c.fix && c.state !== "ok" && <div className="mt-0.5 text-xs text-zinc-300">→ {c.fix}</div>}
                </div>
                {c.href && c.state !== "ok" && <Link to={c.href} className="btn-ghost shrink-0 px-2 py-1 text-xs">Fix</Link>}
                {c.key === "email" && (
                  <button
                    className="btn-ghost shrink-0 px-2 py-1 text-xs"
                    onClick={async () => {
                      try {
                        const r = await api.post<{ to: string }>("/api/launch/test-email", to ? { to } : {});
                        toast(`Test email sent to ${r.to}`);
                        void load();
                      } catch (e) {
                        toast((e as Error).message, "err");
                      }
                    }}
                  >
                    Send test email
                  </button>
                )}
              </li>
            ))}
          </ul>
          {g === "Staying informed" && <input className="input mt-2 max-w-xs text-xs" type="email" placeholder="Test email to (if not your account email)" value={to} onChange={(e) => setTo(e.target.value)} />}
        </section>
      ))}
      <p className="text-xs text-zinc-500">Full instructions for each item: docs/DEPLOY.md and docs/EBAY_SETUP.md.</p>
    </div>
  );
}
