import { useEffect, useRef, useState } from "react";

/**
 * Barcode input that works everywhere:
 *  - Live camera scan (needs HTTPS or localhost): native BarcodeDetector, else ZXing
 *  - Plain http (phone on home Wi-Fi): snap a photo of the barcode, decoded on-device
 *  - Bluetooth/USB handheld scanners: they "type" digits + Enter into the field
 */
type Detector = { detect: (src: CanvasImageSource | ImageBitmap) => Promise<{ rawValue: string }[]> };
const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e"];

function nativeDetector(): Detector | null {
  const BD = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
  return BD ? new BD({ formats: FORMATS }) : null;
}

export default function BarcodeScanner({ onCode }: { onCode: (code: string) => void }) {
  const [live, setLive] = useState(false);
  const [typed, setTyped] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const photo = useRef<HTMLInputElement>(null);
  const stopRef = useRef<() => void>(() => {});
  const canLive = typeof window !== "undefined" && window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;

  const done = (code: string) => {
    stopRef.current();
    setLive(false);
    navigator.vibrate?.(60);
    onCode(code);
  };

  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    (async () => {
      try {
        const det = nativeDetector();
        if (det) {
          const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
          if (cancelled) return stream.getTracks().forEach((t) => t.stop());
          video.current!.srcObject = stream;
          await video.current!.play();
          let raf = 0;
          const tick = async () => {
            if (cancelled) return;
            const found = await det.detect(video.current!).catch(() => []);
            if (found[0]?.rawValue) return done(found[0].rawValue);
            raf = requestAnimationFrame(tick);
          };
          tick();
          stopRef.current = () => {
            cancelAnimationFrame(raf);
            stream.getTracks().forEach((t) => t.stop());
          };
        } else {
          const { BrowserMultiFormatReader } = await import("@zxing/browser");
          const reader = new BrowserMultiFormatReader();
          const controls = await reader.decodeFromConstraints({ video: { facingMode: "environment" } }, video.current!, (result) => {
            if (result) done(result.getText());
          });
          stopRef.current = () => controls.stop();
        }
      } catch (e) {
        setErr((e as Error).message || "Camera unavailable");
        setLive(false);
      }
    })();
    return () => {
      cancelled = true;
      stopRef.current();
    };
  }, [live]); // eslint-disable-line react-hooks/exhaustive-deps

  const fromPhoto = async (file: File) => {
    setErr(null);
    try {
      const det = nativeDetector();
      if (det) {
        const found = await det.detect(await createImageBitmap(file));
        if (found[0]) return done(found[0].rawValue);
      } else {
        const { BrowserMultiFormatReader } = await import("@zxing/browser");
        const url = URL.createObjectURL(file);
        const r = await new BrowserMultiFormatReader().decodeFromImageUrl(url).finally(() => URL.revokeObjectURL(url));
        return done(r.getText());
      }
      setErr("No barcode found in that photo. Get closer and keep it sharp.");
    } catch {
      setErr("No barcode found in that photo. Get closer and keep it sharp.");
    }
  };

  return (
    <div className="space-y-2">
      {live && (
        <div className="relative overflow-hidden rounded-lg border border-zinc-700 bg-black">
          <video ref={video} className="h-48 w-full object-cover" playsInline muted />
          <div className="pointer-events-none absolute inset-x-8 top-1/2 h-0.5 -translate-y-1/2 bg-red-500/80" />
          <button className="absolute right-2 top-2 rounded bg-black/70 px-2 py-1 text-xs" onClick={() => (stopRef.current(), setLive(false))}>Cancel</button>
        </div>
      )}
      <div className="flex gap-2">
        <input
          className="input py-3 text-base tabular-nums"
          inputMode="numeric"
          placeholder="Barcode (UPC / ISBN)"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && typed.trim() && (onCode(typed.trim()), setTyped(""))}
        />
        {canLive ? (
          <button className="btn-ghost whitespace-nowrap px-4" onClick={() => (setErr(null), setLive(true))}>📷 Scan</button>
        ) : (
          <>
            <input ref={photo} type="file" accept="image/*" capture="environment" hidden onChange={(e) => e.target.files?.[0] && fromPhoto(e.target.files[0])} />
            <button className="btn-ghost whitespace-nowrap px-4" onClick={() => photo.current?.click()} title="Live scanning needs HTTPS; this reads a photo of the barcode instead">📷 Scan</button>
          </>
        )}
      </div>
      {err && <div className="text-xs text-amber-300">{err}</div>}
    </div>
  );
}
