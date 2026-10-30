/**
 * The rules pack the extension runs with: the built-in one
 * (common/rules-default.js) under the latest fetched from philform's service
 * (`GET /v1/rules`), kept in storage. Fetched at most every few hours, with
 * the service's ETag, and never waited for longer than a moment: a fill
 * starts with what is here. A fetched pack that does not parse is ignored.
 *
 * Fetching from philform's own service needs no permission the store build
 * lacks: it is the address fills already go through. The pack is data
 * (patterns, selectors, waits, rules), never code.
 */

import { getSettings } from './storage.js';
import { DEFAULT_RULES_PACK } from '../common/rules-default.js';
import { compilePack, mergeRaw, setActivePack, setActivePlatform, activePack_ } from '../common/rulespack.js';
import { setExtraRules } from './heuristics.js';

const KEY = 'rulesPack';
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 2500;

let loaded = null;

/** The compiled pack in force, from storage over the built-in one. */
export async function loadRulesPack() {
  if (loaded) return loaded;
  let stored = null;
  try {
    stored = (await chrome.storage.local.get(KEY))[KEY] || null;
  } catch { /* storage unavailable: the built-in pack */ }
  loaded = compilePack(mergeRaw(DEFAULT_RULES_PACK, stored?.raw));
  setActivePack(loaded);
  return loaded;
}

/**
 * Fetch a newer pack when the stored one is stale. Returns true when a new
 * pack was taken. Quietly does nothing offline or with the service away.
 */
export async function refreshRulesPack(settings) {
  settings = settings || await getSettings();
  const base = String(settings.proxyUrl || '').replace(/\/$/, '');
  if (!/^https?:/.test(base)) return false;
  let stored = null;
  try {
    stored = (await chrome.storage.local.get(KEY))[KEY] || null;
  } catch {
    return false;
  }
  if (stored?.fetchedAt && Date.now() - stored.fetchedAt < MAX_AGE_MS) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/v1/rules`, {
      headers: stored?.etag ? { 'if-none-match': stored.etag } : {},
      signal: controller.signal
    });
    if (res.status === 304) {
      await chrome.storage.local.set({ [KEY]: { ...stored, fetchedAt: Date.now() } });
      return false;
    }
    if (!res.ok) return false;
    const raw = await res.json();
    if (!raw || typeof raw !== 'object' || !raw.version) return false;
    await chrome.storage.local.set({ [KEY]: { raw, etag: res.headers.get('etag') || '', fetchedAt: Date.now() } });
    loaded = null;
    await loadRulesPack();
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Put one platform's rules in force for the fill under way, in the engine and the label rules. */
export function usePlatform(platformId) {
  const rules = setActivePlatform(platformId);
  setExtraRules(rules.rules);
  return rules;
}

/** The pack's version, for the popup and reports. */
export function rulesVersion() {
  return (loaded || activePack_()).version;
}
