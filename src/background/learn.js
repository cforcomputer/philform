/**
 * Save answers from a form the user filled in by hand.
 *
 * On a new kind of form, the user answers what Applicator missed, then clicks
 * "Save my answers from this page". Every answer on the page that Applicator
 * does not already have becomes one item, shown as the page asked it, with
 * where it would be saved:
 *
 *   - a profile field Applicator knows ("Preferred contact method: Email"),
 *     or a replacement for one when the page shows something else than what
 *     is saved: the user corrected a fill, and the correction is offered;
 *   - one detail of a job, school or reference, merged into that entry
 *     ("Company phone" for the job at Acme), or a new entry;
 *   - otherwise a saved answer: the question in the form's own words and the
 *     user's answer. It is offered on every later form, so a similar question
 *     on another site finds it by meaning.
 *
 * Each item is saved on its own, when the user chooses it. Nothing here calls
 * a model: reading back a form the user filled is free.
 */

import { matchField, HEURISTIC_ACCEPT } from './heuristics.js';
import { scopeOf } from './scope.js';
import { placeInScope, normaliseRepeats, datePartFor, isDefinitelyEssay } from './orchestrator.js';
import {
  FIELD_BY_KEY, SENSITIVE_KEYS, LISTS, listEntries, blankEntry, profileValue, fieldDef, isIdentityQuestion
} from '../common/schema.js';
import { normalize } from '../common/util.js';

/** Boxes whose contents are about this one application, not about the user. */
const NOT_REUSABLE = /search|captcha|coupon|promo|referral code|job (id|code|number)|requisition/i;

/** The answer as the user sees it: the option text rather than its value. */
/** "Which shifts can you work?: Weekends" as its question and option, or null. */
function tickedOption(field) {
  const label = String(field.label || '');
  const at = label.lastIndexOf(': ');
  if (at < 8) return null;
  const question = label.slice(0, at).trim();
  const option = label.slice(at + 2).trim();
  return option && /\?|\b(which|select|choose|pick|apply)\b/i.test(question) ? { question, option } : null;
}

function answerOf(field) {
  if (field.type === 'checkbox') return field.currentValue ? 'yes' : '';
  if (field.type === 'radio') {
    const hit = (field.options || []).find(o => o.value === field.currentValue);
    return hit ? hit.label : String(field.currentValue || '');
  }
  if (field.tag === 'select') return field.currentText || '';
  return String(field.currentValue || '').trim();
}

/** "Full-Time" is the profile's "Full-time"; "Yes, I agree..." is "yes". */
function toProfileValue(def, answer) {
  if (!def) return answer;
  if (def.type === 'boolean') {
    const a = normalize(answer);
    if (/^(yes|y|true|i agree|i understand|i acknowledge|i accept|i can|i am|i do)\b/.test(a)) return 'yes';
    if (/^(no|n|false|i do not|i don't|i cannot|i can't|i am not)\b/.test(a)) return 'no';
    return '';
  }
  if (def.type === 'select' && def.choices) {
    const squash = x => normalize(x).replace(/[^a-z0-9]/g, '');
    return def.choices.find(c => squash(c) === squash(answer)) ||
      def.choices.find(c => squash(answer).startsWith(squash(c))) || answer;
  }
  return answer;
}

const LIST_OF_SCOPE = { employment: 'employment', supervisor: 'employment', education: 'education', reference: 'references' };
const NAME_PROP = { employment: 'company', education: 'school', references: 'fullName' };
const NOUN = { employment: 'job', education: 'school', references: 'reference' };

/**
 * Read a filled form back into proposals.
 *
 * @param {object} args
 * @param {object[]} args.fields   Extracted fields, with the user's values.
 * @param {object}   args.profile
 * @param {string}   args.site
 * @returns {object[]} proposals, each with a `title` and `detail` to show.
 */
