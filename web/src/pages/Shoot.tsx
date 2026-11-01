import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, uploadWithProgress, type Item } from "../api";
import { localItems, newId, shrinkPhoto, type LocalItem } from "../offline";
import { toast } from "../ui";

/**
 * Shoot mode (works offline): photograph item after item; everything is saved on this phone and
 * uploads automatically when you're online, then AI writes each draft.
 */
export default function Shoot() {
  const [items, setItems] = useState<LocalItem[]>([]);
  const [online, setOnline] = useState(navigator.onLine);
  const [syncing, setSyncing] = useState(false);
  const [thumbs, setThumbs] = useState<Record<string, string[]>>({});
  const cam = useRef<HTMLInputElement>(null);
  const syncingRef = useRef(false);

  const reload = useCallback(async () => {
    const all = await localItems.all();
    setItems(all);
    setThumbs((old) => {
      Object.values(old).flat().forEach((u) => URL.revokeObjectURL(u));
      return Object.fromEntries(all.map((it) => [it.id, it.photos.slice(0, 6).map((b) => URL.createObjectURL(b))]));
    });
  }, []);
  useEffect(() => void reload(), [reload]);

  const current = items.find((i) => i.status === "shooting");

  const addPhotos = async (files: FileList | null) => {
    if (!files?.length) return;
    const blobs = await Promise.all(Array.from(files).map((f) => shrinkPhoto(f)));
    const it: LocalItem = current ?? { id: newId(), createdAt: Date.now(), cost: "", notes: "", photos: [], status: "shooting" };
    it.photos = [...it.photos, ...blobs];
    await localItems.put(it);
    navigator.vibrate?.(30);
    if (cam.current) cam.current.value = "";
    reload();
  };
  const update = async (patch: Partial<LocalItem>) => {
    if (!current) return;
    await localItems.put({ ...current, ...patch });
    reload();
  };
  const finish = async () => {
    if (!current?.photos.length) return;
    await localItems.put({ ...current, status: "queued" });
    await reload();
    if (navigator.onLine) void sync();
  };

  const sync = useCallback(async () => {
    if (syncingRef.current || !navigator.onLine) return;
    syncingRef.current = true;
    setSyncing(true);
    try {
      for (const it of (await localItems.all()).filter((x) => x.status === "queued" || x.status === "error")) {
        await localItems.put({ ...it, status: "syncing", error: undefined });
        await reload();
        try {
          let id = it.serverId;
          if (!id) {
            const created = await api.post<Item>("/api/items", { cost: Number(it.cost) || 0, notes: it.notes, quantity: 1, quantity_purchased: 1 });
            id = created.id;
            await localItems.put({ ...it, status: "syncing", serverId: id }); // don't create twice if the upload fails
          }
          const fd = new FormData();
          it.photos.forEach((b, k) => fd.append("photos", b, `shoot-${k + 1}.jpg`));
          await uploadWithProgress(`/api/items/${id}/photos`, fd);
          await api.post(`/api/items/${id}/auto-write`);
          // Uploaded: keep a tiny record, drop the photo data from the phone.
          await localItems.put({ ...it, serverId: id, status: "synced", photos: it.photos.slice(0, 1) });
        } catch (e) {
          const fresh = (await localItems.all()).find((x) => x.id === it.id) ?? it;
          await localItems.put({ ...fresh, status: "error", error: (e as Error).message });
        }
        await reload();
      }
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }, [reload]);

  useEffect(() => {
    const on = () => (setOnline(true), void sync());
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    if (navigator.onLine) void sync();
    return () => (window.removeEventListener("online", on), window.removeEventListener("offline", off));
  }, [sync]);

  const queued = items.filter((i) => i.status === "queued" || i.status === "error" || i.status === "syncing").length;
  const synced = items.filter((i) => i.status === "synced");

  return (
    <div className="mx-auto max-w-md space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Shoot</h1>
        <span className={`rounded-full px-2 py-0.5 text-xs ${online ? "bg-green-950 text-green-300" : "bg-amber-950 text-amber-200"}`}>{online ? "● Online" : "○ Offline: saving on this phone"}</span>
      </div>
      <p className="text-sm text-zinc-400">Photograph one item, tap <b>Next item</b>, repeat. Works with no signal; everything uploads when you're back online and AI writes each draft.</p>

      <div className="card space-y-3 p-4">
        <div className="text-xs uppercase tracking-wide text-zinc-500">{current ? `Item ${items.filter((i) => i.status !== "synced").length} · ${current.photos.length} photo${current.photos.length === 1 ? "" : "s"}` : "New item"}</div>
        <input ref={cam} type="file" accept="image/*" capture="environment" multiple hidden onChange={(e) => addPhotos(e.target.files)} />
        <button className="btn-primary w-full py-6 text-lg" onClick={() => cam.current?.click()}>📷 {current?.photos.length ? "Add photo" : "Take first photo"}</button>
        {current && (
          <>
            <div className="grid grid-cols-4 gap-1.5">{(thumbs[current.id] ?? []).map((u) => <img key={u} src={u} alt="" className="aspect-square w-full rounded object-cover" />)}</div>
            <div className="flex gap-2">
              <input className="input" placeholder="Notes (brand, size, flaws…)" value={current.notes} onChange={(e) => update({ notes: e.target.value })} />
              <input className="input w-24" inputMode="decimal" placeholder="Paid $" value={current.cost} onChange={(e) => update({ cost: e.target.value })} />
            </div>
            <div className="flex gap-2">
              <button className="btn-primary flex-1 py-3" disabled={!current.photos.length} onClick={finish}>Next item ▶</button>
              <button className="btn-ghost py-3" onClick={async () => (await localItems.remove(current.id), reload())}>Discard</button>
            </div>
          </>
        )}
      </div>

      {queued > 0 && (
        <div className="card flex items-center justify-between p-3 text-sm">
          <span>{syncing ? "⟳ Uploading…" : `${queued} item${queued === 1 ? "" : "s"} waiting to upload`}</span>
          <button className="btn-ghost py-1 text-xs" disabled={!online || syncing} onClick={() => void sync()}>Upload now</button>
        </div>
      )}

      <div className="space-y-1.5">
        {items.filter((i) => i.status !== "shooting").reverse().map((it) => (
          <div key={it.id} className="flex items-center gap-3 rounded-lg border border-zinc-800 p-2 text-sm">
            {thumbs[it.id]?.[0] ? <img src={thumbs[it.id][0]} alt="" className="h-10 w-10 rounded object-cover" /> : <div className="h-10 w-10 rounded bg-zinc-800" />}
            <div className="min-w-0 flex-1">
              <div className="truncate">{it.notes || `${it.photos.length} photo(s)`}</div>
              <div className={`text-xs ${it.status === "error" ? "text-red-300" : it.status === "synced" ? "text-green-400" : "text-zinc-500"}`}>
                {it.status === "queued" && "Waiting for signal"}
                {it.status === "syncing" && "Uploading…"}
                {it.status === "synced" && "✓ Uploaded · AI writing the draft"}
                {it.status === "error" && `⚠ ${it.error ?? "Upload failed"} (will retry)`}
              </div>
            </div>
            {it.status === "synced" && it.serverId && <Link className="text-xs text-brand" to={`/items/${it.serverId}`}>Open</Link>}
            {it.status === "synced" && <button className="text-xs text-zinc-600" aria-label="Remove from list" onClick={async () => (await localItems.remove(it.id), reload())}>✕</button>}
          </div>
        ))}
      </div>
      {synced.length > 0 && <Link to="/inventory?view=drafts" className="btn-ghost w-full">Review drafts →</Link>}
      <p className="text-[11px] text-zinc-500">Tip: add FlipDesk to your home screen (Share, then Add to Home Screen) to open it like an app, even without signal (needs your online HTTPS address).</p>
    </div>
  );
}
