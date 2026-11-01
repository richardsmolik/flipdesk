import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { uploadWithProgress } from "../api";

/** The page your phone opens from the QR code: take photos, they upload straight into the item. */
export default function PhoneCapture() {
  const { token = "" } = useParams();
  const [info, setInfo] = useState<{ title: string; sku: string; price: number; photos: string[]; remaining: number; ai: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pct, setPct] = useState<number | null>(null);
  const [added, setAdded] = useState(0);
  const cam = useRef<HTMLInputElement>(null);
  const lib = useRef<HTMLInputElement>(null);

  const load = () =>
    fetch(`/api/m/${token}`)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error);
        setInfo(j);
      })
      .catch((e: Error) => setErr(e.message));
  useEffect(() => void load(), [token]); // eslint-disable-line react-hooks/exhaustive-deps
  // While the AI is drafting, check back every 2 seconds.
  useEffect(() => {
    if (info?.ai !== "pending" && info?.ai !== "writing") return;
    const t = setTimeout(load, 2000);
    return () => clearTimeout(t);
  }, [info]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async (files: FileList | null) => {
    if (!files?.length) return;
    const fd = new FormData();
    Array.from(files).forEach((f) => fd.append("photos", f, f.name));
    try {
      setPct(0);
      const r = await uploadWithProgress<{ added: number }>(`/api/m/${token}/photos`, fd, setPct);
      setAdded((a) => a + r.added);
      navigator.vibrate?.(40);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setPct(null);
      if (cam.current) cam.current.value = "";
      if (lib.current) lib.current.value = "";
    }
  };

  return (
    <div className="mx-auto min-h-screen max-w-md space-y-4 bg-zinc-950 p-4 text-zinc-100">
      <div className="text-lg font-bold">📦 Flip<span className="text-brand">Desk</span></div>
      {err && <div className="rounded-lg border border-red-900 bg-red-950/50 p-3 text-sm text-red-100">{err}</div>}
      {info && (
        <>
          <div>
            <div className="text-xs text-zinc-500">Adding photos to</div>
            <div className="font-semibold">{info.title}</div>
            <div className="text-xs text-zinc-500">{info.sku}</div>
          </div>
          <input ref={cam} type="file" accept="image/*" capture="environment" multiple hidden onChange={(e) => send(e.target.files)} />
          <input ref={lib} type="file" accept="image/*,.heic,.heif" multiple hidden onChange={(e) => send(e.target.files)} />
          <button className="btn-primary w-full py-5 text-lg" disabled={pct !== null} onClick={() => cam.current?.click()}>📷 Take photo</button>
          <button className="btn-ghost w-full py-3" disabled={pct !== null} onClick={() => lib.current?.click()}>🖼️ Choose from library</button>
          {pct !== null && (
            <div>
              <div className="mb-1 text-xs text-zinc-400">Uploading {pct}%</div>
              <div className="h-1.5 rounded bg-zinc-800"><div className="h-1.5 rounded bg-brand transition-all" style={{ width: `${pct}%` }} /></div>
            </div>
          )}
          {added > 0 && <div className="text-sm text-green-400">✓ {added} photo{added === 1 ? "" : "s"} sent. They're already on your computer.</div>}
          {(info.ai === "pending" || info.ai === "writing") && (
            <div className="rounded-lg border border-blue-900 bg-blue-950/40 p-3 text-sm text-blue-100">✨ {info.ai === "pending" ? "Keep shooting. The AI writes the listing a few seconds after your last photo." : "AI is writing your listing…"}</div>
          )}
          {info.ai === "done" && info.title !== "New item" && (
            <div className="rounded-lg border border-green-900 bg-green-950/30 p-3 text-sm">
              <div className="text-xs text-green-300">✨ Draft ready on your computer</div>
              <div className="font-medium">{info.title}</div>
              {info.price > 0 && <div className="text-zinc-300">${info.price.toFixed(2)}</div>}
            </div>
          )}
          <div className="grid grid-cols-4 gap-1.5">
            {info.photos.map((u) => <img key={u} src={u} alt="" className="aspect-square w-full rounded object-cover" />)}
          </div>
          <p className="text-xs text-zinc-500">Tips: front, back, label/tag, any flaws, and measurements. Good light, plain background.</p>
        </>
      )}
    </div>
  );
}
