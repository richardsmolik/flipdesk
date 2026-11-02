/**
 * Versions and going back. Every time FlipDesk starts it notes which version it is (and, on Fly.io, which
 * image) in data/versions.json: a plain file, so it's readable even when a database isn't. A version that
 * starts and serves is marked good. Going back = telling Fly to run this machine on the last good image.
 * Needs FLY_API_TOKEN (fly tokens create deploy) as a secret; Fly sets FLY_APP_NAME / FLY_MACHINE_ID / FLY_IMAGE_REF.
 */
import fs from "node:fs";
import path from "node:path";
import { appVersion } from "./replay.js";

export interface VersionRow { version: string; image: string | null; firstStarted: string; lastStarted: string; goodAt: string | null; failed: string | null }

const file = (dataDir: string) => path.join(dataDir, "versions.json");
export function listVersions(dataDir: string): VersionRow[] {
  try {
    return JSON.parse(fs.readFileSync(file(dataDir), "utf8")) as VersionRow[];
  } catch {
    return [];
  }
}
function save(dataDir: string, rows: VersionRow[]) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file(dataDir), JSON.stringify(rows.slice(0, 12), null, 1));
}
export const currentImage = () => process.env.FLY_IMAGE_REF || null;
const version = () => process.env.FLIPDESK_VERSION || appVersion();
const sameAs = (r: VersionRow) => (currentImage() ? r.image === currentImage() : r.version === version());

/** Called at start-up (before anything can fail). Newest first. */
export function noteStart(dataDir: string) {
  const rows = listVersions(dataDir);
  const now = new Date().toISOString();
  const i = rows.findIndex(sameAs);
  if (i >= 0) {
    const [r] = rows.splice(i, 1);
    rows.unshift({ ...r, lastStarted: now });
  } else rows.unshift({ version: version(), image: currentImage(), firstStarted: now, lastStarted: now, goodAt: null, failed: null });
  save(dataDir, rows);
}
/** Called once the server is up and its data opened fine. */
export function markGood(dataDir: string) {
  const rows = listVersions(dataDir);
  const r = rows.find(sameAs);
  if (r) {
    r.goodAt = new Date().toISOString();
    r.failed = null;
    save(dataDir, rows);
  }
}
export function markFailed(dataDir: string, why: string) {
  const rows = listVersions(dataDir);
  const r = rows.find(sameAs);
  if (r) {
    r.failed = why.slice(0, 500);
    save(dataDir, rows);
  }
}
/** The newest earlier version that worked (and that we can run again: it has an image). */
export function previousGood(dataDir: string) {
  return listVersions(dataDir).find((r) => !sameAs(r) && r.goodAt && r.image) ?? null;
}

export const flyReady = () => Boolean(process.env.FLY_API_TOKEN && process.env.FLY_APP_NAME && process.env.FLY_MACHINE_ID);

/** Ask Fly to run this machine on another image. The machine restarts on it (about a minute). */
export async function switchImage(image: string) {
  if (!flyReady()) throw Object.assign(new Error("Going back from the app needs FLY_API_TOKEN (run: fly tokens create deploy, then fly secrets set FLY_API_TOKEN=...). Or run: fly releases, then fly deploy --image <previous image>."), { status: 400 });
  const base = `https://api.machines.dev/v1/apps/${encodeURIComponent(process.env.FLY_APP_NAME!)}/machines/${encodeURIComponent(process.env.FLY_MACHINE_ID!)}`;
  const headers = { Authorization: `Bearer ${process.env.FLY_API_TOKEN}`, "Content-Type": "application/json" };
  const cur = await fetch(base, { headers });
  if (!cur.ok) throw new Error(`Fly answered ${cur.status} reading this machine: ${(await cur.text()).slice(0, 200)}`);
  const m = (await cur.json()) as { config: Record<string, unknown> };
  const r = await fetch(base, { method: "POST", headers, body: JSON.stringify({ config: { ...m.config, image } }) });
  if (!r.ok) throw new Error(`Fly answered ${r.status} switching versions: ${(await r.text()).slice(0, 200)}`);
  return { ok: true, image };
}
