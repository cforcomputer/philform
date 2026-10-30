/**
 * What each field's question is, read by TypeSafe from the page itself.
 *
 * The extractor finds the controls and groups options; finding the words that
 * ask each question is left to TypeSafe, given the page as a person reads it:
 * its visible lines in order (content/extract.js, structureOf). Per field, it
 * picks the nearby line that is the question, says the control's own
 * placeholder names it (__self__), or that it is not part of the application
 * at all (__none__: step menus, site search, a dropdown's own list). An option
 * with no words of its own gets the line beside it.
 *
 * One request per frame per pass, about 0.03¢, measured against the label
 * rules on 57 live and saved forms (.dev/experiments/structure/RESULTS.md):
 * 93% of questions right with the rules, 99% with this, and 100% against 96.5%
 * on forms never seen while it was written. If the request fails, the
 * extractor's own labels stand.
 */

import { askTypeSafe, estimateTokens } from './llm/typesafe.js';
import { trace } from './trace.js';

const NO_LINE = '__none__';
const OWN_NAME = '__self__';

/** Read once per request, so each question can be a one-line pointer to it. */
export const TASK =
  'Which line of `page` is the question or label that a person answers with each control? A group of options (radio ' +
  'buttons, tick boxes, Yes/No buttons): the question the options answer, not one option\'s words. A single tick box: ' +
  'the sentence beside it saying what ticking it means, not a heading above it. __self__: the control\'s own ' +
  'placeholder or aria-label names it better than any line does (a country-code picker beside a phone number). ' +
  '__none__: not a question of the application: navigation, a list of steps or rows, pagination, site search, menus, ' +
  'cookie banners, chat, a dropdown\'s own list of options, the month or year list inside a pop-up calendar (a ' +
  'form\'s own From/To month or year boxes are questions).';

const OPTION_TASK = '`control` is one option of a question. Which line is this option\'s own words? __none__ if no line is.';

/** A placeholder that says how to answer, not what is asked. */
const GENERIC_PLACEHOLDER = /^(type|enter|write|add|start typing)( (here|text|your (answer|response)|an answer|a response))?\W*$|^your (answer|response)\W*$/i;

/** Below this, the extractor's own reading is kept. */
const MIN_CONFIDENCE = 0.3;
/** A field is set aside as not part of the application only this surely, and never when required. */
const JUNK_CONFIDENCE = 0.7;

/** The request for one frame's structure: { state, questions }, or null when there is nothing to ask. */
export function structureQuestions(structure, fields) {
  const { offset, lines } = structure;
  const text = i => lines[i - offset];
  const { page, idOf } = numberedPage(structure, fields);
  const state = { page, task: TASK };
  const questions = {};
  for (const f of fields) {
    const s = structure.fields[f.id];
    if (!s) continue;
    const criteria = {};
    for (const i of s.candidates) if (text(i) !== undefined) criteria[idOf(i)] = text(i).slice(0, 80);
    criteria[OWN_NAME] = 'Its own placeholder or aria-label';
    criteria[NO_LINE] = 'Not an application question';
    questions[qid(f.id)] = { type: 'choice', instructions: { control: `${qid(f.id)}: ${s.marker}`, question: 'Its question, per `task`?' }, criteria };
    for (const o of s.options || []) {
      const near = {};
      for (const i of o.candidates) if (text(i) !== undefined) near[idOf(i)] = text(i).slice(0, 80);
      if (!Object.keys(near).length) continue;
      near[NO_LINE] = 'No line is';
      questions[oid(f.id, o.index)] = { type: 'choice', instructions: { control: `option ${o.index + 1} of: ${s.marker}`, question: OPTION_TASK }, criteria: near };
    }
  }
  return Object.keys(questions).length ? { state, questions } : null;
}

