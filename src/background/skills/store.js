/**
 * Site skill persistence and timing records.
 *
 * Every run updates the timing stats for the form it ran on. A run slower than
 * the configured threshold is flagged, which is what surfaces it in the Skills
 * tab of Options: the point is that a slow site is visible, so its mappings can
 * be corrected by hand and the next run on that site takes the fast route.
 */

import { getSkills, saveSkills, getSettings } from '../storage.js';
import { learnFromRun, exportSkill, importSkill } from './matcher.js';

export function blankSkill(site) {
  return {
    site,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    notes: '',
    fields: {},
    forms: {},
    stats: { runs: 0, totalMs: 0, lastRunMs: 0, fastestMs: null, modelCalls: 0 }
  };
}

export async function getSkill(site) {
  const skills = await getSkills();
  return skills[site] || null;
}

export async function putSkill(site, skill) {
  const skills = await getSkills();
  skills[site] = { ...skill, site, updatedAt: Date.now() };
  await saveSkills(skills);
  return skills[site];
}

export async function deleteSkill(site) {
  const skills = await getSkills();
  delete skills[site];
  await saveSkills(skills);
}

/** Package one site's skill for sharing. */
export async function shareSkill(site) {
  const skill = await getSkill(site);
  if (!skill) throw new Error(`Nothing is saved for ${site}.`);
  return exportSkill(skill);
}

/** Merge a shared skill in, keeping any local corrections. */
export async function adoptSkill(shared) {
  const skills = await getSkills();
  const { skill, added, kept } = importSkill(skills[shared?.site], shared);
  skills[skill.site] = skill;
  await saveSkills(skills);
  return { site: skill.site, added, kept };
}

/** Forget every site at once, for starting clean. */
export async function forgetAllSkills() {
  await saveSkills({});
  return true;
}

export async function listSkills() {
  const settings = await getSettings();
  const skills = await getSkills();
  return Object.values(skills)
    .map(skill => {
      const runs = skill.stats?.runs || 0;
      const avgMs = runs ? Math.round((skill.stats.totalMs || 0) / runs) : 0;
      const entries = Object.values(skill.fields || {});
      return {
        ...skill,
        fieldCount: entries.length,
        lockedCount: entries.filter(f => f.locked).length,
        // What the editor is for: fields the page offers that Applicator could
        // not place, and fields that failed the last time it tried.
        unresolvedCount: entries.filter(f => f.kind === 'unresolved').length,
        failingCount: entries.filter(f => f.lastOutcome === 'empty').length,
        sharedCount: entries.filter(f => f.shared).length,
        avgMs,
        // Flagged so the Skills tab can show which sites are worth correcting.
        slow: avgMs > settings.slowRunThresholdMs
      };
    })
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/**
 * Record one completed run against a site, folding in what was learned.
 */
export async function recordRun(site, {
  fingerprint,
  durationMs,
  fieldCount,
  modelCalls,
  observations
}) {
  const settings = await getSettings();
  const skills = await getSkills();
  const existing = skills[site] || blankSkill(site);

  const learned = settings.learnSkills
    ? learnFromRun(existing, observations)
    : existing;

  const stats = learned.stats || { runs: 0, totalMs: 0, modelCalls: 0 };
  stats.runs = (stats.runs || 0) + 1;
  stats.totalMs = (stats.totalMs || 0) + durationMs;
  stats.lastRunMs = durationMs;
  stats.modelCalls = (stats.modelCalls || 0) + (modelCalls || 0);
  stats.fastestMs = stats.fastestMs == null ? durationMs : Math.min(stats.fastestMs, durationMs);

  const forms = { ...(learned.forms || {}) };
  const prevForm = forms[fingerprint] || { seen: 0, totalMs: 0 };
  forms[fingerprint] = {
    seen: prevForm.seen + 1,
    totalMs: prevForm.totalMs + durationMs,
    lastMs: durationMs,
    avgMs: Math.round((prevForm.totalMs + durationMs) / (prevForm.seen + 1)),
    fieldCount,
    lastSeen: Date.now()
  };

  skills[site] = { ...learned, site, stats, forms, updatedAt: Date.now() };
  await saveSkills(skills);
  return skills[site];
}
