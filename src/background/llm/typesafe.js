/**
 * TypeSafe AI client.
 *
 * TypeSafe's System One model, Jev, is not a text model. It answers a fixed set
 * of typed questions against one shared read of some state, and a Choice
 * question can only come back as one of the option keys you defined. That suits
 * form filling better than a chat model does, in three ways:
 *
 *   - It cannot invent an answer. A chat model asked which profile value fits a
 *     field can return a key that does not exist, or a dropdown option the page
 *     never offered. A Choice cannot.
 *   - Every answer carries a calibrated confidence, so a field can be left
 *     blank on a weak signal instead of filled with a guess.
 *   - There is no JSON to parse and therefore no parse to fail.
 *
 * Measured against DeepSeek Flash on the same twenty fields, both scored 20/20,
 * while TypeSafe was roughly five times cheaper and eight times faster.
 *
 * Output tokens are free; only input is billed, at $0.042 per million tokens.
 * Offering every option to every field therefore costs a fraction of a cent
 * per form, which is why callers send the full list rather than a guess at it.
 */

import { timeout } from '../../common/util.js';
import { trace } from '../trace.js';
import { route, relayError, relayActive } from './relay.js';

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const REQUEST_TIMEOUT_MS = 60000;

export const TYPESAFE_MODELS = [
  { id: 'jev-latest', label: 'Jev (latest stable, recommended)' },
  { id: 'jev-preview', label: 'Jev preview' }
];

/**
 * A Choice question may carry at most 255 options. Applicator stays far below
 * that, but the ceiling is enforced here so a large profile cannot produce a
 * silently rejected request.
 */
export const MAX_OPTIONS = 255;

/**
 * Size of one request. The model reads 64k tokens in total, and 32k for the
 * state plus its longest question. Every question repeats its own option list,
 * so questions are packed into requests by estimated size, not by count.
 */
export const MAX_QUESTIONS_PER_CALL = 80;
export const TOKEN_BUDGET_PER_CALL = 44000;

/** A deliberately high estimate: JSON-heavy text runs about 3.5 characters a token. */
export const estimateTokens = value => Math.ceil(JSON.stringify(value ?? '').length / 3.2);

/**
 * Ask one batch of typed questions.
 *
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} [opts.model]
 * @param {object|string} opts.state   Shared context, read once for every question.
 * @param {object} opts.questions      { [id]: { type, instructions, criteria } }
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{answers: object, usage: object, model: string}>}
 */
export async function askTypeSafe({ apiKey, model = 'jev-latest', state, questions, signal }) {
  if (!apiKey && !relayActive()) throw new Error('No TypeSafe API key is set. Add one in philform settings.');

  const ids = Object.keys(questions || {});
  if (!ids.length) return { answers: {}, usage: {}, model };

  for (const id of ids) {
    const count = Object.keys(questions[id]?.criteria || {}).length;
    if (count > MAX_OPTIONS) {
      throw new Error(`A question offered ${count} options; TypeSafe allows ${MAX_OPTIONS}.`);
    }
  }

  const started = Date.now();
  const body = JSON.stringify({ model, state, questions });
  const payload = await Promise.race([hedged(apiKey, body, signal), timeout(REQUEST_TIMEOUT_MS, 'TypeSafe request')]);
  // Development only: every question with its answer and confidence.
  trace('typesafe', { ms: Date.now() - started, state, questions, answers: payload.answers || {}, usage: payload.usage || {}, model: payload.model || model });
  return {
    answers: payload.answers || {},
    usage: payload.usage || {},
    model: payload.model || model
  };
}

/**
 * TypeSafe answers in well under a second, but now and then one request
 * stalls for half a minute. A request with no answer after HEDGE_MS is sent
 * again, and whichever answers first is used; the other is cancelled. A stall
 * then costs a few seconds and one more request's input tokens (a twentieth
 * of a cent), not the fill.
 */
const HEDGE_MS = 3000;
const NETWORK_RETRIES = 2;

function hedged(apiKey, body, signal) {
  const controllers = [];
  const send = () => {
    const controller = new AbortController();
    controllers.push(controller);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const { url, headers } = route('typesafe', ENDPOINT, apiKey);
    return fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers,
      body
    }).then(async res => {
      if (!res.ok) throw new Error(await relayError(res) || await describeTypeSafeError(res));
      return res.json();
    }).finally(() => signal?.removeEventListener('abort', onAbort));
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    let pending = 0;
    let lastError;
    const finish = (ok, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const c of controllers) c.abort();
      ok ? resolve(value) : reject(value);
    };
    let retries = NETWORK_RETRIES;
    const launch = () => {
      pending++;
      send().then(value => finish(true, value), err => {
        lastError = err;
        // A dropped connection (fetch's TypeError, "NetworkError when
        // attempting to fetch") is worth sending again: it once left a whole
        // pass unanswered and four fields empty.
        if (err?.name === 'TypeError' && retries > 0 && !signal?.aborted) {
          retries--;
          setTimeout(() => {
            pending--;
            if (settled) return;
            signal?.aborted ? (pending === 0 && finish(false, lastError)) : launch();
          }, 500);
          return;
        }
        // Every copy sent has failed (a bad key, a rejected request, or the
        // run cancelled): that is the answer, and a second copy would only
        // repeat it.
        if (--pending === 0) finish(false, lastError);
      });
    };
    launch();
    const timer = setTimeout(() => { if (!settled && !signal?.aborted) launch(); }, HEDGE_MS);
  });
}

