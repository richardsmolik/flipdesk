import { useEffect } from "react";
import { api } from "../api";
import { MpBadge, toast, useMarketplaces } from "../ui";
import EbaySetup from "../components/EbaySetup";
import EbaySmoke from "../components/EbaySmoke";

const ENV_HINT: Record<string, string> = {
  ebay: "EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_RU_NAME",
  etsy: "ETSY_API_KEY, ETSY_SHOP_ID, ETSY_ACCESS_TOKEN",
  shopify: "SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_TOKEN",
  amazon: "SP-API approval required (coming next)",
};

const pctText = (f: Record<string, number | boolean>) => {
  const parts: string[] = [];
  if (f.flatUnderThreshold) parts.push(`$${f.flatUnder} under $${f.flatUnderThreshold}, else`);
  if (f.pct) parts.push(`${f.pct}%`);
  if (f.fixed) parts.push(`+ $${f.fixed}`);
  if (f.processingPct) parts.push(`+ ${f.processingPct}% + $${f.processingFixed ?? 0} processing`);
  if (f.listingFee) parts.push(`+ $${f.listingFee} listing`);
  return parts.length ? parts.join(" ") : "0% seller fee";
};

export default function Connections() {
  const { marketplaces, reload } = useMarketplaces();
  useEffect(() => {
    if (new URLSearchParams(location.search).get("ebay") === "connected") {
      toast("eBay connected 🎉");
      history.replaceState(null, "", "/connections");
    }
  }, []);
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Marketplaces</h1>
        <p className="max-w-3xl text-sm text-zinc-400">
          <b className="text-zinc-200">API</b> sites connect directly and sync automatically. <b className="text-zinc-200">Extension</b> sites have no public seller API, so the FlipDesk Chrome extension fills in their listing forms in your logged-in browser. Your passwords never leave your browser.
        </p>
      </div>
      <EbaySetup />
      <EbaySmoke />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {marketplaces.map((m) => {
          const connected = m.connection.status === "connected";
          return (
            <div key={m.id} className="card flex flex-col gap-3 p-4">
              <div className="flex items-center justify-between">
                <MpBadge id={m.id} mp={m} />
                <span className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide ${m.mode === "api" ? "bg-blue-950 text-blue-300" : "bg-zinc-800 text-zinc-300"}`}>{m.mode}</span>
              </div>
              <div className="text-xs text-zinc-400">
                <div>Fees: <span className="text-zinc-200">{pctText(m.fees)}</span></div>
                <div>Title {m.titleMax} chars · {m.maxPhotos} photos · {m.multiQty ? "multi-quantity" : "1 per listing (auto-relist)"}</div>
                <div className="mt-1 text-zinc-500">{m.notes}</div>
              </div>
              <div className="mt-auto flex items-center justify-between text-sm">
                <span className={connected ? "text-green-400" : "text-zinc-500"}>
                  {connected ? `● Connected${m.connection.username ? ` as ${m.connection.username}` : ""}` : "○ Not connected"}
                  {m.mode === "api" && !m.live && <span className="ml-1 text-amber-400">(demo)</span>}
                </span>
                <span className="text-xs text-zinc-500">{m.activeListings} live</span>
              </div>
              <div className="flex gap-2">
                {m.id === "ebay" ? (
                  <button
                    className="btn-primary flex-1"
                    onClick={async () => {
                      try {
                        const r = await api.get<{ url: string }>(`/api/connections/ebay/auth-url?return=${encodeURIComponent(location.origin)}`);
                        location.href = r.url;
                      } catch (e) {
                        toast((e as Error).message, "err");
                      }
                    }}
                  >
                    {m.live ? "Reconnect eBay" : "Connect eBay"}
                  </button>
                ) : m.mode === "extension" ? (
                  <button
                    className={connected ? "btn-ghost flex-1" : "btn-primary flex-1"}
                    onClick={async () => {
                      const username = connected ? undefined : prompt(`Your ${m.name} username (optional)`) ?? undefined;
                      await api.post(`/api/connections/${m.id}`, { status: connected ? "disconnected" : "connected", username });
                      reload();
                    }}
                  >
                    {connected ? "Disconnect" : "I'm logged in via the extension"}
                  </button>
                ) : (
                  <div className="text-[11px] text-zinc-500">Add to <code>.env</code>: {ENV_HINT[m.id]}</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
