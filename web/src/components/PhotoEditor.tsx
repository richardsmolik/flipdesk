import { useEffect, useRef, useState } from "react";
import { api, type Item, type PhotoCaps } from "../api";
import { toast, useFetch } from "../ui";

/**
 * Photo editor: AI auto-enhance, remove objects / fix wrinkles (paint), remove background,
 * crop (free / 1:1 / 4:5), rotate, flip, straighten, light & color, sharpen, square on white.
 * Manual adjustments preview live (CSS) and are applied on the server when you click Apply.
 */
function Slider({ label, value, set, min, max, step, fmt }: { label: string; value: number; set: (n: number) => void; min: number; max: number; step: number; fmt?: (n: number) => string }) {
  return (
    <label className="block text-xs">
      <div className="flex justify-between text-zinc-400"><span>{label}</span><span className="tabular-nums">{fmt ? fmt(value) : value.toFixed(2)}</span></div>
      <input type="range" className="w-full accent-[#3987e5]" min={min} max={max} step={step} value={value} onChange={(e) => set(Number(e.target.value))} onDoubleClick={() => set(label === "Warmth" || label === "Straighten" ? 0 : 1)} />
    </label>
  );
}

type Mode = "adjust" | "crop" | "removeObject" | "fixWrinkles";
interface Box { x: number; y: number; w: number; h: number }

