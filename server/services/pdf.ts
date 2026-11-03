/**
 * A tiny PDF writer for plain-text reports (no dependencies): a bold title, then lines of text, wrapped and paged
 * on US Letter with Helvetica. Characters Helvetica can't show (emoji etc.) are dropped.
 */
const W = 612;
const H = 792;
const MARGIN = 54;
const SIZE = 11;
const LEAD = 15;
const MAX_CHARS = 92;

const clean = (s: string) =>
  s
    .replace(/[–—]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, "...")
    .replace(/→/g, "->")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "")
    .trim();
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

function wrap(line: string) {
  const out: string[] = [];
  let cur = "";
  for (const word of line.split(/\s+/)) {
    if ((cur + " " + word).trim().length > MAX_CHARS) {
      if (cur) out.push(cur);
      cur = word;
    } else cur = (cur + " " + word).trim();
  }
  out.push(cur);
  return out;
}

export function textPdf(title: string, lines: string[]): Buffer {
  const body = lines.flatMap((l) => (l.trim() === "" ? [""] : wrap(clean(l))));
  const perPage = Math.floor((H - 2 * MARGIN - 30) / LEAD);
  const pages: string[][] = [];
  for (let i = 0; i < Math.max(1, body.length); i += perPage) pages.push(body.slice(i, i + perPage));
  const objs: string[] = [];
  const add = (s: string) => (objs.push(s), objs.length);
  const catalog = add("");
  const pagesObj = add("");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const bold = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const kids: number[] = [];
  pages.forEach((pl, pi) => {
    let y = H - MARGIN;
    let stream = "";
    if (pi === 0) {
      stream += `BT /F2 18 Tf ${MARGIN} ${y - 18} Td (${esc(clean(title))}) Tj ET\n`;
      y -= 40;
    }
    for (const l of pl) {
      if (l) stream += `BT /F1 ${SIZE} Tf ${MARGIN} ${y} Td (${esc(l)}) Tj ET\n`;
      y -= LEAD;
    }
    stream += `BT /F1 8 Tf ${MARGIN} 30 Td (Page ${pi + 1} of ${pages.length}) Tj ET\n`;
    const content = add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}endstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${font} 0 R /F2 ${bold} 0 R >> >> /Contents ${content} 0 R >>`));
  });
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
