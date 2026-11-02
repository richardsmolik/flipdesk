import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { MpBadge, toast, useMarketplaces } from "../ui";
import { switchShop } from "./Account";

export interface OnboardingState {
  showWelcome: boolean;
  dismissed: boolean;
  checklistHidden: boolean;
  defaultMarketplaces: string[];
  steps: { key: string; label: string; done: boolean; detail: string; href: string; how: string[] }[];
  doneCount: number;
  total: number;
  complete: boolean;
}

const SELLS: [string, string][] = [
  ["clothing", "👕 Clothing & shoes"],
  ["electronics", "🎧 Electronics"],
  ["collectibles", "🃏 Collectibles & toys"],
  ["home", "🏺 Home & vintage"],
  ["books", "📚 Books & media"],
  ["everything", "🧺 A bit of everything"],
];
const EXPERIENCE: [string, string, string][] = [
  ["new", "Just starting", "Under a year"],
  ["growing", "Side hustle", "Selling regularly"],
  ["fulltime", "Full-time", "This is my job"],
];

/** First-run welcome: 3 questions that set your defaults. Shown once; "Skip" hides it. */
export function Welcome({ onDone }: { onDone: (s: OnboardingState) => void }) {
  const { marketplaces } = useMarketplaces();
  const [mps, setMps] = useState<string[]>(["ebay"]);
  const [sells, setSells] = useState<string[]>([]);
  const [exp, setExp] = useState("growing");
  const toggle = (list: string[], set: (x: string[]) => void, v: string) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/80 p-4">
      <div className="card max-h-[92vh] w-full max-w-xl space-y-5 overflow-y-auto bg-zinc-900 p-6">
        <div>
          <div className="text-2xl font-bold">Welcome to 📦 Flip<span className="text-brand">Desk</span></div>
          <p className="mt-1 text-sm text-zinc-400">Three quick questions so FlipDesk fits how you sell. You can change any of this later in Settings.</p>
        </div>
        <section>
          <h2 className="mb-2 text-sm font-semibold">1. Where do you sell (or want to)?</h2>
          <div className="flex flex-wrap gap-1.5">
            {marketplaces.map((m) => (
              <button key={m.id} onClick={() => toggle(mps, setMps, m.id)} className={`rounded-full border px-1 py-0.5 ${mps.includes(m.id) ? "border-brand bg-blue-950/50" : "border-zinc-800"}`} aria-pressed={mps.includes(m.id)}>
                <MpBadge id={m.id} mp={m} />
              </button>
            ))}
          </div>
        </section>
        <section>
          <h2 className="mb-2 text-sm font-semibold">2. What do you mostly sell?</h2>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
            {SELLS.map(([v, l]) => (
              <button key={v} onClick={() => toggle(sells, setSells, v)} className={`rounded-md border px-2 py-2 text-left text-sm ${sells.includes(v) ? "border-brand bg-blue-950/50" : "border-zinc-800 text-zinc-300"}`} aria-pressed={sells.includes(v)}>{l}</button>
            ))}
          </div>
        </section>
        <section>
          <h2 className="mb-2 text-sm font-semibold">3. How long have you been reselling?</h2>
          <div className="grid grid-cols-3 gap-1.5">
            {EXPERIENCE.map(([v, l, d]) => (
              <button key={v} onClick={() => setExp(v)} className={`rounded-md border px-2 py-2 text-left ${exp === v ? "border-brand bg-blue-950/50" : "border-zinc-800"}`} aria-pressed={exp === v}>
                <div className="text-sm">{l}</div>
                <div className="text-[11px] text-zinc-500">{d}</div>
              </button>
            ))}
          </div>
        </section>
        <div className="flex gap-2">
          <button
            className="btn-primary flex-1 py-2.5"
            disabled={!mps.length}
            onClick={async () => {
              const s = await api.post<OnboardingState>("/api/onboarding/profile", { marketplaces: mps, sells, experience: exp });
              toast("You're set up. Here's your checklist to get selling.");
              onDone(s);
            }}
          >
            Let's go →
          </button>
          <button className="btn-ghost" onClick={async () => onDone(await api.post<OnboardingState>("/api/onboarding/dismiss", { dismissed: true }))}>Skip for now</button>
        </div>
        <div className="rounded-md border border-zinc-800 bg-zinc-950/60 p-3 text-sm">
          <b>Just looking?</b> <span className="text-zinc-400">Open a sample shop with 30+ items, sales, an oversell and orders to ship. Try everything, then come back here to set up yours.</span>
          <button className="btn-ghost mt-2 w-full" onClick={() => switchShop("enter_demo")}>🧪 Open the sample shop</button>
        </div>
      </div>
    </div>
  );
}

/** Dashboard checklist; steps tick themselves off from real activity. */
export function GetStarted({ onWelcome }: { onWelcome: () => void }) {
  const [s, setS] = useState<OnboardingState | null>(null);
  const [how, setHow] = useState<string | null>(null);
  const [videos, setVideos] = useState<Record<string, string>>({});
  useEffect(() => void api.get<Record<string, string>>("/api/help-videos").then(setVideos).catch(() => {}), []);
  useEffect(() => void api.get<OnboardingState>("/api/onboarding").then(setS).catch(() => {}), []);
  if (!s || s.complete || s.checklistHidden) return null;
  const next = s.steps.find((x) => !x.done);
  return (
    <div className="card space-y-3 border-blue-900 p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">🚀 Get started <span className="text-sm font-normal text-zinc-400">{s.doneCount} of {s.total} done</span></h2>
        <button className="text-xs text-zinc-500 hover:text-zinc-200" onClick={() => (void api.post("/api/onboarding/dismiss", { checklist: true }), setS({ ...s, checklistHidden: true }))}>Hide</button>
      </div>
      <div className="h-1.5 rounded bg-zinc-800"><div className="h-1.5 rounded bg-brand transition-all" style={{ width: `${(s.doneCount / s.total) * 100}%` }} /></div>
      <ol className="grid gap-1.5 md:grid-cols-2">
        {s.steps.map((st) => {
          const isNext = st === next;
          const inner = (
            <>
              <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] ${st.done ? "bg-green-900 text-green-200" : isNext ? "bg-brand text-white" : "bg-zinc-800 text-zinc-400"}`}>{st.done ? "✓" : "•"}</span>
              <span className="min-w-0">
                <span className={`block text-sm ${st.done ? "text-zinc-500 line-through" : "text-zinc-100"}`}>{st.label}</span>
                {!st.done && <span className="block text-xs text-zinc-500">{st.detail}</span>}
              </span>
            </>
          );
          const cls = `flex items-start gap-2 rounded-md p-2 ${isNext ? "bg-blue-950/30 ring-1 ring-blue-900" : "hover:bg-zinc-900"}`;
          return (
            <li key={st.key}>
              {st.href === "#welcome" ? <button className={`${cls} w-full text-left`} onClick={onWelcome}>{inner}</button> : <Link to={st.href} className={cls}>{inner}</Link>}
              {!st.done && st.how?.length > 0 && (
                <div className="ml-9">
                  <button className="text-xs text-brand hover:underline" onClick={() => setHow(how === st.key ? null : st.key)} aria-expanded={how === st.key}>
                    {how === st.key ? "Hide steps" : "Show me how"}
                  </button>
                  {videos[st.key] && (
                    <a className="ml-3 text-xs text-brand hover:underline" href={videos[st.key]} target="_blank" rel="noreferrer noopener">▶ Watch</a>
                  )}
                  {how === st.key && (
                    <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-xs text-zinc-400">
                      {st.how.map((h) => <li key={h}>{h}</li>)}
                    </ol>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