export function proposeLearning({ fields, profile, site }) {
  const proposals = [];
  const blocks = new Map(); // `${list}:${index}` -> { list, index, values }
  const dateBits = new Map(); // `${block}:${prop}` -> { year, month }
  // Questions already answered; one kept as an empty reminder is still to learn.
  const customs = new Set((profile.custom || []).filter(c => String(c.answer ?? '').trim()).map(c => normalize(c.question)));

  const prepared = normaliseRepeats(fields).map(f => ({ ...f, scope: scopeOf(f).scope }));

  // Tick boxes labelled "Question: option" are one question: saved as the
  // question, answered with the options ticked, never as the option's text
  // answered "yes".
  const ticked = new Map(); // question -> { field, options }

  for (const field of prepared) {
    const asked = field.type === 'checkbox' ? tickedOption(field) : null;
    if (asked) {
      if (!ticked.has(asked.question)) ticked.set(asked.question, { field, options: [] });
      if (field.currentValue) ticked.get(asked.question).options.push(asked.option);
      continue;
    }
    // A box labelled only as an answer ("Yes, I identify as ..."), its
    // question not found: nothing to ask it by on another form.
    if (field.type === 'checkbox' && /^(yes|no)\b,?\s+\S/i.test(String(field.label || ''))) continue;
    const answer = answerOf(field);
    const question = String(field.label || field.ariaLabel || field.placeholder || '').trim();
    // A question of only "*" names nothing to match on another form.
    if (!answer || !/[a-z]/i.test(question) || NOT_REUSABLE.test(question)) continue;

    const match = matchField(field);
    const placed = match && match.confidence >= HEURISTIC_ACCEPT
      ? placeInScope({ ...field, profileKey: match.key })
      : null;
    const key = placed?.profileKey || null;
    const def = key ? FIELD_BY_KEY[key] : null;

    // Demographics are never learned from a page; the user sets them in settings.
    if (key && SENSITIVE_KEYS.has(key)) continue;

    // A detail of one job or school.
    const list = def?.repeating ? def.section : LIST_OF_SCOPE[field.scope];
    if (def?.repeating && LISTS[list]) {
      const prop = key.split('.')[1];
      const blockId = `${list}:${field.repeatIndex || 0}`;
      if (!blocks.has(blockId)) blocks.set(blockId, { list, values: {}, questions: {} });
      blocks.get(blockId).questions[prop] ||= question;
      // A reference's name asked in parts is kept whole, as it is saved.
      if (key === 'references.firstName' || key === 'references.lastName') {
        blocks.get(blockId)[prop] = answer.trim();
        continue;
      }
      if (def.inferredOnly) continue; // "This is my current employer" follows from the dates
      const part = datePartFor(field, key);
      if (part) {
        const bitId = `${blockId}:${prop}`;
        const bits = dateBits.get(bitId) || {};
        if (part === 'year' && /^(19|20)\d{2}$/.test(answer.trim())) bits.year = answer.trim();
        if (part === 'month') {
          const m = answer.match(/\d{1,2}/);
          if (m) bits.month = String(Number(m[0])).padStart(2, '0');
        }
        dateBits.set(bitId, bits);
        blocks.get(blockId).values[prop] = bits.year ? (bits.month ? `${bits.year}-${bits.month}` : bits.year) : '';
        continue;
      }
      blocks.get(blockId).values[prop] = toProfileValue(def, answer);
      continue;
    }
    // Inside a job or school block but not a known detail of one: specific to
    // that entry, so it is not saved as a general answer.
    if (LIST_OF_SCOPE[field.scope] && !key) continue;

    // A profile field Applicator knows: new, or a correction of what is saved.
    if (key && def && !def.inferredOnly) {
      const value = toProfileValue(def, answer);
      if (!value) continue;
      const saved = String(profileValue(profile, key) || '').trim();
      if (saved && same(saved, value)) continue;
      proposals.push({
        type: 'field', key, value, question, answer, replaces: saved || undefined,
        title: question, detail: answer, saveTo: def.label
      });
      continue;
    }
    if (key && fieldDef(key, profile)?.custom) continue; // already learned

    // Something new: keep the question and the answer. Written answers about
    // this particular employer ("why do you want to work here") are skipped.
    if (isDefinitelyEssay({ label: question }) || customs.has(normalize(question))) continue;
    // Nor identity answers ("Yes, I identify as LGBTQ+."): those are set in settings.
    if (isIdentityQuestion({ ...field, label: question })) continue;
    customs.add(normalize(question));
    proposals.push({ type: 'custom', question, answer, site, title: question, detail: answer, saveTo: 'A new saved answer' });
  }

  for (const [question, { field, options }] of ticked) {
    if (!options.length || NOT_REUSABLE.test(question) || customs.has(normalize(question))) continue;
    if (isIdentityQuestion({ ...field, label: question, options: options.map(label => ({ label })) })) continue;
    if (LIST_OF_SCOPE[field.scope]) continue;
    customs.add(normalize(question));
    const answer = options.join('; ');
    proposals.push({ type: 'custom', question, answer, site, title: question, detail: answer, saveTo: 'A new saved answer' });
  }

  // One item per detail of a job, school or reference, each carrying the
  // entry's name so it lands in the right one whichever is saved first.
  for (const { list, values, questions, firstName, lastName } of blocks.values()) {
    if (list === 'references' && !values.fullName && (firstName || lastName)) {
      values.fullName = [firstName, lastName].filter(Boolean).join(' ');
    }
    const clean = Object.fromEntries(Object.entries(values).filter(([, v]) => String(v || '').trim()));
    if (!Object.keys(clean).length) continue;
    const nameProp = NAME_PROP[list];
    const name = clean[nameProp] || '';
    const at = findEntry(profile, list, name);
    const entry = at >= 0 ? profile[list][at] : null;
    const noun = NOUN[list];
    const where = list === 'references' ? `your reference ${name || '(new)'}` : `your ${noun}${name ? ` at ${name}` : ''}`;
    const props = Object.keys(clean).filter(prop => !entry || !same(entry[prop], clean[prop]));
    // A known entry with nothing new: nothing to offer.
    if (entry && props.every(prop => prop === nameProp)) continue;
    for (const prop of props) {
      if (prop === nameProp && entry) continue;
      const label = FIELD_BY_KEY[`${list}.${prop}`]?.label || prop;
      proposals.push({
        type: 'entry', list, name,
        values: name ? { [nameProp]: name, [prop]: clean[prop] } : { [prop]: clean[prop] },
        question: questions?.[prop] || label,
        answer: String(clean[prop]),
        replaces: entry && String(entry[prop] || '').trim() ? String(entry[prop]) : undefined,
        title: questions?.[prop] || label,
        detail: String(clean[prop]).slice(0, 200),
        saveTo: prop === nameProp && !entry ? `A new ${noun}` : `${label}, ${where}`
      });
    }
  }
  return proposals;
}

