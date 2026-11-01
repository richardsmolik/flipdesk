import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import "./index.css";
import { api } from "./api";
import { Toaster } from "./ui";
import { MobileBar, Sidebar, useNavCounts } from "./components/Nav";
import { Welcome, type OnboardingState } from "./components/Onboarding";
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
import Bundles from "./pages/Bundles";
import Shipping from "./pages/Shipping";
import { Labels, PackingSlips, PickList } from "./pages/Print";
import { BinDetail, BinList } from "./pages/Bins";
import Mileage from "./pages/Mileage";
import Bulk from "./pages/Bulk";
import PhoneCapture from "./pages/PhoneCapture";
import Shoot from "./pages/Shoot";
import Switch from "./pages/Switch";


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
  const counts = useNavCounts();
  const [welcome, setWelcome] = useState(false);
  useEffect(() => {
    api.get<OnboardingState>("/api/onboarding").then((o) => setWelcome(o.showWelcome)).catch(() => {});
    const open = () => setWelcome(true);
    window.addEventListener("fd-open-welcome", open);
    return () => window.removeEventListener("fd-open-welcome", open);
  }, []);
  useEffect(() => void api.get<{ ai: string; ebay: string }>("/api/health").then(setHealth).catch(() => {}), []);
  if (needLogin) return <Login />;
  return (
    <div className="flex min-h-screen">
      <Sidebar
        counts={counts}
        footer={
          health && (
            <div className="space-y-1 px-2 text-[11px] text-zinc-500">
              <div>AI writer: <span className={health.ai === "live" ? "text-green-400" : "text-amber-400"}>{health.ai}</span></div>
              <div>eBay API: <span className={health.ebay === "live" ? "text-green-400" : "text-amber-400"}>{health.ebay}</span></div>
            </div>
          )
        }
      />
      <main className="min-w-0 flex-1 p-4 pb-24 md:p-8">
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
          <Route path="/bundles" element={<Bundles />} />
          <Route path="/shipping" element={<Shipping />} />
          <Route path="/bins" element={<BinList />} />
          <Route path="/mileage" element={<Mileage />} />
          <Route path="/bulk" element={<Bulk />} />
          <Route path="/shoot" element={<Shoot />} />
          <Route path="/switch" element={<Switch />} />
          <Route path="/bins/:name" element={<BinDetail />} />
        </Routes>
      </main>
      <MobileBar counts={counts} />
      {welcome && <Welcome onDone={() => (setWelcome(false), window.dispatchEvent(new Event("fd-onboarding-changed")))} />}
      <Toaster />
    </div>
  );
}

// Installable app: register the offline service worker (secure origins only: HTTPS or localhost).
if (import.meta.env.PROD && "serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        {/* Print pages render without the app chrome */}
        <Route path="/print/slips" element={<PackingSlips />} />
        <Route path="/print/picklist" element={<PickList />} />
        <Route path="/print/labels" element={<Labels />} />
        <Route path="/m/:token" element={<PhoneCapture />} />
        <Route path="*" element={<Shell />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
