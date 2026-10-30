import { PROFILE_FIELDS, LISTS, blankEntry, normaliseProfile } from '../common/schema.js';
import { openVault, writeVault, lockStatus, enableLock, unlock, lockNow, changePassword, disableLock, forgetVault, LockedError } from './vault.js';

/**
 * Thin wrapper over chrome.storage. Everything Applicator keeps lives here.
 *
 * `local` holds the profile, site skills and run history, which can be large.
 * `sync` is deliberately unused: the profile contains personal data the user
 * may not want replicated to their browser account, and site skills routinely
 * exceed the per-item sync quota.
 */

const KEYS = {
  PROFILE: 'profile',
  SETTINGS: 'settings',
  SKILLS: 'skills',
  RESPONSES: 'responses',
  DOCUMENTS: 'documents',
  RUNS: 'runs',
  USAGE: 'usage',
  ISSUES: 'issues'
};

export const STORAGE_KEYS = KEYS;

/** philform's service: holds the model keys and the wallets. */
export const SERVICE_URL = 'https://philformapp.com';
/** Where feedback and help requests go (Cloudflare forwards it to the team). */
export const SUPPORT_EMAIL = 'support@philformapp.com';

export const DEFAULT_SETTINGS = {
  // --- providers ---------------------------------------------------------
  // 'proxy'  calls philform's service, which holds the keys and meters the wallet.
  // 'direct' calls the model APIs from this machine with your own keys (local testing).
  mode: 'proxy',
  proxyUrl: SERVICE_URL,
  proxyToken: '',


  // Which engine decides what goes in each field. TypeSafe answers a typed
  // choice, so it cannot return a value the page never offered; DeepSeek
  // returns text. Both scored 20/20 on the benchmark in tools/test-live.py.
  classifier: 'typesafe',
  // Who reads each field's question from the page: TypeSafe (structure.js), or
  // 'off' for the extractor's label rules alone (corpus comparisons).
  structure: 'typesafe',
  // Calibrated, so this is a meaningful gate. Below it a field is left blank.
  classifierConfidence: 0.6,

  typesafeApiKey: '',
  typesafeModel: 'jev-latest',

  deepseekApiKey: '',
  // The user's own DeepSeek key, used through philform's service too: written
  // answers then go straight to DeepSeek on the user's account, and the wallet
  // pays only for TypeSafe (relay.js).
  ownDeepseekKey: '',
  // Field matching. Reasoning is off: placing a stored value into a labelled
  // box needs none, and reasoning tokens bill at the output rate.
  deepseekModel: 'deepseek-flash',
  deepseekClassifyEffort: 'none',
  // Written answers. Pro drafts noticeably better prose than Flash.
  // Reasoning is off by default: measured against the real prompt, effort
  // "low" spent 7.7x more on output tokens than "none" and produced an answer
  // of the same length and quality. Raise it only if drafts disappoint.
  deepseekWriterModel: 'deepseek-v4-pro',
  deepseekWriterEffort: 'none',


  // --- behaviour ---------------------------------------------------------
  // Fields the heuristic matcher resolves never reach a model at all.
  useHeuristicsFirst: true,
  // What to do with long text boxes: cover letters, "why this company",
  // "describe a time when".
  //   write  - use a saved response if one matches, otherwise draft one
  //   canned - use a saved response if one matches, otherwise leave it empty
  //   skip   - never touch a long text box
  longTextMode: 'write',
  // Kept for compatibility with saved settings written before longTextMode
  // existed. `effectiveLongTextMode` below is what the run actually reads.
  writeLongAnswers: true,
  // Longest answer the writing model may produce, in words.
  longAnswerMaxWords: 180,
  // Fill voluntary demographic questions from the saved profile. On, because a
  // value only exists here if the user typed it in, and a form that asks the
  // question is the only place it is ever used. Clear the fields to opt out.
  fillDemographics: true,
  // "Can you pass a background and reference check?": yes, unless unticked.
  passBackgroundCheck: true,
  // "Why us?" questions get a quick look at the company (DeepSeek Flash) and
  // a writer that reasons: they can make or break an application.
  whyUsResearch: true,
  deepseekWhyUsEffort: 'low',
  // 'first' fills only the most recent job. 'all' fills as many employer blocks
  // as the page offers, from your saved history, most recent first.
  fillEmploymentHistory: 'all',
  // Attach the CV and cover letter stored in settings to upload fields.
  attachDocuments: true,
  // Highlight every field Applicator touched so review is quick.
  highlightFilled: true,
  // Replace values the page already had. Off by default so a part-filled
  // application, or a value the user typed themselves, is never clobbered.
  overwriteExisting: false,
  // Never true. Applicator does not submit applications; this constant exists
  // so the intent is explicit to anyone reading the code or reviewing it.
  autoSubmit: false,

  // --- the reward ------------------------------------------------------------
  // What an hour of the user's time is worth, for "time saved is worth $X".
  hourlyWage: 16,

  // --- site skills -------------------------------------------------------
  learnSkills: true,
  // A run slower than this many milliseconds is flagged for review in Options.
  slowRunThresholdMs: 12000,

  // --- privacy -----------------------------------------------------------
  // Keep the extracted field list and model output for each run, for debugging.
  keepRunHistory: true,
  maxRunHistory: 50,
  // Redact profile values from stored run history.
  redactHistory: true
};

