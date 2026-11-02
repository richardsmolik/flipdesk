/**
 * Problem replay. When a crosslist / delist / price update fails for good, FlipDesk saves a "problem report":
 * the job, a snapshot of the item and listing, the exact eBay requests and answers (no tokens), the error and
 * the app version. `npx tsx scripts/replay.ts report.json` re-runs it against those recorded answers, so the
 * failure can be reproduced and fixed without your account or your data.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import type { Db, Item, JobRow, ListingRow } from "../db.js";

export interface Exchange { method: string; path: string; status: number; request?: unknown; response: string }
const recorder = new AsyncLocalStorage<Exchange[]>();

/** Run fn while recording marketplace API calls made inside it. */
export const withRecording = <T>(fn: () => Promise<T>) => {
  const log: Exchange[] = [];
  return { log, run: () => recorder.run(log, fn) };
};

/** Called by marketplace API helpers for every request/response. */
export function recordExchange(e: Exchange) {
  const log = recorder.getStore();
  if (!log || log.length >= 40) return;
  log.push({ ...e, response: e.response.length > 20_000 ? e.response.slice(0, 20_000) + "…(cut)" : e.response });
}

let version: string | null = null;
export function appVersion() {
  if (version) return version;
  version = process.env.FLIPDESK_VERSION || process.env.FLY_IMAGE_REF || "";
  if (!version) {
    try {
      version = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).trim();
    } catch {
      version = "unknown";
    }
  }
  return version;
}

function ensure(db: Db) {
  db.exec(`CREATE TABLE IF NOT EXISTS problem_reports (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, job_id INTEGER, summary TEXT NOT NULL,
    data TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
}

/** Strip what a problem report must never carry (buyer details, local file paths). */
function scrubItem(item: Item) {
  return {
    ...item,
    photos: item.photos.map((p) => ({ id: p.id, url: p.url.split("/").pop() })),
    notes: item.notes ? "(removed)" : "",
    location: item.location ? "(removed)" : "",
  };
}

export function saveProblem(db: Db, p: { job: JobRow; item?: Item; listing?: ListingRow; error: string; exchanges?: Exchange[]; mode?: string }) {
  ensure(db);
  const data = {
    format: 1,
    kind: "job",
    at: new Date().toISOString(),
    version: appVersion(),
    marketplace: p.job.marketplace,
    mode: p.mode ?? "unknown",
    error: p.error,
    job: { id: p.job.id, type: p.job.type, marketplace: p.job.marketplace, attempts: p.job.attempts },
    item: p.item ? scrubItem(p.item) : null,
    listing: p.listing ?? null,
    exchanges: p.exchanges ?? [],
  };
  const summary = `${p.job.marketplace} ${p.job.type} failed: ${p.error}`.slice(0, 300);
  // One report per job is enough (retries of the same job update it).
  const existing = db.prepare("SELECT id FROM problem_reports WHERE job_id = ?").get(p.job.id) as { id: number } | undefined;
  if (existing) db.prepare("UPDATE problem_reports SET summary = ?, data = ?, created_at = datetime('now') WHERE id = ?").run(summary, JSON.stringify(data), existing.id);
  else db.prepare("INSERT INTO problem_reports (kind, job_id, summary, data) VALUES ('job', ?, ?, ?)").run(p.job.id, summary, JSON.stringify(data));
  // Keep the newest 200.
  db.prepare("DELETE FROM problem_reports WHERE id NOT IN (SELECT id FROM problem_reports ORDER BY id DESC LIMIT 200)").run();
}

export function listProblems(db: Db) {
  ensure(db);
  return db.prepare("SELECT id, kind, job_id, summary, created_at FROM problem_reports ORDER BY id DESC LIMIT 100").all() as { id: number; kind: string; job_id: number | null; summary: string; created_at: string }[];
}

export function getProblem(db: Db, id: number) {
  ensure(db);
  const r = db.prepare("SELECT data FROM problem_reports WHERE id = ? OR (job_id = ? AND ? < 0)").get(id, -id, id) as { data: string } | undefined;
  return r ? JSON.parse(r.data) : null;
}

export function problemForJob(db: Db, jobId: number) {
  ensure(db);
  const r = db.prepare("SELECT id FROM problem_reports WHERE job_id = ?").get(jobId) as { id: number } | undefined;
  return r?.id ?? null;
}
