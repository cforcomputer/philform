/**
 * Saved responses: answers the user has already written, reused verbatim.
 *
 * Open-ended questions repeat across applications. "Why do you want to work
 * here", "tell us about a time you disagreed with a colleague" and "anything
 * else we should know" come up again and again, and a person applying for
 * similar roles usually wants to give the same answer, in their own words,
 * rather than a fresh draft every time.
 *
 * A saved response that matches is filled with no model call. That makes it
 * both the cheapest and the highest-quality path for long text, because the
 * words are the user's own.
 */

import { normalize, similarity, hash, parseLooseJson, truncate } from '../common/util.js';
import { profileValue } from '../common/schema.js';
import { callDeepSeek } from './llm/deepseek.js';
import { askTypeSafeBatched, readChoice } from './llm/typesafe.js';

/**
 * Matching happens in two passes.
 *
 * The local pass only fires on an unmistakable hit: a phrase the user listed
 * appearing in the question. That is free and instant, and it covers the case
 * where someone has already taught Applicator the exact wording.
 *
 * Everything else goes to the model, because wording varies in ways no string
 * comparison survives. "Where do you see yourself in five years", "What are
 * your long-term career goals" and "Describe your career aspirations" are one
 * question with three surfaces. Measured on that set, local matching placed 9
 * of 14 questions and the model placed 14 of 14, and the difference was
 * entirely paraphrase.
 */
export const LOCAL_ACCEPT = 0.9;

/** Floor for accepting the model's choice. True paraphrases scored 0.6 and up. */
export const MODEL_ACCEPT = 0.55;

export function blankResponse() {
  return {
    id: hash(`${Date.now()}-${Math.random()}`),
    name: '',
    triggers: '',
    text: '',
    enabled: true,
    // Off means the saved text is used word for word, with placeholders filled.
    // On sends it through the writer to be tailored to this employer.
    adapt: false,
    uses: 0
  };
}

/** Trigger phrases are entered one per line or separated by commas. */
export function parseTriggers(triggers) {
  return String(triggers || '')
    .split(/[\n,]+/)
    .map(t => normalize(t))
    .filter(Boolean);
}

/**
 * Score one saved response against a form question.
 *
 * A trigger phrase appearing in the question is a deliberate statement by the
 * user and scores highest. Otherwise the question is compared against the
 * response's name and its trigger phrases, and the best overlap wins.
 */
export function scoreResponse(response, question) {
  if (!response.enabled || !String(response.text || '').trim()) return 0;

  const asked = normalize(question);
  if (!asked) return 0;

  let best = 0;
  for (const trigger of parseTriggers(response.triggers)) {
    if (trigger.length >= 4 && asked.includes(trigger)) {
      // A listed phrase appearing outright is the one unambiguous signal, so it
      // always clears LOCAL_ACCEPT. A longer phrase is stronger evidence still.
      best = Math.max(best, Math.min(0.99, 0.92 + trigger.length / 300));
    } else {
      // Word overlap is a hint, never a decision. Capped below LOCAL_ACCEPT so
      // it can only ever rank candidates, and the model settles the question.
      best = Math.max(best, similarity(asked, trigger) * 0.7);
    }
  }

  if (response.name) {
    best = Math.max(best, similarity(asked, response.name) * 0.65);
  }

  return best;
}

export function questionOf(field) {
  return field.label || field.ariaLabel || field.placeholder || '';
}

/**
 * The free pass. Returns a match only when a listed phrase appears in the
 * question outright, so a near miss is left for the model rather than guessed.
 */
export function matchResponseLocally(field, responses) {
  const question = questionOf(field);
  if (!question) return null;

  let winner = null;
  for (const response of responses || []) {
    const score = scoreResponse(response, question);
    if (score >= LOCAL_ACCEPT && (!winner || score > winner.score)) {
      winner = { response, score, via: 'saved' };
    }
  }
  return winner;
}

const MATCH_SYSTEM = `You match job-application questions to answers the candidate has already written.

Each saved answer is shown with its name, any phrasings the candidate listed, and the answer itself. The answer text is the best evidence of what question it answers.

Match on meaning, not wording. "Where do you see yourself in five years", "What are your long-term career goals" and "Describe your career aspirations" are the same question and take the same saved answer. A saved answer fits whenever a reader would accept it as a sincere answer to the question asked, allowing for small edits.

Return null only when no saved answer would read as an answer to that question at all. Do not return null merely because the wording differs.

Respond with JSON only: {"matches":[{"id":"<question id>","responseId":"<saved answer id or null>","confidence":0.0}]}`;

/** The saved library, compacted for the prompt. */
export function describeForModel(responses) {
  return (responses || [])
    .filter(r => r.enabled && String(r.text || '').trim())
    .map(r => ({
      id: r.id,
      name: truncate(r.name || '', 120),
      phrasings: parseTriggers(r.triggers).slice(0, 8),
      // The answer itself carries most of the signal, so it is worth the tokens.
      answer: truncate(String(r.text).trim(), 600)
    }));
}

/**
 * Ask the model which saved answer fits each remaining question.
 *
 * Runs on the field-matching model, not the writer: this is categorisation, not
 * prose. It is skipped entirely when there is nothing to match against, so a
 * user with no saved responses never pays for it.
 *
 * @returns {{matches: Array, usage: object}}
 */
