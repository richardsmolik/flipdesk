import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { money, type Item } from "../api";
import { MpBadge, useMarketplaces } from "../ui";

/** Full-screen photo viewer for one item: arrows / swipe / thumbnails, plus its live listings. */
export default function Lightbox({ item, start = 0, onClose, onPrevItem, onNextItem }: { item: Item; start?: number; onClose: () => void; onPrevItem?: () => void; onNextItem?: () => void }) {
  const [i, setI] = useState(start);
  const { byId } = useMarketplaces();
  const touch = useRef<number | null>(null);
  const n = item.photos.length;
  useEffect(() => setI(start), [item.id, start]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") n > 1 && i < n - 1 ? setI(i + 1) : onNextItem?.();
      if (e.key === "ArrowLeft") n > 1 && i > 0 ? setI(i - 1) : onPrevItem?.();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [i, n, onClose, onNextItem, onPrevItem]);

  const live = item.listings.filter((l) => ["active", "sold"].includes(l.status));
  const photo = item.photos[i];
  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-black/95" role="dialog" aria-label={`Photos of ${item.title}`} onClick={onClose}>
      <div className="flex items-center justify-between gap-3 p-3 text-sm" onClick={(e) => e.stopPropagation()}>
        <div className="min-w-0">
          <div className="truncate font-medium text-zinc-100">{item.title || "Untitled"}</div>
          <div className="text-xs text-zinc-400">{item.sku} · {money(item.price)} · {item.quantity} left{n ? ` · photo ${i + 1} of ${n}` : ""}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link to={`/items/${item.id}`} className="btn-ghost py-1 text-xs" onClick={onClose}>Open item</Link>
          <button className="rounded px-2 py-1 text-xl text-zinc-300 hover:text-white" onClick={onClose} aria-label="Close">✕</button>
        </div>
      </div>

      <div
        className="relative flex min-h-0 flex-1 items-center justify-center px-12"
        onClick={(e) => e.stopPropagation()}
        onTouchStart={(e) => (touch.current = e.touches[0].clientX)}
        onTouchEnd={(e) => {
          if (touch.current === null) return;
          const dx = e.changedTouches[0].clientX - touch.current;
          if (Math.abs(dx) > 40) dx < 0 ? (i < n - 1 ? setI(i + 1) : onNextItem?.()) : i > 0 ? setI(i - 1) : onPrevItem?.();
          touch.current = null;
        }}
      >
        {photo ? <img src={photo.url} alt={`${item.title} photo ${i + 1}`} className="max-h-full max-w-full rounded object-contain" /> : <div className="text-zinc-500">No photos yet</div>}
        {(i > 0 || onPrevItem) && (
          <button className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-zinc-900/80 px-3 py-2 text-xl text-zinc-200 hover:bg-zinc-800" aria-label="Previous" onClick={() => (i > 0 ? setI(i - 1) : onPrevItem?.())}>‹</button>
        )}
        {(i < n - 1 || onNextItem) && (
          <button className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-zinc-900/80 px-3 py-2 text-xl text-zinc-200 hover:bg-zinc-800" aria-label="Next" onClick={() => (i < n - 1 ? setI(i + 1) : onNextItem?.())}>›</button>
        )}
      </div>

      <div className="space-y-2 p-3" onClick={(e) => e.stopPropagation()}>
        {n > 1 && (
          <div className="flex justify-center gap-1.5 overflow-x-auto">
            {item.photos.map((p, k) => (
              <button key={p.id} onClick={() => setI(k)} className={`shrink-0 overflow-hidden rounded border-2 ${k === i ? "border-brand" : "border-transparent opacity-60 hover:opacity-100"}`} aria-label={`Photo ${k + 1}`}>
                <img src={p.url} alt="" className="h-14 w-14 object-cover" />
              </button>
            ))}
          </div>
        )}
        {live.length > 0 && (
          <div className="flex flex-wrap justify-center gap-2 text-xs">
            {live.map((l) =>
              l.url ? (
                <a key={l.id} href={l.url} target="_blank" rel="noreferrer" className="hover:opacity-80">
                  <MpBadge id={l.marketplace} mp={byId[l.marketplace]} status={l.status} /> <span className="text-zinc-400">↗</span>
                </a>
              ) : (
                <MpBadge key={l.id} id={l.marketplace} mp={byId[l.marketplace]} status={l.status} />
              ),
            )}
          </div>
        )}
      </div>
    </div>
  );
}
