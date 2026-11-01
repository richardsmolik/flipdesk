import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, NavLink, Route, Routes } from "react-router-dom";
import "./index.css";
import { api } from "./api";
import { Toaster } from "./ui";
import Dashboard from "./pages/Dashboard";
import Inventory from "./pages/Inventory";
import ItemEditor from "./pages/ItemEditor";
import Sales from "./pages/Sales";
import Tools from "./pages/Tools";
import Queue from "./pages/Queue";
import Connections from "./pages/Connections";
import Settings from "./pages/Settings";
import Inbox from "./pages/Inbox";
import Source from "./pages/Source";
import Reports from "./pages/Reports";

const NAV = [
  ["/", "Dashboard", "📊"],
  ["/inbox", "Inbox", "🔔"],
  ["/items/new", "New listing", "✨"],
  ["/source", "Sourcing mode", "🛒"],
  ["/inventory", "Inventory", "📦"],
  ["/sales", "Sales & profit", "💵"],
  ["/reports", "Reports", "📈"],
  ["/tools", "Power tools", "⚡"],
  ["/queue", "Sync queue", "🔄"],
  ["/connections", "Marketplaces", "🔌"],
  ["/settings", "Settings", "⚙️"],
] as const;

function Login() {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form
        className="card w-full max-w-sm space-y-3 p-6"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.post("/api/login", { password: pw });
            location.reload();
          } catch (x) {
            setErr((x as Error).message);
          }
        }}
      >
        <div className="text-lg font-bold">📦 Flip<span className="text-brand">Desk</span></div>
        <input className="input" type="password" autoFocus placeholder="Password" value={pw} onChange={(e) => setPw(e.target.value)} />
        {err && <div className="text-sm text-red-400">{err}</div>}
        <button className="btn-primary w-full">Sign in</button>
      </form>
    </div>
  );
}

function Shell() {
  const [needLogin, setNeedLogin] = useState(false);
  useEffect(() => {
    const f = () => setNeedLogin(true);
    window.addEventListener("fd-login-required", f);
    return () => window.removeEventListener("fd-login-required", f);
  }, []);
  const [health, setHealth] = useState<{ ai: string; ebay: string } | null>(null);
  useEffect(() => void api.get<{ ai: string; ebay: string }>("/api/health").then(setHealth).catch(() => {}), []);
  if (needLogin) return <Login />;
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950 p-3 md:flex">
        <div className="mb-6 px-2 pt-2 text-lg font-bold tracking-tight">
          📦 Flip<span className="text-brand">Desk</span>
        </div>
        <nav className="space-y-0.5">
          {NAV.map(([to, label, icon]) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              className={({ isActive }) =>
                `flex items-center gap-2 rounded-md px-2 py-1.5 text-sm ${isActive ? "bg-zinc-800 text-white" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"}`
              }
            >
              <span aria-hidden>{icon}</span>
              {label}
            </NavLink>
          ))}
        </nav>
        {health && (
          <div className="mt-auto space-y-1 px-2 text-[11px] text-zinc-500">
            <div>
              AI writer: <span className={health.ai === "live" ? "text-green-400" : "text-amber-400"}>{health.ai}</span>
            </div>
            <div>
              eBay API: <span className={health.ebay === "live" ? "text-green-400" : "text-amber-400"}>{health.ebay}</span>
            </div>
          </div>
        )}
      </aside>
      <main className="min-w-0 flex-1 p-4 md:p-8">
        <nav className="mb-4 flex gap-1 overflow-x-auto md:hidden">
          {NAV.map(([to, label]) => (
            <NavLink key={to} to={to} end={to === "/"} className="whitespace-nowrap rounded bg-zinc-900 px-2 py-1 text-xs">
              {label}
            </NavLink>
          ))}
        </nav>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/inventory" element={<Inventory />} />
          <Route path="/items/new" element={<ItemEditor key="new" />} />
          <Route path="/items/:id" element={<ItemEditor />} />
          <Route path="/sales" element={<Sales />} />
          <Route path="/tools" element={<Tools />} />
          <Route path="/queue" element={<Queue />} />
          <Route path="/connections" element={<Connections />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/inbox" element={<Inbox />} />
          <Route path="/source" element={<Source />} />
          <Route path="/reports" element={<Reports />} />
        </Routes>
      </main>
      <Toaster />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  </StrictMode>,
);
