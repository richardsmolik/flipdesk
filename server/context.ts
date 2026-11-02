/**
 * Which shop (workspace) the current request or background job belongs to.
 * One FlipDesk server can hold your real shop, a sample shop, and, when hosted for others,
 * one shop per account. Each has its own database and photo folder.
 */
import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";

export interface WorkspaceContext {
  key: string; // "main" | "demo" | "u12" | "u12d"
  /** The real shop of the person who runs the server: the only one that may use personal keys from .env. */
  owner: boolean;
  demo: boolean;
  /** Where this shop's photos are served from, e.g. "/uploads/" or "/uploads/u12/". */
  urlPrefix: string;
  /** Put in front of phone-link and extension tokens so the server knows which shop they belong to. */
  tokenPrefix: string;
  /** Hosted with accounts: whose shop this is. */
  userId?: number;
}

const als = new AsyncLocalStorage<WorkspaceContext>();
export const currentWorkspace = () => als.getStore();
export const runInWorkspace = <T>(ws: WorkspaceContext, fn: () => T) => als.run(ws, fn);

/**
 * Personal credentials from .env (your mailbox, your Shippo, Etsy, Shopify accounts, your extension token)
 * only apply to the owner's real shop. Never to the sample shop or to other people's accounts.
 * App-level keys (Anthropic, eBay developer app, photo AI) are not personal and are read directly.
 */
export const PERSONAL_ENV = ["IMAP_HOST", "IMAP_USER", "IMAP_PASSWORD", "IMAP_PORT", "IMAP_SECURE", "IMAP_MAILBOX", "SHIPPO_API_KEY", "ETSY_API_KEY", "ETSY_ACCESS_TOKEN", "ETSY_SHOP_ID", "SHOPIFY_STORE_DOMAIN", "SHOPIFY_ADMIN_TOKEN", "FLIPDESK_TOKEN"] as const;
export function personalEnv(name: (typeof PERSONAL_ENV)[number]) {
  const ws = currentWorkspace();
  if (ws && !ws.owner) return undefined;
  return process.env[name];
}

/**
 * AI spending guard. The server installs one when hosted for others (daily cap per account).
 * Call useAi() right before any paid Claude request; it throws a friendly 429 when the cap is reached.
 */
type AiGate = (ws: WorkspaceContext | undefined, kind: string) => void;
let aiGate: AiGate | null = null;
export const setAiGate = (g: AiGate | null) => void (aiGate = g);
export function useAi(kind: string) {
  aiGate?.(currentWorkspace(), kind);
}

/** Public URL path of an uploaded photo file in the current shop. */
export function uploadUrl(filePath: string) {
  const name = filePath.split(/[\\/]/).pop()!;
  return `${currentWorkspace()?.urlPrefix ?? "/uploads/"}${name}`;
}

type Listener = (...a: unknown[]) => void;
const BOUND = new WeakMap<Listener, Listener>();

/**
 * Express middleware: run the rest of this request inside the shop. Body parsers and multer read the
 * request stream through event listeners, which would otherwise lose the shop, so listeners added to
 * the request are bound to it too (and can still be removed normally).
 */
export function enterWorkspace(ws: WorkspaceContext) {
  return (req: import("node:http").IncomingMessage, _res: unknown, next: () => void) => {
    runInWorkspace(ws, () => {
      const r = req as unknown as Record<string, (ev: string, fn: Listener) => unknown>;
      for (const m of ["on", "once", "addListener", "prependListener", "prependOnceListener"]) {
        const orig = r[m].bind(req);
        r[m] = (ev, fn) => {
          let b = BOUND.get(fn);
          if (!b) BOUND.set(fn, (b = AsyncResource.bind(fn)));
          return orig(ev, b);
        };
      }
      for (const m of ["off", "removeListener"]) {
        const orig = r[m].bind(req);
        r[m] = (ev, fn) => orig(ev, BOUND.get(fn) ?? fn);
      }
      next();
    });
  };
}
