/**
 * Field classification: decide what goes in each form control that neither the
 * local heuristics nor the site skill could answer.
 *
 * Two engines can do this.
 *
 * TypeSafe is the default. It answers a Choice question per field, so it
 * returns a profile *key* drawn from a list Applicator supplied, and the value
 * that actually reaches the page is then resolved locally by the same tested
 * code that handles the heuristic matches. A model that can only pick from a
 * list cannot invent a dropdown option the page never offered.
 *
 * DeepSeek remains available and returns the value as text. It scored the same
 * 20/20 on the benchmark, at roughly five times the cost and eight times the
 * latency.
 *
 * Either way the request carries field *descriptors*, never page HTML.
 */

import { callDeepSeek } from './llm/deepseek.js';
import { askTypeSafeBatched, readChoice } from './llm/typesafe.js';
import { shortlistFor, criteriaFor, WRITTEN, NONE } from './shortlist.js';
import { parseLooseJson, truncate, normalize } from '../common/util.js';
import { PROFILE_FIELDS, DEMOGRAPHIC_KEYS, profileValue, filledKeys, allFields, listEntries } from '../common/schema.js';
import { responseQuestions, readResponseAnswers } from './responses.js';

const SYSTEM = `You map job-application form fields to a candidate's saved profile.

You receive a list of form fields and the candidate's profile. For each field, decide which profile value belongs in it.

Rules:
- Return a value only when you are confident it answers the field. Otherwise return null.
- For a field with an "options" list, "value" MUST be copied exactly from one of the option labels. Never invent an option.
- For a yes/no field, answer from the profile's true/false value. Read the question carefully: "Do you require sponsorship?" and "Are you authorized to work?" often have opposite answers.
- Never guess a date of birth, a government identifier, a password or a payment detail. Return null for those fields.
- Leave a field null rather than filling it with a placeholder, "N/A", or a made-up value.
- Do not answer open-ended essay questions here. Return null and set "needsWriting": true for those.

Respond with JSON only, in this exact shape:
{"assignments":[{"id":"<field id>","profileKey":"<key or null>","value":"<string or null>","needsWriting":false,"confidence":0.0}]}`;

/** What each block means for the answer, in words a model can act on. */
const BLOCK_NOTES = {
  personal: 'It asks about the applicant themselves',
  employment: 'It is part of a past or current job entry, so it wants that job\'s details, not the applicant\'s home details',
  education: 'It is part of an education entry, so it wants that school\'s details, not the applicant\'s home details',
  reference: 'It asks about one of the applicant\'s references, another person: only that saved reference\'s details belong here, never the applicant\'s own',
  supervisor: 'It asks about the supervisor at this saved job: the job\'s saved supervisor and phone belong here, the applicant\'s own details do not',
  emergency: 'It asks about an emergency contact, another person, so none of the applicant\'s own details belong here'
};

/** Compact one extracted field into the few lines the model actually needs. */
function describeField(field) {
  const d = {
    id: field.id,
    label: truncate(field.label || field.ariaLabel || field.placeholder || '(no label)', 200),
    control: field.tag === 'select' ? 'select' : field.type || field.tag
  };
  if (field.section) d.section = truncate(field.section, 120);
  if (field.scope && field.scope !== 'unknown') d.block = BLOCK_NOTES[field.scope];
  if (field.name) d.name = truncate(field.name, 80);
  if (field.required) d.required = true;
  if (field.maxLength && field.maxLength > 0) d.maxLength = field.maxLength;
  if (field.hint) d.guess = field.hint;
  if (field.options?.length) {
    d.options = field.options.slice(0, 60).map(o => truncate(o.label, 80));
  }
  return d;
}

