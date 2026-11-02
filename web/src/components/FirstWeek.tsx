import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";

interface Step { day: number; key: string; title: string; how: string; href: string; done: boolean }
interface FW { show: boolean; day?: number; steps?: Step[]; today?: Step | null; doneCount?: number }

/** "Your first week": today's one small step, with the whole plan a tap away. */
export function FirstWeekCard() {
  const [f, setF] = useState<FW | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => void api.get<FW>("/api/first-week").then(setF).catch(() => {}), []);
  if (!f?.show || !f.steps) return null;
  return (
    <div className="card space-y-3 border-emerald-900 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">🌱 Your first week <span className="text-sm font-normal text-zinc-400">day {f.day} of 7 · {f.doneCount} done</span></h2>
        <div className="flex gap-3 text-xs text-zinc-400">
          <button className="hover:text-zinc-100" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "Hide plan" : "Whole plan"}</button>
          <button className="hover:text-zinc-100" onClick={async () => setF(await api.post<FW>("/api/first-week/hide"))}>Dismiss</button>
        </div>
      </div>
      <div className="flex gap-1" aria-hidden>
        {f.steps.map((s) => <div key={s.key} className={`h-1.5 flex-1 rounded ${s.done ? "bg-emerald-500" : s.day <= (f.day ?? 1) ? "bg-amber-600" : "bg-zinc-800"}`} />)}
      </div>
      {f.today && !open && (
        <Link to={f.today.href} className="flex items-start gap-3 rounded-md bg-emerald-950/30 p-3 ring-1 ring-emerald-900 hover:bg-emerald-950/50">
          <span className="text-xs text-emerald-300">Day {f.today.day}</span>
          <span className="min-w-0">
            <span className="block text-sm font-medium text-zinc-100">{f.today.title} →</span>
            <span className="block text-xs text-zinc-400">{f.today.how}</span>
          </span>
        </Link>
      )}
      {open && (
        <ol className="space-y-1.5">
          {f.steps.map((s) => (
            <li key={s.key}>
              <Link to={s.href} className={`flex items-start gap-3 rounded-md p-2 hover:bg-zinc-900 ${s === f.today ? "ring-1 ring-emerald-900" : ""}`}>
                <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] ${s.done ? "bg-emerald-900 text-emerald-200" : "bg-zinc-800 text-zinc-400"}`}>{s.done ? "✓" : s.day}</span>
                <span className="min-w-0">
                  <span className={`block text-sm ${s.done ? "text-zinc-500 line-through" : "text-zinc-100"}`}>{s.title}</span>
                  {!s.done && <span className="block text-xs text-zinc-500">{s.how}</span>}
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
