/**
 * Site skill matching.
 *
 * A "skill" is what Applicator learned about one site. Skills are keyed by
 * hostname rather than by individual form, because applicant tracking systems
 * reuse the same field names across every posting they host: a mapping learned
 * on one Greenhouse job applies to the next one. Per-form records are kept only
 * for timing, so a slow form can be found and corrected later.
 *
 * A field's identity within a skill is `fieldKey`: a hash of its name, its
 * visible label and its control type. That survives a page reload, a different
 * job posting and most template changes, while still distinguishing two fields
 * that merely look similar.
 */

import { hash, normalize } from '../../common/util.js';
import { matchField } from '../heuristics.js';

/** Stable identity for one form control across visits to a site. */
export function fieldKey(field) {
  const parts = [
    normalize(field.name || field.idAttr || ''),
    // The extractor's own reading, stable from run to run (structure.js may relabel).
    normalize((field.extractedLabel ?? field.label) || field.ariaLabel || field.placeholder || ''),
    field.tag || '',
    field.type || ''
  ];
  return hash(parts.join('|'));
}

/** Coarse identity for a whole form, used for timing records and billing. */
export function formFingerprint(site, fields) {
  const keys = fields.map(fieldKey).sort().join(',');
  return `${site}:${hash(keys)}`;
}

/**
 * Apply a saved skill to freshly extracted fields.
 *
 * Anything the skill already knows is answered here, with no model call. This
 * is the "fast route" - on a site visited before, a run can finish without
 * touching the network at all.
 *
 * @returns {{known: Array, unknown: Array, skipped: Array, hits: number}}
 */
/** Where a learned mapping came from a keyword rule, not a model or the user. */
const RULE_MADE = new Set(['label', 'attribute', 'autocomplete']);

export function applySkill(skill, fields) {
  const known = [];
  const unknown = [];
  const skipped = [];

  for (const field of fields) {
    const key = fieldKey(field);
    const entry = skill?.fields?.[key];

    if (!entry) {
      unknown.push({ ...field, fieldKey: key });
      continue;
    }

    if (entry.kind === 'skip') {
      skipped.push({ ...field, fieldKey: key, reason: entry.note || 'Skipped by site skill' });
      continue;
    }

    if (entry.kind === 'long') {
      // Written answers are regenerated every run - the question is the same
      // but the company and role are not - so the skill only records the style.
      unknown.push({ ...field, fieldKey: key, forceLong: true, styleNote: entry.note || '' });
      continue;
    }

    // A mapping first made by a keyword rule is only as good as that rule: once
    // the rule is fixed and no longer gives the key, the old answer must not
    // live on (Solcoa's story question kept a job's duties).
    if (entry.profileKey && RULE_MADE.has(entry.via) && matchField(field)?.key !== entry.profileKey) {
      unknown.push({ ...field, fieldKey: key });
      continue;
    }

    if (entry.profileKey) {
      known.push({
        ...field,
        fieldKey: key,
        profileKey: entry.profileKey,
        confidence: 0.95,
        via: 'skill',
        locked: !!entry.locked,
        note: entry.note || ''
      });
    } else {
      unknown.push({ ...field, fieldKey: key });
    }
  }

  return { known, unknown, skipped, hits: known.length };
}

/**
 * Fold the outcome of a run back into the skill.
 *
 * Every field the page offered is recorded, not only the ones that were
 * filled. A field Applicator could not place is exactly the one worth showing
 * in the editor, so recording only successes made the skill look mostly empty
 * and hid the fields that needed correcting.
 *
 * A mapping the user has edited is locked, and a run never overwrites it.
 *
 * @param {object} skill
 * @param {object[]} observations
 *   [{ fieldKey, label, kind, profileKey, via, ok, reason, section }]
 */
export function learnFromRun(skill, observations) {
  const next = {
    ...skill,
    fields: { ...(skill?.fields || {}) },
    updatedAt: Date.now()
  };

  for (const o of observations || []) {
    if (!o.fieldKey) continue;
    const prev = next.fields[o.fieldKey];

    // What the user corrected by hand stays; only the observed outcome moves.
    if (prev?.locked) {
      next.fields[o.fieldKey] = {
        ...prev,
        label: o.label || prev.label || '',
        section: o.section || prev.section || '',
        lastOutcome: o.ok ? 'filled' : 'empty',
        lastReason: o.ok ? '' : (o.reason || ''),
        lastSeen: Date.now()
      };
      continue;
    }

    next.fields[o.fieldKey] = {
      kind: o.kind || 'unresolved',
      profileKey: o.profileKey || null,
      label: o.label || prev?.label || '',
      section: o.section || prev?.section || '',
      note: prev?.note || '',
      locked: false,
      // A mapping reused from the skill keeps where it first came from.
      via: (o.via && o.via !== 'skill' ? o.via : prev?.via || o.via) || '',
      // Confirmations only count when the field was actually filled, so a
      // field that keeps failing never looks well established.
      confirms: (prev?.confirms || 0) + (o.ok ? 1 : 0),
      misses: (prev?.misses || 0) + (o.ok ? 0 : 1),
      lastOutcome: o.ok ? 'filled' : 'empty',
      lastReason: o.ok ? '' : (o.reason || ''),
      lastSeen: Date.now()
    };
  }

  return next;
}

/** A skill packaged for sharing: mappings only, no timings and no personal data. */
export function exportSkill(skill) {
  const fields = {};
  for (const [key, entry] of Object.entries(skill?.fields || {})) {
    // An unresolved field teaches nothing useful to someone else.
    if (entry.kind === 'unresolved') continue;
    fields[key] = {
      kind: entry.kind,
      profileKey: entry.profileKey || null,
      label: entry.label || '',
      section: entry.section || '',
      note: entry.note || ''
    };
  }
  return {
    application: 'applicator',
    kind: 'site-skill',
    version: 1,
    site: skill.site,
    exportedAt: new Date().toISOString(),
    fieldCount: Object.keys(fields).length,
    notes: skill.notes || '',
    fields
  };
}

/**
 * Merge a shared skill into whatever is already known about a site.
 *
 * A shared skill never overrides a local correction, because the person who
 * made that correction was looking at the form.
 */
export function importSkill(existing, shared) {
  if (shared?.kind !== 'site-skill' || !shared.site || typeof shared.fields !== 'object') {
    throw new Error('That file is not a philform site skill.');
  }

  const base = existing || { site: shared.site, createdAt: Date.now(), fields: {}, forms: {}, stats: {} };
  const fields = { ...(base.fields || {}) };
  let added = 0;
  let kept = 0;

  for (const [key, entry] of Object.entries(shared.fields)) {
    if (fields[key]?.locked) { kept++; continue; }
    fields[key] = {
      kind: entry.kind || 'profile',
      profileKey: entry.profileKey || null,
      label: entry.label || '',
      section: entry.section || '',
      note: entry.note || '',
      locked: false,
      shared: true,
      confirms: fields[key]?.confirms || 0,
      misses: fields[key]?.misses || 0
    };
    added++;
  }

  return {
    skill: { ...base, site: shared.site, fields, notes: base.notes || shared.notes || '', updatedAt: Date.now() },
    added,
    kept
  };
}