/** The same answer, whatever the case and spacing. */
function same(a, b) {
  const squash = x => normalize(String(x ?? '')).replace(/[^a-z0-9@.+]/g, '');
  return squash(a) === squash(b);
}

/** Position in the typed list of the entry with this name, or -1. */
function findEntry(profile, list, name) {
  const raw = Array.isArray(profile?.[list]) ? profile[list] : [];
  const want = normalize(name);
  if (!want) return -1;
  return raw.findIndex(e => normalize(e?.[NAME_PROP[list]]) === want);
}

/**
 * Apply the items the user chose. Returns a new profile. Nothing already saved
 * is overwritten unless the item says `replace` (the user pressed Replace), or
 * it is a saved answer to the very same question.
 */
export function applyLearning(profile, proposals) {
  const next = { ...profile, custom: [...(profile.custom || [])] };
  for (const list of Object.keys(LISTS)) next[list] = [...(profile[list] || [])].map(e => ({ ...e }));
  let applied = 0;

  for (const p of proposals || []) {
    if (p.type === 'field' && FIELD_BY_KEY[p.key] && !SENSITIVE_KEYS.has(p.key)) {
      // A replacement is applied only when the user chose to replace.
      if (String(next[p.key] || '').trim() === '' || p.replace) { next[p.key] = String(p.value); applied++; }
    } else if (p.type === 'entry' && LISTS[p.list]) {
      const at = findEntry(next, p.list, p.name);
      if (at >= 0) {
        const entry = next[p.list][at];
        for (const [prop, value] of Object.entries(p.values || {})) {
          if (!String(entry[prop] || '').trim() || p.replace) entry[prop] = String(value);
        }
        applied++;
      } else if (listEntries(next, p.list).length < LISTS[p.list].max) {
        next[p.list].push({ ...blankEntry(p.list), ...p.values });
        applied++;
      }
    } else if (p.type === 'custom' && String(p.question || '').trim()) {
      const same = next.custom.findIndex(c => normalize(c.question) === normalize(p.question));
      const item = {
        id: same >= 0 ? next.custom[same].id : Math.random().toString(36).slice(2, 10),
        question: String(p.question).trim(),
        answer: String(p.answer || '').trim(),
        site: p.site || ''
      };
      if (same >= 0) next.custom[same] = item;
      else next.custom.push(item);
      applied++;
    }
  }
  return { profile: next, applied };
}
