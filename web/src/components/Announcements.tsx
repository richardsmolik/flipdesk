import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";

interface Ann { id: number; title: string; body: string; link: string }

/** Owner's announcements, shown once at the top of the dashboard until closed. */
export function AnnouncementBar() {
  const [list, setList] = useState<Ann[]>([]);
  useEffect(() => void api.get<Ann[]>("/api/announcements").then(setList).catch(() => {}), []);
  const close = (id: number) => (setList((l) => l.filter((a) => a.id !== id)), void api.post(`/api/announcements/${id}/dismiss`).catch(() => {}));
  if (!list.length) return null;
  return (
    <div className="space-y-2">
      {list.map((a) => (
        <div key={a.id} className="flex items-start gap-3 rounded-lg border border-sky-900 bg-sky-950/40 px-4 py-3 text-sm">
          <span aria-hidden>📣</span>
          <div className="min-w-0 flex-1">
            <div className="font-medium text-zinc-100">{a.title}</div>
            {a.body && <div className="whitespace-pre-wrap text-zinc-300">{a.body}</div>}
            {a.link &&
              (a.link.startsWith("/") ? (
                <Link to={a.link} className="text-brand hover:underline" onClick={() => close(a.id)}>Take a look →</Link>
              ) : (
                <a href={a.link} target="_blank" rel="noreferrer noopener" className="text-brand hover:underline">Learn more ↗</a>
              ))}
          </div>
          <button className="text-zinc-500 hover:text-zinc-200" aria-label="Close" onClick={() => close(a.id)}>✕</button>
        </div>
      ))}
    </div>
  );
}
