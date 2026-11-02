import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import "./index.css";
import { api } from "./api";
import { Toaster } from "./ui";
import { MobileBar, Sidebar, useNavCounts } from "./components/Nav";
import { Welcome, type OnboardingState } from "./components/Onboarding";
import { Shortcuts } from "./components/Shortcuts";
import Uptime from "./pages/Uptime";
import { AuthScreen, DemoBanner, NotMePage, PlanBanner, ResetPage, SharePage, ShopSwitch, useBilling, useWorkspace } from "./components/Account";
import Billing from "./pages/Billing";
import StatusPage from "./pages/Status";
import Help from "./pages/Help";
import LaunchPage from "./pages/Launch";
import { HelpButton } from "./components/HelpChat";
import { useParams } from "react-router-dom";
import Leaderboard from "./pages/Leaderboard";
import Accounts from "./pages/Accounts";
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


function ShareRoute() {
  return <SharePage token={useParams().token ?? ""} />;
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
  const shop = useWorkspace();
  const plan = useBilling(Boolean(shop?.user && !shop.user.owner));
  if (needLogin) return <AuthScreen />;
  return (
    <div className="flex min-h-screen">
      <Sidebar
        shop={shop}
        counts={counts}
        footer={
          health && (
            <div className="space-y-1 px-2 text-[11px] text-zinc-500">
              <ShopSwitch w={shop} />
              <div>AI writer: <span className={health.ai === "live" ? "text-green-400" : "text-amber-400"}>{health.ai}</span></div>
              <div>eBay API: <span className={health.ebay === "live" ? "text-green-400" : "text-amber-400"}>{health.ebay}</span></div>
              <button className="hidden hover:text-zinc-300 md:block" onClick={() => window.dispatchEvent(new Event("fd-shortcuts"))}>⌨ Shortcuts <kbd className="rounded border border-zinc-700 px-1">?</kbd></button>
            </div>
          )
        }
      />
      <main className="min-w-0 flex-1 pb-24">
        {shop?.paymentsTest && <div className="border-b border-fuchsia-900 bg-fuchsia-950/80 px-4 py-1 text-center text-xs text-fuchsia-100">🧪 Payments are in <b>TEST mode</b>: no real charges{shop.user?.owner ? " (switch to Live on the Accounts page)" : ""}.</div>}
        <PlanBanner b={plan} />
        <DemoBanner w={shop} />
        <div className="p-4 md:p-8">
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
          <Route path="/leaderboard" element={<Leaderboard />} />
          <Route path="/accounts" element={<Accounts />} />
          <Route path="/billing" element={<Billing />} />
          <Route path="/status" element={<StatusPage />} />
          <Route path="/help" element={<Help />} />
          <Route path="/launch" element={<LaunchPage />} />
        </Routes>
        </div>
      </main>
      <MobileBar counts={counts} shop={shop} />
      {welcome && <Welcome onDone={() => (setWelcome(false), window.dispatchEvent(new Event("fd-onboarding-changed")))} />}
      <Shortcuts />
      {!shop?.shared && <HelpButton />}
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
        <Route path="/reset" element={<ResetPage />} />
        <Route path="/not-me" element={<NotMePage />} />
        <Route path="/uptime" element={<Uptime />} />
        <Route path="/join" element={<AuthScreen />} />
        <Route path="/s/:token" element={<ShareRoute />} />
        <Route path="*" element={<Shell />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
