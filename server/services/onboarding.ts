/**
 * First run: a 3-question welcome that sets sensible defaults, then a "get started" checklist
 * whose steps tick themselves off from what you've actually done (no manual checkboxes).
 */
import { getSetting, setSetting, type Db } from "../db.js";
import { ebayIsLive } from "../marketplaces/ebay.js";
import { MARKETPLACES, isMarketplaceId, type MarketplaceId } from "../marketplaces/registry.js";
import type { NotifySettings } from "./alerts.js";

export interface Profile {
  marketplaces: MarketplaceId[];
  sells: string[]; // clothing, electronics, collectibles, home, books, everything
  experience: "new" | "growing" | "fulltime";
  done: boolean;
}

export const SOURCING_BY_EXPERIENCE: Record<Profile["experience"], { minProfit: number; minRoiPct: number }> = {
  new: { minProfit: 8, minRoiPct: 100 },
  growing: { minProfit: 10, minRoiPct: 100 },
  fulltime: { minProfit: 15, minRoiPct: 150 },
};

export function saveProfile(db: Db, p: Omit<Profile, "done">) {
  const marketplaces = p.marketplaces.filter(isMarketplaceId);
  setSetting(db, "profile", { ...p, marketplaces, done: true });
  if (marketplaces.length) setSetting(db, "defaultMarketplaces", marketplaces);
  // Don't overwrite targets you've already tuned.
  if (!getSetting(db, "sourcing", null)) setSetting(db, "sourcing", SOURCING_BY_EXPERIENCE[p.experience] ?? SOURCING_BY_EXPERIENCE.growing);
  if (!getSetting(db, "shipping", null) && !marketplaces.includes("ebay")) setSetting(db, "shipping", { defaultProvider: "pirateship" });
}

/** Short "show me how" guides for each checklist step (plain steps; no video needed). */
export const HOW: Record<string, string[]> = {
  profile: ["Click this step.", "Pick the sites you sell on, what you sell and how much.", "Click Let's go. You can change any of it later in Settings."],
  ebay: [
    "On developer.ebay.com, create a free account and a Production keyset (App ID, Cert ID).",
    "Add the RuName (sign-in redirect) shown on FlipDesk's Marketplaces page.",
    "Put the three values in your .env file and restart FlipDesk.",
    "Marketplaces → Connect eBay → sign in. It comes back on its own.",
    "Follow the eBay checklist: business policies, choose policies, ship-from location. Full guide: docs/EBAY_SETUP.md.",
  ],
  item: ["Click New listing (or press n).", "Drop 3-12 photos. On your phone, use 📱 Use phone or Shoot mode.", "Click ✨ Write it for me. Check the flaws and 'double-check' notes, then Save."],
  crosslist: ["Open the item.", "Tick the sites (your favorites are already ticked).", "Click Crosslist. Sites with an API list right away; the others go to the Chrome extension."],
  extension: [
    "In Chrome, open chrome://extensions and turn on Developer mode.",
    "Click Load unpacked and choose the extension folder inside FlipDesk.",
    "Open the extension, paste your server address and the token from the Marketplaces page.",
    "Log in to Poshmark, Mercari, etc. in the same Chrome. Listings fill in automatically.",
  ],
  notify: ["Install the free ntfy app on your phone.", "Subscribe to a long, private topic name (like flipdesk-7k2p9x).", "Settings → Notifications: enter the same name and press Send test."],
  sale: ["Nothing to do. When anything sells, FlipDesk delists it everywhere else.", "Then open Shipping to print the label and packing slip."],
};

export function onboarding(db: Db) {
  const profile = getSetting<Profile | null>(db, "profile", null);
  const dismissed = getSetting(db, "onboardingDismissed", false);
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const chosen = profile?.marketplaces ?? [];
  const wantsExtension = chosen.some((m) => MARKETPLACES[m]?.mode === "extension");
  const extConnected = n(
    `SELECT COUNT(*) AS n FROM connections WHERE status = 'connected' AND marketplace IN (${Object.values(MARKETPLACES)
      .filter((m) => m.mode === "extension")
      .map((m) => `'${m.id}'`)
      .join(",")})`,
  );
  const usesEbay = !profile || chosen.includes("ebay");
  const steps = [
    { key: "profile", label: "Tell FlipDesk how you sell", done: Boolean(profile?.done), detail: "3 quick questions; sets your default sites and profit targets.", href: "#welcome" },
    usesEbay && { key: "ebay", label: "Connect eBay", done: ebayIsLive(db), detail: "Guided checklist, about 20 minutes once (docs/EBAY_SETUP.md).", href: "/connections" },
    { key: "item", label: "Add your first item", done: n("SELECT COUNT(DISTINCT item_id) AS n FROM photos") > 0, detail: "Snap photos (computer or phone) and let AI write it, or import from another tool.", href: "/items/new" },
    { key: "crosslist", label: "Crosslist it", done: n("SELECT COUNT(*) AS n FROM listings WHERE status IN ('active','sold')") > 0, detail: "Pick sites and click Crosslist. FlipDesk keeps them in sync.", href: "/inventory?view=drafts" },
    (wantsExtension || !profile) && { key: "extension", label: "Install the Chrome extension", done: extConnected > 0, detail: "For Poshmark, Mercari, Depop, Vinted, Grailed, Facebook and Whatnot (load the extension/ folder, paste your token).", href: "/connections" },
    { key: "notify", label: "Get sale alerts on your phone", done: Boolean(getSetting<NotifySettings>(db, "notify", {}).ntfyTopic), detail: "Free with the ntfy app. Takes 1 minute.", href: "/settings" },
    { key: "sale", label: "Make your first sale", done: n("SELECT COUNT(*) AS n FROM sales") > 0, detail: "When it sells, FlipDesk delists it everywhere else and shows your real profit.", href: "/sales" },
  ]
    .filter(Boolean)
    .map((s) => ({ ...(s as object), how: HOW[(s as { key: string }).key] ?? [] })) as { key: string; label: string; done: boolean; detail: string; href: string; how: string[] }[];
  const doneCount = steps.filter((s) => s.done).length;
  return {
    showWelcome: !profile?.done && !dismissed,
    checklistHidden: Boolean(getSetting(db, "checklistHidden", false)),
    dismissed: Boolean(dismissed),
    profile,
    defaultMarketplaces: getSetting<MarketplaceId[]>(db, "defaultMarketplaces", []),
    steps,
    doneCount,
    total: steps.length,
    complete: doneCount === steps.length,
  };
}
