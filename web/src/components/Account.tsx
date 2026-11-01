import { useEffect, useState } from "react";
import { api } from "../api";
import { toast } from "../ui";

export interface WorkspaceState {
  mode: "single" | "accounts";
  current: "real" | "demo";
  demoExists: boolean;
  user: { email: string; owner: boolean } | null;
  signupsOpen: boolean;
  needsInvite: boolean;
}

export function useWorkspace() {
  const [w, setW] = useState<WorkspaceState | null>(null);
  useEffect(() => void api.get<WorkspaceState>("/api/workspace").then(setW).catch(() => {}), []);
  return w;
}

/** Switch between your shop and the sample shop. Reloads so every page shows the other shop. */
export async function switchShop(action: "enter_demo" | "leave_demo" | "reset_demo" | "delete_demo") {
  if (action === "enter_demo" || action === "reset_demo") toast("Building the sample shop…");
  await api.post("/api/workspace", { action });
  location.assign("/");
}

/** Sign-in screen: one shared password (your own server) or email accounts (hosted for others). */
export function AuthScreen() {
  const [mode, setMode] = useState<WorkspaceState | null>(null);
  const [tab, setTab] = useState<"in" | "up">("in");
  const [f, setF] = useState({ email: "", password: "", invite: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => void api.get<WorkspaceState>("/api/auth/mode").then((m) => (setMode(m), m.signupsOpen && !m.needsInvite && setTab("up"))).catch(() => setMode(null)), []);
  const accounts = mode?.mode === "accounts";
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      if (!accounts) await api.post("/api/login", { password: f.password });
      else if (tab === "in") await api.post("/api/auth/login", { email: f.email, password: f.password });
      else await api.post("/api/auth/signup", { email: f.email, password: f.password, invite: f.invite || undefined });
      location.assign("/");
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form className="card w-full max-w-sm space-y-3 p-6" onSubmit={submit}>
        <div className="text-lg font-bold">📦 Flip<span className="text-brand">Desk</span></div>
        {accounts && (
          <div className="flex gap-1 rounded-md bg-zinc-900 p-1 text-sm">
            {(["in", "up"] as const).map((t) => (
              <button type="button" key={t} onClick={() => setTab(t)} className={`flex-1 rounded px-2 py-1 ${tab === t ? "bg-zinc-700 text-white" : "text-zinc-400"}`} disabled={t === "up" && !mode?.signupsOpen}>
                {t === "in" ? "Sign in" : "Create account"}
              </button>
            ))}
          </div>
        )}
        {accounts && <input className="input" type="email" autoComplete="email" placeholder="Email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />}
        <input className="input" type="password" autoFocus={!accounts} autoComplete={tab === "up" ? "new-password" : "current-password"} placeholder={tab === "up" ? "Password (8+ characters)" : "Password"} required value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        {accounts && tab === "up" && mode?.needsInvite && <input className="input" placeholder="Invite code" required value={f.invite} onChange={(e) => setF({ ...f, invite: e.target.value })} />}
        {accounts && tab === "up" && !mode?.needsInvite && <p className="text-xs text-zinc-500">You're the first account, so you'll be the owner of this FlipDesk.</p>}
        {accounts && !mode?.signupsOpen && <p className="text-xs text-zinc-500">New accounts need an invite from the owner.</p>}
        {err && <div className="text-sm text-red-400">{err}</div>}
        <button className="btn-primary w-full" disabled={busy}>{busy ? "…" : !accounts || tab === "in" ? "Sign in" : "Create my shop"}</button>
      </form>
    </div>
  );
}

/** Shown across the top while you're in the sample shop. */
export function DemoBanner({ w }: { w: WorkspaceState | null }) {
  if (w?.current !== "demo") return null;
  return (
    <div className="sticky top-0 z-40 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-amber-800 bg-amber-950/95 px-4 py-2 text-sm text-amber-100">
      <span>🧪 <b>Sample shop.</b> Nothing here is real, so click anything.</span>
      <button className="rounded bg-amber-200 px-2 py-0.5 text-xs font-semibold text-amber-950 hover:bg-white" onClick={() => switchShop("leave_demo")}>Back to my shop</button>
      <button className="text-xs underline-offset-2 hover:underline" onClick={() => confirm("Start the sample shop over with fresh data?") && switchShop("reset_demo")}>Start over</button>
    </div>
  );
}

/** Sidebar footer: which shop you're in, and sign out when hosted. */
export function ShopSwitch({ w }: { w: WorkspaceState | null }) {
  if (!w) return null;
  return (
    <div className="space-y-1 px-2 text-[11px] text-zinc-500">
      {w.user && <div className="truncate" title={w.user.email}>👤 {w.user.email}</div>}
      {w.current === "demo" ? (
        <button className="block hover:text-zinc-300" onClick={() => switchShop("leave_demo")}>← Back to my shop</button>
      ) : (
        <button className="block hover:text-zinc-300" onClick={() => switchShop("enter_demo")}>🧪 {w.demoExists ? "Open" : "Try"} the sample shop</button>
      )}
      {w.user && (
        <button className="block hover:text-zinc-300" onClick={async () => (await api.post("/api/auth/logout"), location.assign("/"))}>Sign out</button>
      )}
    </div>
  );
}
