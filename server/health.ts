/**
 * What's working right now, for the Status page. Services report each success/failure as it happens
 * (AI calls, eBay calls, background tasks, email). Kept in memory: a restart starts fresh, which is fine
 * for "is it working now?".
 */
import { currentWorkspace } from "./context.js";

export interface Check { ok: number; fail: number; streak: number; lastOk?: string; lastFail?: string; lastError?: string }
const global = new Map<string, Check>();
const perShop = new Map<string, Map<string, Check>>();
const seen = new Map<string, string>(); // `${shop}:${what}` -> last time
export const startedAt = new Date().toISOString();

function bump(map: Map<string, Check>, key: string, ok: boolean, err?: string) {
  const c = map.get(key) ?? { ok: 0, fail: 0, streak: 0 };
  const now = new Date().toISOString();
  if (ok) (c.ok++, (c.lastOk = now), (c.streak = 0));
  else (c.fail++, c.streak++, (c.lastFail = now), (c.lastError = (err ?? "failed").slice(0, 300)));
  map.set(key, c);
}

/** Record one result. Also counted for the shop the call happened in. */
export function reportHealth(service: string, ok: boolean, err?: string) {
  bump(global, service, ok, err);
  const shop = currentWorkspace()?.key ?? "main";
  if (!perShop.has(shop)) perShop.set(shop, new Map());
  bump(perShop.get(shop)!, service, ok, err);
}

export const touch = (what: string, shop = currentWorkspace()?.key ?? "main") => void seen.set(`${shop}:${what}`, new Date().toISOString());
export const lastSeen = (what: string, shop: string) => seen.get(`${shop}:${what}`) ?? null;
export const globalCheck = (service: string) => global.get(service) ?? null;
export const shopCheck = (shop: string, service: string) => perShop.get(shop)?.get(service) ?? null;
export function resetHealth() {
  global.clear();
  perShop.clear();
  seen.clear();
}

/** ok | down: down when the latest result is a failure. */
export function stateOf(c: Check | null): "ok" | "down" | "unknown" {
  if (!c) return "unknown";
  if (c.lastFail && (!c.lastOk || c.lastFail > c.lastOk)) return "down";
  return "ok";
}

/** Wrap an Anthropic client so every structured-output call reports to the AI check. */
export function trackAnthropic<T>(client: T): T {
  const messages = (client as unknown as { beta: { messages: { parse: (...a: unknown[]) => Promise<unknown> } } }).beta.messages;
  const orig = messages.parse.bind(messages);
  messages.parse = async (...a: unknown[]) => {
    try {
      const r = await orig(...a);
      reportHealth("ai", true);
      return r;
    } catch (e) {
      reportHealth("ai", false, (e as Error).message);
      throw e;
    }
  };
  return client;
}
