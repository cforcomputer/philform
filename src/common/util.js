/** Small shared helpers. No DOM assumptions; safe in a service worker. */

/** FNV-1a 32-bit hash, rendered as 8 hex chars. Stable across sessions. */
export function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Collapse whitespace and lowercase, for label comparison. */
export function normalize(text) {
  return String(text || '')
    .replace(/[ ​]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Strip the trailing "*" / "(required)" noise from a visible label. */
export function cleanLabel(text) {
  return String(text || '')
    .replace(/[ ​]/g, ' ')
    .replace(/\*+/g, ' ')
    .replace(/\(\s*(required|optional)\s*\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Registrable-ish site key for a URL: the hostname without a leading www. */
// Second-level names under which a site is registered one label deeper.
const SHARED_SECOND_LEVEL = /^(co|com|net|org|gov|edu|ac|ne|or)\.[a-z]{2}$/;

/**
 * The site an origin belongs to: its registrable domain ("greenhouse.io" for
 * https://job-boards.greenhouse.io). An embed often redirects within its site
 * (boards.greenhouse.io to job-boards.greenhouse.io), so access is granted
 * and checked by site rather than by exact origin.
 */
export function siteOf(origin) {
  const host = String(origin || '').replace(/^[a-z]+:\/\//i, '').replace(/[:/].*$/, '').toLowerCase();
  if (!host || /^[\d.]+$/.test(host) || host.startsWith('[') || !host.includes('.')) return host;
  const labels = host.split('.');
  const take = SHARED_SECOND_LEVEL.test(labels.slice(-2).join('.')) ? 3 : 2;
  return labels.slice(-take).join('.');
}

/** The permission pattern covering an origin's whole site. */
export function sitePattern(origin) {
  const scheme = /^http:/i.test(origin) ? 'http' : 'https';
  const site = siteOf(origin);
  // An address or a bare host name has no subdomains to cover.
  return /^[\d.]+$/.test(site) || site.startsWith('[') || !site.includes('.')
    ? `${String(origin).replace(/\/$/, '')}/*`
    : `${scheme}://*.${site}/*`;
}

export function siteKey(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    // URL is missing in some minimal JavaScript hosts, and a malformed string
    // reaches here too. A skill keyed on a hostname is better than one keyed
    // on "unknown", which would pool every site into a single skill.
    const match = String(url || '').match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i);
    if (!match) return 'unknown';
    return match[1].replace(/^[^@]*@/, '').replace(/:\d+$/, '').replace(/^www\./, '').toLowerCase();
  }
}

/** Token overlap score in [0,1] between two short strings. */
export function similarity(a, b) {
  const ta = new Set(normalize(a).split(/[^a-z0-9]+/).filter(Boolean));
  const tb = new Set(normalize(b).split(/[^a-z0-9]+/).filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.max(ta.size, tb.size);
}

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/** Truncate a string to `n` characters, appending an ellipsis marker. */
export function truncate(str, n) {
  const s = String(str ?? '');
  return s.length <= n ? s : s.slice(0, n) + '...';
}

/** Parse JSON that a model may have wrapped in prose or a code fence. */
export function parseLooseJson(text) {
  if (typeof text !== 'string') throw new Error('Expected a string to parse');
  const trimmed = text.trim();
  const attempts = [trimmed];

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) attempts.push(fence[1].trim());

  const firstBrace = trimmed.search(/[[{]/);
  if (firstBrace >= 0) {
    const lastBrace = Math.max(trimmed.lastIndexOf(']'), trimmed.lastIndexOf('}'));
    if (lastBrace > firstBrace) attempts.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  let lastErr;
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`Model did not return valid JSON: ${lastErr?.message || 'unknown parse error'}`);
}

/** Promise that rejects after `ms`, for racing against a fetch. */
export function timeout(ms, label = 'operation') {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms)
  );
}

export function nowIso() {
  return new Date().toISOString();
}

/** Format a duration in ms as a short human string. */
export function formatMs(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * The questions a page asks, as a short list of labels: Workday keeps one
 * address for every step of an application, so the popup tells a new step
 * from the page it filled by what it asks.
 */
export function pageQuestions(fields) {
  return [...new Set((fields || []).map(f => normalize(f.label || f.ariaLabel || f.name || '').slice(0, 60)).filter(Boolean))].slice(0, 30);
}

/** Whether two lists of questions are the same page: most of the first still asked. */
export function sameQuestions(before, now) {
  if (!before?.length || !now?.length) return true;
  const here = new Set(now);
  return before.filter(q => here.has(q)).length >= before.length / 2;
}