/** The profile as the model sees it: keys, labels and values, sensitive ones withheld. */
function describeProfile(profile, { includeSensitive, includeReferences = false }) {
  const out = {};
  for (const field of allFields(profile)) {
    if (field.section === 'documents') continue; // long-form source material, not a form value
    if (field.always) continue; // today's date: for the rule that asks for it, not for the model
    // Other people's details are sent only to answer a references block.
    if (field.section === 'references' && !includeReferences) continue;
    if ((DEMOGRAPHIC_KEYS.has(field.key) || (field.custom && field.sensitive)) && !includeSensitive) continue;
    const value = profileValue(profile, field.key);
    if (value === '') continue;
    out[field.key] = { label: field.label, value: truncate(String(value), 300) };
  }
  return out;
}

/**
 * @param {object} args
 * @param {Array}  args.fields      Unresolved field descriptors.
 * @param {object} args.profile
 * @param {object} args.settings
 * @param {object} args.context     { title, company, url }
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{assignments: Array, usage: object}>}
 */
export async function classifyFields({ fields, profile, settings, context, signal }) {
  if (!fields.length) return { assignments: [], usage: {} };

  if (settings.classifier === 'typesafe') {
    return classifyWithTypeSafe({ fields, profile, settings, context, signal });
  }

  const payload = {
    fields: fields.map(describeField),
    profile: describeProfile(profile, { includeSensitive: settings.fillDemographics, includeReferences: fields.some(f => f.scope === 'reference') }),
    context: {
      pageTitle: truncate(context.title || '', 200),
      company: truncate(context.company || '', 120),
      role: truncate(context.role || '', 160)
    }
  };

  const res = await callDeepSeek({
    apiKey: settings.deepseekApiKey,
    model: settings.deepseekModel,
    system: SYSTEM,
    user: JSON.stringify(payload),
    json: true,
    // One line of JSON per field, so the budget scales with the form.
    maxTokens: Math.min(8000, 1500 + fields.length * 120),
    reasoningEffort: settings.deepseekClassifyEffort,
    temperature: 0,
    signal
  });

  const parsed = parseLooseJson(res.text);
  const assignments = Array.isArray(parsed) ? parsed : parsed.assignments || [];
  return { assignments, usage: res.usage };
}

/** The control as a person would name it, for the model. */
function controlOf(field) {
  if (field.type === 'radio') return 'one choice from a set of options';
  if (field.type === 'checkbox') return 'tick box';
  if (field.tag === 'select' || field.widget === 'listbox') return 'dropdown';
  if (field.multiline) return 'multi-line text box';
  if (field.datePicker) return 'date';
  return field.type && field.type !== 'text' ? `${field.type} box` : 'text box';
}

/**
 * The field as TypeSafe sees it: a structured object the question points at,
 * carrying everything known about it rather than the label alone. The name
 * attribute, the placeholder and the options a dropdown offers are often what
 * tells "Company" from "Company size".
 */
export function describeForTypeSafe(field) {
  const form_field = {
    label: truncate(field.label || field.ariaLabel || field.placeholder || '(no label)', 300),
    control: controlOf(field)
  };
  if (field.section) form_field.headings_above = truncate(field.section, 160);
  if (BLOCK_NOTES[field.scope]) form_field.whose_details = BLOCK_NOTES[field.scope];
  if (field.name && !/^[\w-]*\d{3,}[\w-]*$/.test(field.name)) form_field.html_name = truncate(field.name, 80);
  if (field.placeholder && field.placeholder !== form_field.label) form_field.placeholder = truncate(field.placeholder, 80);
  if (field.options?.length) form_field.options_offered = field.options.slice(0, 25).map(o => truncate(o.label, 60));
  if (field.required) form_field.required = true;
  // A tick box under a question ("Are you in the Bay Area?") says which answer it is.
  if (field.optionText) form_field.box_says = truncate(field.optionText, 80);
  // The question as the page words it, where TypeSafe found more than the label.
  if (field.pageQuestion && field.pageQuestion !== form_field.label) form_field.question_on_page = truncate(field.pageQuestion, 300);
  return {
    form_field,
    question: "On this job application, which of the candidate's saved values belongs in `form_field`?"
  };
}

/**
 * Classify with TypeSafe: one Choice question per field, all in one read of the
 * profile. Returns profile keys rather than values, which the caller resolves,
 * and the raw answer for every field so a local guess can be checked against it.
 */
