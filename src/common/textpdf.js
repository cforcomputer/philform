/**
 * Plain text as a one-font PDF (Helvetica, US Letter), for a document phil
 * writes and a page only takes as a file: a required cover letter upload
 * with nothing saved (Astera). No library; Latin-1 text, wrapped to the page.
 */

// Helvetica's widths in 1/1000 em for the printable ASCII range; others count as 556.
const WIDTHS = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500,
  667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556,
  556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500,
  500, 500, 334, 260, 334, 584];
const width = (s, size) => [...s].reduce((w, c) => w + (WIDTHS[c.charCodeAt(0) - 32] ?? 556), 0) * size / 1000;

/** Typographic punctuation as the plain characters Helvetica's WinAnsi set surely has. */
function latin(text) {
  return String(text || '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .replace(/…/g, '...').replace(/ /g, ' ').replace(/[^\n\x20-\x7e\xa0-\xff]/g, '');
}

function wrap(paragraph, size, max) {
  const lines = [];
  let line = '';
  for (const word of paragraph.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && width(next, size) > max) { lines.push(line); line = word; } else line = next;
  }
  lines.push(line);
  return lines;
}

/** The PDF's bytes, base64-encoded, for `text` (paragraphs split on blank lines). */
export function textPdf(text, { size = 11, margin = 72 } = {}) {
  const pageW = 612, pageH = 792, leading = size * 1.45;
  const lines = [];
  for (const para of latin(text).split(/\n\s*\n/)) {
    for (const piece of para.split('\n')) lines.push(...wrap(piece, size, pageW - 2 * margin));
    lines.push('');
  }
  const perPage = Math.floor((pageH - 2 * margin) / leading);
  const pages = [];
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));
  const esc = s => s.replace(/[\\()]/g, c => `\\${c}`);

  // Objects: 1 catalog, 2 pages, 3 font, then a page and its content stream for each page.
  const objects = [];
  const kids = pages.map((_, i) => `${4 + 2 * i} 0 R`).join(' ');
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  pages.forEach((page, i) => {
    const stream = `BT /F1 ${size} Tf ${leading} TL ${margin} ${pageH - margin - size} Td\n` +
      page.map(l => `(${esc(l)}) Tj T*`).join('\n') + '\nET';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * i} 0 R >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });

  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  // Every character is Latin-1, one byte each, so string offsets are byte offsets.
  return btoa(out);
}
