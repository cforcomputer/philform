#!/usr/bin/env node
/**
 * philform's service: accounts, wallets, the model relay and payments.
 *
 * The extension in `proxy` mode talks to this instead of the model providers,
 * so no API key ships in the extension. Every user gets an anonymous account
 * with FREE_APPLICATIONS free applications; after those each fill is charged
 * what its model calls cost times PRICE_MULTIPLIER, capped, from a wallet
 * the user tops up (at least $5) through Stripe Checkout. The charging rules
 * are src/common/wallet.js and the prices src/background/cost.js, the same
 * files the extension uses, so the two can never disagree.
 *
 *   POST /v1/accounts                 -> { token, wallet }      an anonymous account
 *   GET  /v1/wallet                   -> { wallet }
 *   POST /v1/runs { applicationKey }  -> { runId, free, wallet } or 402 when empty
 *   POST /v1/relay/typesafe           the TypeSafe request, sent on with our key;
 *   POST /v1/relay/deepseek           the DeepSeek one; both need x-philform-run
 *                                     and are priced from the usage they report
 *   POST /v1/runs/:id/finish { filled } -> { charge, wallet }   charges what was metered
 *   POST /v1/wallet/reload { amountCents } -> { checkoutUrl }  a Stripe Checkout page
 *   POST /v1/stripe/webhook           Stripe's event; a paid checkout tops up the wallet
 *   GET  /v1/checkout/done            the page Stripe returns the user to
 *   POST /v1/waitlist { email }       early access, from the website's form
 *   POST /v1/reports { verdict, url, ... }  a thumbs up or down on a filled page, for review
 *                                     (the page's address and field labels, never answers)
 *   POST /v1/email/start { email }    a one-time code to that address, to keep the wallet under it
 *   POST /v1/email/verify { email, code } -> { linked } or { restored, token }: an email already
 *                                     holding a wallet brings it back to this browser
 *   GET  /v1/rules                    the rules pack (src/common/rules-default.js under the
 *                                     override file PHILFORM_RULES, when there is one): what
 *                                     the extension knows about forms, as data, so a fix
 *                                     ships without a store release. ETag and 304.
 *   GET  /health
 *
 * Every request but account creation, the webhook and the done page carries
 * `Authorization: Bearer <account token>`. Only a hash of each token is kept.
 *
 * Configuration, from the environment:
 *   PORT                    default 8787
 *   PUBLIC_URL              this service's address, for Stripe's return page
 *   TYPESAFE_API_KEY, DEEPSEEK_API_KEY
 *   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
 *   PHILFORM_DATA           the JSON file accounts are kept in (default backend/data/db.json)
 *   PHILFORM_RULES          a JSON file merged over the built-in rules pack (default backend/data/rules.json)
 *   PHILFORM_FREE_RELOADS=1 testing only: a reload is credited at once, no Stripe
 *   SMTP_HOST, SMTP_PORT (465), SMTP_USER, SMTP_PASS, MAIL_FROM   the mail account the
 *                           sign-in codes are sent from (TLS); without them the email routes say
 *                           they are not set up
 *   PHILFORM_IP_SALT        mixed into the hash the per-address limits are kept under
 *
 * Storage is one JSON file written on every change: right for testing and a
 * first few hundred users, to be replaced by a database before real traffic.
 * No dependencies: Node 22 or later.
 */

import http from 'node:http';
import tls from 'node:tls';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callCents, MAX_FILL_CENTS } from '../src/background/cost.js';
import { newWallet, canStart, settleFill, reload, walletView, MIN_RELOAD_CENTS } from '../src/common/wallet.js';
import { DEFAULT_RULES_PACK } from '../src/common/rules-default.js';
import { mergeRaw } from '../src/common/rulespack.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const UPSTREAM = {
  typesafe: 'https://api.typesafe.ai/v1/systemone',
  deepseek: 'https://api.deepseek.com/chat/completions'
};

