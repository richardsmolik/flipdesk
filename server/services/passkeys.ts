/**
 * Passkeys: sign in with Face ID, Touch ID, Windows Hello, an Android phone or a security key instead of a
 * password and code. Uses SimpleWebAuthn (the widely used WebAuthn library) for the cryptography; this file
 * only stores the public keys and the one-time challenges. A passkey counts as both steps of two-step sign-in:
 * it needs the device AND your face/fingerprint/PIN, and it only works on FlipDesk's own address (can't be phished).
 */
import crypto from "node:crypto";
import type { Request } from "express";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { Db } from "../db.js";

export interface Passkey { id: string; name: string; created_at: string; last_used_at: string | null; device: string }

export function ensurePasskeys(site: Db) {
  site.exec(`CREATE TABLE IF NOT EXISTS passkeys (id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, public_key TEXT NOT NULL, counter INTEGER NOT NULL DEFAULT 0,
    transports TEXT NOT NULL DEFAULT '[]', name TEXT NOT NULL DEFAULT 'Passkey', device TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used_at TEXT)`);
}

/** Which website the passkey belongs to. PUBLIC_BASE_URL wins; otherwise the address the browser used. */
export function relyingParty(req: Request) {
  const base = process.env.PUBLIC_BASE_URL?.trim();
  if (base) {
    const u = new URL(base);
    return { rpID: u.hostname, origin: u.origin };
  }
  const host = String(req.headers.host ?? "localhost");
  const https = req.secure || String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() === "https";
  const origin = `${https ? "https" : "http"}://${host}`;
  return { rpID: new URL(origin).hostname, origin };
}

const challenges = new Map<string, { challenge: string; ownerKey?: string; exp: number }>();
function remember(id: string, v: { challenge: string; ownerKey?: string }) {
  for (const [k, c] of challenges) if (c.exp < Date.now()) challenges.delete(k);
  challenges.set(id, { ...v, exp: Date.now() + 5 * 60_000 });
}
function takeChallenge(id: string) {
  const c = challenges.get(id);
  challenges.delete(id); // one use only
  return c && c.exp > Date.now() ? c : null;
}

/** A stable, meaningless id for the account (the passkey stores it; it isn't the email). */
const userHandle = (ownerKey: string) => new Uint8Array(crypto.createHash("sha256").update(`flipdesk-user:${ownerKey}`).digest().subarray(0, 16));

export function listPasskeys(site: Db, ownerKey: string): Passkey[] {
  ensurePasskeys(site);
  return site.prepare("SELECT id, name, device, created_at, last_used_at FROM passkeys WHERE owner_key = ? ORDER BY created_at").all(ownerKey) as unknown as Passkey[];
}

export const hasPasskeys = (site: Db) => {
  ensurePasskeys(site);
  return Boolean(site.prepare("SELECT 1 FROM passkeys LIMIT 1").get());
};

export async function registrationOptions(site: Db, rp: { rpID: string }, ownerKey: string, label: string) {
  ensurePasskeys(site);
  const existing = site.prepare("SELECT id, transports FROM passkeys WHERE owner_key = ?").all(ownerKey) as { id: string; transports: string }[];
  const options = await generateRegistrationOptions({
    rpName: "FlipDesk",
    rpID: rp.rpID,
    userName: label,
    userDisplayName: label,
    userID: userHandle(ownerKey),
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({ id: c.id, transports: JSON.parse(c.transports) })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  remember(`reg:${ownerKey}`, { challenge: options.challenge, ownerKey });
  return options;
}

export async function finishRegistration(site: Db, rp: { rpID: string; origin: string }, ownerKey: string, response: RegistrationResponseJSON, name: string, device: string) {
  const c = takeChallenge(`reg:${ownerKey}`);
  if (!c) throw Object.assign(new Error("That took too long. Try adding the passkey again."), { status: 400 });
  let v;
  try {
    v = await verifyRegistrationResponse({ response, expectedChallenge: c.challenge, expectedOrigin: rp.origin, expectedRPID: rp.rpID, requireUserVerification: true });
  } catch (e) {
    throw Object.assign(new Error(`The passkey couldn't be checked: ${(e as Error).message}`), { status: 400 });
  }
  if (!v.verified) throw Object.assign(new Error("The passkey couldn't be checked."), { status: 400 });
  const cred = v.registrationInfo.credential;
  site
    .prepare("INSERT INTO passkeys (id, owner_key, public_key, counter, transports, name, device) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(cred.id, ownerKey, Buffer.from(cred.publicKey).toString("base64url"), cred.counter, JSON.stringify(cred.transports ?? response.response.transports ?? []), name.slice(0, 60) || "Passkey", device.slice(0, 100));
  return { id: cred.id };
}

/** Start a passkey sign-in. No email needed: the device offers the passkeys it has for this site. */
export async function loginOptions(rp: { rpID: string }) {
  const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: "required", allowCredentials: [] });
  const ticket = crypto.randomBytes(18).toString("base64url");
  remember(`login:${ticket}`, { challenge: options.challenge });
  return { ticket, options };
}

/** Finish a passkey sign-in: returns whose passkey it was ("owner" or "u<id>"). */
export async function finishLogin(site: Db, rp: { rpID: string; origin: string }, ticket: string, response: AuthenticationResponseJSON) {
  ensurePasskeys(site);
  const c = takeChallenge(`login:${ticket}`);
  if (!c) throw Object.assign(new Error("That took too long. Try again."), { status: 401 });
  const row = site.prepare("SELECT * FROM passkeys WHERE id = ?").get(response.id) as { id: string; owner_key: string; public_key: string; counter: number; transports: string } | undefined;
  if (!row) throw Object.assign(new Error("This passkey isn't set up on FlipDesk (it may have been removed). Sign in with your password."), { status: 401 });
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response,
      expectedChallenge: c.challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: true,
      credential: { id: row.id, publicKey: new Uint8Array(Buffer.from(row.public_key, "base64url")), counter: row.counter, transports: JSON.parse(row.transports) },
    });
  } catch (e) {
    throw Object.assign(new Error(`That passkey didn't work: ${(e as Error).message}`), { status: 401 });
  }
  if (!v.verified) throw Object.assign(new Error("That passkey didn't work."), { status: 401 });
  site.prepare("UPDATE passkeys SET counter = ?, last_used_at = datetime('now') WHERE id = ?").run(v.authenticationInfo.newCounter, row.id);
  return { ownerKey: row.owner_key, passkeyId: row.id };
}

export function removePasskey(site: Db, ownerKey: string, id: string) {
  ensurePasskeys(site);
  return site.prepare("DELETE FROM passkeys WHERE owner_key = ? AND id = ?").run(ownerKey, id).changes > 0;
}

export function renamePasskey(site: Db, ownerKey: string, id: string, name: string) {
  ensurePasskeys(site);
  return site.prepare("UPDATE passkeys SET name = ? WHERE owner_key = ? AND id = ?").run(name.slice(0, 60) || "Passkey", ownerKey, id).changes > 0;
}

/** "Safari on iPhone", "Chrome on Windows"… from the browser's user agent (best effort). */
export function describeDevice(ua = "") {
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /CrOS/.test(ua) ? "Chromebook" : /Linux/.test(ua) ? "Linux" : "";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /Firefox\/|FxiOS/.test(ua) ? "Firefox" : /Chrome\/|CriOS/.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  if (!os && !browser) return ua ? "an unknown browser" : "an unknown device";
  return `${browser || "A browser"}${os ? ` on ${os}` : ""}`;
}
