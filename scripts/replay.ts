/**
 * Replay a FlipDesk problem report: rebuilds the item and listing in a throwaway database, answers every
 * marketplace request with the answer recorded in the report, and re-runs the failed job.
 * Usage: npx tsx scripts/replay.ts flipdesk-problem-12.json
 * Exit code 0 = the same failure reproduced (now debug it), 1 = it behaved differently (already fixed?).
 */
import fs from "node:fs";
import { openDb } from "../server/db.js";
import { processApiJobs } from "../server/services/jobs.js";

interface Report {
  format: number;
  error: string;
  marketplace: string;
  job: { type: string; marketplace: string };
  item: Record<string, unknown> & { specifics?: Record<string, string>; keywords?: string[] };
  listing: Record<string, unknown> | null;
  exchanges: { method: string; path: string; status: number; response: string }[];
}

export async function replay(report: Report, opts: { quiet?: boolean } = {}) {
  const log = (...a: unknown[]) => !opts.quiet && console.log(...a);
  // eBay "connected" with fake keys/tokens: nothing leaves this machine (fetch is replaced below).
  process.env.EBAY_CLIENT_ID ||= "replay";
  process.env.EBAY_CLIENT_SECRET ||= "replay";
  process.env.PUBLIC_BASE_URL ||= "https://replay.invalid"; // photo URLs without uploading files
  const db = openDb(":memory:");
  const it = report.item;
  const itemId = Number(
    db
      .prepare(`INSERT INTO items (sku, title, description, brand, category, condition, color, size, specifics, keywords, cost, price, min_price, quantity, quantity_purchased, weight_oz, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`)
      .run(String(it.sku), String(it.title ?? ""), String(it.description ?? ""), String(it.brand ?? ""), String(it.category ?? ""), String(it.condition ?? ""), String(it.color ?? ""), String(it.size ?? ""), JSON.stringify(it.specifics ?? {}), JSON.stringify(it.keywords ?? []), Number(it.cost ?? 0), Number(it.price ?? 0), (it.min_price as number) ?? null, Number(it.quantity ?? 1), Number(it.quantity_purchased ?? 1), (it.weight_oz as number) ?? null).lastInsertRowid,
  );
  for (const [i, p] of ((it.photos as { url: string }[]) ?? []).entries()) db.prepare("INSERT INTO photos (item_id, path, position) VALUES (?, ?, ?)").run(itemId, `/replay/${p.url}`, i);
  const l = report.listing ?? {};
  const listingId = Number(
    db.prepare("INSERT INTO listings (item_id, marketplace, status, external_id, price, quantity) VALUES (?, ?, ?, ?, ?, ?)").run(itemId, report.marketplace, String(l.status ?? "pending"), (l.external_id as string) ?? null, Number(l.price ?? it.price ?? 0), Number(l.quantity ?? 1)).lastInsertRowid,
  );
  db.prepare("INSERT INTO connections (marketplace, status, username, credentials) VALUES (?, 'connected', 'replay', ?)").run(report.marketplace, JSON.stringify({ refresh_token: "replay", access_token: "replay", expires_at: Date.now() + 3600_000 }));
  if (report.marketplace === "ebay") db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ebay', ?)").run(JSON.stringify({ fulfillmentPolicyId: "r", paymentPolicyId: "r", returnPolicyId: "r", merchantLocationKey: "r" }));
  const jobId = Number(db.prepare("INSERT INTO jobs (marketplace, type, item_id, listing_id, status, attempts) VALUES (?, ?, ?, ?, 'pending', 2)").run(report.marketplace, report.job.type, itemId, listingId).lastInsertRowid);

  // Answer each request with the next recorded answer for the same method + path.
  const queue = [...report.exchanges];
  const realFetch = globalThis.fetch;
  const unmatched: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname + url.search;
    const i = queue.findIndex((e) => e.method === method && e.path === path);
    if (i < 0) {
      unmatched.push(`${method} ${path}`);
      return new Response(JSON.stringify({ errors: [{ message: "replay: no recorded answer for this request" }] }), { status: 599 });
    }
    const [e] = queue.splice(i, 1);
    log(`  ↔ ${method} ${path} → ${e.status}`);
    return new Response(e.status === 204 ? null : e.response, { status: e.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await processApiJobs(db);
  } finally {
    globalThis.fetch = realFetch;
  }
  const job = db.prepare("SELECT status, result FROM jobs WHERE id = ?").get(jobId) as { status: string; result: string | null };
  const error = job.result ? (JSON.parse(job.result).error as string | undefined) : undefined;
  return { status: job.status, error, reproduced: job.status === "failed" && error === report.error, unmatched };
}

if (process.argv[1]?.endsWith("replay.ts")) {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: npx tsx scripts/replay.ts <problem-report.json>");
    process.exit(2);
  }
  const report = JSON.parse(fs.readFileSync(file, "utf8")) as Report;
  console.log(`Replaying: ${report.job.marketplace} ${report.job.type} (recorded error: ${report.error})`);
  const r = await replay(report);
  console.log(r.reproduced ? `\n✕ Reproduced: ${r.error}` : `\nResult: ${r.status}${r.error ? ` (${r.error})` : ""}. ${r.status === "done" ? "It works now." : "Different from the report."}`);
  if (r.unmatched.length) console.log(`Requests with no recorded answer: ${r.unmatched.join(", ")}`);
  process.exit(r.reproduced ? 0 : 1);
}
