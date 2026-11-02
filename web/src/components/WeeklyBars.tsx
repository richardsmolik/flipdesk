import { useState } from "react";

/**
 * One series per chart, by week: thin bars with rounded tops, a hover tooltip per bar, and a table view.
 * Single series → the title names it (no legend box). Text stays in ink colors, never the bar color.
 */
export function WeeklyBars({ title, data, format = (n) => String(n), extra }: { title: string; data: { week: string; value: number }[]; format?: (n: number) => string; extra?: (i: number) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const W = 520, H = 150, L = 34, B = 20;
  const max = Math.max(1, ...data.map((d) => d.value));
  const y = (v: number) => 6 + (1 - v / max) * (H - B - 6);
  const bw = (W - L) / data.length;
  const h = hover !== null ? data[hover] : null;
  return (
    <div className="card p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-200">{title}</h3>
        <button className="text-xs text-zinc-400 hover:underline" onClick={() => setTable(!table)}>{table ? "Show chart" : "Show table"}</button>
      </div>
      {table ? (
        <table className="w-full text-xs tabular-nums">
          <thead className="text-zinc-500"><tr><th className="text-left">Week of</th><th className="text-right">{title}</th></tr></thead>
          <tbody>{data.map((d, i) => <tr key={d.week} className="text-zinc-300"><td>{d.week}</td><td className="text-right">{format(d.value)}{extra ? ` · ${extra(i)}` : ""}</td></tr>)}</tbody>
        </table>
      ) : (
        <div className="relative">
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={title} onMouseLeave={() => setHover(null)}>
            {[0, max].map((t) => (
              <g key={t}>
                <line x1={L} x2={W} y1={y(t)} y2={y(t)} stroke="#27272a" />
                <text x={L - 6} y={y(t)} fill="#71717a" fontSize={10} textAnchor="end" dominantBaseline="middle">{format(t)}</text>
              </g>
            ))}
            {data.map((d, i) => {
              const top = y(d.value);
              const bh = y(0) - top;
              const w = Math.max(2, Math.min(28, bw - 2)); // 2px gap between bars
              const x = L + i * bw + (bw - w) / 2;
              const r = Math.min(4, w / 2, bh);
              return (
                <g key={d.week} onMouseEnter={() => setHover(i)}>
                  <rect x={L + i * bw} y={0} width={bw} height={H} fill="transparent" />
                  {d.value > 0 && (
                    <path
                      d={`M${x},${y(0)} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${y(0)} Z`}
                      fill="#3987e5"
                      opacity={hover === null || hover === i ? 1 : 0.45}
                    />
                  )}
                </g>
              );
            })}
            {data.map((d, i) => (i % Math.ceil(data.length / 6) === 0 || i === data.length - 1 ? <text key={d.week} x={L + i * bw + bw / 2} y={H - 5} fill="#71717a" fontSize={10} textAnchor="middle">{d.week.slice(5)}</text> : null))}
          </svg>
          {h && (
            <div className="pointer-events-none absolute top-0 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs shadow" style={{ left: `${Math.min(75, ((L + hover! * bw) / W) * 100)}%` }}>
              <div className="font-medium text-zinc-100">Week of {h.week}</div>
              <div className="text-zinc-300">{format(h.value)}{extra ? ` · ${extra(hover!)}` : ""}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
