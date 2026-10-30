/**
 * Paying for fills: the wallet (src/common/wallet.js) around each run.
 *
 * Which wallet applies:
 *   - Through philform's service (`proxy` mode) the backend holds it
 *     (backend/server.mjs). A run is opened there first, which says whether
 *     the user can fill; model requests go through its relay tagged with the
 *     run; finishing the run charges what the relay metered.
 *   - The dev build (tools/dev.py) keeps one here in storage, so the wallet can
 *     be tried with your own keys. It starts with the free applications and
 *     $5, and when it runs out it starts over with both, so testing never stops.
 *   - With your own keys outside the dev build there is nothing to charge.
 *
 * An anonymous account is made on the backend the first time it is needed,
 * so a user never types a token.
 */

import { getSettings, saveSettings } from './storage.js';
import { devConfig } from './dev.js';
import { applicationKey } from './timesaved.js';
import { useRelay } from './llm/relay.js';
import { newWallet, canStart, settleFill, reload, walletView, MIN_RELOAD_CENTS } from '../common/wallet.js';

const KEY = 'wallet';
const DEV_START_CENTS = MIN_RELOAD_CENTS;

export const EMPTY_WALLET = 'Your wallet is empty. Add $5 to keep filling.';

/** 'remote', 'local' (dev build) or null (own keys: nothing to charge). */
export async function walletKind(settings) {
  if (settings.mode === 'proxy') return 'remote';
  return (await devConfig()) ? 'local' : null;
}

// --- the dev build's own wallet ----------------------------------------------

const devStart = () => newWallet({ balanceCents: DEV_START_CENTS });

async function loadLocal() {
  const res = await chrome.storage.local.get(KEY);
  return res[KEY] || devStart();
}

async function saveLocal(wallet) {
  await chrome.storage.local.set({ [KEY]: wallet });
}

/** Spent down to nothing: start over with the free applications and $5. */
const refilled = w => (w.freeLeft > 0 || w.balanceCents > 0 ? w : devStart());

// --- the backend's wallet ------------------------------------------------------

async function api(settings, method, path, body) {
  if (!settings.proxyUrl) throw new Error('philform is not set up yet: no service address in Settings.');
  const base = settings.proxyUrl.replace(/\/$/, '');
  let token = settings.proxyToken;
  if (!token) {
    // First use: an anonymous account, which comes with the free applications.
    const made = await fetch(`${base}/v1/accounts`, { method: 'POST' }).catch(() => null);
    if (!made?.ok) throw new Error('Could not reach philform. Check your connection and try again.');
    token = (await made.json()).token;
    await saveSettings({ proxyToken: token });
  }
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined
  }).catch(() => null);
  if (!res) throw new Error('Could not reach philform. Check your connection and try again.');
  const data = await res.json().catch(() => ({}));
  if (res.status === 402) throw new Error(EMPTY_WALLET);
  if (res.status === 401 || res.status === 403) throw new Error('philform could not sign you in. Reload the extension and try again.');
  if (!res.ok) throw new Error(data.error || `philform's service returned ${res.status}.`);
  return { data, token };
}

// --- a run ---------------------------------------------------------------------

/**
 * Before a fill: may it start? Returns the run to finish later, or throws
 * EMPTY_WALLET. Through the service, model requests go through the relay
 * from here until finishRun or endRun.
 */
export async function startRun({ url }) {
  const settings = await getSettings();
  const kind = await walletKind(settings);
  const appKey = applicationKey(url);
  if (kind === 'local') {
    let wallet = await loadLocal();
    if (!canStart(wallet, appKey).allowed) {
      wallet = devStart();
      await saveLocal(wallet);
    }
    return { kind, appKey };
  }
  if (kind === 'remote') {
    const { data, token } = await api(settings, 'POST', '/v1/runs', { applicationKey: appKey });
    useRelay({ url: settings.proxyUrl, token, runId: data.runId });
    return { kind, appKey, runId: data.runId };
  }
  return { kind: null, appKey };
}

/**
 * After a fill: charge it. `costCents` is what the fill's model calls cost
 * (the backend charges what its relay metered, not this). Returns
 * `{ free, cents, freeLeft, balanceCents }`, or null when nothing is charged.
 */
export async function finishRun(run, { costCents, filled }) {
  try {
    if (run?.kind === 'local') {
      const { wallet, charge } = settleFill(await loadLocal(), { appKey: run.appKey, costCents, filled });
      const next = refilled(wallet);
      await saveLocal(next);
      return { ...charge, balanceCents: wallet.balanceCents, refilled: next !== wallet };
    }
    if (run?.kind === 'remote') {
      const settings = await getSettings();
      const { data } = await api(settings, 'POST', `/v1/runs/${encodeURIComponent(run.runId)}/finish`, { filled, costCents });
      return { ...data.charge, balanceCents: data.wallet.balanceCents };
    }
    return null;
  } finally {
    endRun();
  }
}

/** A run that ended without finishing (an error, a cancel): stop relaying. */
export function endRun() {
  useRelay(null);
}

/** The wallet for the popup, or null when there is none. */
export async function walletStatus() {
  const settings = await getSettings();
  const kind = await walletKind(settings);
  if (kind === 'local') return { kind, dev: true, ...walletView(await loadLocal()) };
  if (kind === 'remote') {
    try {
      const { data } = await api(settings, 'GET', '/v1/wallet');
      // The email the wallet is kept under, if the user added one.
      return { kind, ...walletView(data.wallet), email: data.email || null };
    } catch (err) {
      return { kind, error: err.message };
    }
  }
  return null;
}

/**
 * Add money. The dev build's wallet takes it at once; through the service
 * the backend returns a checkout page to open (`{ checkoutUrl }`).
 */
export async function reloadWallet(cents = MIN_RELOAD_CENTS) {
  const settings = await getSettings();
  const kind = await walletKind(settings);
  if (kind === 'local') {
    const wallet = reload(await loadLocal(), cents);
    await saveLocal(wallet);
    return { wallet: walletView(wallet) };
  }
  if (kind === 'remote') {
    const { data } = await api(settings, 'POST', '/v1/wallet/reload', { amountCents: cents });
    // A checkout page to pay on; a test service credits at once instead.
    return data.checkoutUrl ? { checkoutUrl: data.checkoutUrl } : { wallet: data.wallet };
  }
  throw new Error('There is no wallet to reload with your own API keys.');
}

// --- the wallet's email ------------------------------------------------------------

/**
 * Send a one-time code to `email`. Only through philform's service: with
 * your own keys there is no wallet to keep.
 */
export async function startEmail(email) {
  const settings = await getSettings();
  if (settings.mode !== 'proxy') throw new Error('Only a wallet on philform\'s service can be kept under an email.');
  await api(settings, 'POST', '/v1/email/start', { email });
  return { sent: true };
}

/**
 * The code from the email. It links the email to this wallet or, when the
 * email already holds a wallet, brings that wallet back to this browser
 * (`restored`), with this browser's balance added to it.
 */
export async function verifyEmail(email, code) {
  const settings = await getSettings();
  const { data } = await api(settings, 'POST', '/v1/email/verify', { email, code });
  if (data.token) await saveSettings({ proxyToken: data.token });
  return { linked: !!data.linked, restored: !!data.restored, email: data.email || email, wallet: data.wallet ? walletView(data.wallet) : null };
}