async function classifyWithTypeSafe({ fields, profile, settings, context, signal }) {
  const availableKeys = filledKeys(profile);
  const questions = {};
  const offered = new Map();

  for (const field of fields) {
    const keys = shortlistFor(field, {
      availableKeys,
      allowSensitive: settings.fillDemographics,
      profile
    });
    offered.set(field.id, keys);
    questions[field.id] = {
      type: 'choice',
      instructions: describeForTypeSafe(field),
      criteria: criteriaFor(keys, profile)
    };
  }

  const { answers, usage, requests } = await askTypeSafeBatched({
    apiKey: settings.typesafeApiKey,
    model: settings.typesafeModel,
    // One shared read: the state is sent once per request, not once per field.
    state: {
      candidate_profile: describeProfile(profile, { includeSensitive: settings.fillDemographics, includeReferences: fields.some(f => f.scope === 'reference') }),
      application: {
        company: truncate(context.company || '', 120),
        role: truncate(context.role || '', 160)
      }
    },
    questions,
    signal
  });

  const floor = typeof settings.classifierConfidence === 'number' ? settings.classifierConfidence : 0.6;
  const assignments = [];
  const reads = new Map();

  for (const field of fields) {
    const read = readChoice(answers[field.id], { minConfidence: floor });
    if (!read) continue;
    // Only ever a key that was offered, or one of the two escapes.
    if (read.choice !== WRITTEN && read.choice !== NONE && !offered.get(field.id)?.includes(read.choice)) continue;
    reads.set(field.id, read);

    if (read.choice === WRITTEN) {
      if (read.accepted) assignments.push({ id: field.id, profileKey: null, needsWriting: true, confidence: read.confidence });
      continue;
    }
    // A weak answer is dropped rather than filled. The confidence is calibrated,
    // so this is a meaningful gate rather than a guess about a guess.
    if (read.choice === NONE || !read.accepted) continue;

    assignments.push({
      id: field.id,
      profileKey: read.choice,
      // No value: the caller resolves it from the profile, which is what keeps
      // option selection deterministic.
      confidence: read.confidence
    });
  }

  return { assignments, reads, usage, requests, engine: 'typesafe' };
}

/** One job or school as the model sees it: filled properties only, kept short. */
function entrySummary(entry) {
  const out = {};
  for (const [k, v] of Object.entries(entry || {})) {
    const value = String(v ?? '').trim();
    if (value) out[k] = truncate(value, 160);
  }
  return out;
}

/** Which list entry a field in an employer or school block is about. */
function entryPath(field) {
  const list = field.scope === 'education' ? 'education_history'
    : field.scope === 'employment' || field.scope === 'supervisor' ? 'employment_history'
      : field.scope === 'reference' ? 'references' : null;
  return list ? `${list}[${field.repeatIndex || 0}]` : null;
}

/** The state for one planning request: everything the questions may draw on. */
function planState(profile, settings, context, library, { references = false } = {}) {
  const state = {
    candidate_profile: describeProfile(profile, { includeSensitive: settings.fillDemographics, includeReferences: references }),
    employment_history: listEntries(profile, 'employment').map(entrySummary),
    education_history: listEntries(profile, 'education').map(entrySummary),
    application: {
      company: truncate(context.company || '', 120),
      role: truncate(context.role || '', 160)
    }
  };
  // The résumé, for questions about experience that no saved field holds
  // ("How long since you last wrote code at work?"). About 0.006¢ a request.
  const resume = String(profileValue(profile, 'documents.resumeText') || '').trim();
  if (resume) state.resume = truncate(resume, 8000);
  const projects = listEntries(profile, 'projects').filter(e => e.name || e.description);
  if (projects.length) state.projects = projects.map(e => truncate(`${e.name || ''}: ${e.description || ''}`, 600));
  // Other people's details go only with a form that asks for them.
  if (references) state.references = listEntries(profile, 'references').map(entrySummary);
  if (library) state.saved_answers = library;
  return state;
}

const PLACEHOLDER_OPTION = /^(select|choose|please (select|choose)|--|—|pick one)\b|^\s*$/i;

