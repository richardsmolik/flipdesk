import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, uploadWithProgress, type Item } from "../api";
import { toast } from "../ui";
import FileThumb from "../components/FileThumb";

/**
 * Bulk upload: drop a folder (or a pile of photos) for many items at once.
 * FlipDesk splits them into items - one folder per item, by time taken (a pause between items),
 * or every N photos - you fix any splits, then it creates drafts (and can write them with AI).
 */
type Mode = "folder" | "time" | "count";
interface P { key: string; file: File; folder: string; time: number }
interface Group { photos: P[]; cost: string; qty: string }
type Status = { state: "waiting" | "uploading" | "writing" | "done" | "error"; pct?: number; itemId?: number; error?: string };

const IMG = /\.(jpe?g|png|webp|gif|heic|heif|avif)$/i;

function autoGroup(ps: P[], mode: Mode, gapSec: number, perItem: number): P[][] {
  if (!ps.length) return [];
  if (mode === "folder") {
    const by = new Map<string, P[]>();
    for (const p of ps) by.set(p.folder, [...(by.get(p.folder) ?? []), p]);
    return [...by.values()].map((g) => g.sort((a, b) => a.time - b.time || a.file.name.localeCompare(b.file.name)));
  }
  const sorted = [...ps].sort((a, b) => a.time - b.time || a.file.name.localeCompare(b.file.name));
  if (mode === "count") {
    const out: P[][] = [];
    for (let i = 0; i < sorted.length; i += perItem) out.push(sorted.slice(i, i + perItem));
    return out;
  }
  const out: P[][] = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].time - sorted[i - 1].time > gapSec * 1000) out.push([]);
    out[out.length - 1].push(sorted[i]);
  }
  return out;
}

