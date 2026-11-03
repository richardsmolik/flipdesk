import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";

interface Summary {
  month: string;
  shop: string;
  requests: number;
  cost: number;
  listingsWritten: number;
  photosFixed: number;
  titlesRefreshed: number;
  helpAnswers: number;
  minutesSaved: number;
  minutesAssumed: Record<string, number>;
  costPerHourSaved: number | null;
  byProvider: { provider: string; name: string; calls: number; cost: number }[];
  perSale: { perSale: number | null; profitPerSale: number | null; shareOfProfit: number | null; sales: number };
  accuracy: { at: string; items: number; winner: string | null; scores: { who: string; typicalMiss: number | null; n: number }[] } | null;
  lessons: {
    titles: string | null;
    drops: string | null;
    rewrites: { rewritten: number; soldSince: number } | null;
    corrections: { provider: string; bias: number; n: number }[];
  };
}
const NAMES: Record<string, string> = { claude: "Claude", openai: "ChatGPT", gemini: "Gemini", kimi: "Kimi", deepseek: "DeepSeek" };
const hours = (m: number) => (m < 90 ? `${m} minutes` : `${(m / 60).toFixed(1)} hours`);

function Stat({ big, label }: { big: string; label: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 p-3 print:border-zinc-300">
      <div className="text-2xl font-semibold">{big}</div>
      <div className="text-xs text-zinc-400 print:text-zinc-600">{label}</div>
    </div>
  );
}

/** One page: what AI did for the shop this month, what it cost, how accurate it was, what FlipDesk learned. Printable. */
export default function AiReport() {
  const [s, setS] = useState<Summary | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => void api.get<Summary>("/api/ai/summary").then(setS, (e: Error) => setErr(e.message)), []);
  if (err) return <div className="text-red-400">{err}</div>;
  if (!s) return <div className="text-zinc-500">Putting it together…</div>;
  const month = new Date(`${s.month}-01T00:00:00Z`).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
  const best = s.accuracy?.scores.slice().sort((a, b) => (a.typicalMiss ?? 1e9) - (b.typicalMiss ?? 1e9))[0];
  const you = s.accuracy?.scores.find((x) => x.who === "Your list price");
  return (
    <div className="mx-auto max-w-3xl space-y-5 print:max-w-none print:text-black">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <Link to="/reports" className="text-xs text-zinc-500 hover:text-zinc-300 print:hidden">← Reports</Link>
          <h1 className="text-2xl font-semibold">🤖 AI in {month}</h1>
          <p className="text-sm text-zinc-400 print:text-zinc-600">{s.shop} · so far this month</p>
        </div>
        <button className="btn-primary print:hidden" onClick={() => window.print()}>Print or save as PDF</button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat big={hours(s.minutesSaved)} label="time saved (estimate)" />
        <Stat big={`$${s.cost.toFixed(2)}`} label={`spent on ${s.requests} AI requests`} />
        <Stat big={s.perSale.perSale !== null ? `$${s.perSale.perSale.toFixed(2)}` : "-"} label={`AI cost per sale (30 days)${s.perSale.shareOfProfit !== null ? `, ${s.perSale.shareOfProfit}% of profit` : ""}`} />
        <Stat big={best?.typicalMiss != null ? `${best.typicalMiss}%` : "-"} label={best ? `typical price miss (${best.who.split(" (")[0]})` : "price accuracy: run the test"} />
      </div>

      <section className="card space-y-2 p-4 print:border print:border-zinc-300">
        <h2 className="font-semibold">What it did</h2>
        <ul className="space-y-1 text-sm">
          <li>✍️ Wrote {s.listingsWritten} listing{s.listingsWritten === 1 ? "" : "s"}</li>
          {s.photosFixed > 0 && <li>📸 Fixed {s.photosFixed} photo{s.photosFixed === 1 ? "" : "s"}</li>}
          {s.titlesRefreshed > 0 && <li>🕰️ Suggested {s.titlesRefreshed} fresh title{s.titlesRefreshed === 1 ? "" : "s"} for old listings</li>}
          {s.helpAnswers > 0 && <li>❓ Answered {s.helpAnswers} help question{s.helpAnswers === 1 ? "" : "s"}</li>}
          {s.costPerHourSaved !== null && <li>⏱️ That's about ${s.costPerHourSaved.toFixed(2)} of AI per hour of your time saved</li>}
        </ul>
        {s.byProvider.length > 0 && <p className="text-xs text-zinc-400 print:text-zinc-600">By AI: {s.byProvider.map((p) => `${p.name} ${p.calls} ($${p.cost.toFixed(2)})`).join(" · ")}</p>}
        <p className="text-xs text-zinc-500 print:text-zinc-600">
          Time saved assumes {Object.entries(s.minutesAssumed).map(([k, m]) => `${m} min per ${k.replace("-", " ")}`).join(", ")} you'd otherwise do by hand.
        </p>
      </section>

      <section className="card space-y-2 p-4 print:border print:border-zinc-300">
        <h2 className="font-semibold">How accurate it was</h2>
        {s.accuracy ? (
          <>
            <p className="text-sm">
              On {s.accuracy.items} of your past sales (tested {new Date(s.accuracy.at).toLocaleDateString()}): {s.accuracy.winner ? <><b>{NAMES[s.accuracy.winner] ?? s.accuracy.winner}</b> priced closest</> : "no clear winner"}
              {best?.typicalMiss != null ? `, typically ${best.typicalMiss}% off the real sale price` : ""}{you?.typicalMiss != null ? ` (your own list prices: ${you.typicalMiss}%)` : ""}.
            </p>
            <ul className="text-xs text-zinc-400 print:text-zinc-600">
              {s.accuracy.scores.map((x) => <li key={x.who}>{x.who}: typically {x.typicalMiss}% off ({x.n} items)</li>)}
            </ul>
          </>
        ) : (
          <p className="text-sm text-zinc-500">Not tested yet: Reports → Which AI prices best?</p>
        )}
      </section>

      <section className="card space-y-2 p-4 print:border print:border-zinc-300">
        <h2 className="font-semibold">What FlipDesk learned</h2>
        <ul className="space-y-1 text-sm">
          {s.lessons.corrections.map((c) => <li key={c.provider}>🎯 {NAMES[c.provider] ?? c.provider} prices {Math.abs(c.bias)}% too {c.bias > 0 ? "high" : "low"} on your items, so its suggestions are adjusted.</li>)}
          {s.lessons.titles && <li>✍️ {s.lessons.titles}</li>}
          {s.lessons.rewrites && s.lessons.rewrites.rewritten > 0 && <li>🕰️ {s.lessons.rewrites.rewritten} old listings got fresh titles; {s.lessons.rewrites.soldSince} sold since.</li>}
          {s.lessons.drops && <li>📉 {s.lessons.drops}</li>}
          {!s.lessons.corrections.length && !s.lessons.titles && !s.lessons.drops && !(s.lessons.rewrites?.rewritten) && <li className="text-zinc-500">Nothing yet: lessons appear as you sell and run the tests on the Reports page.</li>}
        </ul>
      </section>
    </div>
  );
}
