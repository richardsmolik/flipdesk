import { useEffect, useState } from "react";
import { api } from "../api";
import { toast } from "../ui";

type Id = "claude" | "openai" | "gemini" | "kimi" | "deepseek";
interface Provider { id: Id; name: string; note: string; signup: string; keyEnv: string; ready: boolean; keySource: "env" | "settings" | null; keyHint: string | null; model: string; price: [number, number] }
interface Row { k: string | number | null; calls: number; cost: number }
interface Overview {
  providers: Provider[];
  routing: { order: Id[]; textOrder: Id[]; models: Partial<Record<Id, string>> };
  plan: { photos: Id[]; text: Id[] };
  budget: { monthly: number | null; perMember: number | null };
  spent: { month: number; byProvider: Row[]; byTask: Row[]; byMember: Row[] };
}
const money = (n: number) => (n < 0.01 && n > 0 ? "<$0.01" : `$${n.toFixed(2)}`);
const short = (name: string) => name.split(" (")[0];

/** Owner: which AIs FlipDesk uses (and in what order), their keys and models, and the monthly AI budget. */
export default function AiSettings({ hosted }: { hosted: boolean }) {
  const [o, setO] = useState<Overview | null>(null);
  const [keys, setKeys] = useState<Partial<Record<Id, string>>>({});
  const [models, setModels] = useState<Partial<Record<Id, { list: string[]; auto: string | null }>>>({});
  const [tests, setTests] = useState<Partial<Record<Id, string>>>({});
  const [budget, setBudget] = useState({ monthly: "", perMember: "" });
  useEffect(() => {
    api.get<Overview>("/api/ai").then((x) => {
      setO(x);
      setBudget({ monthly: x.budget.monthly?.toString() ?? "", perMember: x.budget.perMember?.toString() ?? "" });
    }, () => setO(null));
  }, []);
  if (!o) return null;
  const order: Id[] = o.routing.order.length ? o.routing.order : o.providers.filter((p) => p.ready).map((p) => p.id);
  const saveRouting = async (patch: Partial<{ order: Id[]; textOrder: Id[]; models: Partial<Record<Id, string>>; prices: Partial<Record<Id, [number, number]>> }>) => {
    try {
      setO(await api.put<Overview>("/api/ai/routing", { order, ...patch }));
    } catch (e) {
      toast((e as Error).message, "err");
    }
  };
  const move = (id: Id, d: -1 | 1) => {
    const next = [...order];
    const i = next.indexOf(id);
    if (i < 0 || i + d < 0 || i + d >= next.length) return;
    [next[i], next[i + d]] = [next[i + d], next[i]];
    void saveRouting({ order: next });
  };
  const toggle = (id: Id, on: boolean) => void saveRouting({ order: on ? [...order, id] : order.filter((x) => x !== id) });
  const cheapestText = o.routing.textOrder.length > 0;

  return (
    <section className="card space-y-4 p-4">
      <div>
        <h2 className="font-semibold">🤖 AI</h2>
        <p className="text-sm text-zinc-400">
          FlipDesk can use Claude, ChatGPT, Gemini (Google AI Studio), Kimi or DeepSeek. Each request goes to the first one in your list. If it fails, the next one takes over by itself.
        </p>
      </div>

      <div className="space-y-2">
        <div className="text-sm font-medium">In use, in this order</div>
        {order.length ? (
          <ol className="space-y-1">
            {order.map((id, i) => {
              const p = o.providers.find((x) => x.id === id)!;
              return (
                <li key={id} className="flex flex-wrap items-center gap-2 rounded-md border border-zinc-800 px-2 py-1 text-sm">
                  <span className="w-5 text-zinc-500">{i + 1}.</span>
                  <span className="min-w-0 flex-1">{p.name}{!p.ready && <span className="text-xs text-amber-300"> · needs a key</span>}</span>
                  <button className="btn-ghost px-2 py-0.5 text-xs" aria-label="Move up" disabled={i === 0} onClick={() => move(id, -1)}>↑</button>
                  <button className="btn-ghost px-2 py-0.5 text-xs" aria-label="Move down" disabled={i === order.length - 1} onClick={() => move(id, 1)}>↓</button>
                  <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => toggle(id, false)}>Don't use</button>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="text-sm text-amber-300">No AI is set up yet: FlipDesk uses its demo writer. Add a key below.</p>
        )}
        <p className="text-xs text-zinc-500">
          Photos (listing writer, photo fixes, store scanner): {o.plan.photos.map((x) => short(o.providers.find((p) => p.id === x)!.name)).join(" → ") || "none"} · Text (help answers, announcements):{" "}
          {o.plan.text.map((x) => short(o.providers.find((p) => p.id === x)!.name)).join(" → ") || "none"}
        </p>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={cheapestText}
            onChange={(e) => {
              const byPrice = [...order].sort((a, b) => {
                const pa = o.providers.find((p) => p.id === a)!.price;
                const pb = o.providers.find((p) => p.id === b)!.price;
                return pa[0] + pa[1] - (pb[0] + pb[1]);
              });
              void saveRouting({ textOrder: e.target.checked ? byPrice : [] });
            }}
          />
          <span>
            Cheapest first for text-only jobs
            <span className="block text-xs text-zinc-500">Help answers and announcements don't need the best photo reader, so they go to the cheapest AI you have.</span>
          </span>
        </label>
      </div>

      <div className="space-y-3">
        {o.providers.map((p) => (
          <div key={p.id} className="space-y-2 rounded-md border border-zinc-800 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{p.name}</span>
              {p.ready ? <span className="text-xs text-green-400">✓ key {p.keySource === "env" ? "set on the server" : `saved ${p.keyHint ?? ""}`}</span> : <span className="text-xs text-zinc-500">no key</span>}
              {!order.includes(p.id) && p.ready && <button className="btn-ghost ml-auto px-2 py-0.5 text-xs" onClick={() => toggle(p.id, true)}>Use it</button>}
            </div>
            <p className="text-xs text-zinc-400">{p.note}</p>
            {p.keySource !== "env" && (
              <div className="flex flex-wrap gap-2">
                <input className="input min-w-0 flex-1 font-mono text-xs" type="password" autoComplete="off" placeholder={p.ready ? "Paste a new key to replace it" : `Paste your ${short(p.name)} API key`} value={keys[p.id] ?? ""} onChange={(e) => setKeys({ ...keys, [p.id]: e.target.value })} />
                <button
                  className="btn-primary text-xs"
                  disabled={!keys[p.id]?.trim()}
                  onClick={async () => {
                    const x = await api.put<Overview>(`/api/ai/keys/${p.id}`, { key: keys[p.id] });
                    setO(x);
                    setKeys({ ...keys, [p.id]: "" });
                    toast(`${short(p.name)} key saved`);
                    if (!x.routing.order.includes(p.id) && x.routing.order.length) toast("Press “Use it” to add it to the list");
                  }}
                >
                  Save
                </button>
                {p.keySource === "settings" && <button className="btn-ghost text-xs" onClick={async () => setO(await api.put<Overview>(`/api/ai/keys/${p.id}`, { key: "" }))}>Remove</button>}
                <a className="btn-ghost text-xs" href={p.signup} target="_blank" rel="noreferrer">Get a key ↗</a>
              </div>
            )}
            {p.keySource === "env" && <p className="text-xs text-zinc-500">Set with <code>{p.keyEnv}</code> on the server.</p>}
            {p.ready && (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-zinc-400">Model</span>
                {p.id === "claude" ? (
                  <span className="font-mono">{p.model || "claude-opus-5-5"}</span>
                ) : models[p.id] ? (
                  <select className="input w-auto py-1 text-xs" value={p.model} onChange={(e) => void saveRouting({ models: { [p.id]: e.target.value } })}>
                    <option value="">Automatic ({models[p.id]!.auto ?? "none found"})</option>
                    {models[p.id]!.list.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                ) : (
                  <>
                    <span className="font-mono">{p.model || "automatic"}</span>
                    <button
                      className="btn-ghost px-2 py-0.5 text-xs"
                      onClick={async () => {
                        try {
                          const r = await api.get<{ models: string[]; auto: string | null }>(`/api/ai/models/${p.id}`);
                          setModels({ ...models, [p.id]: { list: r.models, auto: r.auto } });
                        } catch (e) {
                          toast((e as Error).message, "err");
                        }
                      }}
                    >
                      Choose…
                    </button>
                  </>
                )}
                <button
                  className="btn-ghost px-2 py-0.5 text-xs"
                  onClick={async () => {
                    setTests({ ...tests, [p.id]: "Testing…" });
                    try {
                      const r = await api.post<{ ok: boolean; ms: number; model: string }>(`/api/ai/test/${p.id}`);
                      setTests({ ...tests, [p.id]: r.ok ? `✓ Works (${r.model}, ${(r.ms / 1000).toFixed(1)} s)` : "✕ Answered, but not as expected" });
                    } catch (e) {
                      setTests({ ...tests, [p.id]: `✕ ${(e as Error).message}` });
                    }
                  }}
                >
                  Test
                </button>
                {tests[p.id] && <span className={tests[p.id]!.startsWith("✓") ? "text-green-400" : tests[p.id]!.startsWith("✕") ? "text-red-400" : "text-zinc-400"}>{tests[p.id]}</span>}
              </div>
            )}
            {p.ready && (
              <details className="text-xs text-zinc-400">
                <summary className="cursor-pointer">Price used for spending: ${p.price[0]} in / ${p.price[1]} out per million tokens</summary>
                <form
                  className="mt-2 flex flex-wrap items-end gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    const pi = Number(f.get("in"));
                    const po = Number(f.get("out"));
                    if (!(pi >= 0 && po >= 0)) return toast("Use numbers like 2.5", "err");
                    void saveRouting({ prices: { [p.id]: [pi, po] } }).then(() => toast("Saved"));
                  }}
                >
                  <label>In <input name="in" className="input w-20 py-1 text-xs" inputMode="decimal" defaultValue={p.price[0]} /></label>
                  <label>Out <input name="out" className="input w-20 py-1 text-xs" inputMode="decimal" defaultValue={p.price[1]} /></label>
                  <button className="btn-ghost px-2 py-1 text-xs">Save</button>
                  <span className="basis-full">Check the provider's pricing page; set what you pay for the model you use.</span>
                </form>
              </details>
            )}
          </div>
        ))}
      </div>

      <div className="space-y-2 border-t border-zinc-800 pt-3">
        <div className="text-sm font-medium">💸 Spending this month: {money(o.spent.month)}{o.budget.monthly !== null && ` of $${o.budget.monthly}`}</div>
        {o.budget.monthly !== null && (
          <div className="h-2 overflow-hidden rounded bg-zinc-800" role="img" aria-label={`${Math.round((o.spent.month / Math.max(0.01, o.budget.monthly)) * 100)}% of the budget used`}>
            <div className={`h-full ${o.spent.month >= o.budget.monthly * 0.8 ? "bg-amber-400" : "bg-brand"}`} style={{ width: `${Math.min(100, (o.spent.month / Math.max(0.01, o.budget.monthly)) * 100)}%` }} />
          </div>
        )}
        <div className="flex flex-wrap items-end gap-2 text-sm">
          <label className="space-y-1">
            <span className="block text-xs text-zinc-400">Monthly limit ($, blank = none)</span>
            <input className="input w-32" inputMode="decimal" value={budget.monthly} onChange={(e) => setBudget({ ...budget, monthly: e.target.value })} />
          </label>
          {hosted && (
            <label className="space-y-1">
              <span className="block text-xs text-zinc-400">Per member per month ($)</span>
              <input className="input w-32" inputMode="decimal" value={budget.perMember} onChange={(e) => setBudget({ ...budget, perMember: e.target.value })} />
            </label>
          )}
          <button
            className="btn-primary"
            onClick={async () => {
              const num = (v: string) => (v.trim() === "" ? null : Number(v));
              const b = { monthly: num(budget.monthly), perMember: num(budget.perMember) };
              if ([b.monthly, b.perMember].some((x) => x !== null && !(x >= 0))) return toast("Use a number like 20 or 7.50", "err");
              setO(await api.put<Overview>("/api/ai/budget", b));
              toast("Saved");
            }}
          >
            Save limits
          </button>
        </div>
        <p className="text-xs text-zinc-500">You get an alert at 80% and at 100%. At the limit AI features pause until the 1st (writing and listing by hand still work).{hosted ? " The per-member limit doesn't apply to you." : ""} Costs are estimates from each AI's token counts and list prices.</p>
        {(o.spent.byProvider.length > 0 || o.spent.byTask.length > 0) && (
          <div className="grid gap-3 text-xs sm:grid-cols-3">
            {[
              ["By AI", o.spent.byProvider.map((r) => ({ ...r, k: short(o.providers.find((p) => p.id === r.k)?.name ?? String(r.k)) }))],
              ["By feature", o.spent.byTask],
              ...(hosted ? [["By member", o.spent.byMember] as const] : []),
            ].map(([title, rows]) => (
              <div key={title as string}>
                <div className="mb-1 text-zinc-400">{title as string}</div>
                <ul className="space-y-0.5">
                  {(rows as Row[]).slice(0, 6).map((r) => (
                    <li key={String(r.k)} className="flex justify-between gap-2"><span className="truncate">{String(r.k)}</span><span className="text-zinc-400">{money(r.cost)} · {r.calls}</span></li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
