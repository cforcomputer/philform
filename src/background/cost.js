/**
 * What a fill costs, and the cap that keeps it cheap.
 *
 * Every model call is priced from the token counts its provider reports, so
 * the figure shown after a fill is what the fill actually cost, not an
 * estimate. A fill is capped at MAX_FILL_CENTS: before each call the meter
 * checks the worst case against what is left, and the writer's output budget
 * is cut to fit. A fill that would go past the cap stops spending and says
 * so, and the popup offers to report the page.
 *
 * The customer price is PRICE_MULTIPLIER times the cost, so the most a fill
 * can be charged is MAX_FILL_CENTS times that (src/common/wallet.js). Priced
 * low on purpose for now: users first, margin later.
 *
 * Prices are per million tokens, in US dollars, as published by each
 * provider (TypeSafe docs, DeepSeek's pricing page, both as of 2026-10-15).
 * Update them here when a provider changes its prices.
 */

export const MAX_FILL_CENTS = 10;
export const PRICE_MULTIPLIER = 3;

const TYPESAFE = { input: 0.042, output: 0 };

// DeepSeek charges half outside peak hours: 01:00-04:00 and 06:00-10:00 UTC,
// Monday to Friday. (Chinese public holidays are also off-peak; charging peak
// then overstates the cost slightly, which errs on the safe side.)
const DEEPSEEK = {
  'deepseek-flash': { hit: 0.006, miss: 0.3, output: 1.2 },
  'deepseek-v4-pro': { hit: 0.044, miss: 1.32, output: 3.96 }
};


export function deepseekPeak(at = new Date()) {
  const day = at.getUTCDay();
  if (day === 0 || day === 6) return false;
  const h = at.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

function deepseekRates(model, at) {
  const peak = DEEPSEEK[model] || DEEPSEEK['deepseek-v4-pro'];
  const f = deepseekPeak(at) ? 1 : 0.5;
  return { hit: peak.hit * f, miss: peak.miss * f, output: peak.output * f };
}

/** Cents for one call, from the usage object the provider returned. */
export function callCents(provider, model, usage = {}, at = new Date()) {
  const perM = (tokens, dollars) => ((tokens || 0) / 1e6) * dollars * 100;
  if (provider === 'typesafe') return perM(usage.input_tokens, TYPESAFE.input);
  if (provider === 'deepseek') {
    const r = deepseekRates(model, at);
    const hit = usage.prompt_cache_hit_tokens || 0;
    const miss = usage.prompt_cache_miss_tokens ?? Math.max(0, (usage.prompt_tokens || 0) - hit);
    return perM(hit, r.hit) + perM(miss, r.miss) + perM(usage.completion_tokens, r.output);
  }
  return 0;
}

/** The most a call can cost: its input, plus every output token it may write. */
export function worstCaseCents(provider, model, inputTokens, maxOutputTokens, at = new Date()) {
  if (provider === 'typesafe') return callCents('typesafe', model, { input_tokens: inputTokens });
  return callCents('deepseek', model, { prompt_cache_miss_tokens: inputTokens, completion_tokens: maxOutputTokens }, at);
}

/** Output tokens a call may still afford within `cents`, after its input. */
export function affordableOutput(provider, model, inputTokens, cents, at = new Date()) {
  const inputCost = worstCaseCents(provider, model, inputTokens, 0, at);
  const perToken = worstCaseCents(provider, model, 0, 1e6, at) / 1e6;
  if (perToken <= 0) return Infinity;
  return Math.max(0, Math.floor((cents - inputCost) / perToken));
}

/** A running total for one fill, with the cap. */
export class Meter {
  constructor(capCents = MAX_FILL_CENTS) {
    this.cap = capCents;
    this.cents = 0;
    this.calls = [];
    this.capped = false;
  }

  /** Record a call that has happened. */
  add(provider, model, usage, label = '') {
    const cents = callCents(provider, model, usage);
    this.cents += cents;
    this.calls.push({ provider, model, label, cents: round(cents), usage });
    return cents;
  }

  remaining() {
    return Math.max(0, this.cap - this.cents);
  }

  /** Whether a call of at most `cents` may still be made. Marks the fill capped if not. */
  allows(cents) {
    if (this.cents + cents <= this.cap) return true;
    this.capped = true;
    return false;
  }

  summary() {
    // Per provider, so the popup can say where the cost came from.
    const byProvider = {};
    for (const c of this.calls) {
      const p = byProvider[c.provider] ||= { cents: 0, calls: 0, inputTokens: 0, outputTokens: 0 };
      const u = c.usage || {};
      p.cents += c.cents;
      p.calls += 1;
      p.inputTokens += u.input_tokens ?? u.prompt_tokens ?? 0;
      p.outputTokens += u.output_tokens ?? u.completion_tokens ?? 0;
    }
    for (const p of Object.values(byProvider)) p.cents = round(p.cents);
    return {
      cents: round(this.cents),
      priceCents: round(this.cents * PRICE_MULTIPLIER),
      capCents: this.cap,
      capped: this.capped,
      byProvider,
      calls: this.calls.map(({ usage, ...c }) => c)
    };
  }
}

const round = c => Math.round(c * 10000) / 10000;