const MAX_BODY = 2_000_000;
const RUN_TTL_MS = 60 * 60 * 1000;             // a run left open this long can no longer relay
// The cap is checked before each call, so these bound how far a run can pass it:
// the writer asks for at most 18,500 (writerBudget plus reasoning, write.js), and runs fewer at once.
const MAX_RELAY_TOKENS = 20000;
const MAX_IN_FLIGHT = 12;
const inFlight = new Map();                    // run id -> relay calls now out
const ACCOUNTS_PER_IP_PER_DAY = 5;             // free applications are per account: slow down farming them
const MAX_RELOAD_CENTS = 10_000;               // $100, so a typo cannot charge a card $5,000
const SIGNUPS_PER_IP_PER_DAY = 10;             // the website's early-access form
const REPORTS_PER_ACCOUNT_PER_DAY = 50;        // thumbs on filled pages
const FREE_ACCOUNTS_PER_IP_PER_MONTH = 20;     // past this, a new account from one address starts with no free
                                               // applications (a reinstall farming them); generous, since a
                                               // library or campus puts many people behind one address
const CODES_PER_EMAIL_PER_DAY = 5;
const CODES_PER_IP_PER_DAY = 15;
const CODE_TTL_MS = 15 * 60 * 1000;
const CODE_TRIES = 5;
/** The practice form on the website: its fills are free, a few per account. */
export const DEMO_APP_KEY = 'philformapp.com/demo';
const DEMO_FILLS = 5;
const MAX_REPORTS = 5000;                      // kept newest first
const MAX_REPORT_CHARS = 60_000;               // one report's JSON

/**
 * Who is asking. Behind Caddy every request comes from 127.0.0.1, which made
 * the per-address limits one limit for everyone: five new accounts a day for
 * the whole service. Caddy appends the client's address to X-Forwarded-For;
 * the last entry is the one it added, so a client cannot choose it.
 */
export function clientIp(req) {
  const socket = req.socket?.remoteAddress || '';
  const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean);
  const loopback = /^(127\.|::1$|::ffff:127\.)/.test(socket);
  return loopback && forwarded.length ? forwarded[forwarded.length - 1] : socket;
}

// --- storage --------------------------------------------------------------------

/** A JSON-file store: { accounts: { id: {...} }, tokens: { hash: id }, runs: {...}, paidSessions: [...] }. */
export function fileStore(file) {
  let db = { accounts: {}, tokens: {}, runs: {}, paidSessions: [], waitlist: [], reports: [], limits: {}, emailCodes: {} };
  try {
    db = { ...db, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch { /* a new store */ }
  return {
    db,
    save() {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, file);
    }
  };
}

/** The same store in memory, for tests. */
export function memoryStore() {
  return { db: { accounts: {}, tokens: {}, runs: {}, paidSessions: [], waitlist: [], reports: [], limits: {}, emailCodes: {} }, save() {} };
}

const hash = token => crypto.createHash('sha256').update(token).digest('hex');
const newId = () => crypto.randomBytes(12).toString('base64url');

// --- Stripe -------------------------------------------------------------------------

/** Form-encode nested params the way Stripe's API wants: a[b][c]=v. */
function stripeForm(params, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(params)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v && typeof v === 'object') out.push(stripeForm(v, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out.filter(Boolean).join('&');
}

/**
 * Whether a webhook body was signed by Stripe with `secret`: the header is
 * "t=<time>,v1=<hmac>", the HMAC-SHA256 of "<time>.<body>". Five minutes of
 * tolerance against replays.
 */
export function stripeSigned(rawBody, header, secret, now = Date.now()) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(String(header).split(',').map(kv => kv.split('=')));
  const sigs = String(header).split(',').filter(kv => kv.startsWith('v1=')).map(kv => kv.slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length || Math.abs(now / 1000 - t) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return sigs.some(s => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

// --- mail ----------------------------------------------------------------------------

/**
 * A minimal SMTP client over TLS (port 465), enough to send one plain-text
 * message: no dependencies, like the rest of the service. Works with any
 * mail account that allows SMTP with a password (an app password for Gmail
 * or Fastmail, a transactional provider's SMTP login).
 */
export function smtpMailer({ host, port = 465, user, pass, from }) {
  const address = String(from).match(/<([^>]+)>/)?.[1] || String(from);
  return ({ to, subject, text }) => new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port: Number(port) || 465, servername: host });
    socket.setEncoding('utf8');
    socket.setTimeout(15000, () => socket.destroy(new Error('The mail server did not answer.')));
    const body = [
      `From: ${from}`, `To: ${to}`, `Subject: ${subject}`, `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${crypto.randomBytes(12).toString('hex')}@${address.split('@')[1] || 'philform'}>`,
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '',
      ...String(text).split(/\r?\n/).map(line => (line.startsWith('.') ? `.${line}` : line))
    ].join('\r\n');
    const steps = [
      [220, () => `EHLO philform`],
      [250, () => `AUTH PLAIN ${Buffer.from(`\0${user}\0${pass}`).toString('base64')}`],
      [235, () => `MAIL FROM:<${address}>`],
      [250, () => `RCPT TO:<${to}>`],
      [250, () => 'DATA'],
      [354, () => `${body}\r\n.`],
      [250, () => 'QUIT']
    ];
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      // A reply is complete at a line "NNN text" (a dash after the code means more lines follow).
      const lines = buffer.split('\r\n');
      const last = lines.filter(Boolean).pop() || '';
      if (!/^\d{3} /.test(last) || !buffer.endsWith('\r\n')) return;
      buffer = '';
      const code = Number(last.slice(0, 3));
      const step = steps.shift();
      if (!step) { socket.end(); return resolve(); }
      if (code !== step[0]) { socket.destroy(); return reject(new Error(`The mail server said: ${last.slice(0, 200)}`)); }
      socket.write(`${step[1]()}\r\n`);
    });
    socket.on('error', reject);
    socket.on('close', () => (steps.length ? reject(new Error('The mail server closed the connection.')) : resolve()));
  });
}