export default function PhotoEditor({ item, photoId, onClose, onSaved }: { item: Item; photoId: number; onClose: () => void; onSaved: (i: Item) => void }) {
  const photo = item.photos.find((p) => p.id === photoId)!;
  const { data: caps } = useFetch<PhotoCaps>("/api/photos/capabilities");
  const [mode, setMode] = useState<Mode>("adjust");
  const [busy, setBusy] = useState<string | null>(null);
  const [rot, setRot] = useState(0); // multiples of 90
  const [straight, setStraight] = useState(0);
  const [flipH, setFlipH] = useState(false);
  const [flipV, setFlipV] = useState(false);
  const [bright, setBright] = useState(1);
  const [contrast, setContrast] = useState(1);
  const [sat, setSat] = useState(1);
  const [warmth, setWarmth] = useState(0);
  const [sharpen, setSharpen] = useState(false);
  const [aspect, setAspect] = useState<"free" | "1:1" | "4:5">("1:1");
  const [crop, setCrop] = useState<Box | null>(null);
  const [brush, setBrush] = useState(40);
  const [painted, setPainted] = useState(false);
  const [notes, setNotes] = useState<{ issues: string[]; tips: string[] } | null>(null);
  const img = useRef<HTMLImageElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);

  const pending = rot % 360 !== 0 || straight !== 0 || flipH || flipV || bright !== 1 || contrast !== 1 || sat !== 1 || warmth !== 0 || sharpen;
  const reset = () => (setRot(0), setStraight(0), setFlipH(false), setFlipV(false), setBright(1), setContrast(1), setSat(1), setWarmth(0), setSharpen(false), setCrop(null), clearMask());

  const call = async (label: string, fn: () => Promise<Item>) => {
    setBusy(label);
    try {
      const i = await fn();
      onSaved(i);
      reset();
      return i;
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(null);
    }
  };
  const edit = (ops: unknown[]) => call("Applying…", () => api.post<Item>(`/api/photos/${photoId}/edit`, { ops }));

  const manualOps = () => {
    const ops: unknown[] = [];
    if (rot % 360) ops.push({ type: "rotate", deg: ((rot % 360) + 360) % 360 });
    if (straight) ops.push({ type: "rotate", deg: straight });
    if (flipH) ops.push({ type: "flip", axis: "h" });
    if (flipV) ops.push({ type: "flip", axis: "v" });
    if (bright !== 1 || contrast !== 1 || sat !== 1 || warmth !== 0 || sharpen) ops.push({ type: "adjust", brightness: bright, contrast, saturation: sat, warmth, sharpen });
    return ops;
  };

  // Crop and paint work on the saved image, so apply pending rotate/flip/color first.
  const switchMode = async (m: Mode) => {
    if (m !== "adjust" && pending) await edit(manualOps());
    setMode(m);
    setCrop(null);
    clearMask();
  };

  // ---------- crop ----------
  const rel = (e: React.PointerEvent) => {
    const r = img.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const cropMove = (e: React.PointerEvent) => {
    if (!drag.current || !img.current) return;
    const p = rel(e);
    let w = Math.abs(p.x - drag.current.x);
    let h = Math.abs(p.y - drag.current.y);
    const ratio = img.current.naturalWidth / img.current.naturalHeight; // box fractions -> pixels
    if (aspect !== "free") {
      const target = aspect === "1:1" ? 1 : 4 / 5; // width/height in pixels
      h = Math.min(1, (w * ratio) / target);
      w = Math.min(1, (h * target) / ratio);
    }
    setCrop({ x: Math.min(drag.current.x, p.x < drag.current.x ? drag.current.x - w : drag.current.x), y: p.y < drag.current.y ? drag.current.y - h : drag.current.y, w, h });
  };

  // ---------- paint mask ----------
  function clearMask() {
    const c = canvas.current;
    if (c) c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
    setPainted(false);
  }
  useEffect(() => {
    const c = canvas.current;
    const i = img.current;
    if (!c || !i) return;
    const fit = () => {
      c.width = i.clientWidth;
      c.height = i.clientHeight;
    };
    if (i.complete) fit();
    i.onload = fit;
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [mode, photo.url]);
  const paint = (e: React.PointerEvent) => {
    if (!drag.current || !canvas.current) return;
    const r = canvas.current.getBoundingClientRect();
    const ctx = canvas.current.getContext("2d")!;
    ctx.fillStyle = "rgba(255,40,80,0.55)";
    ctx.beginPath();
    ctx.arc(e.clientX - r.left, e.clientY - r.top, brush / 2, 0, Math.PI * 2);
    ctx.fill();
    setPainted(true);
  };
  const applyRetouch = async () => {
    const c = canvas.current!;
    const blob = await new Promise<Blob>((res) => c.toBlob((b) => res(b!), "image/png"));
    const fd = new FormData();
    fd.append("tool", mode);
    fd.append("mask", blob, "mask.png");
    await call(mode === "removeObject" ? "Removing…" : "Smoothing…", async () => {
      const r = await api.post<{ item: Item; engine: string }>(`/api/photos/${photoId}/retouch`, fd);
      toast(`Done (${r.engine})`);
      return r.item;
    });
  };

  const aiEnhance = async () => {
    setBusy("✨ AI is looking at your photo…");
    try {
      const r = await api.post<{ item: Item; advice: { issues: string[]; tips: string[] }; demo: boolean; backgroundSkipped: boolean; applied: string[] }>(`/api/photos/${photoId}/ai-enhance`, { allowBackground: true });
      onSaved(r.item);
      reset();
      setNotes(r.advice);
      toast(r.demo ? "Auto-enhanced (demo: add an AI key in Settings → AI for AI analysis)" : `AI applied: ${r.applied.join(", ")}${r.backgroundSkipped ? " (add a background-removal key to also clean the background)" : ""}`);
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(null);
    }
  };

  const warmFilter = warmth > 0 ? `sepia(${warmth * 0.35})` : warmth < 0 ? `hue-rotate(${warmth * 12}deg) saturate(${1 + warmth * 0.1})` : "";
  const style: React.CSSProperties =
    mode === "adjust"
      ? { transform: `rotate(${rot + straight}deg) scale(${flipH ? -1 : 1}, ${flipV ? -1 : 1})`, filter: `brightness(${bright}) contrast(${contrast}) saturate(${sat}) ${warmFilter}`, transition: "transform .2s" }
      : {};

  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-zinc-950" role="dialog" aria-label="Photo editor">
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
        <div className="text-sm font-medium">Edit photo {photo.edited && <span className="ml-2 rounded bg-zinc-800 px-1.5 text-[10px] text-zinc-400">edited</span>}</div>
        <div className="flex items-center gap-2">
          {busy && <span className="text-xs text-zinc-400">{busy}</span>}
          {photo.edited && <button className="btn-ghost py-1 text-xs" disabled={!!busy} onClick={() => call("Reverting…", () => api.post<Item>(`/api/photos/${photoId}/revert`))}>↺ Revert to original</button>}
          <button className="btn-ghost py-1 text-xs" onClick={onClose}>Done</button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[repeating-conic-gradient(#18181b_0_25%,#111113_0_50%)] bg-[length:24px_24px] p-4">
          <div className="relative max-h-full max-w-full">
            <img
              ref={img}
              src={photo.url}
              alt="Photo being edited"
              draggable={false}
              className="block max-h-[70vh] max-w-full select-none object-contain md:max-h-[calc(100vh-8rem)]"
              style={style}
              onPointerDown={(e) => mode === "crop" && ((drag.current = rel(e)), setCrop({ ...rel(e), w: 0, h: 0 }), (e.target as Element).setPointerCapture(e.pointerId))}
              onPointerMove={(e) => mode === "crop" && cropMove(e)}
              onPointerUp={() => (drag.current = null)}
            />
            {mode === "crop" && crop && crop.w > 0 && (
              <div className="pointer-events-none absolute border-2 border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]" style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.w * 100}%`, height: `${crop.h * 100}%` }} />
            )}
            {(mode === "removeObject" || mode === "fixWrinkles") && (
              <canvas
                ref={canvas}
                className="absolute inset-0 h-full w-full cursor-crosshair touch-none"
                onPointerDown={(e) => ((drag.current = { x: 0, y: 0 }), paint(e), (e.target as Element).setPointerCapture(e.pointerId))}
                onPointerMove={paint}
                onPointerUp={() => (drag.current = null)}
              />
            )}
          </div>
        </div>

        <aside className="w-full shrink-0 space-y-4 overflow-y-auto border-t border-zinc-800 p-4 md:w-80 md:border-l md:border-t-0">
          <button className="btn-primary w-full py-2.5" disabled={!!busy} onClick={aiEnhance}>✨ AI auto-enhance</button>
          {notes && (notes.issues.length > 0 || notes.tips.length > 0) && (
            <div className="rounded-md border border-blue-900 bg-blue-950/30 p-2 text-xs">
              {notes.issues.length > 0 && <div className="text-zinc-300">Fixed: {notes.issues.join(", ")}</div>}
              {notes.tips.length > 0 && <div className="mt-1 text-zinc-400">Next time: {notes.tips.join(" · ")}</div>}
            </div>
          )}

          <div className="grid grid-cols-2 gap-1.5 text-xs">
            {([["adjust", "🎚️ Adjust"], ["crop", "✂️ Crop"], ["removeObject", "🧽 Remove item"], ["fixWrinkles", "👕 Fix wrinkles"]] as const).map(([m, l]) => (
              <button key={m} className={`rounded-md border px-2 py-2 ${mode === m ? "border-brand bg-blue-950/40 text-white" : "border-zinc-800 text-zinc-300 hover:border-zinc-600"}`} disabled={!!busy} onClick={() => switchMode(m)}>
                {l}
              </button>
            ))}
          </div>

          {mode === "adjust" && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-1.5">
                <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setRot(rot - 90)} title="Rotate left">⟲ 90°</button>
                <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setRot(rot + 90)} title="Rotate right">⟳ 90°</button>
                <button className={`btn-ghost px-2 py-1 text-xs ${flipH ? "border-brand" : ""}`} onClick={() => setFlipH(!flipH)}>⇋ Flip</button>
                <button className={`btn-ghost px-2 py-1 text-xs ${flipV ? "border-brand" : ""}`} onClick={() => setFlipV(!flipV)}>⇵ Flip</button>
              </div>
              <Slider label="Straighten" value={straight} set={setStraight} min={-15} max={15} step={0.5} fmt={(n) => `${n}°`} />
              <Slider label="Brightness" value={bright} set={setBright} min={0.6} max={1.6} step={0.02} />
              <Slider label="Contrast" value={contrast} set={setContrast} min={0.6} max={1.6} step={0.02} />
              <Slider label="Saturation" value={sat} set={setSat} min={0} max={2} step={0.02} />
              <Slider label="Warmth" value={warmth} set={setWarmth} min={-1} max={1} step={0.05} />
              <label className="flex items-center gap-2 text-xs text-zinc-300"><input type="checkbox" checked={sharpen} onChange={(e) => setSharpen(e.target.checked)} /> Sharpen</label>
              <p className="text-[11px] text-zinc-500">Double-click a slider to reset it.</p>
              <div className="flex gap-2">
                <button className="btn-primary flex-1" disabled={!pending || !!busy} onClick={() => edit(manualOps())}>Apply</button>
                <button className="btn-ghost" disabled={!pending} onClick={reset}>Reset</button>
              </div>
              <div className="space-y-1.5 border-t border-zinc-800 pt-3">
                <button className="btn-ghost w-full text-xs" disabled={!!busy} onClick={() => edit([{ type: "auto" }])}>⚡ Quick fix (levels + color + sharpen)</button>
                <button className="btn-ghost w-full text-xs" disabled={!!busy || !caps?.backgroundRemoval} title={caps?.backgroundRemoval ? "" : "Needs a Photoroom, remove.bg or Clipdrop key"} onClick={() => edit([{ type: "removeBackground" }])}>
                  🪄 Remove background (white){!caps?.backgroundRemoval && " - needs key"}
                </button>
                <button className="btn-ghost w-full text-xs" disabled={!!busy} onClick={() => edit([{ type: "square", size: 1600 }])}>⬜ Make square on white (1600px)</button>
              </div>
            </div>
          )}

          {mode === "crop" && (
            <div className="space-y-3 text-xs">
              <div className="flex gap-1.5">
                {(["1:1", "4:5", "free"] as const).map((a) => (
                  <button key={a} className={`btn-ghost flex-1 py-1 ${aspect === a ? "border-brand" : ""}`} onClick={() => setAspect(a)}>{a === "free" ? "Free" : a}</button>
                ))}
              </div>
              <p className="text-zinc-500">Drag on the photo to draw the crop. 1:1 is best for most marketplaces; Poshmark and Depop show 1:1, and 4:5 fills phone screens.</p>
              <button className="btn-primary w-full" disabled={!crop || crop.w < 0.05 || !!busy} onClick={() => crop && edit([{ type: "crop", ...crop }])}>Crop</button>
            </div>
          )}

          {(mode === "removeObject" || mode === "fixWrinkles") && (
            <div className="space-y-3 text-xs">
              <p className="text-zinc-400">
                {mode === "removeObject" ? "Paint over the thing to erase (tags, hangers, clutter, your hand)." : "Paint over the wrinkles or creases."}{" "}
                {caps?.aiRetouch ? "AI fills it in naturally." : "Basic mode: works best on plain backgrounds and light creases. Add a CLIPDROP_API_KEY for AI results."}
              </p>
              <Slider label="Brush size" value={brush} set={setBrush} min={8} max={140} step={2} fmt={(n) => `${n}px`} />
              <div className="flex gap-2">
                <button className="btn-primary flex-1" disabled={!painted || !!busy} onClick={applyRetouch}>{mode === "removeObject" ? "Remove" : "Smooth"}</button>
                <button className="btn-ghost" disabled={!painted} onClick={clearMask}>Clear</button>
              </div>
            </div>
          )}

          <p className="border-t border-zinc-800 pt-3 text-[11px] text-zinc-500">Edits never change your original; you can revert any time. Keep colors and flaws true to life: buyers return items that don't match the photos.</p>
        </aside>
      </div>
    </div>
  );
}
