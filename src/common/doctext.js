/**
 * The words in a CV file, read in the browser when it is uploaded, so Phil
 * has the CV's text to write from without the user pasting it.
 *
 * PDF (its text layer: a scanned page has none), Word .docx, plain text and
 * RTF. No library: a PDF is read far enough to find each page's text and the
 * font tables that say which letters its codes stand for, which is all a CV
 * needs. Anything this cannot read returns '' and the page asks for the text.
 */

export async function documentText({ filename = '', mimeType = '', data = '' }) {
  const bytes = base64Bytes(data);
  const name = filename.toLowerCase();
  try {
    if (name.endsWith('.pdf') || mimeType === 'application/pdf' || startsWith(bytes, '%PDF')) return tidy(await pdfText(bytes));
    if (name.endsWith('.docx') || startsWith(bytes, 'PK')) return tidy(await docxText(bytes));
    if (name.endsWith('.rtf') || startsWith(bytes, '{\\rtf')) return tidy(rtfText(latin1(bytes)));
    if (name.endsWith('.txt') || mimeType.startsWith('text/')) return tidy(new TextDecoder().decode(bytes));
  } catch {
    /* unreadable: the page asks for the text instead */
  }
  return '';
}

export function base64Bytes(b64) {
  const bin = atob(b64 || '');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const startsWith = (bytes, text) => [...text].every((c, i) => bytes[i] === c.charCodeAt(0));

function latin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return s;
}

