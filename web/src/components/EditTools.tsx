import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { timeAgo, toast } from "../ui";

/* ---------- Title A/B test (item page) ---------- */
interface Phase { days: number; views: number; watchers: number; viewsPerDay: number; sold: boolean }
interface Test { a: string; b: string; days: number; phase: "a" | "b" | "done"; nextAt: string | null; aStats: Phase | null; bStats: Phase | null; winner: "a" | "b" | null; note: string | null; endedAt: string | null }

const until = (iso: string) => {
  const d = Math.ceil((Date.parse(iso) - Date.now()) / 86400_000);
  return d <= 0 ? "within the hour" : `in ${d} day${d === 1 ? "" : "s"}`;
};
const statLine = (s: Phase | null) => (s ? `${s.viewsPerDay} views/day (${s.views} in ${s.days} days)${s.watchers ? `, +${s.watchers} watcher${s.watchers === 1 ? "" : "s"}` : ""}` : "not started");

export function TitleTest({ itemId, live, title, onChanged }: { itemId: number; live: boolean; title: string; onChanged: () => void }) {
  const [t, setT] = useState<Test | null | undefined>(undefined);
  const [b, setB] = useState("");
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const load = () => api.get<Test | null>(`/api/items/${itemId}/title-test`).then(setT).catch(() => setT(null));
  useEffect(() => void load(), [itemId]);
  if (t === undefined || (!live && (!t || t.phase === "done"))) return null;
  const err = (e: unknown) => toast((e as Error).message, "err");
  const running = t && t.phase !== "done";
  return (
    <details className="card p-4 text-sm" open={Boolean(running)}>
      <summary className="cursor-pointer font-semibold">🆎 Title test {running ? <span className="font-normal text-sky-300">running: title {t.phase.toUpperCase()}</span> : t?.winner ? <span className="font-normal text-zinc-400">last: {t.winner.toUpperCase()} won</span> : null}</summary>
      {running ? (
        <div className="mt-3 space-y-2">
          <div className={t.phase === "a" ? "font-medium" : "text-zinc-400"}>A: {t.a}<div className="text-xs text-zinc-500">{statLine(t.aStats)}</div></div>
          <div className={t.phase === "b" ? "font-medium" : "text-zinc-400"}>B: {t.b}<div className="text-xs text-zinc-500">{statLine(t.bStats)}</div></div>
          <p className="text-xs text-zinc-500">{t.phase === "a" ? `Switches every live listing to B ${until(t.nextAt!)}.` : `Picks the winner ${until(t.nextAt!)} and keeps it.`} A sale ends the test early. Changing the title yourself stops it.</p>
          <div className="flex gap-2">
            {(["a", "b"] as const).map((k) => (
              <button key={k} className="btn-ghost text-xs" onClick={async () => { try { await api.post(`/api/items/${itemId}/title-test/stop`, { keep: k }); toast(`Stopped. Kept title ${k.toUpperCase()}.`); onChanged(); void load(); } catch (e) { err(e); } }}>
                Stop, keep {k.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {t?.note && <p className="rounded-md border border-zinc-800 p-2 text-xs text-zinc-300">Last test ({timeAgo(t.endedAt)}): {t.note}</p>}
          <p className="text-xs text-zinc-400">Not sure which title is better? Run your title (A) for a while, then a new one (B) for the same time. FlipDesk counts views per day on your live listings and keeps the winner. Free, no AI needed.</p>
          <div className="text-xs text-zinc-500">A (now): {title}</div>
          <input className="input" maxLength={80} placeholder="Title B" value={b} onChange={(e) => setB(e.target.value)} />
          <div className="flex flex-wrap items-center gap-2">
            <select className="input w-auto py-1 text-xs" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={5}>5 days each</option>
              <option value={7}>7 days each</option>
              <option value={14}>14 days each</option>
            </select>
            <button
              className="btn-ghost text-xs"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try { setB((await api.post<{ title: string }>(`/api/items/${itemId}/fresh-title`)).title); } catch (e) { err(e); } finally { setBusy(false); }
              }}
            >
              {busy ? "Thinking…" : "✨ Suggest B"}
            </button>
            <button className="btn-primary text-xs" disabled={b.trim().length < 3} onClick={async () => { try { await api.post(`/api/items/${itemId}/title-test`, { b, days }); toast(`Test started. Title A runs ${days} days, then B.`); setB(""); void load(); } catch (e) { err(e); } }}>
              Start test
            </button>
          </div>
          <p className="text-xs text-zinc-500">{b.length}/80 · Views come from eBay's traffic report and the extension, so give it a site that reports views.</p>
        </div>
      )}
    </details>
  );
}

/* ---------- Edits that worked in your shop (item page) ---------- */
export function EditTips({ itemId }: { itemId: number }) {
  const [s, setS] = useState<{ kind: string; how: string; why: string }[]>([]);
  useEffect(() => void api.get<typeof s>(`/api/items/${itemId}/edit-suggestions`).then(setS).catch(() => setS([])), [itemId]);
  if (!s.length) return null;
  return (
    <div className="rounded-md border border-emerald-900 bg-emerald-950/20 p-3 text-sm">
      <div className="font-medium">💡 What's worked in your shop</div>
      <ul className="mt-1 space-y-1">
        {s.map((x) => (
          <li key={x.kind}>
            {x.how}
            <span className="block text-xs text-zinc-400">{x.why}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---------- Shop-wide lessons (dashboard) ---------- */
interface Lesson { kind: string; label: string; cases: number; helped: number; helpedPct: number; avgViewsPct: number | null; soldWithin14: number; verdict: "helps" | "mixed" | "no help" }
const VERDICT: Record<Lesson["verdict"], string> = { helps: "text-green-400", mixed: "text-zinc-400", "no help": "text-amber-300" };
export function EditLessons() {
  const [l, setL] = useState<{ lessons: Lesson[]; cases: number } | null>(null);
  useEffect(() => void api.get<typeof l>("/api/edit-lessons").then(setL).catch(() => setL(null)), []);
  if (!l?.lessons.length) return null;
  return (
    <details className="card p-4 text-sm">
      <summary className="cursor-pointer font-semibold">📈 What edits work for you <span className="font-normal text-zinc-500">({l.cases} changes measured)</span></summary>
      <table className="mt-3 w-full text-left text-xs">
        <thead className="text-zinc-500"><tr><th className="py-1">Kind of change</th><th>Helped</th><th>Views</th><th>Verdict</th></tr></thead>
        <tbody>
          {l.lessons.map((x) => (
            <tr key={x.kind} className="border-t border-zinc-800">
              <td className="py-1">{x.label}</td>
              <td>{x.helped} of {x.cases}{x.soldWithin14 ? ` (${x.soldWithin14} sold)` : ""}</td>
              <td>{x.avgViewsPct === null ? "-" : `${x.avgViewsPct > 0 ? "+" : ""}${x.avgViewsPct}%`}</td>
              <td className={VERDICT[x.verdict]}>{x.verdict}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-zinc-500">“Helped” = views per day up 20%+ or it sold within 2 weeks of the change. Counted from 3 days after each change in item history; needs 3+ of a kind. A hint, not proof: seasons and other sellers change too.</p>
    </details>
  );
}

/* ---------- Updates that didn't reach a live listing (dashboard) ---------- */
interface Failed { jobId: number; itemId: number; title: string; marketplace: string; fields: string[]; error: string; at: string }
export function FailedUpdates() {
  const [f, setF] = useState<Failed[]>([]);
  const [busy, setBusy] = useState(false);
  const load = () => api.get<Failed[]>("/api/failed-updates").then(setF).catch(() => setF([]));
  useEffect(() => void load(), []);
  if (!f.length) return null;
  const retry = async (jobIds?: number[]) => {
    setBusy(true);
    try {
      const r = await api.post<{ retried: number; stillFailing: Failed[] }>("/api/failed-updates/retry", jobIds ? { jobIds } : {});
      setF(r.stillFailing);
      const left = r.stillFailing.filter((x) => !jobIds || jobIds.includes(x.jobId)).length;
      toast(left ? `Tried again: ${left} still didn't go through. See the reason under each.` : "Sent. The extension handles the sites it fills in next time it runs.", left ? "err" : "ok");
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section id="failed-updates" className="card space-y-2 border-amber-800 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">⚠️ {f.length} update{f.length === 1 ? "" : "s"} didn't reach a live listing</h2>
        {f.length > 1 && <button className="btn-primary text-xs" disabled={busy} onClick={() => void retry()}>Retry all</button>}
      </div>
      <p className="text-xs text-zinc-400">These listings are still up, but still show the old details. Fix what the site complained about on the item, or just try again.</p>
      <ul className="space-y-2 text-sm">
        {f.slice(0, 8).map((x) => (
          <li key={x.jobId} className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <Link to={`/items/${x.itemId}`} className="hover:underline">{x.title}</Link>
              <span className="block text-xs text-zinc-500">{x.marketplace} · {x.fields.join(", ")} · {timeAgo(x.at)} · <span className="text-amber-300">{x.error}</span></span>
            </div>
            <button className="btn-ghost text-xs" disabled={busy} onClick={() => void retry([x.jobId])}>Retry</button>
          </li>
        ))}
      </ul>
      {f.length > 8 && <Link to="/queue" className="text-xs text-zinc-400 hover:underline">+{f.length - 8} more in the queue</Link>}
    </section>
  );
}

/* ---------- Recent bulk changes with undo (inventory) ---------- */
interface Group { grp: string; at: string; items: number; fields: string[]; pctExample: number | null; allUndone: boolean; undone: number }
export function BulkChanges({ tick, onUndone }: { tick: number; onUndone: () => void }) {
  const [g, setG] = useState<Group[]>([]);
  const load = () => api.get<Group[]>("/api/bulk-changes").then(setG).catch(() => setG([]));
  useEffect(() => void load(), [tick]);
  const recent = g.filter((x) => Date.now() - Date.parse(x.at.replace(" ", "T") + "Z") < 30 * 86400_000).slice(0, 5);
  if (!recent.length) return null;
  return (
    <details className="card p-3 text-sm" open={recent.some((x) => !x.allUndone && Date.now() - Date.parse(x.at.replace(" ", "T") + "Z") < 3600_000)}>
      <summary className="cursor-pointer font-medium">↩️ Recent bulk changes</summary>
      <ul className="mt-2 space-y-1.5">
        {recent.map((x) => (
          <li key={x.grp} className="flex flex-wrap items-center justify-between gap-2">
            <span className={x.allUndone ? "text-zinc-500 line-through" : ""}>
              {x.fields.includes("price") ? `Price ${x.pctExample !== null ? `${x.pctExample > 0 ? "+" : ""}${x.pctExample}%` : "change"}` : x.fields.join(", ")} on {x.items} items
              <span className="ml-2 text-xs text-zinc-500">{timeAgo(x.at)}</span>
            </span>
            {!x.allUndone && (
              <button
                className="btn-ghost px-2 py-0.5 text-xs"
                onClick={async () => {
                  if (!confirm(`Put the old values back on these ${x.items} items and their live listings?`)) return;
                  try {
                    const r = await api.post<{ restored: number; kept: number }>(`/api/bulk-changes/${x.grp}/undo`);
                    toast(`Undone on ${r.restored} item${r.restored === 1 ? "" : "s"}${r.kept ? `. ${r.kept} kept their newer value (you changed them again since)` : ""}. Sent to your live listings.`);
                    onUndone();
                    void load();
                  } catch (e) {
                    toast((e as Error).message, "err");
                  }
                }}
              >
                Undo all
              </button>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
