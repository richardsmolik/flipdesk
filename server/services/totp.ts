/**
 * Two-step sign-in: 6-digit codes from an authenticator app (Google Authenticator, 1Password, Authy…),
 * RFC 6238 TOTP (SHA-1, 30 s, ±1 step for clock drift), plus one-time recovery codes. No dependencies.
 */
import crypto from "node:crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string) {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    value = (value << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newSecret = () => base32Encode(crypto.randomBytes(20));

export function totpAt(secret: string, counter: number) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, "0");
}

/** The matching time step (so it can't be reused), or null. */
export function verifyTotp(secret: string, code: string, now = Date.now(), lastUsedStep = -1): number | null {
  const c = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const step = Math.floor(now / 30_000);
  for (const d of [0, -1, 1]) {
    const s = step + d;
    if (s <= lastUsedStep) continue; // already used: no replays
    const want = totpAt(secret, s);
    if (crypto.timingSafeEqual(Buffer.from(want), Buffer.from(c))) return s;
  }
  return null;
}

export const otpauthUrl = (secret: string, account: string, issuer = "FlipDesk") =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

const hash = (code: string) => crypto.createHash("sha256").update(code.replace(/[^a-z0-9]/gi, "").toLowerCase()).digest("hex");

/** 10 one-time recovery codes (shown once) and their hashes (stored). */
export function newRecoveryCodes() {
  const codes = Array.from({ length: 10 }, () => {
    const s = crypto.randomBytes(5).toString("hex");
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
  return { codes, hashes: codes.map(hash) };
}

/** If code is an unused recovery code, return the remaining hashes (it's used up); else null. */
export function useRecoveryCode(hashes: string[], code: string): string[] | null {
  const h = hash(code);
  const i = hashes.indexOf(h);
  return i < 0 ? null : hashes.filter((_, k) => k !== i);
}
