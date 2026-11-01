import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

/** Two-key "go to" shortcuts: press g, then the letter. */
export const GO: { key: string; to: string; label: string }[] = [
  { key: "d", to: "/", label: "Dashboard" },
  { key: "i", to: "/inventory", label: "Inventory" },
  { key: "f", to: "/inventory?view=drafts", label: "Drafts" },
  { key: "x", to: "/inbox", label: "Inbox" },
  { key: "h", to: "/shipping", label: "Shipping" },
  { key: "s", to: "/sales", label: "Sales & profit" },
  { key: "r", to: "/reports", label: "Reports" },
  { key: "b", to: "/bundles", label: "Bundles" },
  { key: "t", to: "/tools", label: "Power tools" },
  { key: "o", to: "/source", label: "Sourcing mode" },
  { key: "u", to: "/bulk", label: "Bulk upload" },
  { key: "q", to: "/queue", label: "Sync queue" },
  { key: "m", to: "/connections", label: "Marketplaces" },
  { key: ",", to: "/settings", label: "Settings" },
];

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
};

export function focusSearch() {
  const el = document.querySelector<HTMLInputElement>("input[data-search]");
  if (el) (el.focus(), el.select());
  return Boolean(el);
}

/** Keyboard shortcuts for power users. "?" shows them all. Ignored while you type in a field. */
export function Shortcuts() {
  const nav = useNavigate();
  const [help, setHelp] = useState(false);
  const pendingG = useRef(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Cmd/Ctrl+S saves the item you're editing (works inside fields too).
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        if (window.dispatchEvent(new CustomEvent("fd-save", { cancelable: true })) === false) e.preventDefault();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        setHelp(false);
        if (typing(e.target)) (e.target as HTMLElement).blur();
        return;
      }
      if (typing(e.target)) return;
      if (Date.now() - pendingG.current < 1200) {
        pendingG.current = 0;
        const g = GO.find((x) => x.key === e.key.toLowerCase());
        if (g) (e.preventDefault(), nav(g.to));
        return;
      }
      if (e.key === "g") return void (pendingG.current = Date.now());
      if (e.key === "?") return void (e.preventDefault(), setHelp((h) => !h));
      if (e.key === "n") return void (e.preventDefault(), nav("/items/new"));
      if (e.key === "/") {
        e.preventDefault();
        if (!focusSearch()) {
          nav("/inventory");
          setTimeout(focusSearch, 150);
        }
      }
    };
    const open = () => setHelp(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("fd-shortcuts", open);
    return () => (window.removeEventListener("keydown", onKey), window.removeEventListener("fd-shortcuts", open));
  }, [nav]);
  if (!help) return null;
  const Row = ({ k, label }: { k: string[]; label: string }) => (
    <div className="flex items-center justify-between gap-4 py-1 text-sm">
      <span className="text-zinc-300">{label}</span>
      <span className="flex gap-1">{k.map((x) => <kbd key={x} className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-mono text-xs text-zinc-200">{x}</kbd>)}</span>
    </div>
  );
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setHelp(false)}>
      <div className="card max-h-[85vh] w-full max-w-lg overflow-auto bg-zinc-900 p-5" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Keyboard shortcuts">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold">⌨️ Keyboard shortcuts</h2>
          <button className="text-zinc-400 hover:text-zinc-100" onClick={() => setHelp(false)} aria-label="Close">✕</button>
        </div>
        <div className="grid gap-x-8 sm:grid-cols-2">
          <div>
            <Row k={["n"]} label="New listing" />
            <Row k={["/"]} label="Search inventory" />
            <Row k={["⌘/Ctrl", "S"]} label="Save item" />
            <Row k={["?"]} label="Show this list" />
            <Row k={["Esc"]} label="Close / leave a field" />
            <Row k={["←", "→"]} label="Photos in the viewer" />
          </div>
          <div>
            {GO.map((g) => <Row key={g.key} k={["g", g.key]} label={g.label} />)}
          </div>
        </div>
        <p className="mt-3 text-xs text-zinc-500">Shortcuts pause while you're typing in a box.</p>
      </div>
    </div>
  );
}