/** A Choice over the options the page itself offers, plus a way out. */
export function optionCriteria(field) {
  const criteria = {};
  // A list longer than a Choice may hold is sent with the options sharing a
  // word with the saved value first, so the right ones are never cut.
  let options = field.options || [];
  if (options.length > 250 && field.savedValue) {
    const words = normalize(field.savedValue).split(/[^a-z0-9]+/).filter(w => w.length >= 3);
    const near = o => words.some(w => normalize(o.label).includes(w));
    options = [...options.filter(near), ...options.filter(o => !near(o))];
  }
  for (const option of options) {
    const label = truncate(String(option.label || '').trim(), 200);
    if (PLACEHOLDER_OPTION.test(label) || label === NONE || label in criteria) continue;
    criteria[label] = null;
    if (Object.keys(criteria).length >= 250) break;
  }
  criteria[NONE] = "The candidate's saved details do not say which of these applies";
  return criteria;
}

/**
 * Plan a whole form with one TypeSafe round.
 *
 * Three kinds of question go in the same request, all against one state that
 * holds the profile, the job and school history, and any saved answers:
 *
 *   - a text box asks which saved value belongs in it (the answer is a
 *     profile key, resolved to text locally);
 *   - a dropdown or set of radio buttons asks which of *its own options* the
 *     candidate would choose, so the answer is directly what gets selected,
 *     with no second request to map "Cell" onto "Mobile";
 *   - a written question asks which saved answer, if any, already answers it.
 *
 * Packing may split a large form across parallel requests to stay inside the
 * context limit; that is still one round, and costs the same tokens.
 *
 * @returns {Promise<{keyReads: Map, optionReads: Map, responseMatches: object[], usage: object, requests: number}>}
 */
export async function planWithTypeSafe({ keyFields = [], optionFields = [], responseFields = [], profile, responses = [], settings, context, signal }) {
  const availableKeys = filledKeys(profile);
  const questions = {};
  const offered = new Map();

  for (const field of keyFields) {
    const keys = shortlistFor(field, { availableKeys, allowSensitive: settings.fillDemographics, profile })
      .filter(k => field.scope === 'reference' || !k.startsWith('references.'));
    offered.set(field.id, keys);
    const instructions = describeForTypeSafe(field);
    const entry = entryPath(field);
    if (entry) instructions.form_field.about_entry = `\`${entry}\``;
    questions[field.id] = { type: 'choice', instructions, criteria: criteriaFor(keys, profile) };
  }

  for (const field of optionFields) {
    const { form_field } = describeForTypeSafe(field);
    delete form_field.options_offered; // they are the choices themselves
    const entry = entryPath(field);
    if (entry) form_field.about_entry = `\`${entry}\``;
    // A list of offices or places: where the candidate lives, so the nearest one is chosen.
    const home = /^address\.(location|city)$/.test(field.profileKey || '') ? profileValue(profile, 'address.location') : '';
    if (home) form_field.candidate_lives_in = `${home}: choose the option nearest there (same metro area), not ${NONE}, unless none is in that country`;
    questions[field.id] = {
      type: 'choice',
      instructions: {
        form_field,
        question: 'Which option would the candidate choose for `form_field`, going by what their saved details and résumé say? ' +
          'When the question does not apply to them, given those details (a graduate GPA or graduate test score ' +
          'when they hold no graduate degree), choose the option saying it does not apply, if there is one. ' +
          'Asked which office or location they are applying for, choose the one nearest where they live (an office in ' +
          'their metro area), unless their details name another. ' +
          'A question about their experience (how recently they coded at work, how much of their role faced customers, ' +
          'whether they built demos) is answered with the option their résumé makes most likely, with a lower confidence ' +
          `when it is an inference. When their details make one option more likely than the others, choose it with a ` +
          `lower confidence rather than ${NONE}. Only when nothing in their details or résumé bears on it, choose ${NONE}.`
      },
      criteria: optionCriteria(field)
    };
  }

  const matching = responseFields.length ? responseQuestions(responseFields, responses) : null;
  if (matching) Object.assign(questions, matching.questions);

  if (!Object.keys(questions).length) {
    return { keyReads: new Map(), optionReads: new Map(), responseMatches: [], usage: {}, requests: 0 };
  }

  const { answers, usage, requests } = await askTypeSafeBatched({
    apiKey: settings.typesafeApiKey,
    model: settings.typesafeModel,
    state: planState(profile, settings, context, matching?.library, {
      references: [...keyFields, ...optionFields].some(f => f.scope === 'reference')
    }),
    questions,
    signal
  });

  const floor = 0; // raw reads; the caller applies the gate
  const keyReads = new Map();
  for (const field of keyFields) {
    const read = readChoice(answers[field.id], { minConfidence: floor });
    if (!read) continue;
    if (read.choice !== WRITTEN && read.choice !== NONE && !offered.get(field.id)?.includes(read.choice)) continue;
    keyReads.set(field.id, read);
  }
  const optionReads = new Map();
  for (const field of optionFields) {
    const read = readChoice(answers[field.id], { minConfidence: floor });
    if (!read) continue;
    // Only ever one of the page's own options, or the way out.
    if (read.choice !== NONE && !field.options.some(o => truncate(String(o.label || '').trim(), 200) === read.choice)) continue;
    // Report the option as the page spells it.
    const option = field.options.find(o => truncate(String(o.label || '').trim(), 200) === read.choice);
    const second = read.runnerUp && field.options.find(o => truncate(String(o.label || '').trim(), 200) === read.runnerUp.choice);
    optionReads.set(field.id, { ...read, label: option ? option.label : null,
      runnerUp: second ? { label: second.label, confidence: read.runnerUp.confidence } : undefined });
  }
  const responseMatches = matching ? readResponseAnswers(answers, responseFields) : [];

  return { keyReads, optionReads, responseMatches, usage, requests };
}

