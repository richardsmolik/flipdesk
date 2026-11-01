/**
 * Phone -> draft uploads. The computer shows a QR code; the phone opens a page that can ONLY add
 * photos to that one item, for 30 minutes, with up to 60 photos. No login needed on the phone.
 */
import crypto from "node:crypto";
import os from "node:os";
import type { Db } from "../db.js";

export const TOKEN_MINUTES = 30;
export const MAX_PER_TOKEN = 60;

export function createUploadToken(db: Db, itemId: number) {
  const token = crypto.randomBytes(18).toString("base64url");
  db.prepare("DELETE FROM upload_tokens WHERE expires_at < datetime('now')").run();
  db.prepare("INSERT INTO upload_tokens (token, item_id, expires_at) VALUES (?, ?, datetime('now', ?))").run(token, itemId, `+${TOKEN_MINUTES} minutes`);
  const row = db.prepare("SELECT expires_at FROM upload_tokens WHERE token = ?").get(token) as { expires_at: string };
  return { token, expiresAt: row.expires_at };
}

export function checkUploadToken(db: Db, token: string) {
  const row = db.prepare("SELECT token, item_id, uploads, expires_at FROM upload_tokens WHERE token = ? AND expires_at > datetime('now')").get(token) as
    | { token: string; item_id: number; uploads: number; expires_at: string }
    | undefined;
  if (!row) throw Object.assign(new Error("This phone link has expired. Show a new QR code on your computer."), { status: 410 });
  return row;
}

/** Addresses a phone could use to reach this FlipDesk, best first. */
export function phoneAddresses() {
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? "127.0.0.1";
  const urls: string[] = [];
  if (process.env.PUBLIC_BASE_URL) urls.push(process.env.PUBLIC_BASE_URL.replace(/\/$/, ""));
  const lanBound = !["127.0.0.1", "localhost", "::1"].includes(host);
  if (lanBound) {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list ?? []) {
        if (a.family === "IPv4" && !a.internal) urls.push(`http://${a.address}:${port}`);
      }
    }
  }
  const prod = process.env.NODE_ENV === "production";
  let hint: string | null = null;
  if (!urls.length) {
    hint = "Your phone can't reach FlipDesk while it only listens on this computer. Restart with HOST=0.0.0.0 and FLIPDESK_PASSWORD set (same Wi-Fi), or use your online address (docs/DEPLOY.md).";
  } else if (!prod && !process.env.PUBLIC_BASE_URL) {
    hint = "Phone pages are served by the built app: run `npm run build && npm start` (not `npm run dev`).";
  }
  return { urls, hint };
}
