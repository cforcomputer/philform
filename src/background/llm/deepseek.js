/**
 * DeepSeek client. This is currently the only provider Applicator uses: it
 * handles both halves of the work, field classification and written answers.
 *
 * DeepSeek exposes an OpenAI-shaped chat completions endpoint. Model IDs moved
 * in 2026 - `deepseek-chat` and `deepseek-reasoner` were retired - and the two
 * current models are `deepseek-flash` (V4.1 Flash) and `deepseek-v4-pro`
 * (V4-Pro-0813).
 *
 * Both are reasoning models, and reasoning tokens are billed as output tokens
 * and consume `max_tokens` before any answer is produced. A budget that looks
 * generous for the answer alone can therefore return an empty string with
 * `finish_reason: "stop"`. Two consequences run through this file:
 * `reasoning_effort` is always sent explicitly rather than left to the default,
 * and callers pass a budget sized for reasoning plus answer.
 */

import { timeout } from '../../common/util.js';
import { route, relayError, relayActive } from './relay.js';

const ENDPOINT = 'https://api.deepseek.com/chat/completions';
const REQUEST_TIMEOUT_MS = 180000;

/** Models suited to matching fields: cheap and fast. */
export const DEEPSEEK_MODELS = [
  { id: 'deepseek-flash', label: 'DeepSeek V4.1 Flash (cheapest, recommended)' },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro (stronger, pricier)' }
];

/** Models suited to writing prose. Pro is the default: the answers are better. */
export const DEEPSEEK_WRITER_MODELS = [
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro (recommended for written answers)' },
  { id: 'deepseek-flash', label: 'DeepSeek V4.1 Flash (cheaper, blunter)' }
];

/** Accepted by both current models. Higher levels cost more output tokens. */
export const REASONING_EFFORTS = [
  { id: 'none', label: 'None - cheapest, no deliberation' },
  { id: 'low', label: 'Low - recommended' },
  { id: 'high', label: 'High - more considered' },
  { id: 'max', label: 'Max - slowest and priciest' }
];

/**
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {string} [opts.system]
 * @param {string} opts.user
 * @param {boolean} [opts.json]              Constrain the reply to a JSON object.
 * @param {number} [opts.maxTokens]          Must cover reasoning plus the answer.
 * @param {string} [opts.reasoningEffort]    none | low | high | max
 * @param {number} [opts.temperature]        Omitted entirely when not supplied.
 * @param {AbortSignal} [opts.signal]
 */
export async function callDeepSeek({
  apiKey,
  model = 'deepseek-flash',
  system,
  user,
  json = true,
  maxTokens = 4096,
  reasoningEffort = 'low',
  temperature,
  signal
}) {
  if (!apiKey && !relayActive()) throw new Error('No DeepSeek API key is set. Add one in philform settings.');

  const body = {
    model,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: user }
    ],
    max_tokens: maxTokens
  };
  if (json) body.response_format = { type: 'json_object' };
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;
  if (typeof temperature === 'number') body.temperature = temperature;

  const { url, headers } = route('deepseek', ENDPOINT, apiKey);
  const request = fetch(url, { method: 'POST', signal, headers, body: JSON.stringify(body) });

  const res = await Promise.race([request, timeout(REQUEST_TIMEOUT_MS, 'DeepSeek request')]);
  if (!res.ok) throw new Error(await relayError(res) || await describeDeepSeekError(res));

  const payload = await res.json();
  const choice = payload?.choices?.[0];
  const text = (choice?.message?.content || '').trim();

  if (!text) {
    // Almost always the reasoning budget swallowing the whole allowance.
    const reasoning = payload?.usage?.completion_tokens_details?.reasoning_tokens;
    const detail = choice?.finish_reason === 'length' || reasoning >= maxTokens * 0.9
      ? ' The token budget was used up before an answer was produced. Lower the reasoning effort in settings, or ask for shorter answers.'
      : '';
    throw new Error(`DeepSeek returned an empty response.${detail}`);
  }

  return {
    text,
    usage: payload.usage || {},
    model: payload.model || model,
    finishReason: choice?.finish_reason
  };
}

/** Turn an HTTP failure into something a user can act on. */
export async function describeDeepSeekError(res) {
  let detail = '';
  try {
    const body = await res.json();
    detail = body?.error?.message || '';
  } catch {
    detail = (await res.text().catch(() => '')).slice(0, 300);
  }

  switch (res.status) {
    case 401:
      return 'DeepSeek rejected the API key. Check it in philform settings.';
    case 402:
      return 'Your DeepSeek account is out of credit. Top it up to keep filling forms.';
    case 404:
      return 'DeepSeek does not recognise the selected model. Pick another in settings.';
    case 429:
      return 'DeepSeek rate limit reached. Wait a moment and run again.';
    default:
      if (res.status >= 500) return `DeepSeek had a server error (${res.status}). Try again shortly.`;
      return `DeepSeek returned ${res.status}${detail ? `: ${detail}` : ''}`;
  }
}

/** Cheap credential check used by the Test button in settings. */
export async function testDeepSeek({ apiKey, model }) {
  const res = await callDeepSeek({
    apiKey,
    model,
    system: 'You return JSON only.',
    user: 'Return {"status":"ready"}',
    maxTokens: 512,
    reasoningEffort: 'none',
    temperature: 0
  });
  return res.text;
}