/**
 * Settle a dropdown or radio group, given what a local rule resolved (an
 * option label, or null) and which option TypeSafe chose. The same order as
 * `settle`: agreement, then a confident model, then the rule, then a model
 * answer above the gate.
 *
 * @returns {{value: string|null, via: string, reason?: string}}
 */
/**
 * Below the confidence gate, an answer is still the most likely one. When it
 * names a real option or saved value, and is at least this sure, it is filled
 * as a best guess and outlined for the user to check, rather than left empty:
 * an empty required field is a field the user has to find and fill anyway.
 */
export const GUESS_FLOOR = 0.35;

/**
 * A question that only applies after another answer ("If so, ...", "After
 * the OPT, ...") is not guessed: when the model is unsure, it is unsure
 * whether the question applies at all.
 */
export const CONDITIONAL = /^\s*(if|after|when|in case|once)\b|\bif (so|yes|no|applicable)\b|\bif you answered\b/i;

/** Questions about who a person is: never guessed, whatever the wording. */
export const SENSITIVE_QUESTION = /gender|transgender|sexual orientation|\blgbt|\bpronouns?\b|\brace\b|ethnic|hispanic|latin[oax]|veteran|military|disabilit|religio|national origin|date of birth|\bage\b|marital|pregnan|criminal|convict|felony/i;

