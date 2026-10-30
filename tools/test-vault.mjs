#!/usr/bin/env node
/**
 * Checks for the password lock (src/background/vault.js through storage.js),
 * on Node's WebCrypto with chrome.storage faked in memory.
 *
 *   node tools/test-vault.mjs
 */

const memory = () => {
  const data = {};
  return {
    data,
    async get(keys) {
      if (keys === null || keys === undefined) return { ...data };
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter(k => k in data).map(k => [k, data[k]]));
    },
    async set(obj) { Object.assign(data, JSON.parse(JSON.stringify(obj))); },
    async remove(keys) { for (const k of [].concat(keys)) delete data[k]; },
    async clear() { for (const k of Object.keys(data)) delete data[k]; }
  };
};
const local = memory();
const session = memory();
globalThis.chrome = { storage: { local, session } };

const store = await import('../src/background/storage.js');

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `: ${detail}`}`);
  if (!ok) failures++;
};

console.log('== password lock ==');
await store.saveProfile({ 'identity.firstName': 'Pat', 'contact.phone': '415-555-0134' });
await store.saveResponses([{ id: 'r1', text: 'I like street lights.' }]);
check('without the lock the profile is a plain key', local.data.profile?.['identity.firstName'] === 'Pat');

await store.enablePasswordLock('hunter22');
check('turning the lock on removes the plain copies', !local.data.profile && !local.data.responses, Object.keys(local.data).join(','));
check('the locked record holds no readable details', !JSON.stringify(local.data).includes('Pat') && !JSON.stringify(local.data).includes('555-0134'));
check('the password itself is stored nowhere', !JSON.stringify({ ...local.data, ...session.data }).includes('hunter22'));
check('it stays open in this session', (await store.getProfile())['identity.firstName'] === 'Pat');

await store.saveProfile({ ...(await store.getProfile()), 'address.city': 'Portland' });
check('a save while open is kept encrypted', (await store.getProfile())['address.city'] === 'Portland' && !JSON.stringify(local.data).includes('Portland'));

await store.lockNow();
let locked = false;
try { await store.getProfile(); } catch (err) { locked = !!err.locked; }
check('locked, reading the profile says it is locked', locked);
check('and the status says so', JSON.stringify(await store.lockStatus()) === JSON.stringify({ enabled: true, unlocked: false }));
check('a wrong password does not open it', (await store.unlock('wrong-one')) === false);
check('the right one does', (await store.unlock('hunter22')) === true && (await store.getProfile())['address.city'] === 'Portland');

const exported = await store.exportAll({ parts: ['profile', 'responses'] });
check('an export while open holds the details, not the locked record', exported.data.profile?.['identity.firstName'] === 'Pat' && !('vault' in exported.data), JSON.stringify(exported.includes));

await store.changePassword('hunter22', 'new-secret');
await store.lockNow();
check('after a change only the new password opens it', !(await store.unlock('hunter22')) && (await store.unlock('new-secret')));

let refused = false;
try { await store.disableLock('nope-nope'); } catch { refused = true; }
check('turning it off needs the password', refused && !!local.data.vault);
await store.disableLock('new-secret');
check('turned off, the details are plain keys again', local.data.profile?.['address.city'] === 'Portland' && !local.data.vault && local.data.responses?.length === 1);

let short = false;
try { await store.enablePasswordLock('abc'); } catch { short = true; }
check('a password under 6 characters is refused', short && !local.data.vault);

console.log(failures ? `\n${failures} lock check(s) failed.` : '\nThe password lock works.');
process.exit(failures ? 1 : 0);
