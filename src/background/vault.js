/**
 * The optional password lock on the user's personal data.
 *
 * With the lock on, the profile, saved answers, documents and saved reports
 * are kept in one encrypted record (`vault` in local storage) instead of as
 * plain keys: AES-GCM with a 256-bit key derived from the password
 * (PBKDF2-SHA-256, 310,000 rounds, a fresh salt each time the password is
 * set). The password itself is never stored. Unlocking puts the derived key
 * in session storage, which the browser keeps in memory only: closing the
 * browser locks it again, and "Lock now" does so at once.
 *
 * There is no recovery. A forgotten password means the data is gone, which
 * the Data tab says before the lock is turned on.
 *
 * storage.js reads and writes the locked keys through here; nothing else
 * needs to know the lock exists.
 */

const VAULT = 'vault';
const SESSION_KEY = 'vaultKey';
const ROUNDS = 310000;

export const LOCKED_MESSAGE = 'philform is locked. Enter your password to unlock it.';

export class LockedError extends Error {
  constructor() {
    super(LOCKED_MESSAGE);
    this.locked = true;
  }
}

const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));

// Large documents: base64 in chunks, since spreading megabytes into one call overflows the stack.
function bigB64(bytes) {
  const view = new Uint8Array(bytes);
  let out = '';
  for (let i = 0; i < view.length; i += 0x8000) out += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(out);
}

async function derive(password, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ROUNDS, hash: 'SHA-256' }, base,
    { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

const session = () => chrome.storage.session;

async function sessionKey() {
  const raw = (await session()?.get(SESSION_KEY).catch(() => ({})))?.[SESSION_KEY];
  return raw ? crypto.subtle.importKey('raw', unb64(raw), 'AES-GCM', false, ['encrypt', 'decrypt']) : null;
}

async function rememberKey(key) {
  const raw = await crypto.subtle.exportKey('raw', key);
  await session().set({ [SESSION_KEY]: b64(raw) });
}

async function readVault() {
  return (await chrome.storage.local.get(VAULT))[VAULT] || null;
}

// The decrypted contents, kept while the vault is unchanged (each save makes a new iv).
let cache = null;

async function decrypt(vault, key) {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(vault.iv) }, key, unb64(vault.data));
  return JSON.parse(new TextDecoder().decode(plain));
}

async function seal(data, key, salt) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(data)));
  const vault = { v: 1, salt: b64(salt), iv: b64(iv), data: bigB64(cipher) };
  await chrome.storage.local.set({ [VAULT]: vault });
  cache = { iv: vault.iv, data };
  return vault;
}

/** Whether the lock is on, and whether it is open in this browser session. */
export async function lockStatus() {
  const vault = await readVault();
  if (!vault) return { enabled: false, unlocked: true };
  return { enabled: true, unlocked: !!(await sessionKey()) };
}

/** The locked data, or LockedError when the lock is on and closed. Null when the lock is off. */
export async function openVault() {
  const vault = await readVault();
  if (!vault) return null;
  if (cache?.iv === vault.iv) return cache.data;
  const key = await sessionKey();
  if (!key) throw new LockedError();
  const data = await decrypt(vault, key);
  cache = { iv: vault.iv, data };
  return data;
}

/** Write the locked data back, with the session's key. */
export async function writeVault(data) {
  const vault = await readVault();
  const key = await sessionKey();
  if (!vault || !key) throw new LockedError();
  return seal(data, key, unb64(vault.salt));
}

/**
 * Turn the lock on: the given keys' current values move into the vault and
 * their plain copies are removed. Unlocked for this session.
 */
export async function enableLock(password, keys) {
  if (String(password || '').length < 6) throw new Error('Use a password of at least 6 characters.');
  if (await readVault()) throw new Error('The lock is already on.');
  const plain = await chrome.storage.local.get(keys);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await derive(password, salt);
  await seal(plain, key, salt);
  await rememberKey(key);
  await chrome.storage.local.remove(keys);
}

/** Open the lock for this browser session. False for a wrong password. */
export async function unlock(password) {
  const vault = await readVault();
  if (!vault) return true;
  const key = await derive(password, unb64(vault.salt));
  try {
    cache = { iv: vault.iv, data: await decrypt(vault, key) };
  } catch {
    return false;
  }
  await rememberKey(key);
  return true;
}

/** Close the lock now. */
export async function lockNow() {
  cache = null;
  await session()?.remove(SESSION_KEY).catch(() => {});
}

/** A new password, given the current one. */
export async function changePassword(current, next) {
  if (String(next || '').length < 6) throw new Error('Use a password of at least 6 characters.');
  if (!(await unlock(current))) throw new Error('That is not your current password.');
  const data = await openVault();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await derive(next, salt);
  await seal(data, key, salt);
  await rememberKey(key);
}

/** Turn the lock off: the data goes back to plain keys. Needs the password. */
export async function disableLock(password) {
  if (!(await unlock(password))) throw new Error('That is not your password.');
  const data = await openVault();
  await chrome.storage.local.set(data || {});
  await chrome.storage.local.remove(VAULT);
  await lockNow();
}

/** Forget the vault entirely (Delete everything). */
export async function forgetVault() {
  cache = null;
  await chrome.storage.local.remove(VAULT);
  await session()?.remove(SESSION_KEY).catch(() => {});
}