export function settleOption(ruleValue, read, floor = 0.6, { label = '' } = {}) {
  if (read && ruleValue && read.label === ruleValue) return { value: ruleValue, via: 'agreed' };
  const sure = !!read && read.confidence >= Math.max(floor, 0.75);
  if (sure && read.choice !== NONE && read.label) return { value: read.label, via: 'model' };
  if (sure && read.choice === NONE) {
    return { value: null, via: 'model', reason: 'Nothing saved answers this question (checked by the matching model)' };
  }
  if (ruleValue) return { value: ruleValue, via: 'rule' };
  // "None of these" by a narrow lead over a real option: the option is still
  // the most likely answer, filled as a best guess (an office, "Did you
  // graduate from high school?"), never for a conditional or sensitive question.
  const second = read?.choice === NONE ? read.runnerUp : null;
  if (second?.label && second.confidence >= GUESS_FLOOR && !CONDITIONAL.test(label) && !SENSITIVE_QUESTION.test(label)) {
    return { value: second.label, via: 'guess' };
  }
  if (read && read.choice !== NONE && read.label && read.confidence >= floor) return { value: read.label, via: 'model' };
  // Low confidence can also mean "maybe none of these" while one option still
  // far outweighs the others: Vitalize's "able to meet 40% travel?" was Yes
  // 0.51, No 0.05, none 0.44, and a required question was left empty.
  const clearLead = read?.probability >= GUESS_FLOOR && read.probability >= 3 * (read.runnerUp?.confidence || 0);
  if (read && read.choice !== NONE && read.label && (read.confidence >= GUESS_FLOOR || clearLead) && !CONDITIONAL.test(label) && !SENSITIVE_QUESTION.test(label)) {
    return { value: read.label, via: 'guess' };
  }
  return { value: null, via: 'none', reason: 'No confident match in your profile' };
}

/**
 * Settle a field that a local rule matched and TypeSafe also answered.
 *
 * The rule is fast and usually right, but a keyword is not a meaning:
 * "Company size" contains "company", and "State your reason" contains
 * "state". TypeSafe read the whole field, so a confident answer from it wins.
 * Agreement confirms the rule; a confident "nothing fits" leaves the field
 * blank; an unsure answer, or none, keeps the rule's choice.
 *
 * @param {string} ruleKey     What the local rule matched.
 * @param {{choice:string, confidence:number}|undefined} read  TypeSafe's answer.
 * @param {number} floor       The confidence gate from settings.
 * @param {object} [opts]
 * @param {boolean} [opts.offered=true]  Whether the rule's key was among the
 *   options. A key with nothing saved is not offered, and then the model was
 *   choosing among the wrong options: a "Middle name" box must not take the
 *   first name because that was the nearest thing on the list.
 * @returns {{key: string|null, via: string, reason?: string}}
 */
export function settle(ruleKey, read, floor = 0.6, { offered = true, label = '' } = {}) {
  if (!read || !offered) return { key: ruleKey, via: 'rule' };
  if (read.choice === ruleKey) return { key: ruleKey, via: 'agreed' };
  const sure = read.confidence >= Math.max(floor, 0.75);
  // "If you were contacted by a recruiter, please specify who": a keyword
  // ("former employee") is weaker than the model saying nothing fits a
  // question that may not apply at all.
  if ((sure || CONDITIONAL.test(label)) && read.choice === NONE && read.confidence >= floor) {
    return { key: null, via: 'model', reason: 'Nothing saved answers this field (checked by the matching model)' };
  }
  if (sure && read.choice !== WRITTEN) return { key: read.choice, via: 'model', overruled: ruleKey };
  return { key: ruleKey, via: 'rule' };
}

const NO_OPTION = '__none__';

/**
 * Choose among the options a page actually offers, for a field whose profile
 * key is known but whose stored value matches none of them literally.
 *
 * This is the step that answers an equal-opportunity question. A profile saying
 * "Not a veteran" has to become "I am not a protected veteran" on one form and
 * "No" on the next, and no amount of string comparison gets there. Because the
 * options come from the page and the answer is a Choice, the reply can only
 * ever be one of them.
 *
 * @returns {Promise<{picks: Map<string,string>, usage: object}>}
 */
