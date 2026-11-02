import { useEffect, useState } from "react";
import { api } from "../api";
import QRCode from "qrcode";
import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { timeAgo, toast, useFetch, useMarketplaces } from "../ui";
import { switchShop, useAccount, useWorkspace } from "../components/Account";
import AiSettings from "../components/AiSettings";

function ShareLink() {
  const [share, setShare] = useState<{ path: string; views: number } | null | undefined>(undefined);
  useEffect(() => void api.get<{ share: { path: string; views: number } | null }>("/api/workspace/share").then((r) => setShare(r.share)).catch(() => {}), []);
  if (share === undefined) return null;
  const url = share ? location.origin + share.path : "";
  return (
    <div className="space-y-2 border-t border-zinc-800 pt-3">
      <div className="text-sm font-medium">🔗 Share it (read-only)</div>
      <p className="text-xs text-zinc-500">A link anyone can open to look around your sample shop without signing up. They can't change anything. Your real shop is never shared.</p>
      {share ? (
        <>
          <input className="input font-mono text-xs" readOnly value={url} onFocus={(e) => e.target.select()} />
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn-primary" onClick={() => (navigator.clipboard?.writeText(url), toast("Link copied"))}>Copy link</button>
            <button className="btn-ghost text-red-300" onClick={async () => (await api.del("/api/workspace/share"), setShare(null), toast("Link turned off"))}>Turn off link</button>
            <span className="text-xs text-zinc-500">Opened {share.views} time{share.views === 1 ? "" : "s"}</span>
          </div>
          {location.hostname === "localhost" || location.hostname === "127.0.0.1" ? <p className="text-xs text-amber-400">This address only works on this computer. Host FlipDesk online (docs/DEPLOY.md) to share it with others.</p> : null}
        </>
      ) : (
        <button className="btn-ghost" onClick={async () => setShare((await api.post<{ share: { path: string; views: number } }>("/api/workspace/share")).share)}>Make a share link</button>
      )}
    </div>
  );
}

const STEP_LABELS: [string, string][] = [
  ["profile", "Tell FlipDesk how you sell"],
  ["ebay", "Connect eBay"],
  ["item", "Add your first item"],
  ["crosslist", "Crosslist it"],
  ["extension", "Install the Chrome extension"],
  ["notify", "Get sale alerts on your phone"],
  ["sale", "Make your first sale"],
];

function HelpVideos() {
  const [v, setV] = useState<Record<string, string> | null>(null);
  useEffect(() => void api.get<Record<string, string>>("/api/help-videos").then(setV).catch(() => {}), []);
  if (!v) return null;
  return (
    <section className="card space-y-3 p-4">
      <h2 className="font-semibold">🎬 Help videos for "Get started"</h2>
      <p className="text-sm text-zinc-400">Record a short screen video for any step (Loom, YouTube unlisted, your phone's screen recorder…) and paste the link. It shows as "▶ Watch" under that step{" "}for everyone on this FlipDesk.</p>
      <div className="space-y-2">
        {STEP_LABELS.map(([k, label]) => (
          <label key={k} className="grid items-center gap-1 sm:grid-cols-[14rem_1fr]">
            <span className="text-sm text-zinc-300">{label}</span>
            <input className="input" placeholder="https://www.loom.com/share/…" value={v[k] ?? ""} onChange={(e) => setV({ ...v, [k]: e.target.value })} />
          </label>
        ))}
      </div>
      <button
        className="btn-primary"
        onClick={async () => {
          try {
            setV(await api.put<Record<string, string>>("/api/help-videos", v));
            toast("Help videos saved");
          } catch (e) {
            toast((e as Error).message, "err");
          }
        }}
      >
        Save videos
      </button>
    </section>
  );
}

function AccountSection({ email, optOut }: { email: string; optOut: boolean }) {
  const [f, setF] = useState({ current: "", next: "" });
  const [off, setOff] = useState(optOut);
  return (
    <section className="card space-y-3 p-4">
      <h2 className="font-semibold">👤 Your account</h2>
      <p className="text-sm text-zinc-400">Signed in as {email}.</p>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={!off}
          onChange={async (e) => {
            const r = await api.post<{ emailOptOut: boolean }>("/api/account/emails", { optOut: !e.target.checked });
            setOff(r.emailOptOut);
            toast(r.emailOptOut ? "No more reminder emails" : "Reminder emails on");
          }}
        />
        Friendly reminder emails (trial ending, haven't stopped by in a while)
      </label>
      <div className="grid gap-2 sm:grid-cols-3">
        <input className="input" type="password" autoComplete="current-password" placeholder="Current password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} />
        <input className="input" type="password" autoComplete="new-password" placeholder="New password (8+)" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} />
        <button
          className="btn-ghost"
          disabled={!f.current || f.next.length < 8}
          onClick={async () => {
            try {
              await api.post("/api/auth/password", f);
              setF({ current: "", next: "" });
              toast("Password changed");
            } catch (e) {
              toast((e as Error).message, "err");
            }
          }}
        >
          Change password
        </button>
      </div>
    </section>
  );
}

interface BackupCheckInfo { name: string; at: string; ok: boolean; photosChecked: number; photosTotal: number; problems: string[]; databases: { name: string; ok: boolean; detail: string }[] }
interface Drill { at: string; backup: string; ok: boolean; steps: { name: string; ms: number; ok: boolean; detail: string }[]; problems: string[]; estimate: string; minutes: number }
interface BackupState { drill?: Drill | null; check?: BackupCheckInfo | null; last: { at?: string; bytes?: number; uploaded?: string | null; error?: string | null; failedAt?: string } | null; files: { name: string; bytes: number }[]; offsite: boolean; disabled: boolean }
const mb = (b: number) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);

function YourData() {
  return (
    <section className="card space-y-2 p-4">
      <h2 className="font-semibold">📦 Download all my data</h2>
      <p className="text-sm text-zinc-400">One .zip with spreadsheets (items, sales, listings, expenses, mileage), every photo, and the full database. Your data is always yours.</p>
      <a className="btn-ghost inline-block" href="/api/export" download>Download .zip</a>
    </section>
  );
}

/** "flipdesk-20261102-031500.zip" -> local date and time */
function backupWhen(name: string) {
  const m = name.match(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})?/);
  if (!m) return name;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0))).toLocaleString();
}

