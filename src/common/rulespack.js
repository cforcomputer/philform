/**
 * The rules pack, compiled and in use (see rules-default.js for what it holds).
 *
 * Pure: no chrome.*, no DOM, so the logic tests and the service can load it.
 * The extension's copy of the fetched pack is kept by background/rules.js;
 * this module compiles a raw pack (regex strings to RegExp, bad entries
 * dropped), merges a fetched pack over the built-in one, says which platform
 * a page runs on, and holds the rules in force for the fill under way, which
 * the engine reads through activeRules().
 */

import { DEFAULT_RULES_PACK } from './rules-default.js';

const SUPPORT = ['full', 'partial', 'new'];

/** "/source/flags" to a RegExp; a RegExp as it is; anything else null. */
export function parseRegex(text) {
  if (text instanceof RegExp) return text;
  const m = String(text || '').match(/^\/([\s\S]+)\/([a-z]*)$/);
  if (!m) return null;
  try {
    return new RegExp(m[1], m[2].replace(/[^imsu]/g, ''));
  } catch {
    return null;
  }
}

/** A RegExp back to the pack's string form, for content scripts. */
export function regexString(re) {
  return re instanceof RegExp ? `/${re.source}/${re.flags}` : (typeof re === 'string' ? re : '');
}

function compileRule(x) {
  if (!x || typeof x !== 'object' || !x.key) return null;
  const out = { key: String(x.key) };
  for (const k of ['attr', 'label', 'not', 'options']) {
    const re = x[k] && parseRegex(x[k]);
    if (re) out[k] = re;
  }
  if (x.toggle) out.toggle = true;
  if (x.short) out.short = true;
  return out.attr || out.label ? out : null;
}

function compilePatterns(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw || {})) {
    if (v && typeof v === 'object') {
      out[k] = {};
      for (const [k2, v2] of Object.entries(v)) {
        const re = parseRegex(v2);
        if (re) out[k][k2] = re;
      }
    } else {
      const re = parseRegex(v);
      if (re) out[k] = re;
    }
  }
  return out;
}

/** Named CSS selectors: non-empty strings only. */
function selectorsOf(raw) {
  return Object.fromEntries(Object.entries(raw || {}).filter(([, v]) => typeof v === 'string' && v.trim()));
}

/** A raw pack (strings) compiled: regexes as RegExp, unusable entries dropped. */
export function compilePack(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const platforms = (Array.isArray(r.platforms) ? r.platforms : []).filter(p => p && p.id).map(p => ({
    id: String(p.id),
    name: String(p.name || p.id),
    support: SUPPORT.includes(p.support) ? p.support : 'new',
    hosts: (p.hosts || []).map(parseRegex).filter(Boolean),
    markers: (p.markers || []).filter(s => typeof s === 'string' && s.trim()),
    note: String(p.note || '')
  }));
  const overrides = {};
  for (const [id, o] of Object.entries(r.overrides || {})) {
    if (!o || typeof o !== 'object') continue;
    overrides[id] = {
      rules: (Array.isArray(o.rules) ? o.rules : []).map(compileRule).filter(Boolean),
      patterns: compilePatterns(o.patterns),
      selectors: selectorsOf(o.selectors),
      sections: { ...(o.sections || {}) },
      dropdowns: { ...(o.dropdowns || {}) }
    };
  }
  return {
    version: String(r.version || ''),
    platforms,
    rules: (Array.isArray(r.rules) ? r.rules : []).map(compileRule).filter(Boolean),
    patterns: compilePatterns(r.patterns),
    selectors: selectorsOf(r.selectors),
    sections: { ...(r.sections || {}) },
    dropdowns: { ...(r.dropdowns || {}) },
    overrides
  };
}

/**
 * A fetched raw pack over the built-in raw one. The fetched pack's rules
 * come first (they win); its platforms replace the list when it gives one;
 * patterns, sections and dropdowns are merged one level deep; a platform's
 * overrides merge the same way.
 */
export function mergeRaw(base, remote) {
  if (!remote || typeof remote !== 'object') return base;
  const deep = (a, b) => {
    const out = { ...(a || {}) };
    for (const [k, v] of Object.entries(b || {})) {
      out[k] = v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' ? { ...out[k], ...v } : v;
    }
    return out;
  };
  const overrides = { ...(base.overrides || {}) };
  for (const [id, o] of Object.entries(remote.overrides || {})) {
    const b = overrides[id] || {};
    overrides[id] = {
      ...b, ...o,
      rules: [...(Array.isArray(o.rules) ? o.rules : []), ...(Array.isArray(b.rules) ? b.rules : [])],
      patterns: deep(b.patterns, o.patterns),
      selectors: { ...(b.selectors || {}), ...(o.selectors || {}) },
      sections: { ...(b.sections || {}), ...(o.sections || {}) },
      dropdowns: { ...(b.dropdowns || {}), ...(o.dropdowns || {}) }
    };
  }
  return {
    ...base,
    version: remote.version || base.version,
    platforms: Array.isArray(remote.platforms) && remote.platforms.length ? remote.platforms : base.platforms,
    rules: [...(Array.isArray(remote.rules) ? remote.rules : []), ...(Array.isArray(base.rules) ? base.rules : [])],
    patterns: deep(base.patterns, remote.patterns),
    selectors: { ...(base.selectors || {}), ...(remote.selectors || {}) },
    sections: { ...(base.sections || {}), ...(remote.sections || {}) },
    dropdowns: { ...(base.dropdowns || {}), ...(remote.dropdowns || {}) },
    overrides
  };
}