async function area() {
  return chrome.storage.local;
}

/**
 * The user's personal data: with the password lock on (vault.js) these are
 * kept encrypted, and reading them while locked throws LockedError.
 */
const LOCKABLE = [KEYS.PROFILE, KEYS.RESPONSES, KEYS.DOCUMENTS, KEYS.ISSUES];

async function get(key, fallback) {
  if (LOCKABLE.includes(key)) {
    const vault = await openVault();
    if (vault) return vault[key] === undefined ? fallback : vault[key];
  }
  const store = await area();
  const res = await store.get(key);
  return res[key] === undefined ? fallback : res[key];
}

async function set(key, value) {
  if (LOCKABLE.includes(key)) {
    const vault = await openVault();
    if (vault) {
      await writeVault({ ...vault, [key]: value });
      return value;
    }
  }
  const store = await area();
  await store.set({ [key]: value });
  return value;
}

// --- the password lock (vault.js) ----------------------------------------------

export { LockedError, lockStatus, unlock, lockNow, changePassword, disableLock, forgetVault };
export const enablePasswordLock = password => enableLock(password, LOCKABLE);

// --- profile ---------------------------------------------------------------

export async function getProfile() {
  return normaliseProfile(await get(KEYS.PROFILE, {}));
}

export async function saveProfile(profile) {
  return set(KEYS.PROFILE, profile || {});
}

// --- settings --------------------------------------------------------------

export async function getSettings() {
  const stored = await get(KEYS.SETTINGS, {});
  // A blank service address (saved before there was a default) means ours.
  return { ...DEFAULT_SETTINGS, ...stored, proxyUrl: stored.proxyUrl || SERVICE_URL, autoSubmit: false };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch, autoSubmit: false };
  await set(KEYS.SETTINGS, next);
  return next;
}

/**
 * The long-text mode a run should use.
 *
 * An older saved settings object may carry `writeLongAnswers: false` and no
 * `longTextMode`. Honour that rather than silently start writing again.
 */
export function effectiveLongTextMode(settings) {
  if (settings.longTextMode) return settings.longTextMode;
  return settings.writeLongAnswers === false ? 'skip' : 'write';
}

// --- saved responses -------------------------------------------------------

export async function getResponses() {
  return get(KEYS.RESPONSES, []);
}

export async function saveResponses(responses) {
  return set(KEYS.RESPONSES, Array.isArray(responses) ? responses : []);
}

// --- stored documents ------------------------------------------------------

export async function getDocuments() {
  return normaliseDocuments(await get(KEYS.DOCUMENTS, {}));
}

/**
 * The stored files as { resumes: [...], coverLetter }. A user may keep a CV
 * for each kind of job; the first is the main one, whose text is the
 * profile's `documents.resumeText`, and each other keeps its own `text`.
 * Installs and exports from before carry one `resume`: it is read as a list
 * of one.
 */