/**
 * The page as TypeSafe reads it: text lines and controls numbered together in
 * page order, each control a line of its own under the name its question uses
 * ("L42 | [q_f15: checkbox]", then "L43 | Retired from ..."). Unnumbered, or
 * left out, a box's own words and the previous box's read alike, and a section
 * heading as likely as the label above a box. `idOf` maps a text line's index
 * to its number here; `lineOf` maps back.
 */
export function numberedPage(structure, fields) {
  const { offset, lines } = structure;
  const at = new Map();
  for (const f of fields) {
    const s = structure.fields[f.id];
    if (!s) continue;
    const k = s.at ?? s.candidates[0];
    if (!at.has(k)) at.set(k, []);
    at.get(k).push(`[${qid(f.id)}: ${s.marker}]`);
  }
  const out = [];
  const ids = new Map();
  let n = 0;
  const push = t => out.push(`L${++n} | ${t}`);
  lines.forEach((t, k) => {
    for (const m of at.get(k + offset) || []) push(m);
    push(t);
    ids.set(k + offset, `L${n}`);
  });
  for (const m of at.get(lines.length + offset) || []) push(m);
  const back = new Map([...ids].map(([i, id]) => [id, i]));
  return { page: out.join('\n'), idOf: i => ids.get(i), lineOf: id => back.get(id) };
}

// TypeSafe question ids: plain characters only.
const qid = id => `q_${String(id).replace(/[^\w]/g, '_')}`;
const oid = (id, i) => `o_${String(id).replace(/[^\w]/g, '_')}_${i}`;

/**
 * Apply TypeSafe's answers to the fields: the question it found becomes the
 * label (the extractor's is kept as `extractedLabel`), a blank option gets its
 * words, and a field surely not part of the application is marked `notPart`.
 * A tick box relabelled with the question keeps its own words as `optionText`,
 * so a Yes box and a No box under one question are never both ticked.
 */
export function applyStructure(structure, fields, answers, asked = fields) {
  const { offset, lines } = structure;
  // Numbered exactly as the questions were: from the fields that were asked.
  const { lineOf } = numberedPage(structure, asked);
  const text = choice => {
    const i = lineOf(choice);
    return i === undefined ? undefined : lines[i - offset];
  };
  const changes = [];
  // A line that is another field's own label is that field's, not this one's
  // question: the next tick box's words, the next digit box's "Digit 3".
  const norm = t => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const labelsOf = new Map();
  for (const f of fields) {
    const k = norm(f.extractedLabel ?? f.label);
    if (k) labelsOf.set(k, (labelsOf.get(k) || new Set()).add(f.id));
  }
  const othersOwn = (line, f) => [...(labelsOf.get(norm(line)) || [])].some(id => id !== f.id);
  return {
    fields: fields.map(f => {
      if (!structure.fields[f.id]) return f;
      const a = answers[qid(f.id)];
      let out = f;
      if (a?.choice && (a.confidence ?? 0) >= MIN_CONFIDENCE) {
        if (a.choice === NO_LINE) {
          if (a.confidence >= JUNK_CONFIDENCE && !f.required) out = { ...f, notPart: true };
        } else {
          // Its own name only when that name has words ("First Name *", not "(___) ___-____").
          const named = [f.ariaLabel, f.placeholder].find(v => /[A-Za-z]{2}/.test(v || ''));
          const own = a.choice === OWN_NAME ? (named || f.label) : text(a.choice);
          // "Type here..." names nothing: Promise's "Show Off Your Excellence" sat
          // above a long description, out of reach of the nearby lines, and its
          // box was read as the placeholder and skipped.
          const usable = own && norm(own) !== norm(f.label) && !(a.choice !== OWN_NAME && othersOwn(own, f)) &&
            !(GENERIC_PLACEHOLDER.test(own.trim()) && /[A-Za-z]{2}/.test(f.label || ''));
          if (usable && weakLabel(f, own, structure)) {
            out = { ...f, label: own, extractedLabel: f.label };
            if (f.type === 'checkbox' && !(f.options || []).length && f.label) out.optionText = f.label;
          } else if (usable) {
            // The label stands; the question as worded on the page goes along as context.
            out = { ...f, pageQuestion: own };
          }
        }
        changes.push({ id: f.id, before: f.label, after: out.notPart ? NO_LINE : out.label, choice: a.choice, confidence: a.confidence });
      }
      const blanks = structure.fields[f.id].options || [];
      if (blanks.length) {
        const options = (out.options || []).map((o, i) => {
          const ans = answers[oid(f.id, i)];
          const words = ans && ans.choice !== NO_LINE ? text(ans.choice) : undefined;
          return words && !/[A-Za-z0-9]/.test(o.label || '') ? { ...o, label: words, value: o.value || words } : o;
        });
        out = { ...out, options };
      }
      return out;
    }),
    changes
  };
}

