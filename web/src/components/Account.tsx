import { useEffect, useState } from "react";
import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import { api } from "../api";
import { toast } from "../ui";

export interface WorkspaceState {
  mode: "single" | "accounts";
  current: "real" | "demo";
  demoExists: boolean;
  user: { email: string; owner: boolean } | null;
  signupsOpen: boolean;
  needsInvite: boolean;
  shared?: boolean;
  paymentsTest?: boolean;
}

export interface AccountInfo { user: { email: string; owner: boolean } | null; ai: { used: number; limit: number | null } | null; email: boolean; canEditSite: boolean; emailOptOut?: boolean }
export function useAccount() {
  const [a, setA] = useState<AccountInfo | null>(null);
  useEffect(() => void api.get<AccountInfo>("/api/account").then(setA).catch(() => {}), []);
  return a;
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
  const [tab, setTab] = useState<"in" | "up" | "forgot">("in");
  const [sent, setSent] = useState<null | { emailed: boolean }>(null);
  const [ticket, setTicket] = useState<string | null>(null);
  // "code": a code we emailed/phoned because this looked suspicious; "2fa": the authenticator app.
  const [ticketKind, setTicketKind] = useState<{ kind: "2fa" | "code"; sentTo?: string }>({ kind: "2fa" });
  const [recover, setRecover] = useState(false);
  // /join?invite=... : a personal invite link fills in the code and opens "Create account".
  const inviteFromLink = location.pathname === "/join" ? new URLSearchParams(location.search).get("invite") ?? "" : "";
  const [inviteOk, setInviteOk] = useState<boolean | null>(null);
  useEffect(() => {
    if (!inviteFromLink) return;
    setTab("up");
    setF((x) => ({ ...x, invite: inviteFromLink }));
    api.get<{ valid: boolean }>(`/api/auth/invite/${encodeURIComponent(inviteFromLink)}`).then((r) => setInviteOk(r.valid), () => setInviteOk(false));
  }, [inviteFromLink]);
  const [f, setF] = useState({ email: "", password: "", invite: "", code: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => void api.get<WorkspaceState>("/api/auth/mode").then((m) => (setMode(m), m.signupsOpen && !m.needsInvite && setTab("up"))).catch(() => setMode(null)), []);
  const accounts = mode?.mode === "accounts";
  const passkeyOk = typeof window !== "undefined" && browserSupportsWebAuthn();
  const done = () => location.assign(location.pathname === "/join" ? "/" : location.pathname + location.search);
  // Face ID / fingerprint / phone / security key: no password, no code.
  const passkey = async () => {
    setErr("");
    setBusy(true);
    try {
      const o = await api.post<{ ticket: string; options: Parameters<typeof startAuthentication>[0]["optionsJSON"]; available: boolean }>("/api/passkeys/login/options");
      if (!o.available) throw new Error("No passkeys are set up yet. Sign in with your password, then add one in Settings.");
      const response = await startAuthentication({ optionsJSON: o.options });
      await api.post("/api/passkeys/login", { ticket: o.ticket, response });
      done();
    } catch (x) {
      const m = (x as Error).message;
      setErr(/NotAllowed|cancel|timed out|not allowed/i.test(m) ? "Passkey sign-in was cancelled." : m);
    } finally {
      setBusy(false);
    }
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      if (tab === "forgot") return void setSent(await api.post<{ emailed: boolean }>("/api/auth/forgot", { email: f.email }));
      if (recover) await api.post("/api/passkeys/recover", { email: accounts ? f.email : undefined, code: f.code });
      else if (ticket) await api.post(ticketKind.kind === "code" ? "/api/login/verify" : "/api/login/2fa", { ticket, code: f.code });
      else {
        let r: { needs2fa?: boolean; needsCode?: boolean; sentTo?: string; ticket?: string } = {};
        if (!accounts) r = await api.post("/api/login", { password: f.password });
        else if (tab === "in") r = await api.post("/api/auth/login", { email: f.email, password: f.password });
        else await api.post("/api/auth/signup", { email: f.email, password: f.password, invite: f.invite || undefined });
        if (r.needs2fa && r.ticket) return void (setTicketKind({ kind: "2fa" }), setTicket(r.ticket)); // step 2: the code from the authenticator app
        if (r.needsCode && r.ticket) return void (setTicketKind({ kind: "code", sentTo: r.sentTo }), setTicket(r.ticket)); // looked suspicious: code we sent
      }
      done();
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
        {recover ? (
          <>
            <p className="text-sm text-zinc-300">Lost your passkeys? Type one of the recovery codes you saved when you turned on passkey-only sign-in. It signs you in once and turns passkey-only off, so you can add new passkeys.</p>
            {accounts && <input className="input" type="email" autoComplete="email" placeholder="Email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />}
            <input className="input text-center font-mono tracking-widest" autoFocus placeholder="abcde-12345" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
            {err && <div className="text-sm text-red-400">{err}</div>}
            <button className="btn-primary w-full" disabled={busy || f.code.trim().length < 6}>{busy ? "…" : "Sign in with recovery code"}</button>
            <p className="text-xs text-zinc-500">No codes either? {accounts ? "Ask the owner of this FlipDesk to turn passkey-only off for you." : "Restart the server once with FLIPDESK_PASSKEY_RESET=1 (then remove it) and sign in with your password."}</p>
            <button type="button" className="text-xs text-zinc-500 hover:text-zinc-200" onClick={() => (setRecover(false), setErr(""), setF({ ...f, code: "" }))}>← Back</button>
          </>
        ) : ticket ? (
          ticketKind.kind === "code" ? (
          <>
            <p className="text-sm text-zinc-300">🛡️ For your safety: there were several wrong passwords before this sign-in, and we don't recognize this device. We sent a 6-digit code to your {ticketKind.sentTo === "phone" ? "phone (FlipDesk alerts)" : "email"}.</p>
            <input className="input text-center font-mono text-lg tracking-widest" inputMode="numeric" autoComplete="one-time-code" autoFocus maxLength={8} placeholder="123456" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
            {err && <div className="text-sm text-red-400">{err}</div>}
            <button className="btn-primary w-full" disabled={busy || f.code.trim().length < 6}>{busy ? "…" : "Sign in"}</button>
            <button type="button" className="text-xs text-zinc-500 hover:text-zinc-200" onClick={() => (setTicket(null), setF({ ...f, code: "" }))}>← Start over</button>
          </>
          ) : (
          <>
            <p className="text-sm text-zinc-300">Enter the 6-digit code from your authenticator app.</p>
            <input className="input text-center font-mono text-lg tracking-widest" inputMode="numeric" autoComplete="one-time-code" autoFocus maxLength={12} placeholder="123456" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
            <p className="text-xs text-zinc-500">Lost your phone? Type one of your recovery codes instead.</p>
            {err && <div className="text-sm text-red-400">{err}</div>}
            <button className="btn-primary w-full" disabled={busy || f.code.trim().length < 6}>{busy ? "…" : "Sign in"}</button>
            <button type="button" className="text-xs text-zinc-500 hover:text-zinc-200" onClick={() => (setTicket(null), setF({ ...f, code: "" }))}>← Start over</button>
          </>
          )
        ) : (
        <>
        {accounts && (
          <div className="flex gap-1 rounded-md bg-zinc-900 p-1 text-sm">
            {(["in", "up"] as const).map((t) => (
              <button type="button" key={t} onClick={() => (setTab(t), setSent(null))} className={`flex-1 rounded px-2 py-1 ${tab === t ? "bg-zinc-700 text-white" : "text-zinc-400"}`} disabled={t === "up" && !mode?.signupsOpen}>
                {t === "in" ? "Sign in" : "Create account"}
              </button>
            ))}
          </div>
        )}
        {accounts && <input className="input" type="email" autoComplete="email" placeholder="Email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />}
        {tab === "forgot" ? (
          <>
            {sent ? (
              <p className="text-sm text-zinc-300">
                {sent.emailed ? "If that email has an account, a reset link is on its way. It works for 1 hour." : "This FlipDesk can't send email yet. Ask the owner for a reset link (Accounts page)."}
              </p>
            ) : (
              <p className="text-xs text-zinc-500">Enter your email and we'll send you a link to choose a new password.</p>
            )}
            <button type="button" className="text-xs text-zinc-400 hover:text-zinc-100" onClick={() => (setTab("in"), setSent(null))}>← Back to sign in</button>
          </>
        ) : (
        <input className="input" type="password" autoFocus={!accounts} autoComplete={tab === "up" ? "new-password" : "current-password"} placeholder={tab === "up" ? "Password (8+ characters)" : "Password"} required value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        )}
        {accounts && tab === "in" && <button type="button" className="text-xs text-zinc-500 hover:text-zinc-200" onClick={() => setTab("forgot")}>Forgot password?</button>}
        {accounts && tab === "up" && mode?.needsInvite && !inviteFromLink && <input className="input" placeholder="Invite code" required value={f.invite} onChange={(e) => setF({ ...f, invite: e.target.value })} />}
        {inviteFromLink && tab === "up" && inviteOk === true && <p className="text-xs text-green-400">🎟️ You've been invited. Pick an email and password to create your shop.</p>}
        {inviteFromLink && inviteOk === false && <p className="text-xs text-red-400">This invite link was already used or turned off. Ask for a new one.</p>}
        {accounts && tab === "up" && !mode?.needsInvite && <p className="text-xs text-zinc-500">You're the first account, so you'll be the owner of this FlipDesk.</p>}
        {accounts && !mode?.signupsOpen && <p className="text-xs text-zinc-500">New accounts need an invite from the owner.</p>}
        {err && <div className="text-sm text-red-400">{err}</div>}
        {!(tab === "forgot" && sent) && <button className="btn-primary w-full" disabled={busy}>{busy ? "…" : tab === "forgot" ? "Send reset link" : !accounts || tab === "in" ? "Sign in" : "Create my shop"}</button>}
        {tab === "in" && passkeyOk && (
          <button type="button" className="btn-ghost w-full" disabled={busy} onClick={passkey}>
            🔑 Sign in with a passkey
          </button>
        )}
        {tab === "in" && (
          <button type="button" className="block w-full text-center text-xs text-zinc-500 hover:text-zinc-200" onClick={() => (setRecover(true), setErr(""), setF({ ...f, code: "" }))}>
            Lost your passkeys? Use a recovery code
          </button>
        )}
        </>
        )}
      </form>
    </div>
  );
}

/** Shown across the top while you're in the sample shop. */
export function DemoBanner({ w }: { w: WorkspaceState | null }) {
  if (w?.shared)
    return (
      <div className="sticky top-0 z-40 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-sky-800 bg-sky-950/95 px-4 py-2 text-sm text-sky-100">
        <span>👀 <b>A sample shop someone shared with you.</b> Look around; it's read-only.</span>
        <button className="rounded bg-sky-200 px-2 py-0.5 text-xs font-semibold text-sky-950 hover:bg-white" onClick={async () => (await api.post("/api/share/leave"), location.assign("/"))}>
          {w.signupsOpen ? "Get your own FlipDesk" : "Leave"}
        </button>
      </div>
    );
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
  const acct = useAccount();
  if (!w || w.shared) return null;
  const ai = acct?.ai;
  return (
    <div className="space-y-1 px-2 text-[11px] text-zinc-500">
      {w.user && <div className="truncate" title={w.user.email}>👤 {w.user.email}</div>}
      {ai && ai.limit !== null && (
        <div title="AI requests today (listing writer, photo AI, sourcing). Resets at midnight UTC.">
          AI today: <span className={ai.used >= ai.limit ? "text-red-400" : ai.used >= ai.limit * 0.8 ? "text-amber-400" : "text-zinc-300"}>{ai.used}/{ai.limit}</span>
        </div>
      )}
      {w.current === "demo" ? (
        <button className="block hover:text-zinc-300" onClick={() => switchShop("leave_demo")}>← Back to my shop</button>
      ) : (
        <button className="block hover:text-zinc-300" onClick={() => switchShop("enter_demo")}>🧪 {w.demoExists ? "Open" : "Try"} the sample shop</button>
      )}
      {w.mode === "accounts" && <FeedbackButton />}
      {w.user && (
        <button className="block hover:text-zinc-300" onClick={async () => (await api.post("/api/auth/logout"), location.assign("/"))}>Sign out</button>
      )}
    </div>
  );
}

/** /reset?token=... : choose a new password from an emailed (or owner-made) link. */
export function ResetPage() {
  const token = new URLSearchParams(location.search).get("token") ?? "";
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState("");
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form
        className="card w-full max-w-sm space-y-3 p-6"
        onSubmit={async (e) => {
          e.preventDefault();
          if (pw !== pw2) return setErr("The two passwords don't match.");
          try {
            const r = await api.post<{ signIn?: boolean }>("/api/auth/reset", { token, password: pw });
            if (r.signIn) toast("Password changed. Sign in with it and your two-step code.");
            location.assign("/");
          } catch (x) {
            setErr((x as Error).message);
          }
        }}
      >
        <div className="text-lg font-bold">📦 Choose a new password</div>
        <input className="input" type="password" autoComplete="new-password" autoFocus placeholder="New password (8+ characters)" value={pw} onChange={(e) => setPw(e.target.value)} />
        <input className="input" type="password" autoComplete="new-password" placeholder="Type it again" value={pw2} onChange={(e) => setPw2(e.target.value)} />
        {err && <div className="text-sm text-red-400">{err}</div>}
        <button className="btn-primary w-full">Save and sign in</button>
        <p className="text-xs text-zinc-500">This signs you out on your other devices.</p>
      </form>
    </div>
  );
}

/** /not-me?t=... : from the "new sign-in" alert. Opening the link does nothing; the button signs every device out. */
export function NotMePage() {
  const token = new URLSearchParams(location.search).get("t") ?? "";
  const [r, setR] = useState<null | { resetSent: boolean; mode: string; removedPasskeys: number }>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="card w-full max-w-sm space-y-3 p-6">
        <div className="text-lg font-bold">🔐 That sign-in wasn't you?</div>
        {r ? (
          <>
            <p className="text-sm text-green-300">Done. Every device is signed out of FlipDesk{r.removedPasskeys ? `, and ${r.removedPasskeys} passkey(s) added since then were removed` : ""}.</p>
            <p className="text-sm text-zinc-300">
              {r.mode === "accounts"
                ? r.resetSent
                  ? "Check your email for a link to choose a new password. Do that first: whoever signed in knows your current one."
                  : "Now choose a new password: use “Forgot password?” on the sign-in screen."
                : "Now change FLIPDESK_PASSWORD on your server (fly secrets set FLIPDESK_PASSWORD=…), since whoever signed in knows it."}
            </p>
            <p className="text-xs text-zinc-500">Also turn on two-step sign-in or add a passkey in Settings so a password alone is never enough.</p>
            <a className="btn-primary block w-full text-center" href="/">Go to sign in</a>
          </>
        ) : (
          <>
            <p className="text-sm text-zinc-300">This signs out every device that's signed in to your FlipDesk, including whoever that was. You'll then choose a new password.</p>
            {err && <div className="text-sm text-red-400">{err}</div>}
            <button
              className="btn-primary w-full bg-red-600 hover:bg-red-500"
              disabled={busy || !token}
              onClick={async () => {
                setBusy(true);
                setErr("");
                try {
                  setR(await api.post("/api/auth/not-me", { token }));
                } catch (x) {
                  setErr((x as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "…" : "Sign out everywhere"}
            </button>
            <a className="block text-center text-xs text-zinc-500 hover:text-zinc-200" href="/">It was me after all</a>
          </>
        )}
      </div>
    </div>
  );
}

/** /s/<token>: open someone's shared sample shop (read-only). */
export function SharePage({ token }: { token: string }) {
  const [err, setErr] = useState("");
  useEffect(() => {
    api.post(`/api/share/${encodeURIComponent(token)}/open`).then(() => location.assign("/"), (x: Error) => setErr(x.message));
  }, [token]);
  return <div className="flex min-h-screen items-center justify-center p-4 text-zinc-400">{err || "Opening the sample shop…"}</div>;
}

export interface BillingInfo { askCancelReason?: boolean; cancelReasons?: { key: string; label: string }[]; testMode?: boolean; offer?: { pct: number; endsAt: string } | null; enabled: boolean; status: "owner" | "free" | "trial" | "active" | "past_due" | "expired"; canWrite?: boolean; trialDaysLeft?: number | null; renewsAt?: string | null; hasCustomer?: boolean; price?: string | null; aiLimit?: number | null; paidAiLimit?: number; trialDays?: number }

/** Trial ending soon / ended: a slim bar linking to the plan page. */
export function PlanBanner({ b }: { b: BillingInfo | null }) {
  if (!b?.enabled) return null;
  if (b.status === "expired")
    return (
      <a href="/billing" className="block border-b border-red-900 bg-red-950/90 px-4 py-2 text-center text-sm text-red-100 hover:bg-red-950">
        Your free trial has ended. Your shop is read-only until you choose a plan.{b.offer ? ` 🎁 ${b.offer.pct}% off your first month until ${new Date(b.offer.endsAt).toLocaleDateString()}.` : ""} <b className="underline">See plans →</b>
      </a>
    );
  if (b.status === "trial" && (b.trialDaysLeft ?? 99) <= 3)
    return (
      <a href="/billing" className="block border-b border-amber-900 bg-amber-950/80 px-4 py-1.5 text-center text-sm text-amber-100 hover:bg-amber-950">
        {b.trialDaysLeft === 0 ? "Your free trial ends today." : `${b.trialDaysLeft} day${b.trialDaysLeft === 1 ? "" : "s"} left in your free trial.`} <b className="underline">Choose a plan</b>
      </a>
    );
  if (b.status === "past_due")
    return <a href="/billing" className="block border-b border-amber-900 bg-amber-950/80 px-4 py-1.5 text-center text-sm text-amber-100">Your last payment didn't go through. <b className="underline">Update your card</b></a>;
  return null;
}

export function useBilling(enabled: boolean) {
  const [b, setB] = useState<BillingInfo | null>(null);
  useEffect(() => void (enabled && api.get<BillingInfo>("/api/billing").then(setB).catch(() => {})), [enabled]);
  return b;
}

/** Recent errors in this tab, attached to feedback so the owner can see what went wrong. */
const recentErrors: string[] = [];
if (typeof window !== "undefined") {
  window.addEventListener("error", (e) => recentErrors.push(String(e.message).slice(0, 300)) > 5 && recentErrors.shift());
  window.addEventListener("unhandledrejection", (e) => recentErrors.push(String((e.reason as Error)?.message ?? e.reason).slice(0, 300)) > 5 && recentErrors.shift());
}

/** "Send feedback": a note to the owner with the page you're on and recent errors. */
export function FeedbackButton() {
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button className="block hover:text-zinc-300" onClick={() => setOpen(true)}>💬 Send feedback</button>
      {open && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4" onClick={() => setOpen(false)}>
          <form
            className="card w-full max-w-md space-y-3 bg-zinc-900 p-5"
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await api.post("/api/feedback", {
                  message: msg,
                  page: location.pathname + location.search,
                  context: { browser: navigator.userAgent, screen: `${innerWidth}x${innerHeight}`, errors: [...recentErrors], at: new Date().toString() },
                });
                setMsg("");
                setOpen(false);
                toast("Thanks! Sent to the owner.");
              } catch (x) {
                toast((x as Error).message, "err");
              } finally {
                setBusy(false);
              }
            }}
          >
            <h2 className="font-semibold">💬 Send feedback</h2>
            <p className="text-xs text-zinc-500">A bug, an idea, something confusing? It goes straight to the person who runs this FlipDesk, with the page you're on ({location.pathname}) and any recent errors.</p>
            <p className="text-xs text-zinc-500">Something not working? <a href="/status" className="text-brand hover:underline">Check the Status page</a> first: it may already say why.</p>
            <textarea className="input min-h-32" autoFocus value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="What happened, or what would make this better?" />
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
              <button className="btn-primary" disabled={busy || msg.trim().length < 3}>{busy ? "Sending…" : "Send"}</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
