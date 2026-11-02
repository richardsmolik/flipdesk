import { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { api } from "../api";

/** Navigation grouped by job, with live badges; on phones, a bottom tab bar + "More" sheet. */
type Entry = { to: string; label: string; icon: string; badge?: keyof Counts; only?: "accounts" | "owner" | "member" };
type Group = { key: string; label: string; items: Entry[] };
export interface Counts { inbox: number; toShip: number; drafts: number; failed: number }

export const GROUPS: Group[] = [
  { key: "home", label: "", items: [{ to: "/", label: "Dashboard", icon: "📊" }, { to: "/inbox", label: "Inbox", icon: "🔔", badge: "inbox" }] },
  {
    key: "sell",
    label: "Sell",
    items: [
      { to: "/items/new", label: "New listing", icon: "✨" },
      { to: "/shoot", label: "Shoot (phone)", icon: "📷" },
      { to: "/bulk", label: "Bulk upload", icon: "🗂️" },
      { to: "/inventory", label: "Inventory", icon: "📦", badge: "drafts" },
      { to: "/bundles", label: "Bundles", icon: "🎁" },
    ],
  },
  { key: "source", label: "Source", items: [{ to: "/source", label: "Sourcing mode", icon: "🛒" }, { to: "/mileage", label: "Mileage", icon: "🚗" }] },
  { key: "ship", label: "Ship", items: [{ to: "/shipping", label: "Shipping", icon: "🚚", badge: "toShip" }, { to: "/bins", label: "Bins", icon: "🗄️" }] },
  {
    key: "money",
    label: "Money",
    items: [
      { to: "/sales", label: "Sales & profit", icon: "💵" },
      { to: "/reports", label: "Reports", icon: "📈" },
      { to: "/leaderboard", label: "Leaderboard", icon: "🏆", only: "accounts" },
    ],
  },
  { key: "tools", label: "Tools", items: [{ to: "/tools", label: "Power tools", icon: "⚡" }, { to: "/queue", label: "Sync queue", icon: "🔄", badge: "failed" }] },
  {
    key: "setup",
    label: "Setup",
    items: [
      { to: "/connections", label: "Marketplaces", icon: "🔌" },
      { to: "/switch", label: "Switch to FlipDesk", icon: "🔀" },
      { to: "/settings", label: "Settings", icon: "⚙️" },
      { to: "/accounts", label: "Accounts", icon: "👥", only: "owner" },
      { to: "/billing", label: "Your plan", icon: "💳", only: "member" },
    ],
  },
];

/** Hide "Leaderboard" unless hosted with accounts, and "Accounts" unless you're the owner. */
export interface NavShop { mode: "single" | "accounts"; user: { owner: boolean } | null; shared?: boolean }
export function groupsFor(shop?: NavShop | null) {
  return GROUPS.map((g) => ({
    ...g,
    items: g.items.filter(
      (e) =>
        !e.only ||
        (e.only === "accounts" ? shop?.mode === "accounts" && !shop.shared : e.only === "member" ? shop?.mode === "accounts" && Boolean(shop.user) && !shop.user!.owner : Boolean(shop?.user?.owner)),
    ),
  }));
}

const BADGE_TONE: Record<keyof Counts, string> = {
  inbox: "bg-red-600 text-white",
  toShip: "bg-amber-500 text-black",
  drafts: "bg-zinc-700 text-zinc-200",
  failed: "bg-red-600 text-white",
};

export function useNavCounts() {
  const [c, setC] = useState<Counts | null>(null);
  const loc = useLocation();
  useEffect(() => {
    let alive = true;
    const load = () => api.get<Counts>("/api/nav-counts").then((x) => alive && setC(x)).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => ((alive = false), clearInterval(t));
  }, [loc.pathname]); // refresh as you move around
  return c;
}

function Badge({ n, tone, label }: { n: number; tone: string; label: string }) {
  if (!n) return null;
  return <span className={`ml-auto min-w-[1.25rem] rounded-full px-1.5 text-center text-[10px] font-semibold leading-5 ${tone}`} aria-label={`${n} ${label}`}>{n > 99 ? "99+" : n}</span>;
}

function Link_({ e, counts, onClick }: { e: Entry; counts: Counts | null; onClick?: () => void }) {
  return (
    <NavLink
      to={e.to}
      end={e.to === "/"}
      onClick={onClick}
      className={({ isActive }) => `flex items-center gap-2 rounded-md px-2 py-1.5 text-sm ${isActive ? "bg-zinc-800 text-white" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"}`}
    >
      <span aria-hidden>{e.icon}</span>
      {e.label}
      {e.badge && counts && <Badge n={counts[e.badge]} tone={BADGE_TONE[e.badge]} label={e.label} />}
    </NavLink>
  );
}

export function Sidebar({ counts, footer, shop }: { counts: Counts | null; footer?: React.ReactNode; shop?: NavShop | null }) {
  const loc = useLocation();
  const [closed, setClosed] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem("fd-nav-closed") ?? "{}");
    } catch {
      return {};
    }
  });
  const toggle = (k: string) =>
    setClosed((c) => {
      const next = { ...c, [k]: !c[k] };
      try {
        localStorage.setItem("fd-nav-closed", JSON.stringify(next));
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  return (
    <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col overflow-y-auto border-r border-zinc-800 bg-zinc-950 p-3 md:flex">
      <div className="mb-4 px-2 pt-2 text-lg font-bold tracking-tight">📦 Flip<span className="text-brand">Desk</span></div>
      <nav className="space-y-3" aria-label="Main">
        {groupsFor(shop).map((g) => {
          const active = g.items.some((e) => (e.to === "/" ? loc.pathname === "/" : loc.pathname.startsWith(e.to)));
          const isClosed = closed[g.key] && !active; // never hide the section you're in
          const pending = g.items.reduce((a, e) => a + (e.badge && counts ? counts[e.badge] : 0), 0);
          return (
            <div key={g.key}>
              {g.label && (
                <button className="flex w-full items-center justify-between px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-500 hover:text-zinc-300" onClick={() => toggle(g.key)} aria-expanded={!isClosed}>
                  <span>{g.label}</span>
                  <span className="flex items-center gap-1">
                    {isClosed && pending > 0 && <span className="h-1.5 w-1.5 rounded-full bg-amber-400" aria-label="has items needing attention" />}
                    <span aria-hidden>{isClosed ? "▸" : "▾"}</span>
                  </span>
                </button>
              )}
              {!isClosed && <div className="space-y-0.5">{g.items.map((e) => <Link_ key={e.to} e={e} counts={counts} />)}</div>}
            </div>
          );
        })}
      </nav>
      {footer && <div className="mt-auto pt-4">{footer}</div>}
    </aside>
  );
}

const TABS: Entry[] = [
  { to: "/", label: "Home", icon: "📊", badge: "inbox" },
  { to: "/shoot", label: "Shoot", icon: "📷" },
  { to: "/inventory", label: "Inventory", icon: "📦" },
  { to: "/shipping", label: "Ship", icon: "🚚", badge: "toShip" },
];

export function MobileBar({ counts, shop }: { counts: Counts | null; shop?: NavShop | null }) {
  const [more, setMore] = useState(false);
  const loc = useLocation();
  useEffect(() => setMore(false), [loc.pathname]);
  return (
    <>
      {more && (
        <div className="fixed inset-0 z-40 bg-black/60 md:hidden" onClick={() => setMore(false)}>
          <div className="absolute inset-x-0 bottom-16 max-h-[75vh] space-y-3 overflow-y-auto rounded-t-2xl border-t border-zinc-800 bg-zinc-950 p-4 pb-6" onClick={(e) => e.stopPropagation()}>
            {groupsFor(shop).map((g) => (
              <div key={g.key}>
                {g.label && <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">{g.label}</div>}
                <div className="grid grid-cols-2 gap-0.5">{g.items.map((e) => <Link_ key={e.to} e={e} counts={counts} />)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      <nav className="fixed inset-x-0 bottom-0 z-50 grid grid-cols-5 border-t border-zinc-800 bg-zinc-950/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden" aria-label="Main">
        {TABS.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.to === "/"} className={({ isActive }) => `relative flex flex-col items-center gap-0.5 py-2 text-[11px] ${isActive ? "text-white" : "text-zinc-500"}`}>
            <span className="text-lg leading-none" aria-hidden>{t.icon}</span>
            {t.label}
            {t.badge && counts && counts[t.badge] > 0 && <span className={`absolute right-1/4 top-1 min-w-[1rem] rounded-full px-1 text-[9px] font-semibold leading-4 ${BADGE_TONE[t.badge]}`}>{counts[t.badge]}</span>}
          </NavLink>
        ))}
        <button className={`flex flex-col items-center gap-0.5 py-2 text-[11px] ${more ? "text-white" : "text-zinc-500"}`} onClick={() => setMore(!more)} aria-expanded={more}>
          <span className="text-lg leading-none" aria-hidden>☰</span>
          More
        </button>
      </nav>
    </>
  );
}