function tidy(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .split('\n').map(line => line.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Inflate, keeping what came out before any error: a stream cut short still has its first pages. */
async function inflate(bytes, format = 'deflate') {
  const ds = new DecompressionStream(format);
  const writer = ds.writable.getWriter();
  writer.write(bytes).catch(() => {});
  writer.close().catch(() => {});
  const reader = ds.readable.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } catch { /* truncated or trailing junk */ }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

// --- docx and rtf -------------------------------------------------------------

/** word/document.xml out of the zip, its paragraphs as lines. */
async function docxText(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The central directory lists each file with its real sizes, which the
  // local headers may leave as zero.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) return '';
  const count = view.getUint16(end + 10, true);
  let p = view.getUint32(end + 16, true);
  for (let n = 0; n < count && view.getUint32(p, true) === 0x02014b50; n++) {
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = latin1(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name !== 'word/document.xml') continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + size);
    const xml = new TextDecoder().decode(method === 8 ? await inflate(raw, 'deflate-raw') : raw);
    return xml
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<w:(br|cr)\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&(lt|gt|amp|quot|apos|#(\d+)|#x([0-9a-f]+));/gi, (_, e, d, h) =>
        d ? String.fromCodePoint(+d) : h ? String.fromCodePoint(parseInt(h, 16))
          : { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e]);
  }
  return '';
}

/** Plain text out of RTF: drop the header groups and control words, keep the words. */
function rtfText(rtf) {
  let out = '';
  const skip = [];
  let depth = 0;
  for (let i = 0; i < rtf.length; i++) {
    const c = rtf[i];
    if (c === '{') { depth++; continue; }
    if (c === '}') { if (skip.length && skip[skip.length - 1] === depth) skip.pop(); depth--; continue; }
    if (c === '\\') {
      const m = /^\\(?:([a-z]+)(-?\d+)? ?|'([0-9a-f]{2})|([\\{}])|(\*)|(\n))/i.exec(rtf.slice(i, i + 40));
      if (!m) continue;
      i += m[0].length - 1;
      if (skip.length) continue;
      const [, word, num, hex, literal, star, newline] = m;
      if (star) { skip.push(depth); continue; }
      if (newline) { out += '\n'; continue; }
      if (literal) out += literal;
      else if (hex) out += CP1252[parseInt(hex, 16)] || String.fromCharCode(parseInt(hex, 16));
      else if (word === 'u') out += String.fromCharCode((+num + 65536) % 65536), i += rtf[i + 1] === '?' ? 1 : 0;
      else if (word === 'par' || word === 'line' || word === 'row') out += '\n';
      else if (word === 'tab' || word === 'cell') out += '\t';
      else if (/^(fonttbl|colortbl|stylesheet|info|pict|header|footer|listtable|listoverridetable|generator)$/.test(word)) skip.push(depth);
      continue;
    }
    if (skip.length || c === '\n' || c === '\r') continue;
    out += c;
  }
  return out;
}

// --- pdf ----------------------------------------------------------------------

/** The cp1252 letters that differ from latin1, for fonts with no table of their own. */
const CP1252 = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰',
  0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•',
  0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ'
};

/** Mac Roman's upper half, which Quartz (macOS "Save as PDF") writes simple fonts in. */
const MAC_ROMAN = [...'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»…\u00a0ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔ\uF8FFÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ'];

/** Glyph names a font's /Differences commonly uses for letters that are not themselves. */
const GLYPHS = {
  space: ' ', quoteright: '’', quoteleft: '‘', quotedblleft: '“', quotedblright: '”', quotesingle: "'",
  endash: '–', emdash: '—', bullet: '•', ellipsis: '…', fi: 'fi', fl: 'fl', ff: 'ff', ffi: 'ffi', ffl: 'ffl',
  hyphen: '-', period: '.', comma: ',', colon: ':', semicolon: ';', slash: '/', at: '@', ampersand: '&',
  parenleft: '(', parenright: ')', percent: '%', plus: '+', numbersign: '#', dollar: '$', exclam: '!',
  question: '?', underscore: '_', bar: '|', asterisk: '*', equal: '=', quotedbl: '"', minus: '−',
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  middot: '·', periodcentered: '·', copyright: '©', registered: '®', trademark: '™', degree: '°', euro: '€'
};

function glyphChar(name) {
  if (GLYPHS[name]) return GLYPHS[name];
  if (/^[A-Za-z]$/.test(name)) return name;
  const uni = /^uni([0-9A-F]{4})/i.exec(name) || /^u([0-9A-F]{4,6})$/i.exec(name);
  if (uni) return String.fromCodePoint(parseInt(uni[1], 16));
  return null;
}

/** PDF tokens. Names are strings; strings are { s }; refs are { ref }. */
class Lexer {
  constructor(src, pos = 0) { this.src = src; this.pos = pos; }

  skip() {
    const s = this.src;
    while (this.pos < s.length) {
      const c = s.charCodeAt(this.pos);
      if (c === 37) { while (this.pos < s.length && s[this.pos] !== '\n' && s[this.pos] !== '\r') this.pos++; }
      else if (c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0) this.pos++;
      else break;
    }
  }

  token() {
    this.skip();
    const s = this.src;
    if (this.pos >= s.length) return null;
    const c = s[this.pos];
    if (c === '<' && s[this.pos + 1] === '<') { this.pos += 2; return '<<'; }
    if (c === '>' && s[this.pos + 1] === '>') { this.pos += 2; return '>>'; }
    if (c === '[' || c === ']' || c === '{' || c === '}') { this.pos++; return c; }
    if (c === '/') {
      const m = /^\/[^\s()<>[\]{}/%]*/.exec(s.slice(this.pos, this.pos + 128));
      this.pos += m[0].length;
      return { name: m[0].slice(1).replace(/#([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))) };
    }
    if (c === '(') return { s: this.literal() };
    if (c === '<') {
      const end = s.indexOf('>', this.pos);
      let hex = s.slice(this.pos + 1, end < 0 ? s.length : end).replace(/[^0-9a-f]/gi, '');
      this.pos = end < 0 ? s.length : end + 1;
      if (hex.length % 2) hex += '0';
      let out = '';
      for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
      return { s: out };
    }
    const m = /^[^\s()<>[\]{}/%]+/.exec(s.slice(this.pos, this.pos + 64));
    if (!m) { this.pos++; return this.token(); }
    this.pos += m[0].length;
    const n = Number(m[0]);
    return Number.isNaN(n) || !/^[-+.\d]/.test(m[0]) ? { op: m[0] } : n;
  }

  literal() {
    const s = this.src;
    let depth = 1;
    let out = '';
    this.pos++;
    while (this.pos < s.length) {
      const c = s[this.pos++];
      if (c === '\\') {
        const e = s[this.pos++];
        const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
        if (map[e]) out += map[e];
        else if (e >= '0' && e <= '7') {
          let oct = e;
          while (oct.length < 3 && s[this.pos] >= '0' && s[this.pos] <= '7') oct += s[this.pos++];
          out += String.fromCharCode(parseInt(oct, 8) & 255);
        } else if (e === '\r') { if (s[this.pos] === '\n') this.pos++; }
        else if (e !== '\n') out += e;
      } else if (c === '(') { depth++; out += c; }
      else if (c === ')') { if (--depth === 0) break; out += c; }
      else out += c;
    }
    return out;
  }

  /** One value; a dictionary or array whole. */
  value(tok = this.token()) {
    if (tok === '<<') {
      const dict = {};
      for (;;) {
        const key = this.token();
        if (key === '>>' || key === null) return dict;
        if (key && key.name !== undefined) dict[key.name] = this.value();
      }
    }
    if (tok === '[') {
      const arr = [];
      for (;;) {
        const t = this.token();
        if (t === ']' || t === null) return arr;
        arr.push(this.value(t));
      }
    }
    if (typeof tok === 'number' && Number.isInteger(tok) && tok >= 0) {
      const save = this.pos;
      const gen = this.token();
      const r = typeof gen === 'number' ? this.token() : null;
      if (r && r.op === 'R') return { ref: tok };
      this.pos = save;
    }
    if (tok && tok.name !== undefined) return tok.name;
    return tok;
  }
}

class Pdf {
  constructor(bytes) {
    this.src = latin1(bytes);
    this.offsets = new Map();
    this.packed = new Map();
    this.cache = new Map();
    // Every "n 0 obj" in the file; a later one is an edit and wins.
    const re = /(\d+)\s+\d+\s+obj\b/g;
    let m;
    while ((m = re.exec(this.src))) this.offsets.set(+m[1], m.index + m[0].length);
  }

  get(num) {
    if (this.cache.has(num)) return this.cache.get(num);
    let value = null;
    if (this.offsets.has(num)) {
      const lex = new Lexer(this.src, this.offsets.get(num));
      value = lex.value();
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const save = lex.pos;
        const next = lex.token();
        if (next && next.op === 'stream') {
          let start = lex.pos;
          if (this.src[start] === '\r') start++;
          if (this.src[start] === '\n') start++;
          const length = this.resolve(value.Length);
          let end = typeof length === 'number' ? start + length : -1;
          if (end < 0 || end > this.src.length || this.src.slice(end, end + 30).indexOf('endstream') < 0) {
            end = this.src.indexOf('endstream', start);
            if (end < 0) end = this.src.length;
            while (end > start && /[\r\n]/.test(this.src[end - 1])) end--;
          }
          Object.defineProperty(value, '__stream', { value: [start, end] });
        } else lex.pos = save;
      }
    } else if (this.packed.has(num)) value = this.packed.get(num);
    this.cache.set(num, value);
    return value;
  }

  resolve(v) {
    for (let i = 0; v && typeof v === 'object' && v.ref !== undefined && i < 20; i++) v = this.get(v.ref);
    return v;
  }

  async data(stream) {
    if (!stream || !stream.__stream) return new Uint8Array(0);
    const [start, end] = stream.__stream;
    let bytes = Uint8Array.from(this.src.slice(start, end), c => c.charCodeAt(0));
    const filters = [].concat(this.resolve(stream.Filter) || []);
    for (const f of filters) {
      if (f === 'FlateDecode' || f === 'Fl') bytes = await inflate(bytes);
      else if (f === 'ASCIIHexDecode' || f === 'AHx') {
        const hex = latin1(bytes).replace(/[^0-9a-f]/gi, '');
        bytes = Uint8Array.from(hex.match(/../g) || [], h => parseInt(h, 16));
      } else return new Uint8Array(0); // an image filter: no text in it
    }
    return bytes;
  }

  /** Objects packed inside object streams, where newer PDFs keep fonts and pages. */
  async unpack() {
    for (const num of this.offsets.keys()) {
      const obj = this.get(num);
      if (!obj || obj.Type !== 'ObjStm') continue;
      const text = latin1(await this.data(obj));
      const lex = new Lexer(text);
      const n = this.resolve(obj.N) || 0;
      const first = this.resolve(obj.First) || 0;
      const heads = [];
      for (let i = 0; i < n; i++) heads.push([lex.token(), lex.token()]);
      for (const [id, offset] of heads) {
        if (typeof id !== 'number' || this.offsets.has(id)) continue;
        this.packed.set(id, new Lexer(text, first + offset).value());
      }
    }
  }

  /** Page dictionaries in reading order, each with the resources it inherits. */
  pages() {
    const out = [];
    const all = [...this.offsets.keys(), ...this.packed.keys()];
    const catalog = all.map(n => this.get(n)).find(o => o && o.Type === 'Catalog');
    const walk = (node, resources, seen) => {
      node = this.resolve(node);
      if (!node || seen.has(node)) return;
      seen.add(node);
      const res = node.Resources ? this.resolve(node.Resources) : resources;
      if (node.Kids) for (const kid of this.resolve(node.Kids) || []) walk(kid, res, seen);
      else if (node.Contents !== undefined) out.push({ page: node, resources: res });
    };
    if (catalog) walk(catalog.Pages, null, new Set());
    if (!out.length) {
      for (const n of all.sort((a, b) => a - b)) {
        const o = this.get(n);
        if (o && o.Type === 'Page') out.push({ page: o, resources: this.resolve(o.Resources) });
      }
    }
    return out;
  }
}

/** What a font's codes stand for, and how wide each one is. */
async function fontReader(pdf, font, cache) {
  if (!font) return null;
  if (cache.has(font)) return cache.get(font);
  const map = new Map();
  let bytes = font.Subtype === 'Type0' ? 2 : 1;
  const cmapStream = pdf.resolve(font.ToUnicode);
  if (cmapStream && cmapStream.__stream) {
    const cmap = latin1(await pdf.data(cmapStream));
    const space = /begincodespacerange\s*<([0-9a-f]+)>/i.exec(cmap);
    if (space) bytes = Math.max(1, space[1].length / 2);
    const utf16 = hex => {
      const units = [];
      for (let i = 0; i + 4 <= hex.length; i += 4) units.push(parseInt(hex.slice(i, i + 4), 16));
      if (hex.length === 2) units.push(parseInt(hex, 16));
      return String.fromCharCode(...units);
    };
    for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const [, src, dst] of block[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]*)>/gi)) map.set(parseInt(src, 16), utf16(dst));
    }
    for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const [, lo, hi, dst] of block[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*(<[0-9a-f]*>|\[[^\]]*\])/gi)) {
        const a = parseInt(lo, 16);
        const b = Math.min(parseInt(hi, 16), a + 65535);
        if (dst[0] === '[') {
          const list = [...dst.matchAll(/<([0-9a-f]*)>/gi)].map(x => utf16(x[1]));
          for (let c = a; c <= b; c++) if (list[c - a] !== undefined) map.set(c, list[c - a]);
        } else {
          const base = dst.slice(1, -1);
          const head = base.slice(0, -4);
          const tail = parseInt(base.slice(-4) || '0', 16);
          for (let c = a; c <= b; c++) map.set(c, utf16(head + (tail + c - a).toString(16).padStart(4, '0')));
        }
      }
    }
  }
  // A simple font with no table: its own /Differences over its base encoding.
  const encoding = pdf.resolve(font.Encoding);
  const base = typeof encoding === 'string' ? encoding : encoding?.BaseEncoding;
  const simple = code => base === 'MacRomanEncoding' && code >= 128 ? MAC_ROMAN[code - 128]
    : base === 'StandardEncoding' && code === 0x27 ? '’'
      : base === 'StandardEncoding' && code === 0x60 ? '‘'
        : CP1252[code] || String.fromCharCode(code);
  const differences = {};
  if (encoding && Array.isArray(pdf.resolve(encoding.Differences))) {
    let code = 0;
    for (const item of pdf.resolve(encoding.Differences)) {
      if (typeof item === 'number') code = item;
      else if (typeof item === 'string') { const ch = glyphChar(item); if (ch !== null) differences[code] = ch; code++; }
    }
  }
  // Widths, in thousandths of the font size, to tell a gap from a space.
  const widths = new Map();
  let fallback = 500;
  if (font.Subtype === 'Type0') {
    const desc = pdf.resolve((pdf.resolve(font.DescendantFonts) || [])[0]);
    if (desc) {
      fallback = pdf.resolve(desc.DW) || 1000;
      const w = pdf.resolve(desc.W) || [];
      for (let i = 0; i < w.length;) {
        const first = pdf.resolve(w[i]);
        const next = pdf.resolve(w[i + 1]);
        if (Array.isArray(next)) { next.forEach((x, k) => widths.set(first + k, pdf.resolve(x))); i += 2; }
        else { for (let c = first; c <= next; c++) widths.set(c, pdf.resolve(w[i + 2])); i += 3; }
      }
    }
  } else {
    const first = pdf.resolve(font.FirstChar) || 0;
    (pdf.resolve(font.Widths) || []).forEach((x, k) => widths.set(first + k, pdf.resolve(x)));
  }
  const reader = {
    decode(str) {
      const out = [];
      for (let i = 0; i + bytes <= str.length; i += bytes) {
        let code = 0;
        for (let k = 0; k < bytes; k++) code = code * 256 + str.charCodeAt(i + k);
        let ch = map.get(code);
        if (ch === undefined) ch = differences[code];
        if (ch === undefined) ch = bytes === 1 ? simple(code) : '';
        out.push({ ch, width: widths.get(code) ?? fallback, space: bytes === 1 && code === 32 });
      }
      return out;
    }
  };
  cache.set(font, reader);
  return reader;
}