export default function Bulk() {
  const [photos, setPhotos] = useState<P[]>([]);
  const [mode, setMode] = useState<Mode>("time");
  const [gap, setGap] = useState(60);
  const [perItem, setPerItem] = useState(4);
  const [groups, setGroups] = useState<Group[]>([]);
  const [useAi, setUseAi] = useState(true);
  const [defaultCost, setDefaultCost] = useState("");
  const [status, setStatus] = useState<Record<number, Status>>({});
  const [running, setRunning] = useState(false);
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const regroup = (ps: P[], m = mode, g = gap, n = perItem) => setGroups(autoGroup(ps, m, g, n).map((photos) => ({ photos, cost: "", qty: "1" })));
  const add = (list: FileList | File[]) => {
    const fresh = Array.from(list)
      .filter((f) => IMG.test(f.name) || f.type.startsWith("image/"))
      .map((f) => {
        const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || "";
        const folder = rel.includes("/") ? rel.split("/").slice(0, -1).join("/") : "(no folder)";
        return { key: `${f.name}-${f.size}-${f.lastModified}`, file: f, folder, time: f.lastModified };
      });
    const all = [...photos, ...fresh.filter((f) => !photos.some((p) => p.key === f.key))];
    const folders = new Set(all.map((p) => p.folder));
    const m: Mode = folders.size > 1 ? "folder" : mode === "folder" ? "time" : mode;
    setMode(m);
    setPhotos(all);
    regroup(all, m);
  };

  const splitAt = (gi: number, pi: number) =>
    setGroups((gs) => (pi === 0 ? gs : [...gs.slice(0, gi), { ...gs[gi], photos: gs[gi].photos.slice(0, pi) }, { photos: gs[gi].photos.slice(pi), cost: "", qty: "1" }, ...gs.slice(gi + 1)]));
  const mergeUp = (gi: number) => setGroups((gs) => (gi === 0 ? gs : [...gs.slice(0, gi - 1), { ...gs[gi - 1], photos: [...gs[gi - 1].photos, ...gs[gi].photos] }, ...gs.slice(gi + 1)]));
  const moveToPrev = (gi: number, pi: number) =>
    setGroups((gs) => {
      if (gi === 0) return gs;
      const p = gs[gi].photos[pi];
      const next = gs.map((g, i) => (i === gi - 1 ? { ...g, photos: [...g.photos, p] } : i === gi ? { ...g, photos: g.photos.filter((_, k) => k !== pi) } : g));
      return next.filter((g) => g.photos.length);
    });
  const removePhoto = (gi: number, pi: number) => setGroups((gs) => gs.map((g, i) => (i === gi ? { ...g, photos: g.photos.filter((_, k) => k !== pi) } : g)).filter((g) => g.photos.length));

  const total = useMemo(() => groups.reduce((a, g) => a + g.photos.length, 0), [groups]);

  const run = async () => {
    setRunning(true);
    const queue = groups.map((g, i) => ({ g, i }));
    const work = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const { g, i } = next;
        const set = (s: Status) => setStatus((st) => ({ ...st, [i]: { ...st[i], ...s } }));
        try {
          set({ state: "uploading", pct: 0 });
          const qty = Math.max(1, Number(g.qty) || 1);
          const item = await api.post<Item>("/api/items", { cost: Number(g.cost || defaultCost) || 0, quantity: qty, quantity_purchased: qty });
          const fd = new FormData();
          g.photos.forEach((p) => fd.append("photos", p.file, p.file.name));
          await uploadWithProgress<Item>(`/api/items/${item.id}/photos`, fd, (pct) => set({ state: "uploading", pct }));
          if (useAi) {
            set({ state: "writing", itemId: item.id });
            const ai = new FormData();
            ai.append("itemId", String(item.id));
            if (g.cost || defaultCost) ai.append("cost", g.cost || defaultCost);
            const r = await api.post<{ draft: { title: string; description: string; brand: string; category: string; condition: string; color: string; size: string; item_specifics: { name: string; value: string }[]; keywords: string[]; price: { recommended: number; quick_sale: number } } }>("/api/ai/generate", ai);
            const d = r.draft;
            await api.patch(`/api/items/${item.id}`, {
              title: d.title, description: d.description, brand: d.brand, category: d.category, condition: d.condition, color: d.color, size: d.size,
              specifics: Object.fromEntries(d.item_specifics.map((s) => [s.name, s.value])), keywords: d.keywords,
              price: d.price.recommended, min_price: Math.round(d.price.quick_sale * 0.9 * 100) / 100,
            });
          }
          set({ state: "done", itemId: item.id });
        } catch (e) {
          set({ state: "error", error: (e as Error).message });
        }
      }
    };
    await Promise.all([work(), work()]); // two at a time
    setRunning(false);
    toast("Bulk upload finished - review your drafts");
  };

  const done = Object.values(status).filter((s) => s.state === "done").length;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Bulk upload</h1>
        <p className="max-w-3xl text-sm text-zinc-400">Shoot all your items, then drop every photo here at once. FlipDesk splits them into items: one folder per item, or by the pause between items while you shoot. Fix any splits, then create the drafts (AI can write them all).</p>
      </div>

      <div
        className="card flex min-h-36 flex-col items-center justify-center gap-3 border-dashed p-6 text-center"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => (e.preventDefault(), add(e.dataTransfer.files))}
      >
        <div className="text-3xl">🗂️</div>
        <div className="text-sm text-zinc-300">Drop photos or folders here</div>
        <div className="flex gap-2">
          <input ref={filesInput} type="file" multiple accept="image/*,.heic,.heif" hidden onChange={(e) => e.target.files && add(e.target.files)} />
          <input ref={folderInput} type="file" multiple hidden {...({ webkitdirectory: "", directory: "" } as Record<string, string>)} onChange={(e) => e.target.files && add(e.target.files)} />
          <button className="btn-ghost" onClick={() => filesInput.current?.click()}>Choose photos</button>
          <button className="btn-ghost" onClick={() => folderInput.current?.click()}>Choose a folder</button>
        </div>
        <div className="text-xs text-zinc-500">iPhone (HEIC) photos are fine; they're converted automatically.</div>
      </div>

      {photos.length > 0 && (
        <div className="card flex flex-wrap items-center gap-3 p-3 text-sm">
          <span className="text-zinc-300">{total} photos → <b>{groups.length} items</b></span>
          <select className="input w-auto" value={mode} onChange={(e) => { const m = e.target.value as Mode; setMode(m); regroup(photos, m); }}>
            <option value="folder">One folder per item</option>
            <option value="time">Split by pause between photos</option>
            <option value="count">Every N photos</option>
          </select>
          {mode === "time" && <label className="flex items-center gap-1">pause &gt; <input className="input w-16" type="number" value={gap} onChange={(e) => { setGap(Number(e.target.value)); regroup(photos, mode, Number(e.target.value)); }} /> sec</label>}
          {mode === "count" && <label className="flex items-center gap-1"><input className="input w-16" type="number" min={1} value={perItem} onChange={(e) => { setPerItem(Number(e.target.value)); regroup(photos, mode, gap, Number(e.target.value)); }} /> photos per item</label>}
          <label className="flex items-center gap-1">default cost $<input className="input w-20" type="number" step="0.01" value={defaultCost} onChange={(e) => setDefaultCost(e.target.value)} /></label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={useAi} onChange={(e) => setUseAi(e.target.checked)} /> Write listings with AI</label>
          <div className="ml-auto flex gap-2">
            <button className="btn-ghost" disabled={running} onClick={() => (setPhotos([]), setGroups([]), setStatus({}))}>Clear</button>
            <button className="btn-primary" disabled={running || !groups.length || done === groups.length} onClick={run}>{running ? `Working… ${done}/${groups.length}` : `Create ${groups.length} drafts`}</button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {groups.map((g, gi) => {
          const st = status[gi];
          return (
            <div key={gi} className={`card p-3 ${st?.state === "error" ? "border-red-900" : st?.state === "done" ? "border-green-900" : ""}`}>
              <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                <span className="font-medium text-zinc-200">Item {gi + 1}</span>
                <span className="text-zinc-500">{g.photos.length} photo{g.photos.length === 1 ? "" : "s"}{mode === "folder" ? ` · ${g.photos[0]?.folder}` : ""}</span>
                {gi > 0 && !st && <button className="text-zinc-400 hover:text-zinc-100" onClick={() => mergeUp(gi)}>⤒ merge with item {gi}</button>}
                <span className="ml-auto flex items-center gap-2">
                  {!st && (
                    <>
                      <label>cost $<input className="input ml-1 inline w-16 py-0.5" type="number" step="0.01" placeholder={defaultCost || "0"} value={g.cost} onChange={(e) => setGroups((gs) => gs.map((x, i) => (i === gi ? { ...x, cost: e.target.value } : x)))} /></label>
                      <label>qty<input className="input ml-1 inline w-12 py-0.5" type="number" min={1} value={g.qty} onChange={(e) => setGroups((gs) => gs.map((x, i) => (i === gi ? { ...x, qty: e.target.value } : x)))} /></label>
                    </>
                  )}
                  {st?.state === "uploading" && <span className="text-zinc-400">Uploading {st.pct ?? 0}%</span>}
                  {st?.state === "writing" && <span className="text-blue-300">✨ AI writing…</span>}
                  {st?.state === "done" && st.itemId && <Link className="text-green-400 hover:underline" to={`/items/${st.itemId}`}>✓ Draft ready - review</Link>}
                  {st?.state === "error" && <span className="text-red-300">⚠ {st.error}</span>}
                </span>
              </div>
              {st?.state === "uploading" && <div className="mb-2 h-1 rounded bg-zinc-800"><div className="h-1 rounded bg-brand transition-all" style={{ width: `${st.pct ?? 0}%` }} /></div>}
              <div className="flex flex-wrap gap-2">
                {g.photos.map((p, pi) => (
                  <div key={p.key} className="group relative">
                    <FileThumb file={p.file} />
                    {!st && (
                      <div className="absolute inset-x-0 bottom-0 hidden justify-between gap-0.5 bg-black/70 p-0.5 text-[10px] group-hover:flex">
                        {gi > 0 && <button title="Move to previous item" onClick={() => moveToPrev(gi, pi)}>◀</button>}
                        {pi > 0 && <button title="Start a new item from this photo" onClick={() => splitAt(gi, pi)}>✂ new item</button>}
                        <button title="Remove" onClick={() => removePhoto(gi, pi)}>✕</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {done > 0 && !running && <Link to="/inventory?view=drafts" className="btn-primary">Review {done} drafts →</Link>}
    </div>
  );
}
