import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, money } from "../api";
import { toast } from "../ui";

interface Task { key: string; icon: string; title: string; why: string; href: string; action?: { kind: "price"; itemId: number; price: number } }
interface TodayState { day: string; tasks: Task[]; more: number }

/** "Do these 3 things today": the most valuable jobs right now, with skip-for-today. */
export function TodayCard() {
  const [t, setT] = useState<TodayState | null>(null);
  useEffect(() => void api.get<TodayState>("/api/today").then(setT).catch(() => {}), []);
  if (!t) return null;
  if (!t.tasks.length)
    return <div className="card p-4 text-sm text-zinc-400">✅ <b className="text-zinc-200">All caught up.</b> Nothing urgent today. A good day to source or shoot new items.</div>;
  return (
    <div className="card p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="font-semibold">Today: do these {t.tasks.length}</h2>
        {t.more > 0 && <span className="text-xs text-zinc-500">+{t.more} more after these</span>}
      </div>
      <ol className="space-y-2">
        {t.tasks.map((x, i) => (
          <li key={x.key} className="flex items-start gap-3 rounded-md bg-zinc-900/60 p-2.5">
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-xs text-zinc-300">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <Link to={x.href} className="block text-sm font-medium text-zinc-100 hover:underline">{x.icon} {x.title}</Link>
              <div className="text-xs text-zinc-500">{x.why}</div>
            </div>
            <div className="flex shrink-0 gap-1">
              {x.action?.kind === "price" && (
                <button
                  className="btn-primary px-2 py-1 text-xs"
                  onClick={async () => {
                    setT(await api.post<TodayState>("/api/today/do", { key: x.key }));
                    toast(`Price set to ${money(x.action!.price)} everywhere`);
                  }}
                >
                  Do it
                </button>
              )}
              <button className="btn-ghost px-2 py-1 text-xs" title="Hide until tomorrow" onClick={async () => setT(await api.post<TodayState>("/api/today/skip", { key: x.key }))}>
                Skip
              </button>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

interface GoalRow { key: "listed" | "sales" | "profit"; target: number; done: number; pct: number; status: "done" | "on_track" | "behind"; left: number; perDay: number }
interface GoalState { goals: { listed?: number; sales?: number; profit?: number }; daysLeft: number; elapsedPct: number; rows: GoalRow[] }
const LABEL = { listed: "Items listed", sales: "Items sold", profit: "Profit" };
const show = (k: string, v: number) => (k === "profit" ? money(v) : String(v));

/** Weekly goals with a pace marker (where you should be by now). */
export function GoalsCard() {
  const [g, setG] = useState<GoalState | null>(null);
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState({ listed: "", sales: "", profit: "" });
  useEffect(() => void api.get<GoalState>("/api/goals").then(setG).catch(() => {}), []);
  if (!g) return null;
  const open = () => (setForm({ listed: String(g.goals.listed ?? ""), sales: String(g.goals.sales ?? ""), profit: String(g.goals.profit ?? "") }), setEdit(true));
  return (
    <div className="card p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="font-semibold">🎯 This week's goals</h2>
        <button className="text-xs text-zinc-400 hover:text-zinc-100" onClick={edit ? () => setEdit(false) : open}>{edit ? "Cancel" : g.rows.length ? "Edit" : "Set goals"}</button>
      </div>
      {edit ? (
        <form
          className="space-y-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const num = (s: string) => (s.trim() ? Number(s) : 0);
            setG(await api.put<GoalState>("/api/goals", { listed: num(form.listed), sales: num(form.sales), profit: num(form.profit) }));
            setEdit(false);
          }}
        >
          {(["listed", "sales", "profit"] as const).map((k) => (
            <label key={k} className="flex items-center justify-between gap-3 text-sm">
              <span className="text-zinc-300">{LABEL[k]}{k === "profit" ? " ($)" : ""}</span>
              <input className="input w-28 text-right" inputMode="numeric" placeholder="none" value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value.replace(/[^\d.]/g, "") })} />
            </label>
          ))}
          <p className="text-xs text-zinc-500">The week runs Monday to Sunday in your time zone (Settings → Weekly summary). Your Monday summary shows how you did.</p>
          <button className="btn-primary w-full">Save goals</button>
        </form>
      ) : !g.rows.length ? (
        <p className="text-sm text-zinc-500">Set a weekly target, like "list 30 items, $500 profit". FlipDesk tracks it and tells you each day what keeps you on pace.</p>
      ) : (
        <div className="space-y-3">
          {g.rows.map((r) => (
            <div key={r.key}>
              <div className="flex justify-between text-sm">
                <span className="text-zinc-300">{LABEL[r.key]}</span>
                <span className="tabular-nums text-zinc-100">
                  {show(r.key, r.done)} <span className="text-zinc-500">/ {show(r.key, r.target)}</span>
                </span>
              </div>
              <div className="relative mt-1 h-2 rounded bg-zinc-800">
                <div className={`h-2 rounded ${r.status === "done" ? "bg-green-500" : r.status === "on_track" ? "bg-brand" : "bg-amber-500"}`} style={{ width: `${r.pct}%` }} />
                <div className="absolute -top-0.5 h-3 w-0.5 bg-zinc-300" style={{ left: `${g.elapsedPct}%` }} title="Where you should be by now" />
              </div>
              <div className="mt-0.5 text-[11px] text-zinc-500">
                {r.status === "done" ? "Done! 🎉" : r.status === "on_track" ? "On pace" : `Behind. About ${show(r.key, r.perDay)} a day for the ${g.daysLeft} day${g.daysLeft === 1 ? "" : "s"} left`}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
