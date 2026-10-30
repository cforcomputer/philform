/**
 * A thumb up or down on a fill, from the popup.
 *
 * A thumb down keeps a full report in the extension's storage: the run's
 * summary and cost, the full trace (what was read, what TypeSafe was asked and
 * answered, what was decided and written), what every field shows now, the
 * page's HTML, and the user's own note. A development build also sends it to
 * tools/dev.py.
 *
 * That report holds the user's own profile values, as the page does, and
 * stays in the browser. What goes to philform's service (store builds, which
 * run through it) is only what is needed to find and reproduce a page that
 * filled badly: the page's address, the verdict and note, how many fields were
 * filled, the labels of the questions, never an answer.
 */

import { extractAll } from './frames.js';
import { compactField } from './trace.js';
import { devConfig, pageSnapshot } from './dev.js';
import { getSettings, saveIssue } from './storage.js';
import { siteKey } from '../common/util.js';

const MAX_HTML = 300_000;

/**
 * The last fill on each tab, for a report about it and for the popup to show
 * again when it is reopened. Kept in memory and in session storage, because
 * the background is unloaded when idle and the popup closes on every click
 * away. Forgotten when the tab loads a new page or closes.
 */
const lastRuns = new Map();
const runKey = tabId => `lastRun:${tabId}`;

export async function rememberRun(tabId, run) {
  const entry = { ...run, at: new Date().toISOString() };
  lastRuns.set(tabId, entry);
  // Only the latest few tabs matter.
  if (lastRuns.size > 10) lastRuns.delete(lastRuns.keys().next().value);
  const session = chrome.storage?.session;
  if (!session) return;
  try {
    await session.set({ [runKey(tabId)]: entry });
  } catch {
    // Over the session quota: the trace is the bulky part, keep the rest.
    await session.set({ [runKey(tabId)]: { ...entry, trace: null } }).catch(() => {});
  }
}

export async function lastRunFor(tabId) {
  if (lastRuns.has(tabId)) return lastRuns.get(tabId);
  const key = runKey(tabId);
  const stored = await chrome.storage?.session?.get(key).catch(() => null);
  return stored?.[key] || null;
}

export async function forgetRun(tabId) {
  lastRuns.delete(tabId);
  await chrome.storage?.session?.remove(runKey(tabId)).catch(() => {});
}

/**
 * `verdict` is 'up' or 'down'. A thumb down saves the full report here and
 * sends the slim one to the service; a thumb up sends the slim one only. A
 * call with the `id` of an earlier report adds the user's note to it.
 * Returns `{ id, saved, sent }`: whether the service took it.
 */
export async function reportIssue({ tabId, url, note, verdict = 'down', id }) {
  const run = await lastRunFor(tabId);
  const at = run?.url || url;
  if (id) {
    const sent = await sendToService({ id, verdict, url: at, site: siteKey(at || ''), note });
    return { id, saved: 0, sent };
  }
  const report = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    reportedAt: new Date().toISOString(),
    verdict,
    url: at,
    site: siteKey(at || ''),
    note: String(note || '').slice(0, 4000),
    summary: run?.summary || null,
    error: run?.error || null
  };
  let readback = [];
  let count = 0;
  if (verdict === 'down') {
    try {
      readback = (await extractAll(tabId, { context: true })).fields.map(f => ({ ...compactField(f), context: f.context || '' }));
    } catch (err) {
      readback = [{ error: err?.message || String(err) }];
    }
    const after = (await pageSnapshot(tabId)).map(f => ({ ...f, html: String(f.html || '').slice(0, MAX_HTML) }));
    const full = { ...report, trace: run?.trace || null, readback, after };
    count = await saveIssue(full);
    const dev = await devConfig();
    if (dev?.reportUrl) {
      try {
        await fetch(dev.reportUrl.replace(/\/report$/, '/issue'), {
          method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ ...full, build: dev.build || null })
        });
      } catch { /* dev server not running */ }
    }
  }
  const summary = run?.summary || {};
  const sent = await sendToService({
    id: report.id, verdict, url: at, site: report.site, note: report.note, platform: summary.platform || '',
    error: run?.error ? String(run.error.message || run.error).slice(0, 1000) : '',
    counts: Object.fromEntries(Object.entries(summary).filter(([, v]) => typeof v === 'number')),
    possiblyMissed: (summary.possiblyMissed || []).map(q => String(q?.label ?? q)),
    fields: readback.map(f => String(f.label || f.ariaLabel || f.placeholder || '')).filter(Boolean)
  });
  return { id: report.id, saved: count, sent };
}

/** The slim report, to philform's service when fills go through it. False when it could not be sent. */
async function sendToService(body) {
  const settings = await getSettings();
  if (settings.mode !== 'proxy' || !settings.proxyUrl || !settings.proxyToken || !/^https?:/.test(body.url || '')) return false;
  try {
    const res = await fetch(`${settings.proxyUrl.replace(/\/$/, '')}/v1/reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.proxyToken}` },
      body: JSON.stringify({ ...body, build: chrome.runtime?.getManifest?.().version || '', browser: /firefox/i.test(navigator.userAgent) ? 'firefox' : 'chrome' })
    });
    return res.ok;
  } catch {
    return false;
  }
}
