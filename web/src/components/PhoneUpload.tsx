import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { api, type Item } from "../api";
import { Modal } from "../ui";

/** QR code that lets your phone add photos straight into this item. New photos appear here live. */
export default function PhoneUpload({ item, onClose, onPhotos }: { item: Item; onClose: () => void; onPhotos: (i: Item) => void }) {
  const [link, setLink] = useState<{ token: string; urls: string[]; hint: string | null; expiresAt: string } | null>(null);
  const [base, setBase] = useState("");
  const [qr, setQr] = useState("");
  const [count, setCount] = useState(item.photos.length);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api
      .post<NonNullable<typeof link>>(`/api/items/${item.id}/phone-link`)
      .then((l) => {
        setLink(l);
        setBase(l.urls[0] ?? location.origin);
      })
      .catch((e: Error) => setErr(e.message));
  }, [item.id]);
  const url = link ? `${base}/m/${link.token}` : "";
  useEffect(() => {
    if (url) QRCode.toDataURL(url, { width: 520, margin: 1 }).then(setQr);
  }, [url]);
  // Poll for photos arriving from the phone.
  useEffect(() => {
    const t = setInterval(async () => {
      const i = await api.get<Item>(`/api/items/${item.id}`).catch(() => null);
      if (i && i.photos.length !== count) {
        setCount(i.photos.length);
        onPhotos(i);
      }
    }, 2500);
    return () => clearInterval(t);
  }, [item.id, count, onPhotos]);

  return (
    <Modal open onClose={onClose} title="📱 Add photos from your phone">
      <div className="space-y-3 text-center text-sm">
        {err && <div className="text-red-300">{err}</div>}
        {link && (
          <>
            <p className="text-zinc-400">Scan with your phone's camera, then take photos. They appear here as soon as they upload.</p>
            {qr && <img src={qr} alt="QR code for phone upload" className="mx-auto h-64 w-64 rounded-lg bg-white p-2" />}
            {link.urls.length > 1 && (
              <select className="input mx-auto w-auto text-xs" value={base} onChange={(e) => setBase(e.target.value)}>
                {link.urls.map((u) => <option key={u}>{u}</option>)}
              </select>
            )}
            <div className="break-all text-[11px] text-zinc-500">{url}</div>
            {link.hint && <div className="rounded border border-amber-900 bg-amber-950/30 px-2 py-1 text-left text-xs text-amber-200">{link.hint}</div>}
            <div className="text-lg font-semibold tabular-nums">{count} photo{count === 1 ? "" : "s"} on this item</div>
            <p className="text-[11px] text-zinc-500">Link works for 30 minutes and can only add photos to this item. Your phone must be on the same Wi-Fi (or use your online address).</p>
            <button className="btn-primary w-full" onClick={onClose}>Done</button>
          </>
        )}
      </div>
    </Modal>
  );
}