export function normaliseDocuments(stored) {
  const docs = { ...(stored || {}) };
  const resumes = (Array.isArray(docs.resumes) ? docs.resumes : []).filter(d => d && (d.data || d.text));
  if (docs.resume && !resumes.length) resumes.push(docs.resume);
  delete docs.resume;
  docs.resumes = resumes.map((d, i) => ({ category: '', ...d, id: d.id || `cv-${i + 1}` }));
  return docs;
}

/**
 * Store one document, as bytes, for attaching to upload fields.
 * `kind` is 'resume' or 'coverLetter'. A CV is added to the list, or
 * replaces the one with its id or file name (an updated "cv.pdf" uploaded
 * again keeps its place and what jobs it is for). `doc` null removes the CV
 * with `id`, or every CV without one.
 */
export async function saveDocument(kind, doc, { id } = {}) {
  const documents = await getDocuments();
  if (kind === 'resume') {
    const list = documents.resumes;
    if (!doc) {
      documents.resumes = id ? list.filter(d => d.id !== id) : [];
    } else {
      const at = list.findIndex(d => doc.id ? d.id === doc.id : d.filename === doc.filename);
      if (at >= 0) list[at] = { ...list[at], ...doc, id: list[at].id };
      else list.push({ category: '', ...doc, id: doc.id || `cv-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` });
    }
  } else if (doc) {
    documents[kind] = doc;
  } else {
    delete documents[kind];
  }
  await set(KEYS.DOCUMENTS, documents);
  return documents;
}

/** Store the CV list as given: a new order (the main one first) or new categories. */
export async function saveResumes(resumes) {
  const documents = await getDocuments();
  await set(KEYS.DOCUMENTS, normaliseDocuments({ ...documents, resumes: Array.isArray(resumes) ? resumes : [] }));
  return getDocuments();
}

// --- site skills -----------------------------------------------------------

export async function getSkills() {
  return get(KEYS.SKILLS, {});
}

export async function saveSkills(skills) {
  return set(KEYS.SKILLS, skills || {});
}

// --- run history -----------------------------------------------------------

export async function getRuns() {
  return get(KEYS.RUNS, []);
}

export async function pushRun(run) {
  const settings = await getSettings();
  if (!settings.keepRunHistory) return [];
  const runs = await getRuns();
  runs.unshift(run);
  const trimmed = runs.slice(0, settings.maxRunHistory);
  await set(KEYS.RUNS, trimmed);
  return trimmed;
}

export async function clearRuns() {
  return set(KEYS.RUNS, []);
}

// --- usage ledger ----------------------------------------------------------

export async function getUsage() {
  return get(KEYS.USAGE, { completions: 0, byMonth: {}, recent: [] });
}

export async function saveUsage(usage) {
  return set(KEYS.USAGE, usage);
}

// --- bulk export / import --------------------------------------------------

/** What an export file may contain, and which storage key each part maps to. */
export const EXPORT_PARTS = [
  { id: 'profile', key: KEYS.PROFILE, label: 'Profile', blurb: 'Your name, contact details, work history and documents.' },
  { id: 'settings', key: KEYS.SETTINGS, label: 'Settings and preferences', blurb: 'Every option on the Settings tab.' },
  { id: 'responses', key: KEYS.RESPONSES, label: 'Saved responses', blurb: 'Your pre-written answers and their trigger phrases.' },
  { id: 'documents', key: KEYS.DOCUMENTS, label: 'Uploaded documents', blurb: 'Your CV and cover letter files. These make the export much larger.' },
  { id: 'skills', key: KEYS.SKILLS, label: 'Site skills', blurb: 'What phil learned about each site.' },
  { id: 'history', key: KEYS.RUNS, label: 'Run history', blurb: 'The record of past runs. Not needed on a new machine.' },
  { id: 'usage', key: KEYS.USAGE, label: 'Completion count', blurb: 'How many form completions you have used.' }
];

const EXPORT_VERSION = 2;
const CREDENTIAL_KEYS = ['typesafeApiKey', 'deepseekApiKey', 'ownDeepseekKey', 'proxyToken'];