/** The mailer the environment configures, or null. */
export function envMailer(env) {
  return env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.MAIL_FROM
    ? smtpMailer({ host: env.SMTP_HOST, port: env.SMTP_PORT, user: env.SMTP_USER, pass: env.SMTP_PASS, from: env.MAIL_FROM })
    : null;
}

// --- the service ---------------------------------------------------------------------

/**
 * The request handler. `store` keeps the data, `env` the configuration,
 * `fetchImpl` reaches the model providers and Stripe (replaced in tests).
 */
export function createHandler({ store, env = process.env, fetchImpl = fetch, now = () => Date.now(), sendMail = envMailer(env) }) {
  const db = store.db;
  db.limits = db.limits || {};
  db.emailCodes = db.emailCodes || {};

  /**
   * Counters kept in the store, so a restart or a deploy does not reset them
   * (they were in memory). Addresses and emails are kept only as hashes.
   * `bump` counts one and says whether it was still under `max`.
   */
  const day = () => new Date(now()).toISOString().slice(0, 10);
  const month = () => new Date(now()).toISOString().slice(0, 7);
  const secret = value => crypto.createHash('sha256').update(`${env.PHILFORM_IP_SALT || 'philform'}|${value}`).digest('hex').slice(0, 24);
  const bump = (key, max) => {
    const n = db.limits[key] || 0;
    if (n >= max) return false;
    db.limits[key] = n + 1;
    // Old days and months go: only the current ones are ever read.
    const keep = new Set([day(), month()]);
    for (const k of Object.keys(db.limits)) if (!keep.has(k.split('|')[1])) delete db.limits[k];
    return true;
  };
  const normEmail = value => String(value || '').trim().toLowerCase().slice(0, 254);
  const validEmail = email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const ownerOf = email => Object.values(db.accounts).find(a => a.email === email) || null;

  const send = (res, status, body, headers = {}) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, {
      'content-type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json',
      ...headers
    });
    res.end(text);
  };

  const readBody = req => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Request too large.'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

  const json = raw => {
    try { return raw ? JSON.parse(raw) : {}; } catch { throw Object.assign(new Error('The body is not JSON.'), { status: 400 }); }
  };

  const accountOf = req => {
    const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    const id = m && db.tokens[hash(m[1].trim())];
    return id ? db.accounts[id] : null;
  };

  const view = account => walletView(account.wallet);

  /** The built-in rules pack under the server's override file, read each time (it is small, and edited by hand). */
  const rulesPack = () => {
    const file = env.PHILFORM_RULES || path.join(HERE, 'data', 'rules.json');
    try {
      const over = JSON.parse(fs.readFileSync(file, 'utf8'));
      return mergeRaw(DEFAULT_RULES_PACK, over && typeof over === 'object' ? over : null);
    } catch {
      return DEFAULT_RULES_PACK;
    }
  };

  async function route(req, res, url) {
    const p = url.pathname;

    if (req.method === 'GET' && p === '/health') return send(res, 200, { ok: true });

    if (req.method === 'GET' && p === '/v1/rules') {
      const body = JSON.stringify(rulesPack());
      const etag = `"${crypto.createHash('sha1').update(body).digest('hex').slice(0, 16)}"`;
      const headers = { etag, 'cache-control': 'public, max-age=300' };
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/json', ...headers });
      return res.end(body);
    }

    if (req.method === 'GET' && p === '/v1/checkout/done') {
      const cancelled = url.searchParams.has('cancelled');
      return send(res, 200, `<!doctype html><meta charset="utf-8"><title>philform</title>
<body style="font:16px system-ui;text-align:center;padding:48px">
<h1>${cancelled ? 'No charge made' : 'Your wallet is topped up'}</h1>
<p>${cancelled ? 'You can add money any time from the philform popup.' : 'Thank you! You can close this tab and keep filling.'}</p></body>`);
    }

    if (req.method === 'POST' && p === '/v1/accounts') {
      const ip = secret(clientIp(req));
      if (!bump(`a|${day()}|${ip}`, ACCOUNTS_PER_IP_PER_DAY)) { store.save(); return send(res, 429, { error: 'Too many new accounts from here today.' }); }
      // Free applications are per account, and a reinstall makes a new one:
      // past this many from one address in a month, a new account starts
      // without them (it can still be topped up, or restored by email).
      const withFree = bump(`m|${month()}|${ip}`, FREE_ACCOUNTS_PER_IP_PER_MONTH);
      const token = crypto.randomBytes(32).toString('base64url');
      const account = { id: newId(), createdAt: now(), wallet: withFree ? newWallet() : { ...newWallet(), freeLeft: 0 } };
      db.accounts[account.id] = account;
      db.tokens[hash(token)] = account.id;
      store.save();
      return send(res, 201, { token, wallet: view(account) });
    }

    if (req.method === 'POST' && p === '/v1/waitlist') {
      const body = json(await readBody(req));
      // A field people never see: a bot that fills it is told yes and kept out.
      if (body.website) return send(res, 201, { ok: true });
      const email = String(body.email || '').trim().toLowerCase().slice(0, 254);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return send(res, 400, { error: 'That email address does not look right.' });
      if (!bump(`w|${day()}|${secret(clientIp(req))}`, SIGNUPS_PER_IP_PER_DAY)) { store.save(); return send(res, 429, { error: 'Too many sign-ups from here today.' }); }
      db.waitlist = db.waitlist || [];
      if (!db.waitlist.some(w => w.email === email)) {
        db.waitlist.push({ email, at: now(), browser: String(body.browser || '').slice(0, 20) });
        store.save();
      }
      return send(res, 201, { ok: true });
    }

    if (req.method === 'POST' && p === '/v1/stripe/webhook') {
      const raw = await readBody(req);
      if (!stripeSigned(raw, req.headers['stripe-signature'], env.STRIPE_WEBHOOK_SECRET, now())) return send(res, 400, { error: 'Bad signature.' });
      const event = json(raw);
      const session = event.data?.object || {};
      if (event.type === 'checkout.session.completed' && session.payment_status === 'paid') {
        // Stripe may send an event more than once: credit each checkout once.
        if (!db.paidSessions.includes(session.id)) {
          const account = db.accounts[session.metadata?.account || session.client_reference_id];
          if (account) {
            account.wallet = reload(account.wallet, session.amount_total);
            // The email paid with keeps the wallet: it can be restored by a
            // code sent there, after a reinstall or on another computer.
            const paidWith = normEmail(session.customer_details?.email || session.customer_email);
            if (!account.email && validEmail(paidWith) && !ownerOf(paidWith)) {
              account.email = paidWith;
              account.emailFrom = 'stripe';
            }
            db.paidSessions.push(session.id);
            store.save();
          }
        }
      }
      return send(res, 200, { received: true });
    }

    const account = accountOf(req);
    if (!account) return send(res, 401, { error: 'Not signed in.' });

    if (req.method === 'GET' && p === '/v1/wallet') return send(res, 200, { wallet: view(account), email: account.email || null });

    if (req.method === 'POST' && p === '/v1/email/start') {
      const email = normEmail(json(await readBody(req)).email);
      if (!validEmail(email)) return send(res, 400, { error: 'That email address does not look right.' });
      if (!sendMail) return send(res, 503, { error: 'Keeping your wallet by email is not set up yet.' });
      if (!bump(`ec|${day()}|${secret(email)}`, CODES_PER_EMAIL_PER_DAY) || !bump(`ei|${day()}|${secret(clientIp(req))}`, CODES_PER_IP_PER_DAY)) {
        store.save();
        return send(res, 429, { error: 'Too many codes today. Try again tomorrow.' });
      }
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      db.emailCodes[secret(email)] = { account: account.id, code: hash(code), expires: now() + CODE_TTL_MS, tries: 0 };
      store.save();
      try {
        await sendMail({ to: email, subject: `Your philform code: ${code}`,
          text: `Your philform code is ${code}\n\nType it into philform to keep your wallet under this email. It works for 15 minutes.\n\nIf you did not ask for it, you can ignore this email.\n\nphil` });
      } catch (err) {
        console.error('mail', err.message);
        return send(res, 502, { error: 'The code could not be sent. Try again in a moment.' });
      }
      return send(res, 200, { sent: true });
    }

    if (req.method === 'POST' && p === '/v1/email/verify') {
      const body = json(await readBody(req));
      const email = normEmail(body.email);
      const pending = db.emailCodes[secret(email)];
      if (!pending || pending.account !== account.id || pending.expires < now()) return send(res, 400, { error: 'That code has expired. Ask for a new one.' });
      if (pending.code !== hash(String(body.code || '').replace(/\D/g, ''))) {
        pending.tries += 1;
        if (pending.tries >= CODE_TRIES) delete db.emailCodes[secret(email)];
        store.save();
        return send(res, 400, { error: pending.tries >= CODE_TRIES ? 'Too many wrong codes. Ask for a new one.' : 'That code is not right.' });
      }
      delete db.emailCodes[secret(email)];
      const owner = ownerOf(email);
      if (owner && owner.id !== account.id) {
        // The email keeps another wallet: this browser now uses it, and any
        // money in this browser's wallet goes along (its free applications do not).
        const moved = Math.max(0, account.wallet.balanceCents || 0);
        if (moved) {
          owner.wallet = { ...owner.wallet, balanceCents: (owner.wallet.balanceCents || 0) + moved, reloadedCents: (owner.wallet.reloadedCents || 0) + moved };
          account.wallet = { ...account.wallet, balanceCents: 0 };
          account.mergedInto = owner.id;
        }
        const token = crypto.randomBytes(32).toString('base64url');
        db.tokens[hash(token)] = owner.id;
        store.save();
        return send(res, 200, { restored: true, token, email, wallet: view(owner) });
      }
      account.email = email;
      account.emailFrom = 'code';
      store.save();
      return send(res, 200, { linked: true, email, wallet: view(account) });
    }

    if (req.method === 'POST' && p === '/v1/runs') {
      const body = json(await readBody(req));
      const appKey = String(body.applicationKey || '').slice(0, 500);
      // The website's practice form: free, a few times per account, whatever the wallet holds.
      const demo = appKey === DEMO_APP_KEY && (account.demoFills || 0) < DEMO_FILLS;
      const start = demo ? { allowed: true, free: true } : canStart(account.wallet, appKey);
      if (!start.allowed) return send(res, 402, { error: 'Your wallet is empty.', wallet: view(account) });
      const run = { id: newId(), account: account.id, appKey, demo, costCents: 0, calls: 0, startedAt: now(), finished: null };
      db.runs[run.id] = run;
      // Old runs are only needed until they are finished or expire.
      for (const [id, r] of Object.entries(db.runs)) if (now() - r.startedAt > 7 * RUN_TTL_MS) delete db.runs[id];
      store.save();
      return send(res, 201, { runId: run.id, free: start.free, wallet: view(account) });
    }

    const relay = p.match(/^\/v1\/relay\/(typesafe|deepseek)$/);
    if (req.method === 'POST' && relay) {
      const provider = relay[1];
      const run = db.runs[String(req.headers['x-philform-run'] || '')];
      if (!run || run.account !== account.id || run.finished || now() - run.startedAt > RUN_TTL_MS) {
        return send(res, 410, { error: 'No open run.' });
      }
      if (run.costCents >= MAX_FILL_CENTS) return send(res, 409, { error: 'This fill reached its spending cap.' });
      const key = provider === 'typesafe' ? env.TYPESAFE_API_KEY : env.DEEPSEEK_API_KEY;
      if (!key) return send(res, 503, { error: `The ${provider} key is not configured.` });
      const raw = await readBody(req);
      const body = json(raw);
      if (provider === 'deepseek' && !(Number(body.max_tokens) > 0 && Number(body.max_tokens) <= MAX_RELAY_TOKENS)) {
        return send(res, 400, { error: `max_tokens must be between 1 and ${MAX_RELAY_TOKENS}.` });
      }
      if ((inFlight.get(run.id) || 0) >= MAX_IN_FLIGHT) return send(res, 429, { error: 'Too many requests at once.' });
      inFlight.set(run.id, (inFlight.get(run.id) || 0) + 1);
      let upstream, text;
      try {
        upstream = await fetchImpl(UPSTREAM[provider], {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: raw
        });
        text = await upstream.text();
      } finally {
        const left = inFlight.get(run.id) - 1;
        if (left > 0) inFlight.set(run.id, left); else inFlight.delete(run.id);
      }
      let reply = null;
      try { reply = JSON.parse(text); } catch { /* passed on as it came */ }
      if (upstream.ok && reply?.usage) {
        run.costCents += callCents(provider, reply.model || body.model, reply.usage, new Date(now()));
        run.calls += 1;
        store.save();
      }
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' });
      return res.end(text);
    }

    const finish = p.match(/^\/v1\/runs\/([\w-]+)\/finish$/);
    if (req.method === 'POST' && finish) {
      const run = db.runs[finish[1]];
      if (!run || run.account !== account.id) return send(res, 404, { error: 'No such run.' });
      // Finishing twice charges once.
      if (!run.finished) {
        const body = json(await readBody(req));
        if (run.demo) {
          // A practice fill: free, and no free application used.
          account.demoFills = (account.demoFills || 0) + 1;
          run.finished = { at: now(), charge: { free: true, demo: true, cents: 0, costCents: run.costCents, freeLeft: account.wallet.freeLeft } };
          store.save();
          return send(res, 200, { charge: run.finished.charge, wallet: view(account) });
        }
        // Charged from what the relay metered, never from what the extension says.
        const { wallet, charge } = settleFill(account.wallet, { appKey: run.appKey, costCents: run.costCents, filled: Number(body.filled) || 0 });
        account.wallet = wallet;
        run.finished = { at: now(), charge };
        store.save();
      }
      return send(res, 200, { charge: run.finished.charge, wallet: view(account) });
    }

    // A thumbs up or down from the popup after a fill. The page's address,
    // the verdict, counts and field labels, so a page phil filled badly can
    // be reproduced and fixed; answers are never sent. A later note for the
    // same report (its id) is merged into it.
    if (req.method === 'POST' && p === '/v1/reports') {
      const raw = await readBody(req);
      if (raw.length > MAX_REPORT_CHARS) return send(res, 413, { error: 'Report too large.' });
      const body = json(raw);
      const verdict = body.verdict === 'up' ? 'up' : 'down';
      const url = String(body.url || '').slice(0, 2000);
      if (!/^https?:\/\//.test(url)) return send(res, 400, { error: 'No page address.' });
      if (!bump(`r|${day()}|${account.id}`, REPORTS_PER_ACCOUNT_PER_DAY)) { store.save(); return send(res, 429, { error: 'Too many reports today.' }); }
      db.reports = db.reports || [];
      const id = String(body.id || newId()).slice(0, 40);
      const strings = list => (Array.isArray(list) ? list.slice(0, 300).map(x => String(x?.label ?? x).slice(0, 200)) : []);
      const counts = Object.fromEntries(Object.entries(body.counts || {}).filter(([, v]) => typeof v === 'number').slice(0, 40));
      const report = {
        id, account: account.id, at: now(), verdict, url, site: String(body.site || '').slice(0, 200),
        note: String(body.note || '').slice(0, 4000), error: String(body.error || '').slice(0, 1000),
        counts, possiblyMissed: strings(body.possiblyMissed), fields: strings(body.fields),
        platform: String(body.platform || '').slice(0, 40),
        build: String(body.build || '').slice(0, 40), browser: String(body.browser || '').slice(0, 20), status: 'new'
      };
      const i = db.reports.findIndex(r => r.id === id && r.account === account.id);
      if (i >= 0) db.reports[i] = { ...db.reports[i], ...report, at: db.reports[i].at, note: report.note || db.reports[i].note };
      else db.reports.unshift(report);
      if (db.reports.length > MAX_REPORTS) db.reports.length = MAX_REPORTS;
      store.save();
      return send(res, 201, { ok: true, id });
    }

    if (req.method === 'POST' && p === '/v1/wallet/reload') {
      const body = json(await readBody(req));
      const cents = Math.round(Number(body.amountCents) || MIN_RELOAD_CENTS);
      if (cents < MIN_RELOAD_CENTS || cents > MAX_RELOAD_CENTS) {
        return send(res, 400, { error: `A reload is between $${MIN_RELOAD_CENTS / 100} and $${MAX_RELOAD_CENTS / 100}.` });
      }
      if (env.PHILFORM_FREE_RELOADS === '1') {
        account.wallet = reload(account.wallet, cents);
        store.save();
        return send(res, 200, { wallet: view(account) });
      }
      // Without the webhook's secret a paid checkout could never be credited: take no money.
      if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) return send(res, 503, { error: 'Payments are not set up yet.' });
      const back = `${String(env.PUBLIC_URL || '').replace(/\/$/, '')}/v1/checkout/done`;
      const made = await fetchImpl('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: stripeForm({
          mode: 'payment',
          success_url: back,
          cancel_url: `${back}?cancelled=1`,
          client_reference_id: account.id,
          metadata: { account: account.id },
          line_items: { 0: { quantity: 1, price_data: { currency: 'usd', unit_amount: cents, product_data: { name: 'philform wallet top-up' } } } }
        })
      });
      const session = await made.json().catch(() => ({}));
      if (!made.ok || !session.url) return send(res, 502, { error: 'Could not start the payment.' });
      return send(res, 200, { checkoutUrl: session.url });
    }

    return send(res, 404, { error: 'Not found.' });
  }

  return async (req, res) => {
    // The extension calls from its own origin.
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type, x-philform-run, if-none-match',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-expose-headers': 'etag'
    };
    for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    try {
      await route(req, res, new URL(req.url, 'http://localhost'));
    } catch (err) {
      if (!res.headersSent) send(res, err.status || 500, { error: err.status ? err.message : 'Something went wrong.' });
      if (!err.status) console.error(err);
    }
  };
}

// Run directly: node backend/server.mjs
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const store = fileStore(process.env.PHILFORM_DATA || path.join(HERE, 'data', 'db.json'));
  const port = Number(process.env.PORT) || 8787;
  http.createServer(createHandler({ store })).listen(port, () => console.log(`philform service on http://localhost:${port}`));
}
