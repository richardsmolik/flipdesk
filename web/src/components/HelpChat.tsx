import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { api } from "../api";

interface Source { title: string; text: string; source: string }
interface Turn { role: "user" | "assistant"; content: string; sources?: Source[]; demo?: boolean; id?: number; rated?: boolean }

/** Tiny safe markdown: **bold**, `code`, [links](/path or https://), numbered/bulleted lines. No HTML. */
function Md({ text }: { text: string }) {
  const inline = (s: string, key: string): ReactNode[] => {
    const out: ReactNode[] = [];
    const re = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    let i = 0;
    while ((m = re.exec(s))) {
      if (m.index > last) out.push(s.slice(last, m.index));
      const k = `${key}-${i++}`;
      if (m[1]) out.push(<b key={k}>{m[1]}</b>);
      else if (m[2]) out.push(<code key={k} className="rounded bg-zinc-800 px-1">{m[2]}</code>);
      else if (m[4].startsWith("/")) out.push(<Link key={k} to={m[4]} className="text-brand underline">{m[3]}</Link>);
      else if (/^https:\/\//.test(m[4])) out.push(<a key={k} href={m[4]} target="_blank" rel="noreferrer noopener" className="text-brand underline">{m[3]}</a>);
      else out.push(m[3]);
      last = m.index + m[0].length;
    }
    if (last < s.length) out.push(s.slice(last));
    return out;
  };
  return (
    <div className="space-y-1">
      {text.split("\n").map((line, i) => {
        const l = line.trim();
        if (!l) return <Fragment key={i} />;
        const num = l.match(/^(\d+)\.\s+(.*)/);
        const bul = l.match(/^[-*]\s+(.*)/);
        const head = l.match(/^#{1,4}\s+(.*)/);
        if (num) return <div key={i} className="flex gap-2"><span className="text-zinc-500">{num[1]}.</span><span>{inline(num[2], `l${i}`)}</span></div>;
        if (bul) return <div key={i} className="flex gap-2"><span className="text-zinc-500">•</span><span>{inline(bul[1], `l${i}`)}</span></div>;
        if (head) return <div key={i} className="font-semibold">{inline(head[1], `l${i}`)}</div>;
        return <p key={i}>{inline(l, `l${i}`)}</p>;
      })}
    </div>
  );
}

const SUGGESTED = ["How do I crosslist to Poshmark?", "Why didn't my item delist?", "How do I print a label with Pirate Ship?", "How do I connect eBay?"];

/** "Ask FlipDesk": answers from FlipDesk's own docs. */
export function HelpChat({ compact }: { compact?: boolean }) {
  const loc = useLocation();
  const [turns, setTurns] = useState<Turn[]>(() => {
    try {
      return JSON.parse(sessionStorage.getItem("fd-help") ?? "[]");
    } catch {
      return [];
    }
  });
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    try {
      sessionStorage.setItem("fd-help", JSON.stringify(turns.slice(-20)));
    } catch {
      /* private mode */
    }
    end.current?.scrollIntoView({ block: "end" });
  }, [turns]);
  const ask = async (question: string) => {
    if (!question.trim() || busy) return;
    const history = turns.map((t) => ({ role: t.role, content: t.content }));
    setTurns((t) => [...t, { role: "user", content: question }]);
    setQ("");
    setBusy(true);
    try {
      const r = await api.post<{ answer: string | null; sources: Source[]; demo: boolean; id?: number }>("/api/help/ask", { question, page: loc.pathname, history });
      setTurns((t) => [...t, { role: "assistant", content: r.answer ?? (r.sources.length ? "Here's what the guide says:" : "I couldn't find that in the guide. Try other words, or send feedback."), sources: r.answer ? undefined : r.sources, demo: r.demo, id: r.id }]);
    } catch (e) {
      setTurns((t) => [...t, { role: "assistant", content: (e as Error).message }]);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`flex flex-col ${compact ? "h-full" : "min-h-[60vh]"}`}>
      <div className="flex-1 space-y-3 overflow-y-auto p-1">
        {!turns.length && (
          <div className="space-y-2 text-sm text-zinc-400">
            <p>Ask anything about using FlipDesk. Answers come from FlipDesk's own guide.</p>
            <div className="flex flex-wrap gap-1.5">
              {SUGGESTED.map((s) => (
                <button key={s} className="rounded-full border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:border-brand" onClick={() => ask(s)}>{s}</button>
              ))}
            </div>
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={t.role === "user" ? "ml-8 rounded-lg bg-blue-950/50 px-3 py-2 text-sm text-zinc-100" : "mr-4 text-sm text-zinc-200"}>
            {t.role === "user" ? t.content : <Md text={t.content} />}
            {t.sources?.map((s) => (
              <details key={s.title + s.source} className="mt-2 rounded-md border border-zinc-800 p-2">
                <summary className="cursor-pointer text-zinc-100">{s.title} <span className="text-xs text-zinc-500">· {s.source}</span></summary>
                <div className="mt-1 text-xs text-zinc-400"><Md text={s.text.replace(/\|/g, " ")} /></div>
              </details>
            ))}
            {t.demo && t.role === "assistant" && <div className="mt-1 text-[11px] text-zinc-500">AI answers need an Anthropic key on the server; showing the guide instead.</div>}
            {t.role === "assistant" && t.id && (
              <div className="mt-1 flex items-center gap-2 text-[11px] text-zinc-500">
                {t.rated ? (
                  "Thanks for the feedback"
                ) : (
                  <>
                    Did this help?
                    {[true, false].map((h) => (
                      <button
                        key={String(h)}
                        className="rounded px-1 hover:bg-zinc-800"
                        aria-label={h ? "Yes, helpful" : "No, not helpful"}
                        onClick={() => {
                          void api.post("/api/help/feedback", { id: t.id, helpful: h }).catch(() => {});
                          setTurns((all) => all.map((x) => (x === t ? { ...x, rated: true } : x)));
                        }}
                      >
                        {h ? "👍" : "👎"}
                      </button>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        ))}
        {busy && <div className="text-sm text-zinc-500">Looking it up…</div>}
        <div ref={end} />
      </div>
      <form className="mt-2 flex gap-2" onSubmit={(e) => (e.preventDefault(), void ask(q))}>
        <input className="input flex-1" maxLength={1000} placeholder="Ask a question…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn-primary" disabled={busy || !q.trim()}>Ask</button>
      </form>
      {turns.length > 0 && (
        <div className="mt-1 flex justify-between text-[11px] text-zinc-500">
          <button onClick={() => setTurns([])}>Start over</button>
          <span>Still stuck? 💬 Send feedback in the sidebar.</span>
        </div>
      )}
    </div>
  );
}

/** Floating "Help" button (desktop) with a slide-in panel. On phones, Help lives in More → Help. */
export function HelpButton() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const f = () => setOpen(true);
    window.addEventListener("fd-help", f);
    return () => window.removeEventListener("fd-help", f);
  }, []);
  return (
    <>
      {!open && (
        <button className="fixed bottom-5 right-5 z-40 hidden rounded-full bg-brand px-4 py-2 text-sm font-medium text-white shadow-lg hover:brightness-110 md:block" onClick={() => setOpen(true)}>
          ❓ Help
        </button>
      )}
      {open && (
        <div className="fixed bottom-5 right-5 z-50 flex h-[70vh] w-[min(420px,calc(100vw-2.5rem))] flex-col rounded-xl border border-zinc-700 bg-zinc-900 p-3 shadow-2xl" role="dialog" aria-label="Ask FlipDesk">
          <div className="mb-2 flex items-center justify-between">
            <b>❓ Ask FlipDesk</b>
            <button className="text-zinc-400 hover:text-zinc-100" aria-label="Close" onClick={() => setOpen(false)}>✕</button>
          </div>
          <div className="min-h-0 flex-1"><HelpChat compact /></div>
        </div>
      )}
    </>
  );
}
