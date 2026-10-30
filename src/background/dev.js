/**
 * Development hooks, inert in every build but the one tools/dev.py makes.
 *
 * tools/dev.py writes src/common/dev-config.js into its own build only. When
 * that file is absent, as in every package anyone else installs, `devConfig()`
 * returns null and nothing here runs. When present it holds:
 *
 *   reportUrl  where the dev server receives a report of each fill
 *   build      which rebuild this is, so a report names the code that made it
 *   seed       an exported profile and settings, loaded into an empty profile
 *   mode       'proxy' (philform's service, as a store build) or 'direct' (own keys),
 *              applied on every start, whatever the profile saved
 */

import { runInFrames, extractAll } from './frames.js';
import { compactField } from './trace.js';

let loaded;

export async function devConfig() {
  if (loaded === undefined) {
    try {
      ({ DEV_CONFIG: loaded } = await import('../common/dev-config.js'));
    } catch {
      loaded = null;
    }
  }
  return loaded || null;
}

const MAX_HTML = 3_000_000;

/** The HTML of every reachable frame, as the page is right now. */
export async function pageSnapshot(tabId) {
  try {
    const frames = await runInFrames(tabId, () => ({
      url: location.href,
      html: document.documentElement.outerHTML
    }));
    return frames.map(({ frameId, result }) => ({
      frameId,
      url: result.url,
      html: String(result.html || '').slice(0, MAX_HTML)
    }));
  } catch (err) {
    return [{ error: err?.message || String(err) }];
  }
}

/** The visible part of the tab, as a PNG data URL, or null when not allowed. */
async function screenshot(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } catch {
    return null;
  }
}

/**
 * Send one run to the dev server: the outcome, the trace, the page after the
 * fill, what every field shows now, and a screenshot. Never throws; a dev
 * server that is not listening must not break a fill.
 */
export async function reportRun({ tabId, url, summary, error, trace }) {
  const dev = await devConfig();
  if (!dev?.reportUrl) return;
  try {
    let readback = [];
    try {
      readback = (await extractAll(tabId, { context: true })).fields.map(f => ({ ...compactField(f), context: f.context || '' }));
    } catch (err) {
      readback = [{ error: err?.message || String(err) }];
    }
    let page = {};
    try {
      const tab = await chrome.tabs.get(tabId);
      page = { title: tab.title || '' };
    } catch { /* tab gone */ }
    const report = {
      build: dev.build || null,
      url,
      page,
      reportedAt: new Date().toISOString(),
      summary: summary || null,
      error: error || null,
      trace,
      readback,
      after: await pageSnapshot(tabId),
      screenshot: await screenshot(tabId)
    };
    // Plain text keeps the request "simple", so a local server needs no
    // preflight handling.
    await fetch(dev.reportUrl, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(report) });
  } catch {
    /* dev server not running */
  }
}