export async function pickOptions({ fields, profile, settings, signal }) {
  const eligible = fields.filter(f => f.options?.length && f.profileKey);
  if (!eligible.length || settings.classifier !== 'typesafe') {
    return { picks: new Map(), usage: {} };
  }

  const questions = {};
  const wanted = new Map();

  for (const field of eligible) {
    const stored = profileValue(profile, field.profileKey, { repeatIndex: field.repeatIndex || 0 });
    if (stored === '') continue;

    const criteria = {};
    for (const option of field.options.slice(0, 200)) {
      criteria[option.label] = option.label;
    }
    criteria[NO_OPTION] = 'None of these options expresses the candidate\'s answer';

    const label = truncate(field.label || field.ariaLabel || '(no label)', 300);
    questions[field.id] = {
      type: 'choice',
      instructions:
        `A job application form asks "${label}". The candidate's own answer to that question is ` +
        `"${truncate(String(stored), 200)}". Which of the options on the form says the same thing? ` +
        'Choose the option that means what the candidate means, not the one that looks most similar.',
      criteria
    };
    wanted.set(field.id, field);
  }

  if (!wanted.size) return { picks: new Map(), usage: {} };

  const { answers, usage } = await askTypeSafeBatched({
    apiKey: settings.typesafeApiKey,
    model: settings.typesafeModel,
    state: { note: 'Each question carries the candidate answer it must be matched against.' },
    questions,
    signal
  });

  const floor = typeof settings.classifierConfidence === 'number' ? settings.classifierConfidence : 0.6;
  const picks = new Map();

  for (const [id, field] of wanted) {
    const read = readChoice(answers[id], { minConfidence: floor });
    if (!read || !read.accepted || read.choice === NO_OPTION) continue;
    // Only ever an option the page actually offered.
    if (!field.options.some(o => o.label === read.choice)) continue;
    picks.set(id, read.choice);
  }

  return { picks, usage };
}

/**
 * For each skill a list holds under no name of its own ("SQL" among "SQL
 * Data Mining", "SQL Server", "Structured Query Language (SQL)"), whether
 * one entry is that skill or a close enough equivalent for an employer.
 * Nothing close enough: no entry, never a guess.
 *
 * @param {{skill: string, options: string[]}[]} items
 * @returns {Promise<{picks: Map<string, string>, usage: object}>} skill -> entry
 */
export async function pickEquivalents({ items, settings, signal }) {
  const ask = (items || []).filter(i => i.skill && i.options?.length);
  if (!ask.length || settings.classifier !== 'typesafe') return { picks: new Map(), usage: {} };
  const questions = {};
  ask.forEach((item, n) => {
    const criteria = {};
    for (const label of item.options.slice(0, 30)) criteria[label] = label;
    // A single answer (a major, a school) has the list's own "Other" to fall
    // back on, among the options; a skill is left out instead.
    criteria[NO_OPTION] = item.question ? 'None of these, not even Other' : 'None of these is the same skill or a close equivalent';
    questions[`s${n}`] = {
      type: 'choice',
      instructions: item.question
        ? `A job application form asks "${truncate(item.question, 150)}" and offers only these entries. The candidate's own answer ` +
          `is "${truncate(item.skill, 120)}". Which entry is the same, or the closest equivalent an employer would read as that ` +
          'answer (a broader field that contains it counts; one that merely shares a word does not)? If none is close, choose "Other" if offered.'
        : `A job application asks for the candidate's skills and offers only these entries. The candidate's skill is ` +
          `"${truncate(item.skill, 80)}". Which entry is the same skill, or a close enough equivalent that an employer would read ` +
          'it as that skill? A different tool or field that merely shares a word is not.',
      criteria
    };
  });
  const { answers, usage } = await askTypeSafeBatched({
    apiKey: settings.typesafeApiKey,
    model: settings.typesafeModel,
    state: { note: 'Each question names the skill it must be matched against.' },
    questions,
    signal
  });
  const floor = Math.max(0.6, typeof settings.classifierConfidence === 'number' ? settings.classifierConfidence : 0.6);
  const picks = new Map();
  ask.forEach((item, n) => {
    const read = readChoice(answers[`s${n}`], { minConfidence: floor });
    if (read?.accepted && read.choice !== NO_OPTION && item.options.includes(read.choice)) picks.set(item.key ?? item.skill, read.choice);
  });
  return { picks, usage };
}

/**
 * A posting with its role's own section first. Many open with a long pitch
 * for the company (Nimble: 2,500 characters of robotics before "The Role"),
 * which a cut to length keeps while dropping the duties that say what the
 * job is.
 */