/**
 * Build a portable configuration file.
 *
 * This is what moves an Applicator setup to another browser or another
 * machine. API keys are excluded unless explicitly asked for, because an export
 * usually ends up in a downloads folder or a chat message.
 *
 * @param {object} [options]
 * @param {string[]} [options.parts]         Ids from EXPORT_PARTS. Defaults to all.
 * @param {boolean} [options.includeKeys]    Include API keys and the licence token.
 */
export async function exportAll(options = {}) {
  const store = await area();
  // With the lock on, the personal data comes from the vault (unlocked first).
  const all = { ...(await store.get(null)), ...((await openVault()) || {}) };
  delete all.vault;
  return buildExport(all, options);
}

/**
 * The export file, built from a plain storage snapshot.
 *
 * Kept free of chrome.* so it can be tested directly: losing a user's
 * configuration on export is the kind of failure that only shows up when they
 * already need the file.
 */
export function buildExport(all, { parts, includeKeys = false } = {}) {
  const wanted = parts?.length ? new Set(parts) : new Set(EXPORT_PARTS.map(p => p.id));

  const data = {};
  const included = [];
  for (const part of EXPORT_PARTS) {
    if (!wanted.has(part.id)) continue;
    if (all?.[part.key] === undefined) continue;
    data[part.key] = all[part.key];
    included.push(part.id);
  }

  if (data[KEYS.SETTINGS] && !includeKeys) {
    data[KEYS.SETTINGS] = { ...data[KEYS.SETTINGS] };
    for (const key of CREDENTIAL_KEYS) data[KEYS.SETTINGS][key] = '';
  }

  return {
    application: 'applicator',
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    includes: included,
    containsCredentials: !!(includeKeys && data[KEYS.SETTINGS]),
    data
  };
}

/**
 * Restore a configuration file.
 *
 * Version 1 files, which were a raw dump of every storage key, are still
 * accepted. A key already configured on this machine is never overwritten by a
 * blank one from the file, so importing a keyless export does not log you out.
 *
 * @returns {{imported: string[]}}
 */
export async function importAll(payload, { parts } = {}) {
  const currentSettings = await getSettings();
  const currentProfile = await getProfile();
  const { incoming, imported, report } = prepareImport(payload, { parts, currentSettings, currentProfile });
  const store = await area();
  // Personal data goes through the lock, when it is on.
  for (const key of LOCKABLE) {
    if (incoming[key] === undefined) continue;
    await set(key, incoming[key]);
    delete incoming[key];
  }
  await store.set(incoming);
  return { imported, report };
}

/**
 * Validate a configuration file and work out what to write.
 *
 * Throws with a message meant for the user. Kept free of chrome.* so the
 * validation and the credential merge can be tested directly.
 */
export function prepareImport(payload, { parts, currentSettings = {}, currentProfile = {} } = {}) {
  const data = readImportShape(payload);

  const wanted = parts?.length ? new Set(parts) : null;
  const incoming = {};
  const imported = [];
  const report = { matched: 0, unknown: [], skipped: [] };

  for (const part of EXPORT_PARTS) {
    if (wanted && !wanted.has(part.id)) continue;
    const value = data[part.key];
    if (value === undefined) continue;
    incoming[part.key] = value;
    imported.push(part.id);
  }

  // The profile is merged field by field rather than replaced, so a file
  // holding only an address still leaves the rest of the profile alone, and a
  // field this version does not know about is reported instead of discarded
  // silently.
  if (incoming[KEYS.PROFILE]) {
    const { merged, matched, unknown } = mergeProfile(currentProfile, incoming[KEYS.PROFILE]);
    incoming[KEYS.PROFILE] = merged;
    report.matched = matched;
    report.unknown = unknown;
    if (!matched) {
      delete incoming[KEYS.PROFILE];
      const at = imported.indexOf('profile');
      if (at >= 0) imported.splice(at, 1);
      report.skipped.push('profile');
    }
  }

  if (!imported.length) {
    throw new Error(
      report.unknown.length
        ? `That file had no fields this version recognises. Unrecognised: ${report.unknown.slice(0, 5).join(', ')}.`
        : 'That file contained nothing to import.'
    );
  }

  if (incoming[KEYS.SETTINGS]) {
    const merged = { ...DEFAULT_SETTINGS, ...incoming[KEYS.SETTINGS], autoSubmit: false };
    // A blank key in the file must not wipe a working key on this machine.
    for (const key of CREDENTIAL_KEYS) {
      if (!merged[key]) merged[key] = currentSettings[key] || '';
    }
    incoming[KEYS.SETTINGS] = merged;
  }

  return { incoming, imported, report };
}

