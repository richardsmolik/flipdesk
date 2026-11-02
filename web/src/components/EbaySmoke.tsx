import { useEffect, useState } from "react";
import { api } from "../api";
import { timeAgo, toast } from "../ui";

interface Step { name: string; ok: boolean; ms: number; detail: string }
interface Result { ok: boolean; env: string; steps: Step[]; error: string | null; ranAt: string }

/** One click: list a test item on eBay's sandbox, end it, clean up. Proves the whole eBay path. */
export default function EbaySmoke() {
  const [r, setR] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => void api.get<Result | null>("/api/ebay/smoke-test").then(setR).catch(() => {}), []);
  const run = async (allowProduction = false) => {
    setBusy(true);
    try {
      const x = await api.post<Result>("/api/ebay/smoke-test", { allowProduction });
      setR(x);
      toast(x.ok ? "eBay test passed ✅" : "eBay test found a problem", x.ok ? "ok" : "err");
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(false);
    }
  };
  const production = r?.steps.some((s) => s.name === "Safe place to test" && !s.ok);
  return (
    <section className="card space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold">🧪 eBay end-to-end test</h2>
          <p className="text-xs text-zinc-400">Lists a test item on eBay's sandbox (test site), ends it and cleans up, so you know listing and delisting work before using real items.</p>
        </div>
        <button className="btn-primary" disabled={busy} onClick={() => run()}>{busy ? "Testing… (up to a minute)" : r ? "Run again" : "Run eBay test"}</button>
      </div>
      {r && (
        <div className="space-y-1">
          <div className={`text-sm font-medium ${r.ok ? "text-green-400" : "text-red-400"}`}>{r.ok ? "✅ Passed" : "✕ Stopped"} · {r.env} · {timeAgo(r.ranAt)}</div>
          <ol className="space-y-0.5 text-sm">
            {r.steps.map((s) => (
              <li key={s.name} className="flex gap-2">
                <span className={s.ok ? "text-green-400" : "text-red-400"}>{s.ok ? "✓" : "✕"}</span>
                <span className="text-zinc-200">{s.name}</span>
                <span className="text-xs text-zinc-500">{s.detail}{s.ms > 50 ? ` · ${(s.ms / 1000).toFixed(1)} s` : ""}</span>
              </li>
            ))}
          </ol>
          {!r.ok && !production && r.steps.some((s) => s.name === "Reach your eBay account") && <p className="text-xs text-zinc-500">A problem report was saved (Inbox → 📮 Send report) so it can be reproduced and fixed.</p>}
          {production && (
            <button className="btn-ghost text-xs text-amber-300" disabled={busy} onClick={() => confirm("This creates a REAL eBay listing for a few seconds, then ends it. eBay may count it toward your free listings. Continue?") && run(true)}>
              Test on real eBay anyway
            </button>
          )}
        </div>
      )}
    </section>
  );
}
