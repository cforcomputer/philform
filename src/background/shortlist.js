/**
 * The options offered to TypeSafe for one field: every profile key that holds
 * a value, most plausible first.
 *
 * An earlier version cut this to the fifteen best-ranked keys to save input
 * tokens. That saved about half a tenth of a cent per form and cost recall:
 * the ranking is string similarity, and a key it ranked sixteenth could not be
 * chosen at all. TypeSafe's guidance is to offer the full list (up to 255
 * options, a few tokens each), so the list is now capped only by that ceiling.
 * The ranking still decides the order, and which keys survive if a profile
 * ever grows past the ceiling.
 */

import { normalize, similarity } from '../common/util.js';
import { DEMOGRAPHIC_KEYS, profileValue, allFields, fieldDef } from '../common/schema.js';
import { matchField } from './heuristics.js';
import { MAX_OPTIONS } from './llm/typesafe.js';

/** Two options are reserved for the escapes below. */
export const SHORTLIST_SIZE = MAX_OPTIONS - 2;

/** Option keys that are not profile fields but must always be offered. */
export const WRITTEN = '__written__';
export const NONE = '__none__';

/** How strongly a profile field is worth offering for this form field. */
function affinity(field, profileField) {
  const label = field.label || field.ariaLabel || field.placeholder || '';
  const attrs = [field.name, field.idAttr, field.dataAttr].filter(Boolean).join(' ');
  const tail = profileField.key.split('.').pop();

  return Math.max(
    similarity(label, profileField.label),
    similarity(label, tail),
    similarity(attrs, profileField.label) * 0.9,
    similarity(attrs, tail) * 0.9,
    // Fields in the same area of a form tend to want neighbouring keys.
    normalize(field.section).includes(normalize(profileField.section)) ? 0.25 : 0,
    // A field inside an employer block wants that job's keys offered first.
    field.scope === 'employment' && profileField.section === 'employment' ? 0.5 : 0
  );
}

/**
 * Build the option list for one field.
 *
 * @param {object} field                  Extracted field descriptor.
 * @param {object} options
 * @param {string[]} options.availableKeys Profile keys that actually hold a value.
 * @param {boolean} options.allowSensitive Offer demographic keys.
 * @param {number} [options.size]
 * @returns {string[]} Profile keys, most plausible first.
 */
export function shortlistFor(field, { availableKeys, allowSensitive = false, size = SHORTLIST_SIZE, profile = null }) {
  const available = new Set(availableKeys);

  const candidates = allFields(profile).filter(f => {
    if (f.section === 'documents') return false;
    if (!available.has(f.key)) return false;
    if (DEMOGRAPHIC_KEYS.has(f.key) && !allowSensitive) return false;
    return true;
  });

  const ranked = candidates
    .map(f => ({ key: f.key, score: affinity(field, f) }))
    .sort((a, b) => b.score - a.score)
    .map(c => c.key);

  const picked = ranked.slice(0, size);

  // The local matcher's guess is authoritative about plausibility even when the
  // token overlap that drives the ranking is weak, so it is never dropped.
  // It is still subject to every filter above: a guess must not be a way to
  // smuggle a demographic key past a user who switched demographics off.
  const hint = field.hint || matchField(field)?.key;
  const hintAllowed = hint &&
    available.has(hint) &&
    fieldDef(hint, profile) &&
    fieldDef(hint, profile).section !== 'documents' &&
    (allowSensitive || !DEMOGRAPHIC_KEYS.has(hint));

  if (hintAllowed && !picked.includes(hint)) {
    if (picked.length >= size) picked.pop();
    picked.unshift(hint);
  }

  return picked;
}

/**
 * Where two saved values are easy to confuse, the boundary between them,
 * written as TypeSafe's structured option guidance: what an option is not for
 * sharpens the choice more than a longer description of what it is.
 */
const NOT_FOR = {
  'authorization.authorizedToWork': 'Questions about needing visa sponsorship; answer those with the sponsorship value',
  'authorization.requiresSponsorship': 'Questions about being authorized or eligible to work; those have the opposite meaning',
  'authorization.visaStatus': 'Yes/no questions about authorization or sponsorship',
  'authorization.citizenship': 'Whether the candidate is authorized to work or needs sponsorship; being authorized is not being a citizen',
  'identity.fullName': 'The name of an employer, school, supervisor, reference or emergency contact',
  'identity.firstName': 'The first name of a supervisor, reference or emergency contact',
  'identity.lastName': 'The last name of a supervisor, reference or emergency contact',
  'contact.phone': 'The phone number of an employer, supervisor, reference or emergency contact',
  'contact.email': 'The email of a supervisor, reference or emergency contact',
  'address.line1': 'The address of an employer or school',
  'address.city': 'The city of an employer or school, or where the job is located',
  'address.location': 'A street address, or the location of an employer, school or the job itself',
  'address.state': 'The state of an employer or school',
  'address.country': 'The country of an employer or school, or a phone country code',
  'work.currentCompany': 'An employer block for a past job other than the most recent one',
  'work.currentTitle': 'The title of the job being applied for',
  'preferences.howHeard': 'The name of the person who referred the candidate',
  'preferences.referredBy': 'Where or how the candidate heard about the job (a website or source)',
  'preferences.previouslyEmployed': 'Whether a relative works for the employer',
  'screening.relatedToEmployee': 'Whether the candidate worked for the employer before',
  'preferences.availableStartDate': 'Start or end dates of a past job or school',
  'employment.startDate': 'The date the candidate could start the new job',
  'preferences.agreeToTerms': 'A statement certifying that the application is true and complete, or an electronic signature'
};

/**
 * The criteria map for a Choice question: profile key to a description.
 *
 * The keys are readable ("contact.email"), and the state already holds each
 * key's label and saved value, so an option needs no description of its own
 * unless it is easy to confuse with another. Measured on the live benchmark,
 * repeating the label and saved value in every option cost 75% more input
 * tokens and gained nothing: 20 of 20 either way, with every answer at 0.92
 * confidence or above. A learned answer's key is an id, so it names its
 * question.
 */
export function criteriaFor(keys, profile) {
  const criteria = {};
  for (const key of keys) {
    const field = fieldDef(key, profile);
    if (!field) continue;
    if (field.custom) criteria[key] = { what: `The candidate's saved answer to "${field.label.slice(0, 160)}"` };
    else criteria[key] = NOT_FOR[key] ? { not_for: NOT_FOR[key] } : null;
  }
  criteria[WRITTEN] = 'An open-ended question that needs a written paragraph, not a stored value';
  criteria[NONE] = 'No saved value answers this field, the field asks for a password, payment detail, ' +
    'government identifier, passport number or date of birth, or it is about another person';
  return criteria;
}
