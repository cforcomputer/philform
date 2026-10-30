/**
 * Completions.
 *
 * A *form completion* is one successful fill of one form on one page. The
 * rules for counting one:
 *
 *   - A run that fills nothing never counts.
 *   - Re-running on the same form within REPEAT_WINDOW_MS counts once, so
 *     correcting the profile and trying again does not add to the time saved.
 *   - A run that fails never counts.
 *
 * This ledger counts completions (the history, "filled this month", and
 * which fills add to the time saved). Money is the wallet's business:
 * src/background/billing.js charges each fill by what it used.
 */

import { getUsage, saveUsage } from './storage.js';

const REPEAT_WINDOW_MS = 30 * 60 * 1000;

function monthKey(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Has this exact form been charged recently? `formId` is the site + form
 * fingerprint produced by the extractor, so a page with two distinct forms
 * bills twice and a retry of one form bills once.
 */
export async function isRepeat(formId) {
  const usage = await getUsage();
  const cutoff = Date.now() - REPEAT_WINDOW_MS;
  return (usage.recent || []).some(r => r.formId === formId && r.at > cutoff);
}

/** Record one completion. Returns the updated ledger. */
export async function chargeCompletion({ formId, site, fieldsFilled }) {
  const usage = await getUsage();
  const repeat = await isRepeat(formId);

  const entry = { formId, site, fieldsFilled, at: Date.now(), charged: !repeat };
  usage.recent = [entry, ...(usage.recent || [])].slice(0, 200);

  if (!repeat) {
    usage.completions = (usage.completions || 0) + 1;
    const mk = monthKey();
    usage.byMonth = usage.byMonth || {};
    usage.byMonth[mk] = (usage.byMonth[mk] || 0) + 1;
  }

  await saveUsage(usage);
  return { usage, charged: !repeat };
}

export async function usageSummary() {
  const usage = await getUsage();
  return {
    completions: usage.completions || 0,
    thisMonth: (usage.byMonth || {})[monthKey()] || 0,
    recent: (usage.recent || []).slice(0, 20)
  };
}