/** Split questions into requests that each fit the budget alongside the state. */
export function packQuestions(questions, state, budget = TOKEN_BUDGET_PER_CALL) {
  const base = estimateTokens(state);
  const batches = [];
  let current = {};
  let used = base;
  let count = 0;
  for (const [id, q] of Object.entries(questions || {})) {
    const cost = estimateTokens(q);
    if (count && (used + cost > budget || count >= MAX_QUESTIONS_PER_CALL)) {
      batches.push(current);
      current = {};
      used = base;
      count = 0;
    }
    current[id] = q;
    used += cost;
    count++;
  }
  if (count) batches.push(current);
  return batches;
}

/**
 * Run a set of questions across as many requests as the context limit needs,
 * in parallel, merging the answers.
 */
export async function askTypeSafeBatched({ apiKey, model, state, questions, signal }) {
  const batches = packQuestions(questions, state);
  const replies = await Promise.all(
    batches.map(chunk => askTypeSafe({ apiKey, model, state, questions: chunk, signal }))
  );
  const answers = {};
  const usage = { input_tokens: 0, output_tokens: 0 };
  let servedBy = model;
  for (const res of replies) {
    Object.assign(answers, res.answers);
    usage.input_tokens += res.usage.input_tokens || 0;
    usage.output_tokens += res.usage.output_tokens || 0;
    servedBy = res.model;
  }
  return { answers, usage, model: servedBy, requests: batches.length };
}

/** Read one Choice answer, applying a confidence floor. */
export function readChoice(answer, { minConfidence = 0 } = {}) {
  if (!answer || answer.type !== 'choice' || !answer.choice) return null;
  const confidence = typeof answer.confidence === 'number' ? answer.confidence : 0;
  // The likeliest real answer besides the chosen one: when "none of these"
  // wins narrowly, it may still be worth filling as a best guess.
  const runnerUp = Object.entries(answer.probabilities || {})
    .filter(([c]) => c !== answer.choice && c !== '__none__' && c !== '__self__' && c !== '__written__')
    .sort((a, b) => b[1] - a[1])[0];
  const extra = runnerUp && runnerUp[1] > 0 ? { runnerUp: { choice: runnerUp[0], confidence: runnerUp[1] } } : {};
  const probability = answer.probabilities?.[answer.choice];
  if (typeof probability === 'number') extra.probability = probability;
  if (confidence < minConfidence) return { choice: answer.choice, confidence, accepted: false, ...extra };
  return { choice: answer.choice, confidence, accepted: true, ...extra };
}

export async function describeTypeSafeError(res) {
  let detail = '';
  try {
    const body = await res.json();
    detail = body?.error?.message || body?.detail || '';
    if (typeof detail === 'object') detail = JSON.stringify(detail);
  } catch {
    detail = (await res.text().catch(() => '')).slice(0, 300);
  }

  switch (res.status) {
    case 401:
      return 'TypeSafe rejected the API key. Check it in philform settings.';
    case 422:
      return `TypeSafe could not read the request${detail ? `: ${detail}` : '.'}`;
    case 429:
      return 'TypeSafe rate limit reached. Wait a moment and run again.';
    case 529:
      return 'TypeSafe is overloaded. Try again shortly.';
    default:
      if (res.status >= 500) return `TypeSafe had a server error (${res.status}). Try again shortly.`;
      return `TypeSafe returned ${res.status}${detail ? `: ${detail}` : ''}`;
  }
}

/** Cheap credential check for the Test button in settings. */
export async function testTypeSafe({ apiKey, model }) {
  const res = await askTypeSafe({
    apiKey,
    model,
    state: 'The candidate email address is pat@example.com.',
    questions: {
      probe: {
        type: 'choice',
        instructions: 'Which value belongs in a form field labelled "Email Address"?',
        criteria: { email: 'The email address', name: 'The full name' }
      }
    }
  });
  return res.answers?.probe?.choice === 'email' ? 'Connected.' : 'Connected, but the probe answered oddly.';
}