function RestoreDialog({ name, onClose }: { name: string; onClose: () => void }) {
  const [parts, setParts] = useState<{ part: string; label: string; bytes: number; photos: number }[] | null>(null);
  const [pick, setPick] = useState<string[]>([]);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get<{ parts: { part: string; label: string; bytes: number; photos: number }[] }>(`/api/backups/${name}/contents`).then((r) => (setParts(r.parts), setPick(r.parts.filter((p) => !p.part.endsWith(".db")).map((p) => p.part))), (e: Error) => toast(e.message, "err"));
  }, [name]);
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="card max-h-[90vh] w-full max-w-lg space-y-3 overflow-y-auto bg-zinc-900 p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="font-semibold">Restore from {backupWhen(name)}</h2>
        <p className="text-sm text-zinc-400">What you pick is put back exactly as it was then. Anything newer in those parts is replaced.</p>
        <p className="text-sm text-green-300">🛟 Safe to try: FlipDesk makes a fresh backup first (your undo button), and keeps the replaced files in data/restore-trash.</p>
        {!parts ? (
          <div className="text-sm text-zinc-500">Reading the backup…</div>
        ) : (
          <div className="space-y-1">
            {parts.map((p) => (
              <label key={p.part} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={pick.includes(p.part)} onChange={(e) => setPick(e.target.checked ? [...pick, p.part] : pick.filter((x) => x !== p.part))} />
                <span className="text-zinc-200">{p.label}</span>
                <span className="text-xs text-zinc-500">{mb(p.bytes)}{p.photos ? ` · ${p.photos} photos` : ""}</span>
              </label>
            ))}
            {pick.includes("accounts.db") && <p className="text-xs text-amber-400">Restoring sign-ins may sign people out, and undoes newer sign-ups and plan changes.</p>}
          </div>
        )}
        <label className="block text-sm">
          Type <b>RESTORE</b> to confirm
          <input className="input mt-1" value={typed} onChange={(e) => setTyped(e.target.value)} />
        </label>
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            disabled={busy || typed !== "RESTORE" || !pick.length}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await api.post<{ restored: string[]; undoBackup: string }>(`/api/backups/${name}/restore`, { parts: pick, confirm: "RESTORE" });
                toast(`Restored. Undo copy: ${backupWhen(r.undoBackup)}`);
                setTimeout(() => location.reload(), 900);
              } catch (e) {
                toast((e as Error).message, "err");
                setBusy(false);
              }
            }}
          >
            {busy ? "Restoring…" : "Restore"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Backups() {
  const [b, setB] = useState<BackupState | null>(null);
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  useEffect(() => void api.get<BackupState>("/api/backups").then(setB).catch(() => {}), []);
  if (!b) return null;
  return (
    <section className="card space-y-3 p-4">
      <h2 className="font-semibold">🛟 Nightly backups</h2>
      <p className="text-sm text-zinc-400">
        {b.disabled ? "Turned off (BACKUP_DISABLED=1). " : "Every night FlipDesk saves a copy of every shop and its photos on the server (newest 7 kept). "}
        {b.offsite ? "Each copy is also uploaded to your cloud storage." : "Add cloud storage (BACKUP_S3_* in .env: Cloudflare R2, Backblaze B2 or AWS S3) so a lost server doesn't mean lost data."}
      </p>
      {b.last?.at && (
        <div className="text-sm">
          Last backup: <b>{new Date(b.last.at).toLocaleString()}</b>{b.last.bytes ? ` · ${mb(b.last.bytes)}` : ""}{b.last.uploaded ? " · ☁️ uploaded" : ""}
          {b.last.error && <div className="text-amber-400">{b.last.error}</div>}
        </div>
      )}
      {!b.last?.at && <div className="text-sm text-amber-400">No backup yet.</div>}
      {b.check && (
        <div className={`text-sm ${b.check.ok ? "text-green-400" : "text-red-400"}`}>
          {b.check.ok ? "✓" : "✕"} Restore check {new Date(b.check.at).toLocaleDateString()}: {b.check.ok ? `${backupWhen(b.check.name)} restores fine (${b.check.databases.length} databases, ${b.check.photosChecked} of ${b.check.photosTotal} photos verified). Runs monthly.` : b.check.problems.slice(0, 2).join("; ")}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          className="btn-primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await api.post<BackupState & { result: { error: string | null } }>("/api/backups");
              setB(r);
              toast(r.result.error ? r.result.error : "Backup saved", r.result.error ? "err" : "ok");
            } catch (e) {
              toast((e as Error).message, "err");
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Backing up…" : "Back up now"}
        </button>
        {b.files.length > 0 && (
          <button
            className="btn-ghost"
            disabled={busy}
            title="Practise a full recovery from the newest backup in a scratch folder, and time it"
            onClick={async () => {
              setBusy(true);
              try {
                const d = await api.post<Drill>("/api/backups/fire-drill", {});
                setB({ ...b, drill: d });
                toast(d.ok ? `🧯 Fire drill passed: ${d.estimate.split(":")[0]}` : `Fire drill failed: ${d.problems[0]}`, d.ok ? "ok" : "err");
              } catch (e) {
                toast((e as Error).message, "err");
              } finally {
                setBusy(false);
              }
            }}
          >
            🧯 Fire drill
          </button>
        )}
      </div>
      {b.drill && (
        <details className="text-sm">
          <summary className={`cursor-pointer ${b.drill.ok ? "text-green-400" : "text-red-400"}`}>
            {b.drill.ok ? "✓" : "✕"} Fire drill {new Date(b.drill.at).toLocaleDateString()}: {b.drill.ok ? `if the server died, you'd be back in ${b.drill.estimate.split(":")[0].replace(/^About/, "about")}.` : b.drill.problems[0]} Runs monthly.
          </summary>
          <ol className="mt-1 space-y-0.5 text-xs">
            {b.drill.steps.map((st) => (
              <li key={st.name} className="flex gap-2">
                <span className={st.ok ? "text-green-400" : "text-red-400"}>{st.ok ? "✓" : "✕"}</span>
                <span className="text-zinc-300">{st.name}</span>
                <span className="text-zinc-500">{st.detail} · {(st.ms / 1000).toFixed(1)} s</span>
              </li>
            ))}
          </ol>
          <p className="mt-1 text-xs text-zinc-500">{b.drill.estimate} Practised on a copy of {backupWhen(b.drill.backup)} in a scratch folder: nothing real was touched.</p>
        </details>
      )}
      {b.files.length > 0 && (
        <ul className="space-y-1 text-sm">
          {b.files.map((f) => (
            <li key={f.name} className="flex items-center justify-between gap-2">
              <a className="text-brand hover:underline" href={`/api/backups/${f.name}`}>{backupWhen(f.name)}</a>
              <span className="flex items-center gap-2 text-zinc-500">
                {mb(f.bytes)}
                <button
                  className="btn-ghost px-2 py-0.5 text-xs"
                  title="Unpack it in a scratch folder and make sure it would restore"
                  onClick={async () => {
                    toast("Checking…");
                    const c = await api.post<BackupCheckInfo>(`/api/backups/${f.name}/check`);
                    setB({ ...b, check: c });
                    toast(c.ok ? `✓ Restores fine (${c.databases.length} databases, ${c.photosChecked} photos checked)` : `Problem: ${c.problems[0]}`, c.ok ? "ok" : "err");
                  }}
                >
                  Check
                </button>
                <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => setRestoring(f.name)}>Restore…</button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {restoring && <RestoreDialog name={restoring} onClose={() => setRestoring(null)} />}
      <p className="text-xs text-zinc-500">Restore… puts a backup back right here (a fresh backup is made first, so it can be undone).</p>
    </section>
  );
}

interface Alerts { quiet: boolean; quietStart: number; quietEnd: number; afterMinutes: number; timezone: string; quietNow: boolean }
const hourLabel = (h: number) => (h === 0 ? "12 am" : h < 12 ? `${h} am` : h === 12 ? "12 pm" : `${h - 12} pm`);

function AlertSettings() {
  const [a, setA] = useState<Alerts | null>(null);
  useEffect(() => void api.get<Alerts>("/api/alert-settings").then(setA).catch(() => {}), []);
  if (!a) return null;
  const save = async (next: Partial<Alerts>) => {
    const r = await api.put<Alerts>("/api/alert-settings", { quiet: next.quiet ?? a.quiet, quietStart: next.quietStart ?? a.quietStart, quietEnd: next.quietEnd ?? a.quietEnd });
    setA(r);
    toast("Saved");
  };
  return (
    <section className="card space-y-3 p-4">
      <h2 className="font-semibold">🔕 Problem alerts</h2>
      <p className="text-sm text-zinc-400">
        When AI, eBay or email keeps failing, FlipDesk alerts you. Problems fixed within {a.afterMinutes} minutes are only logged (Tools → Status), several at once arrive as one message, and you hear "✅ working again" when they're fixed.
      </p>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" checked={a.quiet} onChange={(e) => save({ quiet: e.target.checked })} /> Quiet hours from</label>
        <select className="input w-28 py-1" value={a.quietStart} disabled={!a.quiet} onChange={(e) => save({ quietStart: Number(e.target.value) })}>
          {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
        </select>
        to
        <select className="input w-28 py-1" value={a.quietEnd} disabled={!a.quiet} onChange={(e) => save({ quietEnd: Number(e.target.value) })}>
          {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
        </select>
        <span className="text-xs text-zinc-500">({a.timezone}{a.quietNow ? ", quiet now" : ""})</span>
      </div>
      <p className="text-xs text-zinc-500">During quiet hours nothing pings you. Anything still broken when they end arrives then; anything that fixed itself overnight comes as one "while you were away" note.</p>
    </section>
  );
}

interface PasskeyRow { id: string; name: string; device: string; created_at: string; last_used_at: string | null }
function Passkeys() {
  type St = { passkeys: PasskeyRow[]; unavailable?: string; passkeyOnly?: boolean; recoveryLeft?: number };
  const [st, setSt] = useState<St | null>(null);
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const reload = () => api.get<St>("/api/passkeys").then(setSt).catch(() => setSt(null));
  useEffect(() => void reload(), []);
  if (!st) return null;
  const supported = browserSupportsWebAuthn();
  const add = async () => {
    setBusy(true);
    try {
      const options = await api.post<Parameters<typeof startRegistration>[0]["optionsJSON"]>("/api/passkeys/register/options");
      const response = await startRegistration({ optionsJSON: options });
      const r = await api.post<{ passkeys: PasskeyRow[] }>("/api/passkeys/register", { response });
      setSt({ ...st!, passkeys: r.passkeys });
      toast("Passkey added. Next time, tap “Sign in with a passkey”.");
    } catch (e) {
      const m = (e as Error).message;
      toast(/NotAllowed|cancel|timed out|not allowed/i.test(m) ? "Cancelled" : /InvalidState|already/i.test(m) ? "This device already has a FlipDesk passkey." : m, "err");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card space-y-3 p-4">
      <h2 className="font-semibold">🔑 Passkeys {st.passkeys.length > 0 && <span className="text-sm font-normal text-green-400">{st.passkeys.length} set up</span>}</h2>
      <p className="text-sm text-zinc-400">Sign in with Face ID, your fingerprint, Windows Hello or your phone instead of typing a password and code. A passkey only works on FlipDesk's own address, so a fake sign-in page can't steal it.</p>
      {st.unavailable && <p className="text-sm text-amber-300">{st.unavailable}</p>}
      {st.passkeys.length > 0 && (
        <ul className="divide-y divide-zinc-800 rounded-md border border-zinc-800">
          {st.passkeys.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center gap-2 p-2 text-sm">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{k.name}</div>
                <div className="text-xs text-zinc-500">Added {timeAgo(k.created_at)}{k.last_used_at ? ` · last used ${timeAgo(k.last_used_at)}` : " · not used yet"}</div>
              </div>
              <button
                className="btn-ghost text-xs"
                onClick={async () => {
                  const name = prompt("Name this passkey (e.g. “My iPhone”)", k.name);
                  if (name?.trim()) setSt({ ...st, passkeys: (await api.patch<{ passkeys: PasskeyRow[] }>(`/api/passkeys/${encodeURIComponent(k.id)}`, { name: name.trim() })).passkeys });
                }}
              >
                Rename
              </button>
              <button
                className="btn-ghost text-xs text-red-300"
                onClick={async () => {
                  if (!confirm(`Remove “${k.name}”? That device won't be able to sign in with it any more.`)) return;
                  try {
                    setSt({ ...st, passkeys: (await api.del<{ passkeys: PasskeyRow[] }>(`/api/passkeys/${encodeURIComponent(k.id)}`)).passkeys });
                  } catch (e) {
                    toast((e as Error).message, "err");
                  }
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {!st.unavailable &&
        (supported ? (
          <button className="btn-primary" disabled={busy} onClick={add}>{busy ? "…" : st.passkeys.length ? "Add another device" : "Add a passkey on this device"}</button>
        ) : (
          <p className="text-xs text-zinc-500">This browser can't make passkeys. Try Safari, Chrome or Edge on a recent phone or computer.</p>
        ))}
      {codes && (
        <div className="space-y-2 rounded-md border border-amber-800 bg-amber-950/30 p-3">
          <div className="text-sm font-medium text-amber-200">Save these recovery codes now. If you lose every passkey, one of them signs you in (once) and turns passkey-only off. They won't be shown again.</div>
          <pre className="grid grid-cols-2 gap-1 font-mono text-sm text-zinc-100">{codes.join("\n")}</pre>
          <div className="flex gap-2">
            <button className="btn-ghost text-xs" onClick={() => (navigator.clipboard?.writeText(codes.join("\n")), toast("Copied"))}>Copy</button>
            <a className="btn-ghost text-xs" download="flipdesk-passkey-recovery-codes.txt" href={`data:text/plain;charset=utf-8,${encodeURIComponent(`FlipDesk passkey recovery codes (each works once)\n\n${codes.join("\n")}\n`)}`}>Download</a>
            <button className="btn-primary text-xs" onClick={() => setCodes(null)}>I saved them</button>
          </div>
        </div>
      )}
      {!st.unavailable && st.passkeys.length > 0 && (
        <div className="space-y-1 border-t border-zinc-800 pt-3">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={Boolean(st.passkeyOnly)}
              disabled={!st.passkeyOnly && st.passkeys.length < 2}
              onChange={async (e) => {
                const on = e.target.checked;
                if (on && !confirm("Turn off password sign-in? From now on only your passkeys sign you in. You'll get recovery codes for emergencies.")) return;
                try {
                  const r = await api.post<{ passkeyOnly: boolean; recoveryCodes?: string[] }>("/api/passkeys/only", { on });
                  if (r.recoveryCodes) setCodes(r.recoveryCodes);
                  await reload();
                  toast(on ? "Passkey-only sign-in is on" : "Password sign-in is back on");
                } catch (x) {
                  toast((x as Error).message, "err");
                }
              }}
            />
            <span>
              <span className="font-medium">Passkey-only sign-in</span> {st.passkeyOnly && <span className="text-xs text-green-400">on · {st.recoveryLeft} recovery codes left</span>}
              <span className="block text-xs text-zinc-500">
                {st.passkeys.length < 2 && !st.passkeyOnly ? "Add a second passkey (e.g. your phone and your computer) to turn this on. " : ""}Your password stops working for sign-in, so a leaked or guessed password is useless. Recovery codes get you in if you lose every passkey.
              </span>
            </span>
          </label>
        </div>
      )}
      <p className="text-xs text-zinc-500">{st.passkeyOnly ? "Keep your recovery codes somewhere safe: they're the way back in if you lose every device." : "Keep your password too: it's the way back in if you lose every device."}</p>
    </section>
  );
}

interface DeviceRow { device: string; ip: string | null; firstSeen: string; lastSeen: string; thisOne: boolean }
function Devices() {
  type Ev = { at: string; action: string; detail: string; ip: string | null };
  const [st, setSt] = useState<{ devices: DeviceRow[]; canSignOut: boolean; history?: Ev[] } | null>(null);
  useEffect(() => void api.get<{ devices: DeviceRow[]; canSignOut: boolean; history?: Ev[] }>("/api/devices").then(setSt).catch(() => setSt(null)), []);
  if (!st || !st.canSignOut) return null;
  return (
    <section className="card space-y-3 p-4">
      <h2 className="font-semibold">📱 Signed-in devices</h2>
      <p className="text-sm text-zinc-400">Browsers that have signed in to your FlipDesk. When a new one signs in you get an alert with a “this wasn't me” link.</p>
      {st.devices.length ? (
        <ul className="divide-y divide-zinc-800 rounded-md border border-zinc-800">
          {st.devices.map((d, i) => (
            <li key={i} className="p-2 text-sm">
              <span className="font-medium">{d.device}</span> {d.thisOne && <span className="text-xs text-green-400">this one</span>}
              <div className="text-xs text-zinc-500">Last signed in {timeAgo(d.lastSeen)} · first {timeAgo(d.firstSeen)}{d.ip ? ` · ${d.ip}` : ""}</div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-zinc-500">FlipDesk starts remembering devices from your next sign-in.</p>
      )}
      <button
        className="btn-ghost text-red-300"
        onClick={async () => {
          if (!confirm("Sign out every other device? This one stays signed in.")) return;
          setSt({ ...st, ...(await api.post<{ devices: DeviceRow[] }>("/api/devices/sign-out-everywhere")) });
          toast("Every other device is signed out");
        }}
      >
        Sign out everywhere else
      </button>
      {!!st.history?.length && (
        <details className="text-sm">
          <summary className="cursor-pointer text-zinc-300">Recent sign-in activity ({st.history.length})</summary>
          <ul className="mt-2 space-y-1">
            {st.history.map((e, i) => (
              <li key={i} className={`flex flex-wrap justify-between gap-x-3 text-xs ${/failed/.test(e.action) ? "text-amber-300" : "text-zinc-300"}`}>
                <span>{/failed/.test(e.action) ? "⚠️" : /new device/.test(e.action) ? "📱" : "•"} {e.action}{e.detail ? `: ${e.detail}` : ""}</span>
                <span className="text-zinc-500">{timeAgo(e.at)}{e.ip ? ` · ${e.ip}` : ""}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-zinc-500">Something you don't recognize? Press “Sign out everywhere else”, then change your password.</p>
        </details>
      )}
    </section>
  );
}

function TwoStep() {
  const [st, setSt] = useState<{ enabled: boolean; recoveryLeft: number; unavailable?: string } | null>(null);
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  useEffect(() => void api.get<{ enabled: boolean; recoveryLeft: number; unavailable?: string }>("/api/2fa").then(setSt).catch(() => setSt(null)), []);
  if (!st) return null;
  const err = (e: unknown) => toast((e as Error).message, "err");
  return (
    <section className="card space-y-3 p-4">
      <h2 className="font-semibold">🔐 Two-step sign-in {st.enabled ? <span className="text-sm font-normal text-green-400">on</span> : <span className="text-sm font-normal text-amber-400">off</span>}</h2>
      <p className="text-sm text-zinc-400">After your password, FlipDesk asks for a 6-digit code from an app on your phone (Google Authenticator, 1Password, Authy…). A stolen password alone is then not enough.</p>
      {codes && (
        <div className="space-y-2 rounded-md border border-amber-800 bg-amber-950/30 p-3">
          <div className="text-sm font-medium text-amber-200">Save these recovery codes now. Each works once if you lose your phone. They won't be shown again.</div>
          <pre className="grid grid-cols-2 gap-1 font-mono text-sm text-zinc-100">{codes.join("\n")}</pre>
          <div className="flex gap-2">
            <button className="btn-ghost text-xs" onClick={() => (navigator.clipboard?.writeText(codes.join("\n")), toast("Copied"))}>Copy</button>
            <a className="btn-ghost text-xs" download="flipdesk-recovery-codes.txt" href={`data:text/plain;charset=utf-8,${encodeURIComponent(`FlipDesk recovery codes (each works once)\n\n${codes.join("\n")}\n`)}`}>Download</a>
            <button className="btn-primary text-xs" onClick={() => setCodes(null)}>I saved them</button>
          </div>
        </div>
      )}
      {st.unavailable && <p className="text-sm text-amber-300">{st.unavailable}</p>}
      {!st.enabled && !setup && !st.unavailable && (
        <button
          className="btn-primary"
          onClick={async () => {
            try {
              const r = await api.post<{ secret: string; otpauth: string }>("/api/2fa/setup");
              setSetup({ secret: r.secret, qr: await QRCode.toDataURL(r.otpauth, { margin: 1, width: 220 }) });
            } catch (e) {
              err(e);
            }
          }}
        >
          Turn on two-step sign-in
        </button>
      )}
      {setup && (
        <div className="flex flex-wrap items-start gap-4">
          <img src={setup.qr} alt="QR code for your authenticator app" className="h-44 w-44 rounded bg-white p-1" />
          <div className="min-w-0 flex-1 space-y-2 text-sm">
            <ol className="list-decimal space-y-1 pl-5 text-zinc-300">
              <li>Open your authenticator app and scan this code.</li>
              <li>Can't scan? Enter this key: <code className="break-all text-xs">{setup.secret}</code></li>
              <li>Type the 6-digit code it shows:</li>
            </ol>
            <div className="flex gap-2">
              <input className="input w-36 text-center font-mono" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
              <button
                className="btn-primary"
                disabled={code.length !== 6}
                onClick={async () => {
                  try {
                    const r = await api.post<{ recoveryCodes: string[] }>("/api/2fa/enable", { code });
                    setCodes(r.recoveryCodes);
                    setSetup(null);
                    setCode("");
                    setSt({ enabled: true, recoveryLeft: r.recoveryCodes.length });
                    toast("Two-step sign-in is on. Other devices were signed out.");
                  } catch (e) {
                    err(e);
                  }
                }}
              >
                Turn on
              </button>
            </div>
          </div>
        </div>
      )}
      {st.enabled && !codes && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-zinc-400">{st.recoveryLeft} recovery code{st.recoveryLeft === 1 ? "" : "s"} left.</span>
          <input className="input w-36 font-mono" placeholder="Current code" value={code} onChange={(e) => setCode(e.target.value.trim())} />
          <button className="btn-ghost text-xs" disabled={code.length < 6} onClick={async () => {
            try {
              const r = await api.post<{ recoveryCodes: string[] }>("/api/2fa/recovery-codes", { code });
              setCodes(r.recoveryCodes);
              setCode("");
              setSt({ ...st, recoveryLeft: r.recoveryCodes.length });
            } catch (e) {
              err(e);
            }
          }}>New recovery codes</button>
          <button className="btn-ghost text-xs text-red-300" disabled={code.length < 6} onClick={async () => {
            if (!confirm("Turn off two-step sign-in?")) return;
            try {
              await api.post("/api/2fa/disable", { code });
              setCode("");
              setSt({ enabled: false, recoveryLeft: 0 });
              toast("Two-step sign-in is off");
            } catch (e) {
              err(e);
            }
          }}>Turn off</button>
        </div>
      )}
    </section>
  );
}

interface AuditRow { id: number; at: string; actor: string; action: string; detail: string; ip: string | null }

function ActivityLog() {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [q, setQ] = useState("");
  const load = (more = false) =>
    api
      .get<AuditRow[]>(`/api/audit?q=${encodeURIComponent(q)}${more && rows?.length ? `&before=${rows[rows.length - 1].id}` : ""}`)
      .then((r) => setRows(more && rows ? [...rows, ...r] : r))
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void load(), [q]);
  if (!rows) return null;
  const risky = /failed|RESTORED|deleted|turned off|payments mode|reset link/i;
  return (
    <section className="card space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">🗂️ Activity log</h2>
        <input className="input max-w-xs py-1 text-sm" placeholder="Search (email, action…)" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <p className="text-xs text-zinc-500">Sign-ins (and failed ones), account changes, invites, backups and restores, payment and alert settings. Kept for the newest 20,000 events.</p>
      <div className="max-h-96 overflow-auto">
        <table className="w-full text-sm">
          <tbody className="divide-y divide-zinc-800">
            {rows.map((r) => (
              <tr key={r.id} className={risky.test(r.action) ? "text-amber-200" : "text-zinc-300"}>
                <td className="whitespace-nowrap py-1.5 pr-3 text-xs text-zinc-500" title={r.at + " UTC"}>{timeAgo(r.at)}</td>
                <td className="pr-3">{r.actor}</td>
                <td className="pr-3">{r.action}</td>
                <td className="text-xs text-zinc-500">{r.detail}{r.ip ? ` · ${r.ip}` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <div className="p-4 text-sm text-zinc-500">Nothing yet.</div>}
      </div>
      {rows.length >= 100 && <button className="btn-ghost text-xs" onClick={() => load(true)}>Older</button>}
    </section>
  );
}

function SiteSections() {
  const a = useAccount();
  const w = useWorkspace();
  return (
    <>
      {a?.user && <AccountSection email={a.user.email} optOut={Boolean(a.emailOptOut)} />}
      {!w?.shared && <Passkeys />}
      {!w?.shared && <TwoStep />}
      {!w?.shared && <Devices />}
      {!w?.shared && <YourData />}
      {a?.canEditSite && <AiSettings hosted={w?.mode === "accounts"} />}
      {a?.canEditSite && <Backups />}
      {a?.canEditSite && <AlertSettings />}
      {a?.canEditSite && <ActivityLog />}
      {a?.canEditSite && <HelpVideos />}
    </>
  );
}

function SampleShop() {
  const w = useWorkspace();
  if (!w) return null;
  return (
    <section className="card space-y-2 p-4">
      <h2 className="font-semibold">🧪 Sample shop</h2>
      <p className="text-sm text-zinc-400">A separate shop full of fake items, sales and orders, for trying features or showing someone FlipDesk. It never touches your real shop, eBay account, mailbox or label account.</p>
      <div className="flex flex-wrap gap-2">
        {w.current === "demo" ? (
          <button className="btn-primary" onClick={() => switchShop("leave_demo")}>Back to my shop</button>
        ) : (
          <button className="btn-primary" onClick={() => switchShop("enter_demo")}>{w.demoExists ? "Open the sample shop" : "Create a sample shop"}</button>
        )}
        {w.demoExists && <button className="btn-ghost" onClick={() => confirm("Start the sample shop over with fresh data?") && switchShop("reset_demo")}>Start over</button>}
        {w.demoExists && <button className="btn-ghost text-red-300" onClick={() => confirm("Delete the sample shop and its photos? Any share link stops working.") && switchShop("delete_demo")}>Delete it</button>}
      </div>
      <ShareLink />
    </section>
  );
}

interface S {
  shipFrom: { name?: string; street1?: string; street2?: string; city?: string; state?: string; zip?: string; phone?: string; email?: string } | null;
  mileage: { rate?: number } | null;
  shop: { name?: string; thankYou?: string } | null;
  shipping: { defaultProvider?: string; perMarketplace?: Record<string, string>; defaultPackage?: { weightOz?: number; length?: number; width?: number; height?: number } } | null;
  weekly: { enabled?: boolean; day?: number; hour?: number; timezone?: string; email?: boolean; emailTo?: string } | null;
  notify: { ntfyTopic?: string; onSale?: boolean; onOversell?: boolean; onEmailReview?: boolean; onWeekly?: boolean } | null;
  minutesPerItem: number | null;
  sourcing: { minProfit: number; minRoiPct: number } | null;
  feeOverrides: Record<string, { pct?: number; fixed?: number }> | null;
  defaultShippingCost: number | null;
  skuPrefix: string | null;
  autoDrop: { enabled: boolean; afterDays: number; everyDays: number; dropPct: number } | null;
  ebay: { fulfillmentPolicyId?: string; paymentPolicyId?: string; returnPolicyId?: string; merchantLocationKey?: string; bestOffer?: boolean } | null;
  descriptionFooter: string | null;
  extensionToken: string;
  status: { ai: boolean; ebayKeys: boolean; ebayLive: boolean };
}

function EmailTester() {
  const [from, setFrom] = useState("support@poshmark.com");
  const [subject, setSubject] = useState("Congratulations! You just made a sale");
  const [text, setText] = useState("");
  const [out, setOut] = useState<string | null>(null);
  return (
    <section className="card space-y-3 p-4">
      <h2 className="font-semibold">📬 Sale emails</h2>
      <p className="text-xs text-zinc-500">
        FlipDesk watches your inbox (IMAP settings in <code>.env</code>) or accepts forwarded emails at <code>POST /api/ext/email</code>. Paste an email below to see what it would do. Nothing gets recorded.
      </p>
      <div className="grid grid-cols-2 gap-2">
        <input className="input" value={from} onChange={(e) => setFrom(e.target.value)} placeholder="From" />
        <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" />
      </div>
      <textarea className="input min-h-24" placeholder="Paste the email body" value={text} onChange={(e) => setText(e.target.value)} />
      <button className="btn-ghost" onClick={async () => setOut(JSON.stringify(await api.post("/api/emails/test", { from, subject, text }), null, 2))}>Test</button>
      {out && <pre className="max-h-64 overflow-auto rounded bg-zinc-950 p-2 text-xs text-zinc-300">{out}</pre>}
    </section>
  );
}

export default function Settings() {
  const { data } = useFetch<S>("/api/settings");
  const { marketplaces } = useMarketplaces();
  const [s, setS] = useState<S | null>(null);
  const [digest, setDigest] = useState<string | null>(null);
  const [policies, setPolicies] = useState<{ fulfillment: { id: string; name: string }[]; payment: { id: string; name: string }[]; returns: { id: string; name: string }[] } | null>(null);
  useEffect(() => void (data && setS(data)), [data]);
  if (!s) return <div className="text-zinc-500">Loading…</div>;
  const autoDrop = s.autoDrop ?? { enabled: false, afterDays: 21, everyDays: 7, dropPct: 5 };
  const ebay = s.ebay ?? {};
  const fees = s.feeOverrides ?? {};
  const shipFrom = s.shipFrom ?? {};
  const mileage = s.mileage ?? { rate: 0.7 };
  const shop = s.shop ?? { name: "", thankYou: "Thank you for your order! If anything isn't right, message me before leaving feedback and I'll make it right." };
  const shipping = s.shipping ?? { defaultProvider: "ebay", perMarketplace: {}, defaultPackage: { weightOz: 16 } };
  const pkg = shipping.defaultPackage ?? {};
  const weekly = s.weekly ?? { enabled: true, day: 1, hour: 8, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  const sourcing = s.sourcing ?? { minProfit: 10, minRoiPct: 100 };
  const notifyS = s.notify ?? { onSale: true, onOversell: true, onEmailReview: true };
  const save = async () => {
    await api.put("/api/settings", { shipFrom, mileage, shop, shipping, weekly, notify: notifyS, sourcing, minutesPerItem: s.minutesPerItem ?? 20, feeOverrides: s.feeOverrides ?? {}, defaultShippingCost: s.defaultShippingCost ?? 0, skuPrefix: s.skuPrefix || "FD", autoDrop, ebay, descriptionFooter: s.descriptionFooter ?? "" });
    toast("Settings saved");
  };

  return (
    <div className="max-w-3xl space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Settings</h1>
        <button className="btn-primary" onClick={save}>Save settings</button>
      </div>

      <section className="card space-y-3 p-4">
        <h2 className="font-semibold">Status</h2>
        <ul className="text-sm text-zinc-300">
          <li>{s.status.ai ? "✅" : "⚠️"} AI listing writer {s.status.ai ? "live" : "in demo mode - add a key in AI below"}</li>
          <li>{s.status.ebayLive ? "✅" : "⚠️"} eBay {s.status.ebayLive ? "connected" : s.status.ebayKeys ? "keys found - click Connect eBay on Marketplaces" : "in demo mode - add eBay keys to .env"}</li>
        </ul>
        <div>
          <label className="label">Chrome extension token</label>
          <input className="input font-mono" readOnly value={s.extensionToken} onFocus={(e) => e.target.select()} />
          <p className="mt-1 text-xs text-zinc-500">Paste this into the FlipDesk extension popup along with the server URL (http://localhost:8787).</p>
        </div>
      </section>

      <SampleShop />
      <SiteSections />

      <section className="card space-y-3 p-4">
        <h2 className="font-semibold">📱 Phone notifications</h2>
        <p className="text-xs text-zinc-500">
          Free via <a className="text-brand hover:underline" href="https://ntfy.sh" target="_blank" rel="noreferrer">ntfy</a>: install the ntfy app, subscribe to a hard-to-guess topic name (e.g. flipdesk-7f3k9q), and enter the same name here.
        </p>
        <div className="flex gap-2">
          <input className="input" placeholder="your-private-topic" value={notifyS.ntfyTopic ?? ""} onChange={(e) => setS({ ...s, notify: { ...notifyS, ntfyTopic: e.target.value } })} />
          <button className="btn-ghost shrink-0" onClick={async () => { await save(); try { await api.post("/api/notify/test"); toast("Test sent - check your phone"); } catch (e) { toast((e as Error).message, "err"); } }}>Send test</button>
        </div>
        <div className="flex flex-wrap gap-4 text-sm">
          {([["onSale", "Every sale"], ["onOversell", "Oversells (urgent)"], ["onEmailReview", "Sale emails to confirm"], ["onWeekly", "Weekly summary"]] as const).map(([k, label]) => (
            <label key={k} className="flex items-center gap-2"><input type="checkbox" checked={notifyS[k] !== false} onChange={(e) => setS({ ...s, notify: { ...notifyS, [k]: e.target.checked } })} /> {label}</label>
          ))}
        </div>
      </section>

      <section className="card space-y-3 p-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">📊 Weekly summary</h2>
          <div className="flex gap-2">
            <button className="btn-ghost text-xs" onClick={async () => { const d = await api.get<{ title: string; body: string }>("/api/digest/preview"); setDigest(`${d.title}\n\n${d.body}`); }}>Preview</button>
            <button className="btn-ghost text-xs" onClick={async () => { await save(); const r = await api.post<{ pushed: boolean; emailed?: boolean; title: string; body: string }>("/api/digest/send"); setDigest(`${r.title}\n\n${r.body}`); toast(r.pushed || r.emailed ? `Sent${r.pushed ? " to your phone" : ""}${r.emailed ? (r.pushed ? " and email" : " by email") : ""}` : "Set an ntfy topic above (or turn on email) to receive it", r.pushed || r.emailed ? "ok" : "err"); }}>Send now</button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
          <label className="flex items-center gap-2"><input type="checkbox" checked={weekly.enabled !== false} onChange={(e) => setS({ ...s, weekly: { ...weekly, enabled: e.target.checked } })} /> Enabled</label>
          <select className="input" value={weekly.day ?? 1} onChange={(e) => setS({ ...s, weekly: { ...weekly, day: Number(e.target.value) } })}>
            {["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((d, i) => <option key={d} value={i}>{d}</option>)}
          </select>
          <select className="input" value={weekly.hour ?? 8} onChange={(e) => setS({ ...s, weekly: { ...weekly, hour: Number(e.target.value) } })}>
            {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{h === 0 ? "12 am" : h < 12 ? `${h} am` : h === 12 ? "12 pm" : `${h - 12} pm`}</option>)}
          </select>
          <input className="input" value={weekly.timezone ?? ""} placeholder="America/Chicago" onChange={(e) => setS({ ...s, weekly: { ...weekly, timezone: e.target.value } })} />
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" checked={Boolean(weekly.email)} onChange={(e) => setS({ ...s, weekly: { ...weekly, email: e.target.checked } })} /> Also email it to me</label>
          {weekly.email && <input className="input max-w-xs" type="email" placeholder="you@example.com (blank = your account email)" value={weekly.emailTo ?? ""} onChange={(e) => setS({ ...s, weekly: { ...weekly, emailTo: e.target.value } })} />}
          {weekly.email && <span className="text-xs text-zinc-500">Needs email set up on the server (SMTP_* in .env).</span>}
        </div>
        {digest && <pre className="whitespace-pre-wrap rounded bg-zinc-950 p-3 text-sm text-zinc-200">{digest}</pre>}
      </section>

      <section className="card space-y-3 p-4">
        <h2 className="font-semibold">🧾 Packing slips</h2>
        <div><label className="label">Shop name</label><input className="input" value={shop.name ?? ""} onChange={(e) => setS({ ...s, shop: { ...shop, name: e.target.value } })} /></div>
        <div><label className="label">Thank-you note</label><textarea className="input min-h-16" value={shop.thankYou ?? ""} onChange={(e) => setS({ ...s, shop: { ...shop, thankYou: e.target.value } })} /></div>
      </section>

      <section className="card space-y-3 p-4">
        <h2 className="font-semibold">Listing defaults</h2>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label">SKU prefix</label><input className="input" value={s.skuPrefix ?? "FD"} onChange={(e) => setS({ ...s, skuPrefix: e.target.value })} /></div>
          <div><label className="label">Typical shipping label cost ($)</label><input className="input" type="number" step="0.01" value={s.defaultShippingCost ?? 0} onChange={(e) => setS({ ...s, defaultShippingCost: Number(e.target.value) })} /></div>
        </div>
        <div><label className="label">Description footer (added on extension sites)</label><textarea className="input min-h-20" value={s.descriptionFooter ?? ""} placeholder="Ships within 1 business day · Smoke-free home · Bundle to save!" onChange={(e) => setS({ ...s, descriptionFooter: e.target.value })} /></div>
      </section>

      <section className="card space-y-3 p-4">
        <h2 className="font-semibold">🛒 Sourcing targets and your time</h2>
        <div className="grid grid-cols-3 gap-3 text-sm">
          <div><label className="label">Min profit per item ($)</label><input className="input" type="number" value={sourcing.minProfit} onChange={(e) => setS({ ...s, sourcing: { ...sourcing, minProfit: Number(e.target.value) } })} /></div>
          <div><label className="label">Min return on cost (%)</label><input className="input" type="number" value={sourcing.minRoiPct} onChange={(e) => setS({ ...s, sourcing: { ...sourcing, minRoiPct: Number(e.target.value) } })} /></div>
          <div><label className="label">Minutes per item</label><input className="input" type="number" value={s.minutesPerItem ?? 20} onChange={(e) => setS({ ...s, minutesPerItem: Number(e.target.value) })} /></div>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <label className="label mb-0">Mileage rate ($/mile)</label>
          <input className="input w-24" type="number" step="0.005" value={mileage.rate ?? 0.7} onChange={(e) => setS({ ...s, mileage: { rate: Number(e.target.value) } })} />
          <span className="text-xs text-zinc-500">Use the IRS standard business rate for the current year (it changes every January).</span>
        </div>
        <p className="text-xs text-zinc-500">Sourcing mode's "pay at most" price must meet both the profit and return targets. Minutes per item (sourcing, photos, listing, shipping) is used for profit per hour in Reports.</p>
      </section>

      <section className="card space-y-3 p-4">
        <h2 className="font-semibold">🚚 Shipping labels</h2>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-zinc-400">When I buy my own label, use:</span>
          {[["ebay", "eBay labels (eBay orders) + Pirate Ship elsewhere"], ["pirateship", "Pirate Ship for everything"], ["shippo", "Buy in FlipDesk (Shippo)"], ["manual", "Manual"]].map(([v, label]) => (
            <label key={v} className="flex items-center gap-1.5"><input type="radio" name="prov" checked={(shipping.defaultProvider ?? "ebay") === v} onChange={() => setS({ ...s, shipping: { ...shipping, defaultProvider: v } })} /> {label}</label>
          ))}
        </div>
        <details className="text-sm">
          <summary className="cursor-pointer text-zinc-400">Per-marketplace override</summary>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {marketplaces.map((m) => (
              <label key={m.id} className="flex items-center justify-between gap-2">
                <span>{m.name}</span>
                <select className="input w-44 py-1" value={shipping.perMarketplace?.[m.id] ?? ""} onChange={(e) => setS({ ...s, shipping: { ...shipping, perMarketplace: { ...shipping.perMarketplace, [m.id]: e.target.value } } })}>
                  <option value="">Default</option>
                  <option value="marketplace">Site's prepaid label</option>
                  {m.id === "ebay" && <option value="ebay">eBay labels</option>}
                  <option value="pirateship">Pirate Ship</option>
                  <option value="shippo">Shippo (in FlipDesk)</option>
                  <option value="manual">Manual</option>
                </select>
              </label>
            ))}
          </div>
        </details>
        <div className="grid grid-cols-4 gap-2 text-sm">
          {([["weightOz", "Default weight (oz)"], ["length", "Length (in)"], ["width", "Width (in)"], ["height", "Height (in)"]] as const).map(([k, label]) => (
            <div key={k}><label className="label">{label}</label><input className="input" type="number" value={pkg[k] ?? ""} onChange={(e) => setS({ ...s, shipping: { ...shipping, defaultPackage: { ...pkg, [k]: e.target.value === "" ? undefined : Number(e.target.value) } } })} /></div>
          ))}
        </div>
        <div>
          <label className="label">Ship-from address (for labels bought in FlipDesk)</label>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {([["name", "Name"], ["street1", "Street"], ["street2", "Apt / suite"], ["city", "City"], ["state", "State"], ["zip", "ZIP"], ["phone", "Phone"], ["email", "Email"]] as const).map(([k, ph]) => (
              <input key={k} className="input" placeholder={ph} value={shipFrom[k] ?? ""} onChange={(e) => setS({ ...s, shipFrom: { ...shipFrom, [k]: e.target.value } })} />
            ))}
          </div>
        </div>
        <p className="text-xs text-zinc-500">Poshmark, Mercari, Depop, Vinted, Grailed, Whatnot and Facebook give you a prepaid label by default. Pirate Ship has no public API, so FlipDesk uses its spreadsheet import and export.</p>
      </section>

      <section className="card space-y-3 p-4">
        <h2 className="font-semibold">Automatic price drops</h2>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={autoDrop.enabled} onChange={(e) => setS({ ...s, autoDrop: { ...autoDrop, enabled: e.target.checked } })} /> Enabled (never below each item's floor price)</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!(autoDrop as { smart?: boolean }).smart} onChange={(e) => setS({ ...s, autoDrop: { ...autoDrop, smart: e.target.checked } as typeof autoDrop })} /> 💡 Smart: learn from my sales when and how much to drop, per category (falls back to the fixed % below until there's enough history)</label>
        <div className="grid grid-cols-3 gap-3 text-sm">
          <div><label className="label">Start after (days)</label><input className="input" type="number" value={autoDrop.afterDays} onChange={(e) => setS({ ...s, autoDrop: { ...autoDrop, afterDays: Number(e.target.value) } })} /></div>
          <div><label className="label">Repeat every (days)</label><input className="input" type="number" value={autoDrop.everyDays} onChange={(e) => setS({ ...s, autoDrop: { ...autoDrop, everyDays: Number(e.target.value) } })} /></div>
          <div><label className="label">Drop by %</label><input className="input" type="number" value={autoDrop.dropPct} onChange={(e) => setS({ ...s, autoDrop: { ...autoDrop, dropPct: Number(e.target.value) } })} /></div>
        </div>
      </section>

      <section className="card space-y-3 p-4">
        <div className="flex items-center justify-between">
          <h2 id="ebay" className="font-semibold">eBay listing policies</h2>
          <button className="btn-ghost text-xs" disabled={!s.status.ebayLive} onClick={async () => { try { setPolicies(await api.get("/api/ebay/policies")); } catch (e) { toast((e as Error).message, "err"); } }}>Load from eBay</button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {([["fulfillmentPolicyId", "Shipping policy", policies?.fulfillment], ["paymentPolicyId", "Payment policy", policies?.payment], ["returnPolicyId", "Return policy", policies?.returns]] as const).map(([k, label, opts]) => (
            <div key={k}>
              <label className="label">{label}</label>
              {opts ? (
                <select className="input" value={ebay[k] ?? ""} onChange={(e) => setS({ ...s, ebay: { ...ebay, [k]: e.target.value } })}>
                  <option value="">Choose…</option>
                  {opts.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              ) : (
                <input className="input" placeholder="policy id" value={ebay[k] ?? ""} onChange={(e) => setS({ ...s, ebay: { ...ebay, [k]: e.target.value } })} />
              )}
            </div>
          ))}
          <div><label className="label">Inventory location key</label><input className="input" value={ebay.merchantLocationKey ?? ""} onChange={(e) => setS({ ...s, ebay: { ...ebay, merchantLocationKey: e.target.value } })} /></div>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!ebay.bestOffer} onChange={(e) => setS({ ...s, ebay: { ...ebay, bestOffer: e.target.checked } })} /> Enable Best Offer (auto-decline below each item's floor)</label>
      </section>

      <EmailTester />

      <section className="card space-y-3 p-4">
        <h2 className="font-semibold">Fee overrides</h2>
        <p className="text-xs text-zinc-500">Marketplaces change fees often. Override the % and per-order fee here; all profit math uses these.</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {marketplaces.map((m) => (
            <div key={m.id} className="flex items-center gap-2 text-sm">
              <span className="w-24 truncate sm:w-36">{m.name}</span>
              <input className="input w-20" type="number" step="0.1" placeholder={String(m.fees.pct)} value={fees[m.id]?.pct ?? ""} onChange={(e) => setS({ ...s, feeOverrides: { ...fees, [m.id]: { ...fees[m.id], pct: e.target.value === "" ? undefined : Number(e.target.value) } } })} />%
              <input className="input w-20" type="number" step="0.01" placeholder={String(m.fees.fixed)} value={fees[m.id]?.fixed ?? ""} onChange={(e) => setS({ ...s, feeOverrides: { ...fees, [m.id]: { ...fees[m.id], fixed: e.target.value === "" ? undefined : Number(e.target.value) } } })} />$
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