/** The hostname of a URL, or '' . */
export function hostnameOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * The platform a page runs on: by hostname first, then by the markers the
 * page was found to hold (platformMarkers from a read). Null when unknown.
 */
export function detectPlatform(pack, { hostname = '', markers = [] } = {}) {
  const host = String(hostname || '').toLowerCase();
  if (host) {
    const byHost = pack.platforms.find(p => p.hosts.some(re => re.test(host)));
    if (byHost) return byHost;
  }
  if (markers?.length) {
    const byMarker = pack.platforms.find(p => p.markers.some(m => markers.includes(m)));
    if (byMarker) return byMarker;
  }
  return null;
}

/** Every platform's markers, for a page to test: [{ id, selector }]. */
export function markerList(pack) {
  return pack.platforms.flatMap(p => p.markers.map(selector => ({ id: p.id, selector })));
}

/** The rules in force on one platform: its overrides first, then the pack's own. */
export function platformRules(pack, platformId) {
  const o = (platformId && pack.overrides[platformId]) || null;
  const patterns = { ...pack.patterns };
  for (const [k, v] of Object.entries(o?.patterns || {})) {
    patterns[k] = v instanceof RegExp || !patterns[k] || !(patterns[k] instanceof Object) ? v : { ...patterns[k], ...v };
  }
  return {
    platform: platformId || null,
    rules: [...(o?.rules || []), ...pack.rules],
    patterns,
    selectors: { ...pack.selectors, ...(o?.selectors || {}) },
    sections: { ...pack.sections, ...(o?.sections || {}) },
    dropdowns: { ...pack.dropdowns, ...(o?.dropdowns || {}) }
  };
}

/** What a content script needs, as plain data it can carry as an argument. */
export function contentRules(pack, rules) {
  return {
    emptyChoice: regexString(rules.patterns.emptyChoice),
    genericLabel: regexString(rules.patterns.genericLabel),
    iconGlyph: regexString(rules.patterns.iconGlyph),
    pageComplaint: regexString(rules.patterns.pageComplaint),
    questionTitle: regexString(rules.patterns.questionTitle),
    selectors: rules.selectors,
    sections: rules.sections,
    namedListWaitMs: Number(rules.dropdowns.namedListWaitMs) || 1000,
    markers: markerList(pack)
  };
}

/**
 * How well phil can be expected to do here, for the popup: a platform's
 * support level, else what was learned on the site, else new.
 */
export function supportLevel(platform, skill) {
  const learned = skill ? Object.keys(skill.fields || {}).length : 0;
  if (platform?.support === 'full') return { level: 'full', text: `Works well on ${platform.name}` };
  if (platform?.support === 'partial') return { level: 'partial', text: `Partly supported on ${platform.name}: check every answer` };
  if (learned) return { level: 'seen', text: `Seen before: ${learned} ${learned === 1 ? 'answer' : 'answers'} learned on this site` };
  if (platform) return { level: 'new', text: `New to phil: ${platform.name} pages are not tuned yet` };
  return { level: 'new', text: 'New to phil: never seen this site' };
}

// --- the rules in force ----------------------------------------------------------

let activePack = compilePack(DEFAULT_RULES_PACK);
let active = platformRules(activePack, null);

/** The compiled pack in use (the built-in one until background/rules.js loads a fetched one). */
export function activePack_() {
  return activePack;
}

export function setActivePack(pack) {
  activePack = pack;
  active = platformRules(pack, active.platform);
  return active;
}

/** Put a platform's rules in force for the fill under way. */
export function setActivePlatform(platformId) {
  active = platformRules(activePack, platformId);
  return active;
}

/** The rules the engine reads: { platform, rules, patterns, selectors, sections, dropdowns }. */
export function activeRules() {
  return active;
}

/** A named pattern in force, or a pattern that matches nothing. */
export function pattern(name, sub) {
  const p = active.patterns[name];
  const re = sub ? p?.[sub] : p;
  return re instanceof RegExp ? re : /$^/;
}