export function roleFirst(text) {
  const at = text.search(/^\s*(the role|about the role|about this role|the position|the opportunity|responsibilities|what you(?:'|’)?ll do|what you will do|your role)\b/im);
  return at > 600 ? text.slice(at) + '\n\n' + text.slice(0, at) : text;
}

/**
 * Which of the user's CVs goes with this application. Each CV carries the
 * kind of job the user said it is for and its opening text; the job is its
 * title, company and posting. The answer is always one of the CVs: sending
 * the nearest one beats sending none.
 *
 * @param {{id: string, category?: string, filename?: string, text?: string}[]} cvs
 * @returns {Promise<{id: string|null, confidence?: number, usage: object}>}
 */
export async function pickResume({ cvs, context = {}, settings, signal }) {
  const keys = new Map((cvs || []).map((cv, n) => [`CV ${n + 1}`, cv]));
  if (keys.size < 2) return { id: cvs?.[0]?.id || null, usage: {} };
  const criteria = {};
  const state = {
    application: {
      company: truncate(context.company || '', 120),
      role: truncate(context.role || '', 160),
      job_description: truncate(roleFirst(context.jobDescription || ''), 4000) || undefined
    },
    cvs: {}
  };
  for (const [key, cv] of keys) {
    const madeFor = truncate(String(cv.category || '').trim(), 160);
    criteria[key] = madeFor ? `The CV the candidate made for ${madeFor}` : `The CV in ${truncate(cv.filename || 'a file', 120)}`;
    state.cvs[key] = { made_for: madeFor || undefined, file: truncate(cv.filename || '', 120), text: truncate(String(cv.text || '').trim(), 1500) || undefined };
  }
  const { answers, usage } = await askTypeSafeBatched({
    apiKey: settings.typesafeApiKey,
    model: settings.typesafeModel,
    state,
    questions: {
      cv: {
        type: 'choice',
        instructions: 'The candidate keeps a CV for each kind of job (`cvs`, each with what it was made for and how it starts). ' +
          'Which one should they send with this `application`? Choose the one made for the kind of job the role and job ' +
          'description are, going by what each was made for first and its text second. The kind of job is the work the ' +
          'role does day to day, not what the employer makes: testing cloud software at a robotics company is a software job.',
        criteria
      }
    },
    signal
  });
  const read = readChoice(answers.cv, { minConfidence: 0 });
  const cv = read && keys.get(read.choice);
  return { id: cv?.id || null, confidence: read?.confidence, usage };
}

/**
 * Reconcile model output with the fields that were actually extracted.
 *
 * The model returns ids; this discards anything it invented, drops values that
 * are not a real option for a select, and re-attaches the descriptor so the
 * filler has a selector to work with.
 */
export function reconcile(assignments, fields) {
  const byId = new Map(fields.map(f => [f.id, f]));
  const accepted = [];
  const needsWriting = [];

  for (const a of assignments || []) {
    const field = byId.get(a.id);
    if (!field) continue;

    if (a.needsWriting) {
      needsWriting.push(field);
      continue;
    }

    // TypeSafe returns a profile key and no value; the orchestrator resolves it
    // from the profile using the same code path as a heuristic match.
    if (a.value === null || a.value === undefined || String(a.value).trim() === '') {
      if (a.profileKey) {
        accepted.push({
          ...field,
          profileKey: a.profileKey,
          value: null,
          confidence: typeof a.confidence === 'number' ? a.confidence : 0.7,
          via: 'model'
        });
      }
      continue;
    }

    let value = String(a.value);

    if (field.options?.length) {
      const exact = field.options.find(o => o.label === value);
      const loose = exact || field.options.find(o =>
        o.label.trim().toLowerCase() === value.trim().toLowerCase()
      );
      // A select answer that is not one of the offered options is dropped
      // rather than forced, so the user sees an empty field instead of a wrong one.
      if (!loose) continue;
      value = loose.label;
    }

    accepted.push({
      ...field,
      profileKey: a.profileKey || null,
      value,
      confidence: typeof a.confidence === 'number' ? a.confidence : 0.7,
      via: 'model'
    });
  }

  return { accepted, needsWriting };
}