export async function matchResponsesWithModel({ fields, responses, settings, signal }) {
  const library = describeForModel(responses);
  if (!fields.length || !library.length) return { matches: [], usage: {} };

  if (settings.classifier === 'typesafe') {
    return matchWithTypeSafe({ fields, responses, settings, signal });
  }

  const payload = {
    savedAnswers: library,
    questions: fields.map(f => ({ id: f.id, question: truncate(questionOf(f), 400) }))
  };

  const res = await callDeepSeek({
    apiKey: settings.deepseekApiKey,
    model: settings.deepseekModel,
    system: MATCH_SYSTEM,
    user: JSON.stringify(payload),
    json: true,
    maxTokens: Math.min(4000, 800 + fields.length * 80),
    reasoningEffort: settings.deepseekClassifyEffort,
    temperature: 0,
    signal
  });

  const parsed = parseLooseJson(res.text);
  return { matches: parsed.matches || [], usage: res.usage };
}

const NO_MATCH = '__none__';

/**
 * The TypeSafe questions that match written questions to saved answers, one
 * Choice per question over the saved answers. Built separately so a fill can
 * ask them in the same request as everything else on the form.
 *
 * @returns {{library: object[], questions: object}|null}
 */
export function responseQuestions(fields, responses) {
  const library = describeForModel(responses);
  if (!fields.length || !library.length) return null;

  const criteria = {};
  for (const item of library) {
    criteria[item.id] = `${item.name || 'Saved answer'}: ${item.answer}`;
  }
  criteria[NO_MATCH] = 'No saved answer would read as a sincere answer to this question';

  const questions = {};
  for (const field of fields) {
    questions[`response:${field.id}`] = {
      type: 'choice',
      instructions:
        `A job application asks: "${truncate(questionOf(field), 400)}". ` +
        'Which of the answers the candidate has already written (`saved_answers`) answers this same question? ' +
        'Match on meaning rather than wording.',
      criteria
    };
  }
  return { library, questions };
}

/** Read the answers to `responseQuestions` as matches for reconcileMatches. */
export function readResponseAnswers(answers, fields) {
  const matches = [];
  for (const field of fields) {
    const read = readChoice(answers[`response:${field.id}`], { minConfidence: MODEL_ACCEPT });
    if (!read || !read.accepted || read.choice === NO_MATCH) continue;
    matches.push({ id: field.id, responseId: read.choice, confidence: read.confidence });
  }
  return matches;
}

/**
 * Match saved answers with TypeSafe. Picking one item from a list is exactly
 * what a Choice question is, so the answer can only ever be a saved answer that
 * exists, and it arrives with a calibrated confidence.
 */
async function matchWithTypeSafe({ fields, responses, settings, signal }) {
  const built = responseQuestions(fields, responses);
  if (!built) return { matches: [], usage: {} };
  const { answers, usage } = await askTypeSafeBatched({
    apiKey: settings.typesafeApiKey,
    model: settings.typesafeModel,
    state: { saved_answers: built.library },
    questions: built.questions,
    signal
  });
  return { matches: readResponseAnswers(answers, fields), usage, engine: 'typesafe' };
}

/**
 * Turn the model's choices into usable matches, discarding anything it invented
 * and anything it was not confident about.
 */
export function reconcileMatches(matches, fields, responses) {
  const byField = new Map(fields.map(f => [f.id, f]));
  const byResponse = new Map((responses || []).map(r => [r.id, r]));
  const out = [];

  for (const match of matches || []) {
    const field = byField.get(match.id);
    const response = byResponse.get(match.responseId);
    if (!field || !response) continue;
    if (!response.enabled || !String(response.text || '').trim()) continue;

    const score = typeof match.confidence === 'number' ? match.confidence : 0;
    if (score < MODEL_ACCEPT) continue;

    out.push({ field, response, score, via: 'saved-model' });
  }
  return out;
}

/**
 * Substitute placeholders in a saved response.
 *
 * `{{company}}` and `{{role}}` come from the page being applied to, which is
 * what lets one saved cover letter serve every application. Any profile key
 * also works, for example `{{identity.firstName}}`. An unknown placeholder is
 * removed rather than left visible, because a form submitted with a literal
 * `{{company}}` in it is worse than one with a small gap.
 */
export function renderResponse(text, { profile = {}, context = {} } = {}) {
  const lookup = {
    company: context.company || '',
    role: context.role || '',
    title: context.role || '',
    name: profileValue(profile, 'identity.fullName'),
    firstName: profileValue(profile, 'identity.firstName'),
    lastName: profileValue(profile, 'identity.lastName')
  };

  return String(text || '')
    .replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
      if (key in lookup) return lookup[key];
      const fromProfile = profileValue(profile, key);
      return fromProfile || '';
    })
    // Collapse the whitespace a removed placeholder leaves behind.
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Starter library, offered on first use so the feature is discoverable. */
export function starterResponses() {
  return [
    {
      ...blankResponse(),
      name: 'Why this company',
      triggers: 'why do you want to work\nwhy are you interested\nwhy this company\nwhy us\nwhat interests you about',
      text: 'I have been following {{company}} and the {{role}} role lines up closely with the work I want to be doing.\n\nReplace this with two or three sentences of your own. Mention something specific about the company, then connect it to what you have actually built.',
      enabled: false,
      adapt: true
    },
    {
      ...blankResponse(),
      name: 'Anything else we should know',
      triggers: 'anything else\nadditional information\nis there anything else\nother information',
      text: 'Replace this with anything a reader would miss from your resume. Leave it disabled if you would rather answer these individually.',
      enabled: false
    }
  ];
}
