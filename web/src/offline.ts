/**
 * On-phone storage for Shoot mode (IndexedDB): items + photos wait here until there's signal.
 * Photos are shrunk to 2400px JPEG before saving so a day of shooting doesn't fill the phone.
 */
export interface LocalItem {
  id: string;
  createdAt: number;
  cost: string;
  notes: string;
  photos: Blob[];
  status: "shooting" | "queued" | "syncing" | "synced" | "error";
  serverId?: number;
  error?: string;
}

const DB = "flipdesk";
const STORE = "shoot";

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "id" });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

export const localItems = {
  all: () => tx<LocalItem[]>("readonly", (s) => s.getAll() as IDBRequest<LocalItem[]>).then((xs) => xs.sort((a, b) => a.createdAt - b.createdAt)),
  put: (it: LocalItem) => tx("readwrite", (s) => s.put(it)),
  remove: (id: string) => tx("readwrite", (s) => s.delete(id)),
};

/** Downscale + JPEG-encode in the browser. Falls back to the original file if the browser can't decode it (e.g. HEIC on Chrome). */
export async function shrinkPhoto(file: File, max = 2400): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", 0.86));
    return blob ?? file;
  } catch {
    return file;
  }
}

export const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
