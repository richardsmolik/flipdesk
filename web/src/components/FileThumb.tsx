import { useEffect, useState } from "react";
import { canPreview } from "../api";

/** Thumbnail for a local File; iPhone HEIC files get a labelled tile (they're converted to JPEG on upload). */
export default function FileThumb({ file, className = "h-20 w-20" }: { file: File; className?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    if (!canPreview(file)) return;
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  if (!url || broken)
    return (
      <div className={`${className} flex flex-col items-center justify-center rounded-md bg-zinc-800 p-1 text-center text-[9px] leading-tight text-zinc-400`} title={file.name}>
        <span className="text-lg">📷</span>
        <span className="line-clamp-2 break-all">{file.name}</span>
        {!canPreview(file) && <span className="text-[8px] text-zinc-500">iPhone photo</span>}
      </div>
    );
  return <img src={url} alt={file.name} onError={() => setBroken(true)} className={`${className} rounded-md object-cover`} />;
}