/**
 * Accept the shapes an Applicator configuration can arrive in.
 *
 * A file written by this extension has a `data` object. A file someone has
 * pulled apart, or a bare profile saved by hand, may be just the fields. Both
 * are accepted, because refusing a file over its wrapper helps nobody.
 */
function readImportShape(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('That file is not valid JSON, or is not an object.');
  }
  if (payload.data && typeof payload.data === 'object') {
    if (payload.version && payload.version !== 1 && payload.version !== EXPORT_VERSION) {
      throw new Error(`That file is in format ${payload.version}, which this version cannot read.`);
    }
    return payload.data;
  }
  // A bare profile: dotted keys at the top level, or under a `profile` key.
  if (payload.profile && typeof payload.profile === 'object') return payload;
  if (Object.keys(payload).some(k => k.includes('.'))) return { [KEYS.PROFILE]: payload };
  throw new Error('That file is not a philform configuration.');
}

/**
 * Merge an incoming profile into the current one, keeping only fields this
 * version knows. Unknown names are reported rather than written, and a field
 * absent from the file keeps whatever is already saved.
 */
export function mergeProfile(current, incoming) {
  const known = new Set(PROFILE_FIELDS.map(f => f.key));
  const merged = { ...(current || {}) };
  const unknown = [];
  let matched = 0;

  for (const [key, value] of Object.entries(incoming || {})) {
    if (LISTS[key]) {
      if (Array.isArray(value)) {
        const shape = blankEntry(key);
        merged[key] = normaliseProfile({ [key]: value })[key]
          .filter(e => e && typeof e === 'object')
          .map(e => ({ ...shape, ...pickKnown(e, shape) }));
        matched += merged[key].length;
      }
      continue;
    }
    if (key === 'custom') {
      if (Array.isArray(value)) {
        // Learned answers are merged by question, so importing twice adds nothing.
        const have = new Map((merged.custom || []).map(c => [String(c.question).trim().toLowerCase(), c]));
        for (const c of value) {
          if (!c || !String(c.question || '').trim()) continue;
          // An empty reminder never wipes an answer the user has since given.
          const prev = have.get(String(c.question).trim().toLowerCase());
          if (prev && String(prev.answer ?? '').trim() && !String(c.answer ?? '').trim()) continue;
          have.set(String(c.question).trim().toLowerCase(), {
            id: String(c.id || Math.random().toString(36).slice(2, 10)),
            question: String(c.question), answer: String(c.answer ?? '')
          });
          matched++;
        }
        merged.custom = [...have.values()];
      }
      continue;
    }
    if (!known.has(key)) {
      unknown.push(key);
      continue;
    }
    if (value === undefined || value === null) continue;
    merged[key] = typeof value === 'string' ? value : String(value);
    matched++;
  }

  return { merged, matched, unknown };
}

function pickKnown(source, shape) {
  const out = {};
  for (const key of Object.keys(shape)) {
    if (source[key] !== undefined && source[key] !== null) out[key] = String(source[key]);
  }
  return out;
}

// --- reported issues ---------------------------------------------------------
// Pages the user flagged from the popup, kept for review (and, later, sent to
// a server). The newest MAX_ISSUES are kept.

export const MAX_ISSUES = 20;

export async function getIssues() {
  return get(KEYS.ISSUES, []);
}

export async function saveIssue(report) {
  const issues = await getIssues();
  const next = [report, ...issues].slice(0, MAX_ISSUES);
  try {
    await set(KEYS.ISSUES, next);
  } catch {
    // Over the storage quota: keep the report, drop the bulky page copies.
    await set(KEYS.ISSUES, next.map(r => ({ ...r, after: undefined, readback: (r.readback || []).map(f => ({ ...f, context: undefined })) })));
  }
  return next.length;
}

export async function clearIssues() {
  await set(KEYS.ISSUES, []);
}