const multiply = ([a, b, c, d, e, f], [A, B, C, D, E, F]) =>
  [a * A + b * C, a * B + b * D, c * A + d * C, c * B + d * D, e * A + f * C + E, e * B + f * D + F];

/**
 * Run a page's drawing operators far enough to place its text: where each
 * run starts says whether it follows on, sits after a gap (a space) or begins
 * a new line.
 */
async function pageText(pdf, content, resources, state, depth = 0) {
  const lex = new Lexer(content);
  const fonts = pdf.resolve(resources?.Font) || {};
  const xobjects = pdf.resolve(resources?.XObject) || {};
  const stack = [];
  let tm = [1, 0, 0, 1, 0, 0];
  let tlm = [1, 0, 0, 1, 0, 0];
  let font = null;
  let size = 1;
  let tc = 0, tw = 0, th = 1, tl = 0;

  const moveTo = (tx, ty) => {
    tlm = [tlm[0], tlm[1], tlm[2], tlm[3], tlm[4] + tx * tlm[0] + ty * tlm[2], tlm[5] + tx * tlm[1] + ty * tlm[3]];
    tm = tlm.slice();
  };
  const advance = tx => { tm[4] += tx * tm[0]; tm[5] += tx * tm[1]; };
  const gstack = [];
  // Where the text is on the page: the text position through the drawing
  // transform, which Quartz moves for every line while each run starts at 0,0.
  const onPage = () => {
    const [a, b, c, d, e, f] = state.ctm;
    return [tm[4] * a + tm[5] * c + e, tm[4] * b + tm[5] * d + f];
  };
  const show = str => {
    if (!font) return;
    const glyphs = font.decode(str);
    const scale = Math.hypot(tm[0], tm[1]) * size * Math.hypot(state.ctm[0], state.ctm[1]) || 1;
    const [x, y] = onPage();
    if (state.y !== null) {
      if (Math.abs(y - state.y) > scale * 0.5) state.out.push('\n');
      else if (x - state.x > scale * 0.15) state.out.push(' ');
    }
    for (const g of glyphs) {
      state.out.push(g.ch);
      advance(((g.width / 1000) * size + tc + (g.space ? tw : 0)) * th);
    }
    [state.x, state.y] = onPage();
  };

  for (let tok = lex.token(); tok !== null; tok = lex.token()) {
    if (!(tok && tok.op !== undefined)) { stack.push(lex.value(tok)); continue; }
    const args = stack.splice(0);
    const n = i => Number(args[i]) || 0;
    switch (tok.op) {
      case 'q': gstack.push(state.ctm.slice()); break;
      case 'Q': if (gstack.length) state.ctm = gstack.pop(); break;
      case 'cm': state.ctm = multiply(args.slice(0, 6).map(Number), state.ctm); break;
      case 'BT': tm = [1, 0, 0, 1, 0, 0]; tlm = tm.slice(); break;
      case 'Tf': font = await fontReader(pdf, pdf.resolve(fonts[args[0]]), state.fonts); size = n(1) || 1; break;
      case 'Tc': tc = n(0); break;
      case 'Tw': tw = n(0); break;
      case 'Tz': th = n(0) / 100; break;
      case 'TL': tl = n(0); break;
      case 'Td': moveTo(n(0), n(1)); break;
      case 'TD': tl = -n(1); moveTo(n(0), n(1)); break;
      case 'Tm': tlm = args.slice(0, 6).map(Number); tm = tlm.slice(); break;
      case 'T*': moveTo(0, -tl); break;
      case 'Tj': if (args[0]?.s !== undefined) show(args[0].s); break;
      case "'": moveTo(0, -tl); if (args[0]?.s !== undefined) show(args[0].s); break;
      case '"': tw = n(0); tc = n(1); moveTo(0, -tl); if (args[2]?.s !== undefined) show(args[2].s); break;
      case 'TJ':
        for (const part of Array.isArray(args[0]) ? args[0] : []) {
          if (typeof part === 'number') advance((-part / 1000) * size * th);
          else if (part?.s !== undefined) show(part.s);
        }
        break;
      case 'Do': {
        const xo = pdf.resolve(xobjects[args[0]]);
        if (xo && xo.Subtype === 'Form' && depth < 5) {
          const saved = state.ctm;
          const matrix = pdf.resolve(xo.Matrix);
          if (Array.isArray(matrix) && matrix.length === 6) state.ctm = multiply(matrix.map(Number), saved);
          await pageText(pdf, latin1(await pdf.data(xo)), pdf.resolve(xo.Resources) || resources, state, depth + 1);
          state.ctm = saved;
        }
        break;
      }
      case 'ID': {
        // An inline image's bytes are not tokens: skip to its end.
        const end = content.slice(lex.pos).search(/\sEI(\s|$)/);
        lex.pos = end < 0 ? content.length : lex.pos + end + 3;
        break;
      }
      default: break;
    }
  }
}

async function pdfText(bytes) {
  const pdf = new Pdf(bytes);
  await pdf.unpack();
  const pages = [];
  const fonts = new Map();
  for (const { page, resources } of pdf.pages()) {
    const parts = [].concat(pdf.resolve(page.Contents) || []).map(c => pdf.resolve(c));
    let content = '';
    for (const part of parts) content += latin1(await pdf.data(part)) + '\n';
    const state = { out: [], x: 0, y: null, fonts, ctm: [1, 0, 0, 1, 0, 0] };
    await pageText(pdf, content, resources, state);
    pages.push(state.out.join(''));
  }
  return pages.join('\n\n');
}