/**
 * Whether the extractor's own label is too weak to keep, so TypeSafe's reading
 * replaces it. Everything downstream (keyword rules, what counts as an essay,
 * which optional boxes are left to the user) was built on the extractor's
 * labels, and on a well-labelled field swapping in the page's longer wording
 * changed those decisions for the worse: an optional "Additional Information"
 * box read as "Please share anything else..." was drafted, at five times the
 * cost. So the label is replaced only when it is:
 *  - empty, or a placeholder word ("Required", "Select one");
 *  - a short phrase while the page asks a real question (CalCareers' "State
 *    Employment" for "Are you now employed by the State of California?", or a
 *    Yes box under "Are you in the Bay Area?");
 *  - nowhere near the control on the page (taken from an aria-label or a
 *    heading far away).
 */
export function weakLabel(field, found, structure) {
  const norm = t => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const label = norm(field.label);
  if (!/[a-z]{2}/.test(label)) return true;
  if (/^(required|optional|select( one)?( required)?|choose( one)?|please select|no label)$/.test(label)) return true;
  const words = label.split(' ').length;
  if (words <= 4 && /\?/.test(found) && !/\?/.test(field.label || '')) return true;
  // A tick box or radio named by an option's word or two ("Yes", "Custom")
  // under a sentence that asks or explains: the sentence is its question, and
  // the word is kept as what the box says (optionText).
  const toggle = field.type === 'checkbox' || field.type === 'radio';
  if (toggle && words <= 2 && norm(found).split(' ').length >= 5) return true;
  const s = structure.fields[field.id];
  const near = (s?.candidates || []).map(i => norm(structure.lines[i - structure.offset]));
  const own = [field.placeholder, field.ariaLabel].map(norm);
  const seen = [...near, ...own].some(t => t && (t === label || t.includes(label) || (label.length > 12 && label.includes(t) && t.length > 8)));
  return !seen;
}

/**
 * Read the structure of every frame that has one, one request each, in
 * parallel. Returns the fields with their questions, and each request's usage to meter.
 */
export async function readStructure({ extraction, fields, settings, signal }) {
  const usage = { input_tokens: 0, output_tokens: 0 };
  const requests = [];
  let out = fields;
  const changes = [];
  await Promise.all((extraction.structures || []).map(async structure => {
    const mine = out.filter(f => structure.fields[f.id]);
    const request = structureQuestions(structure, mine);
    if (!request) return;
    try {
      const res = await askTypeSafe({ apiKey: settings.typesafeApiKey, model: settings.typesafeModel, ...request, signal });
      const used = { input_tokens: res.usage.input_tokens || estimateTokens(request), output_tokens: 0 };
      usage.input_tokens += used.input_tokens;
      requests.push(used);
      const applied = applyStructure(structure, out, res.answers || {}, mine);
      out = applied.fields;
      changes.push(...applied.changes);
    } catch (err) {
      if (signal?.aborted) throw err;
      changes.push({ error: err?.message || String(err) });
    }
  }));
  trace('structure', { changes, usage });
  return { fields: out, usage, requests, changes };
}
