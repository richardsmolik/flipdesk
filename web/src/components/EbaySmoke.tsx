import { useEffect, useState } from "react";
import { api } from "../api";
import { timeAgo, toast } from "../ui";

interface Step { name: string; ok: boolean; ms: number; detail: string }
interface Result { ok: boolean; env: string; steps: Step[]; error: string | null; ranAt: string }

/** Plain text of a test run to paste into a message (no keys or tokens: just steps, times and eBay's words). */
export function resultText(title: string, r: Result & { kind?: string }) {
  return [
    `${title}: ${r.ok ? "PASSED" : "FAILED"} · ${r.env}${r.kind ? ` · ${r.kind}` : ""} · ${new Date(r.ranAt).toLocaleString()}`,
    ...r.steps.map((s) => `${s.ok ? "✓" : "✕"} ${s.name}: ${s.detail}${s.ms > 50 ? ` (${(s.ms / 1000).toFixed(1)} s)` : ""}`),
    ...(r.error && !r.steps.some((s) => !s.ok) ? [`Error: ${r.error}`] : []),
  ].join("\n");
}
const copy = (text: string) => {
  navigator.clipboard?.writeText(text).then(
    () => toast("Copied. Paste it into your message."),
    () => toast("Couldn't copy: select the text and copy it by hand", "err"),
  );
};

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
          <button className="btn-ghost text-xs" onClick={() => copy(resultText("FlipDesk eBay end-to-end test", r))}>📋 Copy results to share</button>
          {production && (
            <button className="btn-ghost text-xs text-amber-300" disabled={busy} onClick={() => confirm("This creates a REAL eBay listing for a few seconds, then ends it. eBay may count it toward your free listings. Continue?") && run(true)}>
              Test on real eBay anyway
            </button>
          )}
        </div>
      )}
      <WeeklyCheck />
    </section>
  );
}

interface Weekly { enabled: boolean; env: string; connected: boolean; last: (Result & { kind: "full" | "read-only" }) | null }
/** Every week, by itself: the full test on the sandbox; on a real account a read-only check (nothing listed). */
function WeeklyCheck() {
  const [w, setW] = useState<Weekly | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => void api.get<Weekly>("/api/ebay/weekly-check").then(setW).catch(() => {}), []);
  if (!w) return null;
  const last = w.last;
  return (
    <div className="space-y-2 border-t border-zinc-800 pt-3">
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={w.enabled} onChange={async (e) => setW(await api.put<Weekly>("/api/ebay/weekly-check", { enabled: e.target.checked }))} />
        <span>
          <span className="font-medium">Check eBay every week by itself</span>
          <span className="block text-xs text-zinc-500">
            {w.env === "sandbox" ? "On the sandbox: the full test above (list, end, clean up)." : "On your real account: a read-only check. Nothing is listed or changed; it checks your policies, ship-from location, category lookup and sales feed still answer."} If eBay changed something, the Inbox tells you before a real listing fails.
          </span>
        </span>
      </label>
      {last ? (
        <div className="text-xs">
          <button className={`${last.ok ? "text-green-400" : "text-red-400"} hover:underline`} onClick={() => setOpen(!open)}>
            {last.ok ? "✓ Last weekly check passed" : `✕ Last weekly check failed: ${last.steps.find((s) => !s.ok)?.name ?? last.error}`}
          </button>{" "}
          <span className="text-zinc-500">· {last.kind} · {timeAgo(last.ranAt)}</span>
          {open && (
            <ol className="mt-1 space-y-0.5">
              {last.steps.map((s) => (
                <li key={s.name} className="flex gap-2">
                  <span className={s.ok ? "text-green-400" : "text-red-400"}>{s.ok ? "✓" : "✕"}</span>
                  <span className="text-zinc-300">{s.name}</span>
                  <span className="text-zinc-500">{s.detail}</span>
                </li>
              ))}
            </ol>
          )}
          <button className="ml-2 text-zinc-400 underline hover:text-zinc-100" onClick={() => copy(resultText("FlipDesk weekly eBay check", last))}>📋 Copy results</button>
        </div>
      ) : (
        <p className="text-xs text-zinc-500">{w.connected ? "First check runs within a few hours." : "Starts once eBay is connected."}</p>
      )}
      {w.connected && (
        <button
          className="btn-ghost text-xs"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = (await api.post<{ last: Weekly["last"] }>("/api/ebay/weekly-check")).last;
              setW({ ...w, last: r });
              toast(r?.ok ? "eBay check passed ✅" : "eBay check found a problem", r?.ok ? "ok" : "err");
            } catch (e) {
              toast((e as Error).message, "err");
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Checking…" : "Run the weekly check now"}
        </button>
      )}
    </div>
  );
}
