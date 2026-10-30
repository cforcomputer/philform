#!/usr/bin/env node
/**
 * Checks for Philform's service (backend/server.mjs): accounts, the free
 * applications, the relay's metering, charging, the cap, Stripe checkout and
 * its webhook. The model providers and Stripe are faked; nothing leaves this
 * machine.
 *
 *   node tools/test-backend.mjs
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { createHandler, memoryStore, clientIp } from '../backend/server.mjs';
import { callCents, MAX_FILL_CENTS } from '../src/background/cost.js';
import { priceOf, FREE_APPLICATIONS } from '../src/common/wallet.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures++;
};

// --- who is asking, behind Caddy ---------------------------------------------------
check('behind the proxy, the address Caddy appended counts (not 127.0.0.1 for everyone)',
  clientIp({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' } }) === '203.0.113.9');
check('a direct caller cannot choose its address with the header',
  clientIp({ socket: { remoteAddress: '198.51.100.4' }, headers: { 'x-forwarded-for': '1.2.3.4' } }) === '198.51.100.4');

// --- fakes ------------------------------------------------------------------------
const seen = [];
const fakeFetch = async (url, init) => {
  seen.push({ url, init });
  if (url.includes('typesafe')) {
    return new Response(JSON.stringify({ answers: { q1: { choice: 'Yes' } }, usage: { input_tokens: 20000 }, model: 'jev-latest' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.includes('deepseek')) {
    const body = JSON.parse(init.body);
    // A huge reply at the largest budget allowed, to test the cap.
    const out = body.max_tokens >= 20000 ? 2_000_000 : 800;
    return new Response(JSON.stringify({ model: body.model, choices: [{ message: { content: '{}' } }],
      usage: { prompt_tokens: 3000, prompt_cache_miss_tokens: 3000, completion_tokens: out } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.includes('stripe.com')) {
    return new Response(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.test/cs_test_1' }), { status: 200 });
  }
  throw new Error(`unexpected fetch ${url}`);
};

const env = { TYPESAFE_API_KEY: 'ts-server-key', DEEPSEEK_API_KEY: 'ds-server-key', STRIPE_SECRET_KEY: 'sk_test_x',
  STRIPE_WEBHOOK_SECRET: 'whsec_test', PUBLIC_URL: 'https://api.philform.test' };
const store = memoryStore();
const server = http.createServer(createHandler({ store, env, fetchImpl: fakeFetch }));
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const call = async (method, path, { token, body, headers = {}, raw } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: raw ?? (body ? JSON.stringify(body) : undefined)
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
};

const fill = async (token, appKey, { filled = 5, writer = false } = {}) => {
  const start = await call('POST', '/v1/runs', { token, body: { applicationKey: appKey } });
  if (start.status !== 201) return { start };
  const run = start.data.runId;
  await call('POST', '/v1/relay/typesafe', { token, headers: { 'x-philform-run': run }, body: { model: 'jev-latest', questions: {} } });
  if (writer) await call('POST', '/v1/relay/deepseek', { token, headers: { 'x-philform-run': run }, body: { model: 'deepseek-v4-pro', max_tokens: 900 } });
  const done = await call('POST', `/v1/runs/${run}/finish`, { token, body: { filled } });
  return { start, run, done };
};

const db_tokenOf = t => store.db.tokens[crypto.createHash('sha256').update(t).digest('hex')];

try {
  console.log('== backend ==');

  // --- accounts ---
  const made = await call('POST', '/v1/accounts');
  const token = made.data.token;
  check('a new account comes with the free applications and no money',
    made.status === 201 && token && made.data.wallet.freeLeft === FREE_APPLICATIONS && made.data.wallet.balanceCents === 0, JSON.stringify(made));
  check('only a hash of the token is kept', !JSON.stringify(store.db).includes(token));
  check('a request without a token is refused', (await call('GET', '/v1/wallet')).status === 401);

  // --- the relay ---
  const start = await call('POST', '/v1/runs', { token, body: { applicationKey: 'jobs.lever.co/globex/1' } });
  check('a run opens while free applications are left', start.status === 201 && start.data.free === true, JSON.stringify(start));
  const run = start.data.runId;
  check('a relay request without a run is refused',
    (await call('POST', '/v1/relay/typesafe', { token, body: { model: 'jev-latest' } })).status === 410);
  seen.length = 0;
  const relayed = await call('POST', '/v1/relay/typesafe', { token, headers: { 'x-philform-run': run }, body: { model: 'jev-latest', state: 's', questions: {} } });
  check('the relay sends the request on with the service\'s own key, unchanged',
    seen.length === 1 && seen[0].init.headers.authorization === 'Bearer ts-server-key' && JSON.parse(seen[0].init.body).state === 's', JSON.stringify(seen[0]?.init));
  check('and returns the provider\'s reply as it came', relayed.status === 200 && relayed.data.answers?.q1?.choice === 'Yes', JSON.stringify(relayed));
  const metered = store.db.runs[run].costCents;
  check('the call is priced from the usage it reports', Math.abs(metered - callCents('typesafe', 'jev-latest', { input_tokens: 20000 })) < 1e-9, String(metered));

  // --- charging ---
  const done = await call('POST', `/v1/runs/${run}/finish`, { token, body: { filled: 4, costCents: 99 } });
  check('the first application is free', done.data.charge.free === true && done.data.charge.cents === 0 && done.data.wallet.freeLeft === FREE_APPLICATIONS - 1, JSON.stringify(done.data));
  const again = await call('POST', `/v1/runs/${run}/finish`, { token, body: { filled: 4 } });
  check('finishing a run twice charges once', again.data.wallet.freeLeft === FREE_APPLICATIONS - 1, JSON.stringify(again.data));
  check('a finished run cannot relay any more',
    (await call('POST', '/v1/relay/typesafe', { token, headers: { 'x-philform-run': run }, body: {} })).status === 410);
  const page2 = await fill(token, 'jobs.lever.co/globex/1');
  check('another page of a free application is free and uses no other', page2.done.data.charge.free && page2.done.data.wallet.freeLeft === FREE_APPLICATIONS - 1, JSON.stringify(page2.done.data));
  const nothing = await fill(token, 'acme.example/jobs/9', { filled: 0 });
  check('a fill that filled nothing uses no free application', nothing.done.data.wallet.freeLeft === FREE_APPLICATIONS - 1, JSON.stringify(nothing.done.data));

  for (let i = 2; i <= FREE_APPLICATIONS; i++) await fill(token, `acme.example/jobs/${i}`);
  const empty = await call('POST', '/v1/runs', { token, body: { applicationKey: 'acme.example/jobs/new' } });
  check('with the free applications used and no money, a fill cannot start', empty.status === 402 && empty.data.wallet.canFill === false, JSON.stringify(empty));
  const stillFree = await call('POST', '/v1/runs', { token, body: { applicationKey: 'acme.example/jobs/3' } });
  check('but a later page of a free application still can', stillFree.status === 201, JSON.stringify(stillFree));

  // --- no payment without a way to credit it ---
  {
    const half = http.createServer(createHandler({ store: memoryStore(), env: { ...env, STRIPE_WEBHOOK_SECRET: '' }, fetchImpl: fakeFetch }));
    await new Promise(r => half.listen(0, '127.0.0.1', r));
    const at = `http://127.0.0.1:${half.address().port}`;
    const t = (await (await fetch(`${at}/v1/accounts`, { method: 'POST' })).json()).token;
    const res = await fetch(`${at}/v1/wallet/reload`, { method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: '{"amountCents":500}' });
    check('without the webhook secret no checkout is started', res.status === 503);
    half.close();
  }

  // --- the website's early-access list ---
  const signup = await call('POST', '/v1/waitlist', { body: { email: ' Pat@Example.com ', browser: 'chrome' } });
  await call('POST', '/v1/waitlist', { body: { email: 'pat@example.com' } });
  check('an early-access sign-up is kept once, tidied', signup.status === 201
    && store.db.waitlist.length === 1 && store.db.waitlist[0].email === 'pat@example.com', JSON.stringify(store.db.waitlist));
  check('a malformed email is refused', (await call('POST', '/v1/waitlist', { body: { email: 'not-an-email' } })).status === 400);

  // --- the rules pack ---
  const rules = await fetch(`${base}/v1/rules`);
  const pack = await rules.json();
  check('the rules pack is served with a version and platforms', rules.status === 200 && !!pack.version && pack.platforms.some(p => p.id === 'workday'), pack.version);
  const cached = await fetch(`${base}/v1/rules`, { headers: { 'if-none-match': rules.headers.get('etag') } });
  check('an unchanged pack is a 304', cached.status === 304, cached.status);

  // --- reports: a thumbs down sends the page for review, never answers ---
  const down = await call('POST', '/v1/reports', { token, body: { id: 'r1', verdict: 'down', url: 'https://jobs.example.com/apply/1',
    site: 'example.com', platform: 'greenhouse', counts: { filled: 3, total: 40, secret: 'x' }, possiblyMissed: ['Work history'], fields: [{ label: 'First name', value: 'Pat' }] } });
  check('a report is taken', down.status === 201 && down.data.id === 'r1', JSON.stringify(down));
  const kept = store.db.reports[0];
  check('it keeps the address, verdict, counts and labels only', kept.url === 'https://jobs.example.com/apply/1' && kept.verdict === 'down'
    && kept.counts.filled === 3 && kept.counts.secret === undefined && kept.fields[0] === 'First name' && kept.platform === 'greenhouse' && !JSON.stringify(kept).includes('Pat'), JSON.stringify(kept));
  await call('POST', '/v1/reports', { token, body: { id: 'r1', verdict: 'down', url: 'https://jobs.example.com/apply/1', note: 'Nothing was filled' } });
  check('a note for the same report is merged', store.db.reports.length === 1 && store.db.reports[0].note === 'Nothing was filled', JSON.stringify(store.db.reports));
  check('a report needs a page address', (await call('POST', '/v1/reports', { token, body: { verdict: 'down', url: 'about:blank' } })).status === 400);
  check('a report needs an account', (await call('POST', '/v1/reports', { body: { verdict: 'down', url: 'https://x.example.com/' } })).status === 401);
  await call('POST', '/v1/waitlist', { body: { email: 'bot@example.com', website: 'http://spam.example' } });
  check('a bot that fills the hidden field is not kept', store.db.waitlist.length === 1);

  // --- an unlimited wallet, given by hand ---
  const friend = (await call('POST', '/v1/accounts')).data.token;
  const friendId = Object.values(store.db.accounts).at(-1).id;
  store.db.accounts[friendId].wallet.unlimited = true;
  for (let i = 1; i <= FREE_APPLICATIONS + 2; i++) await fill(friend, `globex.example/jobs/${i}`);
  const gifted = await fill(friend, 'globex.example/jobs/more');
  check('an unlimited wallet fills past the free applications, never charged',
    gifted.done?.data?.charge?.free === true && gifted.done.data.charge.unlimited === true && gifted.done.data.charge.cents === 0
    && gifted.done.data.wallet.unlimited === true && gifted.done.data.wallet.canFill === true, JSON.stringify(gifted.done?.data));
  check('and what the gift cost is kept', store.db.accounts[friendId].wallet.giftedCents > 0
    && store.db.accounts[friendId].wallet.freeLeft === FREE_APPLICATIONS, JSON.stringify(store.db.accounts[friendId].wallet));

  // --- paying ---
  check('a reload under $5 is refused', (await call('POST', '/v1/wallet/reload', { token, body: { amountCents: 300 } })).status === 400);
  seen.length = 0;
  const checkout = await call('POST', '/v1/wallet/reload', { token, body: { amountCents: 500 } });
  const form = new URLSearchParams(seen[0]?.init?.body || '');
  const account = Object.values(store.db.accounts)[0];
  check('a reload opens a Stripe checkout for the amount, for this account',
    checkout.data.checkoutUrl === 'https://checkout.stripe.test/cs_test_1' && form.get('line_items[0][price_data][unit_amount]') === '500'
    && form.get('metadata[account]') === account.id && form.get('mode') === 'payment', JSON.stringify([checkout, [...form]]));

  const event = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_test_1', payment_status: 'paid', amount_total: 500,
    customer_details: { email: 'Pat.Brien@Example.com' }, metadata: { account: account.id } } } });
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', env.STRIPE_WEBHOOK_SECRET).update(`${t}.${event}`).digest('hex');
  const forged = await call('POST', '/v1/stripe/webhook', { raw: event, headers: { 'stripe-signature': `t=${t},v1=${'0'.repeat(64)}` } });
  check('a webhook without Stripe\'s signature is refused', forged.status === 400 && account.wallet.balanceCents === 0, JSON.stringify(forged));
  await call('POST', '/v1/stripe/webhook', { raw: event, headers: { 'stripe-signature': `t=${t},v1=${sig}` } });
  await call('POST', '/v1/stripe/webhook', { raw: event, headers: { 'stripe-signature': `t=${t},v1=${sig}` } });
  const after = await call('GET', '/v1/wallet', { token });
  check('a paid checkout tops the wallet up once, however often Stripe says so', after.data.wallet.balanceCents === 500, JSON.stringify(after.data));

  const paid = await fill(token, 'acme.example/jobs/paid', { writer: true });
  const cost = store.db.runs[paid.run].costCents;
  check('a fill after the free ones is charged three times what it cost',
    paid.done.data.charge.free === false && Math.abs(paid.done.data.charge.cents - priceOf(cost)) < 1e-6
    && Math.abs(paid.done.data.wallet.balanceCents - (500 - priceOf(cost))) < 1e-3, JSON.stringify([cost, paid.done.data]));

  // --- the cap ---
  const capped = await call('POST', '/v1/runs', { token, body: { applicationKey: 'acme.example/jobs/big' } });
  const big = capped.data.runId;
  const huge = await call('POST', '/v1/relay/deepseek', { token, headers: { 'x-philform-run': big }, body: { model: 'deepseek-v4-pro', max_tokens: 200000 } });
  check('a budget larger than the writer ever asks for is refused', huge.status === 400 && store.db.runs[big].costCents === 0, JSON.stringify(huge));
  await call('POST', '/v1/relay/deepseek', { token, headers: { 'x-philform-run': big }, body: { model: 'deepseek-v4-pro', max_tokens: 20000 } });
  const over = await call('POST', '/v1/relay/deepseek', { token, headers: { 'x-philform-run': big }, body: { model: 'deepseek-v4-pro', max_tokens: 900 } });
  check('a run past the spending cap can relay no more', store.db.runs[big].costCents >= MAX_FILL_CENTS && over.status === 409, JSON.stringify([store.db.runs[big].costCents, over]));
  const bigDone = await call('POST', `/v1/runs/${big}/finish`, { token, body: { filled: 3 } });
  check('and is charged no more than the cap', bigDone.data.charge.cents <= MAX_FILL_CENTS * 3, JSON.stringify(bigDone.data));

  // --- calls at once ---
  {
    let release;
    const gate = new Promise(r => { release = r; });
    const slowStore = memoryStore();
    const slow = http.createServer(createHandler({ store: slowStore, env, fetchImpl: async (url, init) => { await gate; return fakeFetch(url, init); } }));
    await new Promise(r => slow.listen(0, '127.0.0.1', r));
    const at = `http://127.0.0.1:${slow.address().port}`;
    const post = (path, tok, body, headers = {}) => fetch(at + path, { method: 'POST',
      headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...headers }, body: JSON.stringify(body) });
    const tok = (await (await post('/v1/accounts')).json()).token;
    const runId = (await (await post('/v1/runs', tok, { applicationKey: 'acme.example/jobs/burst' })).json()).runId;
    const burst = Array.from({ length: 13 }, () =>
      post('/v1/relay/deepseek', tok, { model: 'deepseek-flash', max_tokens: 900 }, { 'x-philform-run': runId }));
    await new Promise(r => setTimeout(r, 200));
    release();
    const statuses = (await Promise.all(burst)).map(r => r.status).sort();
    check('a run has at most 12 relay calls out at once', statuses.filter(x => x === 200).length === 12 && statuses.includes(429), JSON.stringify(statuses));
    const after = await post('/v1/relay/deepseek', tok, { model: 'deepseek-flash', max_tokens: 900 }, { 'x-philform-run': runId });
    check('and takes more once they are back', after.status === 200, String(after.status));
    slow.close();
  }

  check('the email paid with keeps the wallet', account.email === 'pat.brien@example.com', account.email);

  // --- limits survive a restart, and free applications are capped per address ---
  {
    const kept = memoryStore();
    const first = http.createServer(createHandler({ store: kept, env: {}, fetchImpl: fakeFetch }));
    await new Promise(r => first.listen(0, '127.0.0.1', r));
    const at = `http://127.0.0.1:${first.address().port}`;
    for (let i = 0; i < 5; i++) await fetch(`${at}/v1/accounts`, { method: 'POST' });
    first.close();
    const second = http.createServer(createHandler({ store: kept, env: {}, fetchImpl: fakeFetch }));
    await new Promise(r => second.listen(0, '127.0.0.1', r));
    const again = await fetch(`http://127.0.0.1:${second.address().port}/v1/accounts`, { method: 'POST' });
    check('the daily account limit survives a restart', again.status === 429, again.status);
    check('the address is kept only as a hash', !JSON.stringify(kept.db.limits).includes('127.0.0.1'), JSON.stringify(kept.db.limits));
    second.close();
    const monthly = memoryStore();
    const h = createHandler({ store: monthly, env: {}, fetchImpl: fakeFetch });
    const third = http.createServer(h);
    await new Promise(r => third.listen(0, '127.0.0.1', r));
    // Past the month's free accounts from one address: an account, but no free applications.
    const bt = `http://127.0.0.1:${third.address().port}`;
    await fetch(`${bt}/v1/accounts`, { method: 'POST' });
    const mk = Object.keys(monthly.db.limits).find(k => k.startsWith('m|'));
    monthly.db.limits[mk] = 20;
    const capped = await (await fetch(`${bt}/v1/accounts`, { method: 'POST' })).json();
    check('past the month\'s free accounts from one address, a new one starts with none', capped.wallet?.freeLeft === 0, JSON.stringify(capped));
    third.close();
  }

  // --- the wallet's email: a code links it, and brings it back on a new install ---
  {
    const mail = [];
    const mailStore = memoryStore();
    const srv = http.createServer(createHandler({ store: mailStore, env: {}, fetchImpl: fakeFetch, sendMail: async m => { mail.push(m); } }));
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const at = `http://127.0.0.1:${srv.address().port}`;
    const ask = async (path, tok, body) => {
      const res = await fetch(at + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: JSON.stringify(body) });
      return { status: res.status, data: await res.json() };
    };
    const a = (await (await fetch(`${at}/v1/accounts`, { method: 'POST' })).json()).token;
    await ask('/v1/email/start', a, { email: 'pat@example.com' });
    const code = mail[0]?.text.match(/\d{6}/)?.[0];
    check('a code is emailed', mail.length === 1 && mail[0].to === 'pat@example.com' && !!code, JSON.stringify(mail));
    check('the code is kept only as a hash', !JSON.stringify(mailStore.db).includes(code));
    const wrong = await ask('/v1/email/verify', a, { email: 'pat@example.com', code: code === '000000' ? '111111' : '000000' });
    check('a wrong code is refused', wrong.status === 400, JSON.stringify(wrong));
    const linked = await ask('/v1/email/verify', a, { email: 'pat@example.com', code });
    check('the right code links the email', linked.data.linked === true, JSON.stringify(linked));
    const owner = Object.values(mailStore.db.accounts).find(x => x.email === 'pat@example.com');
    owner.wallet.balanceCents = 300;
    // A reinstall: a new anonymous account, then the same email.
    const b = (await (await fetch(`${at}/v1/accounts`, { method: 'POST' })).json()).token;
    Object.values(mailStore.db.accounts).find(x => x.id !== owner.id).wallet.balanceCents = 50;
    await ask('/v1/email/start', b, { email: ' PAT@example.com ' });
    const code2 = mail[1]?.text.match(/\d{6}/)?.[0];
    const back = await ask('/v1/email/verify', b, { email: 'pat@example.com', code: code2 });
    check('the same email on a new install brings the wallet back, with this browser\'s money added',
      back.data.restored === true && !!back.data.token && back.data.wallet.balanceCents === 350, JSON.stringify(back));
    const w = await (await fetch(`${at}/v1/wallet`, { headers: { authorization: `Bearer ${back.data.token}` } })).json();
    check('and the new token opens that wallet', w.email === 'pat@example.com' && w.wallet.balanceCents === 350, JSON.stringify(w));
    const none = createHandler({ store: memoryStore(), env: {}, fetchImpl: fakeFetch, sendMail: null });
    const s3 = http.createServer(none);
    await new Promise(r => s3.listen(0, '127.0.0.1', r));
    const at3 = `http://127.0.0.1:${s3.address().port}`;
    const t3 = (await (await fetch(`${at3}/v1/accounts`, { method: 'POST' })).json()).token;
    const off = await fetch(`${at3}/v1/email/start`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t3}` }, body: JSON.stringify({ email: 'pat@example.com' }) });
    check('without a mail account the email routes say so', off.status === 503, off.status);
    s3.close();
    srv.close();
  }

  // --- the practice form is free ---
  {
    const t4 = (await call('POST', '/v1/accounts')).data.token;
    const acct = Object.values(store.db.accounts).find(x => db_tokenOf(t4) === x.id);
    acct.wallet.freeLeft = 0;
    const demo = await fill(t4, 'philformapp.com/demo');
    check('a practice fill runs with nothing in the wallet, free', demo.start.status === 201 && demo.done.data.charge.demo === true, JSON.stringify(demo.done?.data));
    check('and uses no free application or money', acct.wallet.freeLeft === 0 && acct.wallet.balanceCents === 0 && acct.demoFills === 1);
    acct.demoFills = 5;
    check('past five practice fills it is an ordinary application', (await fill(t4, 'philformapp.com/demo')).start.status === 402);
  }

  // --- testing without Stripe ---
  const testEnv = createHandler({ store: memoryStore(), env: { PHILFORM_FREE_RELOADS: '1' }, fetchImpl: fakeFetch });
  const s2 = http.createServer(testEnv);
  await new Promise(r => s2.listen(0, '127.0.0.1', r));
  const b2 = `http://127.0.0.1:${s2.address().port}`;
  const t2 = (await (await fetch(`${b2}/v1/accounts`, { method: 'POST' })).json()).token;
  const r2 = await (await fetch(`${b2}/v1/wallet/reload`, { method: 'POST', headers: { authorization: `Bearer ${t2}`, 'content-type': 'application/json' }, body: JSON.stringify({ amountCents: 500 }) })).json();
  check('a test service credits a reload at once', r2.wallet?.balanceCents === 500, JSON.stringify(r2));
  s2.close();
} finally {
  server.close();
}

console.log(failures ? `\n${failures} backend check(s) failed.` : '\nThe backend works.');
process.exit(failures ? 1 : 0);
