import { MSG } from '../common/messages.js';
import { drawPhils } from '../common/phil.js';
import * as store from '../background/storage.js';
import { listSkills, putSkill, deleteSkill, shareSkill, adoptSkill, forgetAllSkills } from '../background/skills/store.js';
import { usageSummary } from '../background/quota.js';
import { starterResponses } from '../background/responses.js';
import { testDeepSeek } from '../background/llm/deepseek.js';
import { testTypeSafe } from '../background/llm/typesafe.js';
import { PROFILE_FIELDS, SECTIONS, FIELD_BY_KEY, LISTS, listFields, blankEntry, inferredValue, isFieldActive, newestIndex, normaliseProfile } from '../common/schema.js';
import { DEEPSEEK_MODELS, DEEPSEEK_WRITER_MODELS, REASONING_EFFORTS } from '../background/llm/deepseek.js';
import { TYPESAFE_MODELS } from '../background/llm/typesafe.js';
import { formatMs } from '../common/util.js';
import { devConfig } from '../background/dev.js';
import { documentText } from '../common/doctext.js';

const $ = id => document.getElementById(id);
const esc = str => String(str ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Everything this page does is either storage or a plain network call, and both
 * work in any extension context. Doing them here rather than asking the
 * background to do them removes a whole failure mode: Firefox unloads a
 * Manifest V3 event page after a few seconds idle, and a page that has been
 * sitting open while someone types their API keys will often find the
 * background gone when it finally sends a message, which surfaces as
 * "Could not establish connection. Receiving end does not exist."
 *
 * The background is still the right place for a fill, because that needs
 * scripting access to another tab. Nothing on this page does.
 */
const LOCAL = {
  [MSG.GET_SETTINGS]: () => store.getSettings(),
  [MSG.SAVE_SETTINGS]: patch => store.saveSettings(patch),
  [MSG.GET_PROFILE]: () => store.getProfile(),
  [MSG.SAVE_PROFILE]: profile => store.saveProfile(profile),
  [MSG.LIST_RESPONSES]: () => store.getResponses(),
  [MSG.SAVE_RESPONSES]: ({ responses }) => store.saveResponses(responses || []),
  [MSG.SEED_RESPONSES]: async () => {
    const next = [...(await store.getResponses()), ...starterResponses()];
    await store.saveResponses(next);
    return next;
  },
  [MSG.GET_DOCUMENTS]: () => store.getDocuments(),
  [MSG.SAVE_DOCUMENT]: ({ kind, doc, id }) => store.saveDocument(kind, doc, { id }),
  [MSG.SAVE_RESUMES]: ({ resumes }) => store.saveResumes(resumes),
  [MSG.LIST_SKILLS]: () => listSkills(),
  [MSG.SHARE_SKILL]: ({ site }) => shareSkill(site),
  [MSG.ADOPT_SKILL]: ({ shared }) => adoptSkill(shared),
  [MSG.FORGET_ALL_SKILLS]: () => forgetAllSkills(),
  [MSG.SAVE_SKILL]: ({ site, skill }) => putSkill(site, skill),
  [MSG.DELETE_SKILL]: ({ site }) => deleteSkill(site),
  [MSG.LIST_RUNS]: () => store.getRuns(),
  [MSG.LIST_ISSUES]: () => store.getIssues(),
  [MSG.CLEAR_ISSUES]: () => store.clearIssues(),
  [MSG.CLEAR_RUNS]: () => store.clearRuns(),
  [MSG.GET_USAGE]: () => usageSummary(),
  [MSG.EXPORT_PARTS]: () => store.EXPORT_PARTS,
  [MSG.EXPORT_DATA]: options => store.exportAll(options || {}),
  [MSG.IMPORT_DATA]: ({ file, parts }) => store.importAll(file, { parts }),
  [MSG.TEST_PROVIDER]: async ({ provider, settings }) => {
    const merged = { ...(await store.getSettings()), ...(settings || {}) };
    if (provider === 'typesafe') {
      return { ok: true, detail: await testTypeSafe({ apiKey: merged.typesafeApiKey, model: merged.typesafeModel }) };
    }
    if (provider === 'deepseek') {
      return { ok: true, detail: await testDeepSeek({ apiKey: merged.deepseekApiKey, model: merged.deepseekModel }) };
    }
    throw new Error(`Unknown provider: ${provider}`);
  }
};

async function send(type, payload) {
  const local = LOCAL[type];
  if (local) return local(payload || {});

  const res = await chrome.runtime.sendMessage({ type, payload });
  if (!res?.ok) throw new Error(res?.error || 'No response from the philform background script.');
  return res.data;
}

let toastTimer = null;
function show(el, visible = true) {
  el.hidden = !visible;
}

function toast(message, bad = false) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('bad', bad);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

// --- tabs -----------------------------------------------------------------

const PANELS = ['profile', 'settings', 'responses', 'skills', 'history', 'data'];

function showTab(name) {
  // Site skills are a dev build's view; anyone else landing on #skills sees the profile.
  const tab = PANELS.includes(name) && (name !== 'skills' || document.body.classList.contains('dev')) ? name : 'profile';
  for (const panel of PANELS) $(`panel-${panel}`).hidden = panel !== tab;
  for (const btn of document.querySelectorAll('.tab')) {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  }
  if (tab === 'responses') renderResponses();
  if (tab === 'skills') renderSkills();
  if (tab === 'history') renderHistory();
  location.hash = tab;
}

$('tour-start').addEventListener('click', () => window.dispatchEvent(new CustomEvent('philform-tour', { detail: { showTab } })));

$('tabs').addEventListener('click', e => {
  const btn = e.target.closest('.tab');
  if (btn) showTab(btn.dataset.tab);
});

// --- collapsible sections ---------------------------------------------------

// Which sections the user opened or closed, per browser. A convenience only:
// without storage every section starts as the page says.
const BLOCKS_KEY = 'applicator.blocks';
function blockState() {
  try { return JSON.parse(localStorage.getItem(BLOCKS_KEY) || '{}'); } catch { return {}; }
}
function restoreBlocks() {
  const state = blockState();
  for (const el of document.querySelectorAll('details.block[data-block]')) {
    if (el.dataset.block in state) el.open = !!state[el.dataset.block];
  }
}
document.addEventListener('toggle', e => {
  const el = e.target;
  if (!el.matches?.('details.block[data-block]')) return;
  const state = blockState();
  state[el.dataset.block] = el.open;
  try { localStorage.setItem(BLOCKS_KEY, JSON.stringify(state)); } catch { /* private window */ }
}, true);

document.addEventListener('click', e => {
  const btn = e.target.closest('[data-blocks]');
  if (!btn) return;
  const panel = btn.closest('.panel');
  for (const el of panel.querySelectorAll('details.block')) el.open = btn.dataset.blocks === 'open';
});

// --- profile --------------------------------------------------------------

/** Entries being edited, per list, and the learned answers. */
const drafts = Object.fromEntries(Object.keys(LISTS).map(list => [list, []]));
let customDraft = [];

const LIST_TEXT = {
  employment: { noun: 'Job', add: 'Add another job', empty: 'No employment history yet.', newest: 'newest, used for "current employer" questions' },
  education: { noun: 'School', add: 'Add another school', empty: 'No education yet.', newest: 'newest, used for "school" and "degree" questions' },
  references: { noun: 'Reference', add: 'Add another reference', empty: 'No references yet.', newest: '' },
  projects: { noun: 'Project', add: 'Add another project', empty: 'No projects yet.', newest: '' }
};

function profileInput(field, value, profile) {
  const id = `pf-${field.key}`;
  const common = `id="${id}" data-key="${esc(field.key)}"`;

  if (field.type === 'longtext') {
    // The help shows as a hint under the box, so it is not repeated inside it.
    return `<textarea ${common}>${esc(value)}</textarea>`;
  }
  // A switch that is "not set" until touched: then yes or no.
  if (field.toggle) {
    const set = value === 'yes' || value === 'no';
    return `<span class="toggle"><input type="checkbox" class="switch" ${common} data-toggle="${set ? 'set' : ''}"${value === 'yes' ? ' checked' : ''}>
      <span class="hint toggle-state">${set ? (value === 'yes' ? 'Yes' : 'No') : 'Not set: phil leaves this question to you'}</span></span>`;
  }
  if (field.type === 'boolean') {
    return `<select ${common}>
      <option value=""${value === '' ? ' selected' : ''}>Not answered</option>
      <option value="yes"${value === 'yes' ? ' selected' : ''}>Yes</option>
      <option value="no"${value === 'no' ? ' selected' : ''}>No</option>
    </select>`;
  }
  if (field.type === 'select') {
    const opts = (field.choices || [])
      .map(c => `<option value="${esc(c)}"${value === c ? ' selected' : ''}>${esc(c)}</option>`).join('');
    return `<select ${common}><option value=""${value === '' ? ' selected' : ''}>Not answered</option>${opts}</select>`;
  }

  const type = { email: 'email', tel: 'tel', url: 'url', number: 'number' }[field.type] || 'text';
  // A field Applicator can work out from other answers shows that value as a
  // placeholder. It stays editable, and anything typed wins.
  const inferred = inferredValue(profile, field.key);
  const placeholder = inferred ? ` placeholder="${esc(inferred)}"` : '';
  // Common answers offered as suggestions; anything can still be typed.
  if (field.suggestions?.length) {
    const id = `suggest-${field.key.replace(/\W/g, '-')}`;
    return `<input ${common} type="${type}" value="${esc(value)}"${placeholder} list="${id}">` +
      `<datalist id="${id}">${field.suggestions.map(v => `<option value="${esc(v)}">`).join('')}</datalist>`;
  }
  return `<input ${common} type="${type}" value="${esc(value)}"${placeholder}>`;
}

/** One entry of a list, with an input per field of that list. */
function entryCard(list, entry, index) {
  const rows = listFields(list).filter(f => !f.inferredOnly && !f.fromSetting).map(f => {
    const value = entry[f.prop] ?? '';
    const attrs = `data-list="${list}" data-prop="${esc(f.prop)}"`;
    let input;
    if (f.type === 'longtext') {
      input = `<textarea ${attrs} style="min-height:70px" placeholder="${esc(f.help || '')}">${esc(value)}</textarea>`;
    } else if (f.type === 'select' || f.type === 'boolean') {
      const choices = f.type === 'boolean' ? [['yes', 'Yes'], ['no', 'No']] : (f.choices || []).map(c => [c, c]);
      input = `<select ${attrs}><option value="">Not answered</option>${choices
        .map(([v, l]) => `<option value="${esc(v)}"${value === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    } else {
      input = `<input type="text" ${attrs} value="${esc(value)}" placeholder="${esc(f.placeholder || '')}">`;
    }
    return `<label class="row${f.type === 'longtext' ? ' tall' : ''}"><span>${esc(f.label)}</span>${input}</label>`;
  }).join('');

  return `<div class="item" data-card="${list}:${index}">
    <div class="rowline">
      <h3>${LIST_TEXT[list].noun} ${index + 1} <span class="hint" data-newest hidden>· ${esc(LIST_TEXT[list].newest)}</span></h3>
      <button class="danger" data-remove="${list}:${index}" type="button">Remove</button>
    </div>
    ${rows}
  </div>`;
}

function renderList(list) {
  const host = $(`${list}-list`);
  if (!host) return;
  host.innerHTML = drafts[list].length
    ? drafts[list].map((e, i) => entryCard(list, e, i)).join('')
    : `<p class="hint">${esc(LIST_TEXT[list].empty)}</p>`;
  $(`add-${list}`).disabled = drafts[list].length >= LISTS[list].max;
  markNewest(list);
}

/** Label the entry that the dates say is newest, as the dates are typed. */
function markNewest(list) {
  const newest = newestIndex({ [list]: collectList(list) }, list);
  for (const card of $(`${list}-list`).querySelectorAll('[data-card]')) {
    const tag = card.querySelector('[data-newest]');
    const index = Number(card.dataset.card.split(':')[1]);
    if (tag) tag.hidden = !LIST_TEXT[list].newest || drafts[list].length < 2 || index !== newest;
  }
}

function collectList(list) {
  const host = $(`${list}-list`);
  if (!host) return drafts[list];
  for (const card of host.querySelectorAll('[data-card]')) {
    const i = Number(card.dataset.card.split(':')[1]);
    if (!drafts[list][i]) continue;
    for (const el of card.querySelectorAll('[data-prop]')) drafts[list][i][el.dataset.prop] = el.value;
  }
  return drafts[list];
}

// --- learned answers ---------------------------------------------------------

function renderCustom() {
  const host = $('custom-list');
  if (!host) return;
  host.innerHTML = customDraft.length
    ? customDraft.map((c, i) => `<div class="item" data-custom="${i}">
        <label class="row"><span>Question</span><input type="text" data-cprop="question" value="${esc(c.question)}" placeholder="e.g. Do you have a driver's license?"></label>
        <label class="row"><span>Your answer</span><input type="text" data-cprop="answer" value="${esc(c.answer)}" placeholder="e.g. Yes"></label>
        <div class="rowline"><span class="hint">${c.site ? `Saved from ${esc(c.site)}` : 'Added by you'}</span>
          <button class="danger" data-custom-remove="${i}" type="button">Remove</button></div>
      </div>`).join('')
    : '<p class="hint">None yet.</p>';
}

function collectCustom() {
  const host = $('custom-list');
  if (!host) return customDraft;
  for (const card of host.querySelectorAll('[data-custom]')) {
    const c = customDraft[Number(card.dataset.custom)];
    if (!c) continue;
    for (const el of card.querySelectorAll('[data-cprop]')) c[el.dataset.cprop] = el.value;
  }
  return customDraft;
}

/**
 * A collapsible section. The summary names it and, for profile sections, says
 * how much of it is filled, so a closed page still reads as a list of what is
 * where and what is left to do.
 */
const OPEN_AT_FIRST = new Set(['p-identity', 'p-contact']);

function block(key, title, body, count = '') {
  return `<details class="block" data-block="${key}"${OPEN_AT_FIRST.has(key) ? ' open' : ''}>
    <summary>
      <span class="block-title">${esc(title)}</span>
      <span class="block-count"${count ? ` data-count="${count}"` : ''}></span>
    </summary>
    <div class="block-body">${body}</div>
  </details>`;
}

function listFieldset(section) {
  return block(`p-${section.id}`, section.title, `
    <p class="hint">${esc(section.blurb)}</p>
    <div id="${section.id}-list" class="list"></div>
    <div style="margin-top:10px">
      <button class="secondary" id="add-${section.id}" type="button">${esc(LIST_TEXT[section.id].add)}</button>
    </div>`, section.id);
}

function renderProfile(saved) {
  const profile = normaliseProfile(saved);
  for (const list of Object.keys(LISTS)) {
    // An empty list starts with as many blank entries as forms usually ask
    // for: one job or school, three references.
    const saved = Array.isArray(profile[list]) ? profile[list].map(e => ({ ...blankEntry(list), ...e })) : [];
    const initial = LISTS[list].initial || 1;
    drafts[list] = saved.length ? saved : [];
    while (drafts[list].length < initial) drafts[list].push(blankEntry(list));
  }
  customDraft = (profile.custom || []).map(c => ({ ...c }));

  const fieldRows = fields => fields.map(field => {
    const hidden = !isFieldActive(profile, field.key);
    const help = field.help ? `<p class="hint" style="grid-column:2">${esc(field.help)}</p>` : '';
    return `<label class="row${field.type === 'longtext' ? ' tall' : ''}"
                   data-field-row="${esc(field.key)}"${hidden ? ' hidden' : ''}>
      <span>${esc(field.label)}</span>
      ${profileInput(field, profile[field.key] ?? '', profile)}
    </label>${help}`;
  }).join('');
  // Inferred-only keys, such as the current employer, are read from the
  // lists and would only duplicate them here.
  const sectionFields = id => PROFILE_FIELDS.filter(f => f.section === id && !f.inferredOnly && !f.fromSetting);

  // The CV text and writing samples sit with the CV upload, at the top. The
  // CV's text is read from the uploaded file and shown only to check.
  const resumeField = FIELD_BY_KEY[RESUME_TEXT];
  $('resume-text-holder').innerHTML = profileInput(resumeField, profile[RESUME_TEXT] ?? '', profile);
  $('documents-fields').innerHTML = fieldRows(sectionFields('documents').filter(f => f.key !== RESUME_TEXT));

  const html = SECTIONS.filter(section => section.id !== 'documents').map(section => {
    if (LISTS[section.id]) return listFieldset(section);
    const fields = sectionFields(section.id);
    if (!fields.length) return '';
    return block(`p-${section.id}`, section.title,
      `<p class="hint">${esc(section.blurb)}</p>${fieldRows(fields)}`, section.id);
  }).join('') + block('p-custom', 'Other answers', `
      <p class="hint">Questions some forms ask that are not covered above, with your answer.
        phil uses an answer for any question that means the same thing, however a site words it.
        To add one from a form, type your answer into the form, then click <b>Save my answers from this page</b>
        in the philform popup. Or add one here.</p>
      <div id="custom-list" class="list"></div>
      <button id="custom-add" class="secondary" type="button">Add an answer</button>`, 'custom');

  $('profile-dynamic').innerHTML = html;
  restoreBlocks();
  for (const list of Object.keys(LISTS)) renderList(list);
  renderCustom();
  refreshDerived();
  updateProfileCount();
}

function collectProfile() {
  const profile = {};
  for (const el of $('profile-sections').querySelectorAll('[data-key]')) {
    profile[el.dataset.key] = el.dataset.toggle !== undefined
      ? (el.dataset.toggle ? (el.checked ? 'yes' : 'no') : '')
      : el.value.trim();
  }
  for (const list of Object.keys(LISTS)) {
    profile[list] = collectList(list)
      .filter(e => Object.values(e).some(v => String(v || '').trim() !== ''));
  }
  profile.custom = collectCustom()
    .filter(c => String(c.question || '').trim())
    .map(c => ({ ...c, question: c.question.trim(), answer: String(c.answer || '').trim() }));
  return profile;
}

/**
 * Keep the inferred placeholders and the conditional rows in step as the user
 * types, so a full name appears as soon as a first and last name exist, and the
 * non-compete industry question appears the moment the answer above is yes.
 */
document.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset?.toggle === undefined) return;
  el.dataset.toggle = 'set';
  const state = el.parentElement.querySelector('.toggle-state');
  if (state) state.textContent = el.checked ? 'Yes' : 'No';
});

function refreshDerived() {
  const profile = collectProfile();
  for (const el of $('profile-sections').querySelectorAll('[data-key]')) {
    const inferred = inferredValue(profile, el.dataset.key);
    if (el.tagName === 'INPUT' && FIELD_BY_KEY[el.dataset.key]?.derived) {
      el.placeholder = inferred || '';
    }
  }
  for (const row of $('profile-sections').querySelectorAll('[data-field-row]')) {
    row.hidden = !isFieldActive(profile, row.dataset.fieldRow);
    const help = row.nextElementSibling;
    if (help?.classList.contains('hint')) help.hidden = row.hidden;
  }
}

function updateProfileCount() {
  const profile = collectProfile();
  const filled = Object.entries(profile)
    .filter(([k, v]) => !LISTS[k] && k !== 'custom' && String(v || '').trim() !== '').length;
  const jobs = (profile.employment || []).length;
  const schools = (profile.education || []).length;
  const refs = (profile.references || []).length;
  const shown = PROFILE_FIELDS.filter(f => !LISTS[f.section] && !f.inferredOnly && !f.fromSetting).length;
  updateBlockCounts(profile);
  $('profile-count').textContent =
    `${filled} of ${shown} fields filled, ${jobs} job${jobs === 1 ? '' : 's'}, ` +
    `${schools} school${schools === 1 ? '' : 's'}, ${refs} reference${refs === 1 ? '' : 's'}, ` +
    `${profile.custom.length} other answer${profile.custom.length === 1 ? '' : 's'}`;
}

/** "2 of 5" on each closed section, or how many entries a list holds. */
function updateBlockCounts(profile) {
  const isSet = v => String(v || '').trim() !== '';
  for (const el of $('profile-sections').querySelectorAll('[data-count]')) {
    const id = el.dataset.count;
    let text;
    if (id === 'custom') {
      const n = profile.custom.length;
      text = n ? `${n} saved` : 'none yet';
    } else if (LISTS[id]) {
      const n = (profile[id] || []).length;
      text = n ? `${n} added` : 'none yet';
    } else {
      const keys = PROFILE_FIELDS
        .filter(f => f.section === id && !f.inferredOnly && !f.fromSetting && isFieldActive(profile, f.key))
        .map(f => f.key);
      const n = keys.filter(k => isSet(profile[k])).length;
      text = `${n} of ${keys.length} filled`;
      el.classList.toggle('done', n === keys.length && n > 0);
    }
    el.textContent = text;
  }
}

$('profile-sections').addEventListener('click', e => {
  // Whatever is added should be in view, even if its section was closed.
  const opener = e.target.closest('[id^="add-"], #custom-add')?.closest('details.block');
  if (opener) opener.open = true;
  const add = e.target.closest('[id^="add-"]');
  if (add && LISTS[add.id.slice(4)]) {
    const list = add.id.slice(4);
    collectList(list);
    if (drafts[list].length < LISTS[list].max) drafts[list].push(blankEntry(list));
    renderList(list);
    updateProfileCount();
    return;
  }
  const remove = e.target.closest('[data-remove]');
  if (remove) {
    const [list, index] = remove.dataset.remove.split(':');
    collectList(list);
    drafts[list].splice(Number(index), 1);
    if (!drafts[list].length) drafts[list].push(blankEntry(list));
    renderList(list);
    updateProfileCount();
    return;
  }
  if (e.target.closest('#custom-add')) {
    collectCustom();
    customDraft.push({ id: Math.random().toString(36).slice(2, 10), question: '', answer: '', site: '' });
    renderCustom();
    $('custom-list').querySelector('[data-custom]:last-child [data-cprop="question"]')?.focus();
    updateProfileCount();
    return;
  }
  const dropCustom = e.target.closest('[data-custom-remove]');
  if (dropCustom) {
    collectCustom();
    customDraft.splice(Number(dropCustom.dataset.customRemove), 1);
    renderCustom();
    updateProfileCount();
  }
});

$('profile-sections').addEventListener('input', e => {
  const card = e.target.closest('[data-card]');
  if (card) markNewest(card.dataset.card.split(':')[0]);
  refreshDerived();
  updateProfileCount();
});
$('profile-sections').addEventListener('change', () => {
  refreshDerived();
  updateProfileCount();
});

$('save-profile').addEventListener('click', async () => {
  try {
    await send(MSG.SAVE_PROFILE, collectProfile());
    toast('Profile saved.');
  } catch (err) {
    toast(err.message, true);
  }
});

// --- settings -------------------------------------------------------------

const TOGGLES = [
  'useHeuristicsFirst', 'fillDemographics', 'passBackgroundCheck', 'whyUsResearch', 'highlightFilled', 'attachDocuments',
  'overwriteExisting', 'learnSkills', 'keepRunHistory', 'redactHistory'
];
const TEXTS = [
  'mode', 'classifier', 'classifierConfidence',
  'fillEmploymentHistory',
  'typesafeApiKey', 'typesafeModel',
  'deepseekApiKey', 'ownDeepseekKey', 'deepseekModel', 'deepseekClassifyEffort',
  'deepseekWriterModel', 'deepseekWriterEffort',
  'proxyUrl', 'proxyToken', 'longAnswerMaxWords'
];

const options = list => list
  .map(item => `<option value="${esc(item.id)}">${esc(item.label)}</option>`).join('');

function renderSettings(settings) {
  // Populate the dropdowns before the values are applied, or nothing selects.
  $('typesafeModel').innerHTML = options(TYPESAFE_MODELS);
  $('deepseekModel').innerHTML = options(DEEPSEEK_MODELS);
  $('deepseekWriterModel').innerHTML = options(DEEPSEEK_WRITER_MODELS);
  $('deepseekClassifyEffort').innerHTML = options(REASONING_EFFORTS);
  $('deepseekWriterEffort').innerHTML = options(REASONING_EFFORTS);

  for (const key of TEXTS) {
    const el = $(key);
    if (el) el.value = settings[key] ?? '';
  }
  for (const key of TOGGLES) {
    const el = $(key);
    if (el) el.checked = !!settings[key];
  }
  $('slowRunThresholdSec').value = Math.round((settings.slowRunThresholdMs || 12000) / 1000);
  $('hourlyWage').value = settings.hourlyWage ?? 16;
  // One switch for the DeepSeek writer; with it off, saved answers may still fill.
  const longText = store.effectiveLongTextMode(settings);
  $('writeAnswers').checked = longText === 'write';
  $('useSavedAnswers').checked = longText !== 'skip';
  applyMode(settings.mode);
  applyClassifier(settings.classifier);
  applyWriter();
}

function longTextMode() {
  if ($('writeAnswers').checked) return 'write';
  return $('useSavedAnswers').checked ? 'canned' : 'skip';
}

function applyWriter() {
  $('writer-on').hidden = !$('writeAnswers').checked;
  $('writer-off').hidden = $('writeAnswers').checked;
}

$('writeAnswers').addEventListener('change', applyWriter);

// The attach switch sits with the files on the Profile tab, which has its
// own Save button, so it saves the moment it changes.
$('attachDocuments').addEventListener('change', async e => {
  try {
    await send(MSG.SAVE_SETTINGS, { attachDocuments: e.target.checked });
    toast(e.target.checked ? 'Files will be attached.' : 'Files will not be attached.');
  } catch (err) {
    toast(err.message, true);
  }
});

/** Show only the settings belonging to the selected field-matching engine. */
function applyClassifier(engine) {
  $('typesafe-fields').hidden = engine !== 'typesafe';
  $('deepseek-classify').hidden = engine !== 'deepseek';
}

function applyMode(mode) {
  const proxy = mode === 'proxy';
  for (const el of document.querySelectorAll('.direct-only')) el.hidden = proxy;
  $('proxy-fields').hidden = !proxy;
}

$('mode').addEventListener('change', e => applyMode(e.target.value));
$('classifier').addEventListener('change', e => applyClassifier(e.target.value));

$('save-settings').addEventListener('click', async () => {
  const patch = {};
  for (const key of TEXTS) {
    const el = $(key);
    if (el) patch[key] = el.value.trim();
  }
  for (const key of TOGGLES) {
    const el = $(key);
    if (el) patch[key] = el.checked;
  }
  patch.longAnswerMaxWords = Number($('longAnswerMaxWords').value) || 180;
  patch.classifierConfidence = Math.min(1, Math.max(0, Number($('classifierConfidence').value) || 0.6));
  patch.longTextMode = longTextMode();
  // Keep the superseded flag in step, so an older code path cannot disagree.
  patch.writeLongAnswers = patch.longTextMode !== 'skip';
  patch.slowRunThresholdMs = (Number($('slowRunThresholdSec').value) || 12) * 1000;
  patch.hourlyWage = Math.min(1000, Math.max(0, Number($('hourlyWage').value) || 0));

  try {
    await send(MSG.SAVE_SETTINGS, patch);
    toast('Settings saved.');
  } catch (err) {
    toast(err.message, true);
  }
});

const TEST_SETTINGS = {
  deepseek: () => ({ deepseekApiKey: $('deepseekApiKey').value.trim(), deepseekModel: $('deepseekModel').value }),
  typesafe: () => ({ typesafeApiKey: $('typesafeApiKey').value.trim(), typesafeModel: $('typesafeModel').value })
};

async function testProvider(provider, label) {
  $('test-result').textContent = `Testing ${label}...`;
  try {
    const settings = TEST_SETTINGS[provider]();
    await send(MSG.TEST_PROVIDER, { provider, settings });
    $('test-result').textContent = `${label} is reachable.`;
  } catch (err) {
    $('test-result').textContent = `${label}: ${err.message}`;
  }
}

$('test-typesafe').addEventListener('click', () => testProvider('typesafe', 'TypeSafe'));
$('test-deepseek').addEventListener('click', () => testProvider('deepseek', 'DeepSeek'));

$('test-own-deepseek').addEventListener('click', async () => {
  const apiKey = $('ownDeepseekKey').value.trim();
  const result = $('own-key-result');
  if (!apiKey) {
    result.textContent = 'Paste a key first.';
    return;
  }
  result.textContent = 'Testing...';
  try {
    await testDeepSeek({ apiKey, model: 'deepseek-flash' });
    result.textContent = 'Your key works. Save settings to use it.';
  } catch (err) {
    result.textContent = err.message;
  }
});

// --- skills ---------------------------------------------------------------

/**
 * One choice per row: what Phil fills this field with. It stands for a
 * field's kind and, for a profile value, which one: "profile:<key>".
 */
const PROFILE_GROUP = '<optgroup label="From your profile">' + PROFILE_FIELDS
  .filter(f => f.section !== 'documents')
  .map(f => `<option value="profile:${esc(f.key)}">${esc(f.label)}</option>`).join('') + '</optgroup>';

const FILL_CHOICES = `<option value="unresolved">Not decided yet</option>
  <option value="long">A written answer</option>
  <option value="skip">Nothing, leave it alone</option>${PROFILE_GROUP}`;

const fillChoice = entry =>
  entry.kind === 'profile' ? (entry.profileKey ? `profile:${entry.profileKey}` : 'unresolved') : entry.kind || 'unresolved';

function statusPill(entry) {
  if (entry.locked) return '<span class="pill ok">corrected</span>';
  if (entry.shared) return '<span class="pill">shared</span>';
  if (entry.kind === 'unresolved') return '<span class="pill warn">not matched</span>';
  if (entry.lastOutcome === 'empty') return '<span class="pill warn">left empty</span>';
  return `<span class="pill">filled ${entry.confirms || 0}×</span>`;
}

function skillFieldRow(site, key, entry) {
  return `<tr data-row="${esc(key)}">
    <td>
      <div>${esc(entry.label || '(unlabelled)')}</div>
      ${entry.section ? `<div class="hint">${esc(entry.section)}</div>` : ''}
      ${entry.lastReason ? `<div class="hint">${esc(entry.lastReason)}</div>` : ''}
    </td>
    <td>${statusPill(entry)}</td>
    <td><select data-site="${esc(site)}" data-key="${esc(key)}" data-prop="fill">${FILL_CHOICES}</select></td>
    <td><input type="text" data-site="${esc(site)}" data-key="${esc(key)}" data-prop="note"
         value="${esc(entry.note || '')}" placeholder="Note"></td>
  </tr>`;
}

/** Fields that need attention first, then the rest. */
function sortedFields(skill) {
  const rank = e => (e.kind === 'unresolved' ? 0 : e.lastOutcome === 'empty' ? 1 : 2);
  return Object.entries(skill.fields || {})
    .sort((a, b) => rank(a[1]) - rank(b[1]) || (b[1].confirms || 0) - (a[1].confirms || 0));
}

async function renderSkills() {
  const skills = await send(MSG.LIST_SKILLS);
  $('forget-all-skills').hidden = !skills.length;

  if (!skills.length) {
    $('skills-list').innerHTML =
      '<p class="hint">No site skills yet. Fill an application and one is created automatically.</p>';
    return;
  }

  $('skills-list').innerHTML = skills.map(skill => {
    const rows = sortedFields(skill).map(([key, entry]) => skillFieldRow(skill.site, key, entry)).join('');
    const needsWork = skill.unresolvedCount + skill.failingCount;

    return `<div class="item">
      <div class="rowline">
        <div>
          <h3>${esc(skill.site)}</h3>
          <div class="meta">
            <span>${skill.stats?.runs || 0} run${skill.stats?.runs === 1 ? '' : 's'}</span>
            <span>${skill.fieldCount} field${skill.fieldCount === 1 ? '' : 's'} seen</span>
            <span>average ${formatMs(skill.avgMs || 0)}</span>
            ${needsWork ? `<span class="pill warn">${needsWork} need attention</span>`
                        : '<span class="pill ok">all mapped</span>'}
            ${skill.lockedCount ? `<span class="pill ok">${skill.lockedCount} corrected</span>` : ''}
          </div>
        </div>
        <div class="meta">
          <button class="secondary" data-share="${esc(skill.site)}" type="button">Share</button>
          <button class="danger" data-delete="${esc(skill.site)}" type="button">Forget</button>
        </div>
      </div>

      <label class="row tall" style="margin-top:12px">
        <span>Notes for the model</span>
        <textarea data-site="${esc(skill.site)}" data-prop="notes"
          placeholder="Anything the model should know about this site.">${esc(skill.notes || '')}</textarea>
      </label>

      <details class="skill"${needsWork ? ' open' : ''}>
        <summary>Fields on this site (${skill.fieldCount})</summary>
        <table class="fields">
          <thead><tr><th>Field on the page</th><th>Status</th><th>Fill with</th><th>Note</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="4" class="hint">Nothing recorded yet.</td></tr>'}</tbody>
        </table>
        <p class="hint">
          Changing anything here locks that row, so a later run never overwrites your correction.
        </p>
      </details>

      <div style="margin-top:10px"><button class="primary" data-save="${esc(skill.site)}" type="button">Save corrections</button></div>
    </div>`;
  }).join('');

  for (const skill of skills) {
    for (const [key, entry] of Object.entries(skill.fields || {})) {
      const select = $('skills-list').querySelector(
        `select[data-site="${CSS.escape(skill.site)}"][data-key="${CSS.escape(key)}"][data-prop="fill"]`);
      if (select) select.value = fillChoice(entry);
    }
  }
}

$('skills-list').addEventListener('click', async e => {
  const share = e.target.closest('[data-share]');
  if (share) {
    const payload = await send(MSG.SHARE_SKILL, { site: share.dataset.share });
    downloadJson(payload, `applicator-skill-${payload.site}.json`);
    toast(`Shared ${payload.fieldCount} mappings for ${payload.site}.`);
    return;
  }

  const del = e.target.closest('[data-delete]');
  if (del) {
    const site = del.dataset.delete;
    if (!confirm(`Forget everything phil learned about ${site}?`)) return;
    await send(MSG.DELETE_SKILL, { site });
    toast(`Forgot ${site}.`);
    renderSkills();
    return;
  }

  const save = e.target.closest('[data-save]');
  if (!save) return;

  const site = save.dataset.save;
  const skills = await send(MSG.LIST_SKILLS);
  const skill = skills.find(s => s.site === site);
  if (!skill) return;

  const notes = $('skills-list').querySelector(`textarea[data-site="${CSS.escape(site)}"][data-prop="notes"]`);
  const next = { ...skill, notes: notes?.value || '', fields: {} };
  for (const [key, entry] of Object.entries(skill.fields || {})) next.fields[key] = { ...entry };

  const touched = new Set();
  for (const el of $('skills-list').querySelectorAll(`[data-site="${CSS.escape(site)}"][data-key]`)) {
    const { key, prop } = el.dataset;
    const entry = next.fields[key];
    if (!entry) continue;
    const value = el.value;
    if (prop === 'fill') {
      if (fillChoice(entry) === value) continue;
      touched.add(key);
      const [kind, profileKey] = value.startsWith('profile:') ? ['profile', value.slice(8)] : [value, ''];
      entry.kind = kind;
      if (profileKey) entry.profileKey = profileKey;
      else delete entry.profileKey;
      continue;
    }
    if (String(entry[prop] ?? '') !== String(value)) touched.add(key);
    entry[prop] = value;
  }
  // Only rows the user actually changed get locked, so saving does not freeze
  // mappings Applicator is still learning.
  for (const key of touched) next.fields[key].locked = true;

  for (const junk of ['fieldCount', 'lockedCount', 'unresolvedCount', 'failingCount', 'sharedCount', 'avgMs', 'slow']) {
    delete next[junk];
  }

  await send(MSG.SAVE_SKILL, { site, skill: next });
  toast(touched.size ? `Locked ${touched.size} correction(s) for ${site}.` : `Saved ${site}.`);
  renderSkills();
});

$('forget-all-skills').addEventListener('click', async () => {
  if (!confirm('Forget every site phil has learned? Your profile and responses are untouched.')) return;
  await send(MSG.FORGET_ALL_SKILLS);
  toast('All site skills forgotten.');
  renderSkills();
});

$('adopt-skill').addEventListener('change', async e => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const shared = JSON.parse(await file.text());
    const { site, added, kept } = await send(MSG.ADOPT_SKILL, { shared });
    toast(`Added ${added} mappings for ${site}${kept ? `, kept ${kept} of your corrections` : ''}.`);
    renderSkills();
  } catch (err) {
    toast(err.message, true);
  } finally {
    e.target.value = '';
  }
});

// --- saved responses ------------------------------------------------------

let responsesDraft = [];

function responseCard(response, index) {
  const uses = response.uses || 0;
  return `<div class="item" data-index="${index}">
    <div class="rowline">
      <label class="check" style="margin:0">
        <input type="checkbox" data-field="enabled"${response.enabled ? ' checked' : ''}> Active
      </label>
      <div class="meta">
        ${uses ? `<span class="pill">used ${uses} time${uses === 1 ? '' : 's'}</span>`
               : '<span class="pill">never used</span>'}
        <button class="danger" data-remove="${index}" type="button">Delete</button>
      </div>
    </div>
    <label class="row" style="margin-top:10px">
      <span>Name</span>
      <input type="text" data-field="name" value="${esc(response.name)}" placeholder="Why this company">
    </label>
    <label class="row tall">
      <span>Response</span>
      <textarea data-field="text" style="min-height:140px"
        placeholder="Write the answer exactly as you want it to appear.">${esc(response.text)}</textarea>
    </label>
    <label class="row tall">
      <span>Example phrasings <span class="hint">optional</span></span>
      <textarea data-field="triggers" style="min-height:52px"
        placeholder="Optional. One per line. Skips the matching step when the wording is exact.">${esc(response.triggers)}</textarea>
    </label>
    <label class="check" style="margin-left:242px">
      <input type="checkbox" data-field="adapt"${response.adapt ? ' checked' : ''}>
      Tailor this to each role rather than using it word for word
    </label>
    <p class="hint" style="margin-left:242px">
      Off means it is filled exactly as written, with placeholders replaced. On sends it to the
      writing model, which keeps your wording and changes only what is specific to the employer.
    </p>
  </div>`;
}

function responsesSummary() {
  const active = responsesDraft.filter(r => r.enabled && String(r.text || '').trim()).length;
  $('responses-count').textContent = `${responsesDraft.length} saved, ${active} active`;
}

function renderResponses() {
  $('responses-list').innerHTML = responsesDraft.length
    ? responsesDraft.map(responseCard).join('')
    : '<p class="hint">No saved responses yet. Add one, or start from the examples.</p>';
  responsesSummary();
}

/** Read the edited fields back into the draft before any save or re-render. */
function collectResponses() {
  for (const card of $('responses-list').querySelectorAll('.item')) {
    const index = Number(card.dataset.index);
    const response = responsesDraft[index];
    if (!response) continue;
    for (const el of card.querySelectorAll('[data-field]')) {
      response[el.dataset.field] = el.type === 'checkbox' ? el.checked : el.value;
    }
  }
  return responsesDraft;
}

$('responses-list').addEventListener('click', e => {
  const remove = e.target.closest('[data-remove]');
  if (!remove) return;
  collectResponses();
  responsesDraft.splice(Number(remove.dataset.remove), 1);
  renderResponses();
});

$('responses-list').addEventListener('input', () => {
  collectResponses();
  responsesSummary();
});

$('add-response').addEventListener('click', () => {
  collectResponses();
  responsesDraft.push({
    id: `r${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
    name: '', triggers: '', text: '', enabled: true, adapt: false, uses: 0
  });
  renderResponses();
  $('responses-list').lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

$('seed-responses').addEventListener('click', async () => {
  collectResponses();
  responsesDraft = await send(MSG.SEED_RESPONSES);
  renderResponses();
  toast('Starter examples added. They are inactive until you edit and enable them.');
});

$('save-responses').addEventListener('click', async () => {
  const responses = collectResponses().filter(r => String(r.name).trim() || String(r.text).trim());
  try {
    await send(MSG.SAVE_RESPONSES, { responses });
    responsesDraft = responses;
    renderResponses();
    toast('Responses saved.');
  } catch (err) {
    toast(err.message, true);
  }
});

// --- stored documents -----------------------------------------------------

const DOC_LABEL = { resume: 'CV', coverLetter: 'Cover letter' };

function formatBytes(n) {
  if (!n) return '0 KB';
  return n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const RESUME_TEXT = 'documents.resumeText';
const resumeBox = () => $(`pf-${RESUME_TEXT}`);
const wordCount = text => (String(text || '').match(/\S+/g) || []).length;

/** Say what Phil read from the CV, and open the text box only when it read nothing. */
function showResumeText(doc, { failed = false } = {}) {
  const text = resumeBox()?.value.trim() || '';
  const status = $('resume-read');
  const box = $('resume-text-box');
  status.className = 'resume-read';
  if (doc && text && !failed) {
    status.textContent = `✓ phil read ${wordCount(text)} words from ${doc.filename}.`;
    status.classList.add('ok');
    $('resume-text-summary').textContent = 'Check what phil read';
  } else if (doc) {
    status.textContent = `phil could not read the words in ${doc.filename}. It may be a scanned image or an old .doc file. ` +
      'Paste your CV as text below so phil can write from it, or upload a PDF or .docx.';
    status.classList.add('warn');
    $('resume-text-summary').textContent = 'Your CV as text';
    box.open = true;
  } else {
    status.textContent = text ? 'phil writes from the CV text below.' : 'Upload your CV and phil reads it for you.';
    $('resume-text-summary').textContent = text ? 'Your CV as text' : 'No file? Paste your CV as text instead';
  }
}

/**
 * Read the CV's words into the profile, so answers are written from it with
 * no pasting. Saved straight away, like the file itself.
 */
async function readResume(doc) {
  const text = await documentText(doc);
  if (!text) return false;
  resumeBox().value = text;
  const profile = await send(MSG.GET_PROFILE);
  await send(MSG.SAVE_PROFILE, { ...profile, [RESUME_TEXT]: text });
  updateProfileCount();
  return true;
}

/** The CVs as last shown, the main one first. */
let cvList = [];

/** One CV: what jobs it is for (once there are several), and for each but the main one, what phil read. */
function cvRow(cv, i, many) {
  const read = i > 0 && cv.text?.trim();
  return `<div class="cv-row" data-cv="${esc(cv.id)}">
    <div class="rowline">
      <span>${many && i === 0 ? '<span class="cv-main" title="Sent when phil cannot tell which CV fits">Main</span> ' : ''}<b>${esc(cv.filename)}</b>
        <span class="hint">${formatBytes(cv.size)}</span></span>
      <span>${many && i > 0 ? '<button class="link" data-cv-main type="button">Make main</button> ' : ''}<button class="danger" data-cv-remove type="button">Remove</button></span>
    </div>
    ${many ? `<label class="cv-for">Jobs it's for <input type="text" data-cv-category value="${esc(cv.category || '')}" placeholder="e.g. Marketing, sales"></label>` : ''}
    ${i === 0 ? '' : `<p class="resume-read ${read ? 'ok' : 'warn'}">${read
      ? `✓ phil read ${wordCount(cv.text)} words from it.`
      : `phil could not read the words in ${esc(cv.filename)}. Paste them below, or upload a PDF or .docx.`}</p>
    <details class="inline"${read ? '' : ' open'}><summary>${read ? 'Check what phil read' : 'This CV as text'}</summary>
      <textarea data-cv-text rows="8">${esc(cv.text || '')}</textarea></details>`}
  </div>`;
}

async function renderDocuments() {
  const docs = await send(MSG.GET_DOCUMENTS);
  cvList = docs.resumes || [];
  const many = cvList.length > 1;
  showResumeText(cvList[0]);
  const letter = docs.coverLetter;
  $('documents-list').innerHTML = cvList.map((cv, i) => cvRow(cv, i, many)).join('') +
    (cvList.length ? '' : '<div class="rowline" style="padding:6px 0"><span>CV: <span class="hint">none stored</span></span></div>') +
    `<div class="rowline" style="padding:6px 0">
      <span>${esc(DOC_LABEL.coverLetter)}: ${letter ? `<b>${esc(letter.filename)}</b> <span class="hint">${formatBytes(letter.size)}</span>`
                                                   : '<span class="hint">none stored</span>'}</span>
      ${letter ? '<button class="danger" data-doc-remove="coverLetter" type="button">Remove</button>' : ''}
    </div>`;
  $('upload-resume-label').textContent = cvList.length ? 'Add another CV' : 'Upload a CV';
  $('cv-many-hint').hidden = !cvList.length;
  $('cv-count').textContent = many ? `${cvList.length} CVs` : cvList.length ? 'CV added' : 'no CV yet';
  $('cv-count').classList.toggle('done', cvList.length > 0);
}

/** The main CV's text lives in the profile (the box below the list): put a CV's text there. */
async function setMainText(text) {
  resumeBox().value = text || '';
  const profile = await send(MSG.GET_PROFILE);
  await send(MSG.SAVE_PROFILE, { ...profile, [RESUME_TEXT]: text || '' });
  updateProfileCount();
}

$('documents-list').addEventListener('click', async e => {
  const remove = e.target.closest('[data-doc-remove]');
  if (remove) {
    await send(MSG.SAVE_DOCUMENT, { kind: remove.dataset.docRemove, doc: null });
    toast('Removed.');
    return renderDocuments();
  }
  const id = e.target.closest('[data-cv]')?.dataset.cv;
  if (!id) return;
  if (e.target.closest('[data-cv-remove]')) {
    // The next CV becomes the main one, and its words what phil writes from.
    if (cvList[0]?.id === id && cvList[1]) await setMainText(cvList[1].text);
    await send(MSG.SAVE_DOCUMENT, { kind: 'resume', doc: null, id });
    toast('CV removed.');
    renderDocuments();
  } else if (e.target.closest('[data-cv-main]')) {
    const next = cvList.find(cv => cv.id === id);
    const before = { ...cvList[0], text: resumeBox().value.trim() };
    await send(MSG.SAVE_RESUMES, { resumes: [next, before, ...cvList.slice(1).filter(cv => cv.id !== id)] });
    await setMainText(next.text);
    toast(`${next.filename} is your main CV now.`);
    renderDocuments();
  }
});

// What jobs a CV is for, and a CV's text corrected by hand, are saved as they change.
$('documents-list').addEventListener('change', async e => {
  const id = e.target.closest('[data-cv]')?.dataset.cv;
  const field = e.target.matches('[data-cv-category]') ? 'category' : e.target.matches('[data-cv-text]') ? 'text' : '';
  if (!id || !field) return;
  cvList = cvList.map(cv => (cv.id === id ? { ...cv, [field]: e.target.value.trim() } : cv));
  await send(MSG.SAVE_RESUMES, { resumes: cvList });
  toast('Saved.');
  if (field === 'text') renderDocuments();
});

/** Browser storage holds text, so the file is kept as base64. */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.readAsDataURL(file);
  });
}

const MAX_DOC_BYTES = 4 * 1024 * 1024;

for (const kind of Object.keys(DOC_LABEL)) {
  $(`upload-${kind}`).addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      if (file.size > MAX_DOC_BYTES) {
        throw new Error(`That file is ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_DOC_BYTES)}.`);
      }
      const doc = {
        filename: file.name,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
        savedAt: Date.now(),
        data: await fileToBase64(file)
      };
      // The first CV, or a new copy of the main one, is the main CV: its words
      // go in the profile. Any other is one more CV, for another kind of job.
      const main = kind === 'resume' && (!cvList.length || cvList[0].filename === file.name);
      if (kind === 'resume' && !main) {
        doc.text = await documentText(doc).catch(() => '');
        const adding = !cvList.some(cv => cv.filename === file.name);
        await send(MSG.SAVE_DOCUMENT, { kind, doc });
        toast(adding ? 'CV added. Say what jobs it is for.' : 'CV updated.');
        await renderDocuments();
        const row = [...document.querySelectorAll('[data-cv]')].find(r => cvList.find(cv => cv.id === r.dataset.cv)?.filename === file.name);
        if (adding) row?.querySelector('[data-cv-category]')?.focus();
        return;
      }
      await send(MSG.SAVE_DOCUMENT, { kind, doc });
      if (kind === 'resume') {
        const read = await readResume(doc);
        toast(read ? 'CV stored, and phil has read it.' : 'CV stored.');
        await renderDocuments();
        showResumeText(doc, { failed: !read });
      } else {
        toast(`${DOC_LABEL[kind]} stored.`);
        renderDocuments();
      }
    } catch (err) {
      toast(err.message, true);
    } finally {
      e.target.value = '';
    }
  });
}

// --- history --------------------------------------------------------------

async function renderHistory() {
  const [runs, usage] = await Promise.all([send(MSG.LIST_RUNS), send(MSG.GET_USAGE)]);

  $('usage-summary').textContent =
    `${usage.completions} form completion${usage.completions === 1 ? '' : 's'} in total, ${usage.thisMonth} this month.`;

  if (!runs.length) {
    $('runs-list').innerHTML = `<p class="hint">No runs recorded yet.</p>`;
    return;
  }

  $('runs-list').innerHTML = runs.map(run => `
    <div class="item">
      <div class="rowline">
        <div>
          <h3>${esc(run.role || run.site)}</h3>
          <div class="meta">
            <span>${esc(run.site)}</span>
            <span>${new Date(run.at).toLocaleString()}</span>
            <span>${formatMs(run.durationMs)}</span>
            ${run.slow ? '<span class="pill warn">Slow</span>' : ''}
            ${run.charged ? '<span class="pill">Counted</span>' : '<span class="pill">Repeat, free</span>'}
          </div>
        </div>
        <span class="pill">${run.filled}/${run.fieldsFound} filled</span>
      </div>
      <div class="meta" style="margin-top:6px">
        <span>From skill: ${run.fromSkill}</span>
        <span>Local match: ${run.fromHeuristics}</span>
        <span>Saved responses: ${run.fromSavedResponses ?? 0}</span>
        <span>Written: ${run.written}</span>
        <span>Model calls: ${run.modelCalls}</span>
      </div>
      ${run.unfilled?.length ? `<details class="skill"><summary>${run.unfilled.length} field(s) left empty</summary>
        <ul class="hint">${run.unfilled.map(u => `<li>${esc(u.label)} - ${esc(u.reason)}</li>`).join('')}</ul>
      </details>` : ''}
    </div>`).join('');
}

$('clear-runs').addEventListener('click', async () => {
  if (!confirm('Clear all run history?')) return;
  await send(MSG.CLEAR_RUNS);
  renderHistory();
  toast('History cleared.');
});

// --- data -----------------------------------------------------------------

let exportParts = [];

async function renderExportParts() {
  exportParts = await send(MSG.EXPORT_PARTS);
  $('export-parts').innerHTML = exportParts.map(part => `
    <label class="check" title="${esc(part.blurb)}">
      <input type="checkbox" data-part="${esc(part.id)}"${part.id === 'history' ? '' : ' checked'}>
      ${esc(part.label)} <span class="hint">${esc(part.blurb)}</span>
    </label>`).join('');
}

function selectedParts() {
  return Array.from($('export-parts').querySelectorAll('[data-part]'))
    .filter(el => el.checked)
    .map(el => el.dataset.part);
}

/** In a dev build, hand the export to tools/dev.py. False when that is not possible. */
async function saveToProject(payload) {
  const dev = await devConfig();
  if (!dev?.reportUrl) return false;
  try {
    const res = await fetch(dev.reportUrl.replace(/\/report$/, '/config'), {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(payload)
    });
    return res.ok;
  } catch {
    return false; // dev.py is not running: download instead
  }
}

function downloadJson(payload, filename) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

$('export').addEventListener('click', async () => {
  const parts = selectedParts();
  if (!parts.length) {
    toast('Tick at least one thing to export.', true);
    return;
  }
  try {
    const payload = await send(MSG.EXPORT_DATA, { parts, includeKeys: $('includeKeys').checked });
    // A development build keeps the export in the project, where the dev
    // tools read it, rather than downloading it. Any other build downloads.
    if (await saveToProject(payload)) {
      $('import-result').textContent =
        'Saved to the project as .dev/personal-config.json (gitignored, without API keys). The dev tools use it from now on.';
      return;
    }
    downloadJson(payload, `applicator-config-${new Date().toISOString().slice(0, 10)}.json`);
    $('import-result').textContent = payload.containsCredentials
      ? 'Exported. This file contains your API keys, so treat it like a password.'
      : 'Exported. No API keys are in this file.';
  } catch (err) {
    toast(err.message, true);
  }
});

$('import').addEventListener('change', async e => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    // Import only what is ticked, so a file can be restored piecemeal.
    const { imported, report } = await send(MSG.IMPORT_DATA, { file: payload, parts: selectedParts() });
    const labels = imported.map(id => exportParts.find(p => p.id === id)?.label || id).join(', ');

    const notes = [`Imported: ${labels}.`];
    if (report?.matched) notes.push(`${report.matched} profile field(s) matched.`);
    if (report?.unknown?.length) {
      // Reported rather than hidden: a field this version does not know is the
      // user's answer to something, and they should know it did not land.
      notes.push(`Ignored ${report.unknown.length} unrecognised field(s): ${report.unknown.slice(0, 6).join(', ')}.`);
    }
    $('import-result').textContent = `${notes.join(' ')} Reloading.`;
    setTimeout(() => location.reload(), 900);
  } catch (err) {
    $('import-result').textContent = '';
    toast(err.message, true);
  } finally {
    e.target.value = '';
  }
});

async function wipeAll() {
  await chrome.storage.local.clear();
  await store.forgetVault().catch(() => {});
  toast('All philform data deleted. Reloading.');
  setTimeout(() => location.reload(), 700);
}

$('wipe').addEventListener('click', async () => {
  if (!confirm('Delete your profile, every site skill, all history and your saved API keys?')) return;
  await wipeAll();
});

// --- the password lock (background/vault.js) -----------------------------------------

$('unlock-form').addEventListener('submit', async e => {
  e.preventDefault();
  $('unlock-result').textContent = 'Checking...';
  const ok = await store.unlock($('unlock-password').value).catch(() => false);
  if (!ok) {
    $('unlock-result').textContent = 'That is not the password. Try again.';
    $('unlock-password').select();
    return;
  }
  location.reload();
});

$('lock-wipe').addEventListener('click', async () => {
  if (!confirm('Delete everything philform keeps in this browser? Your locked details cannot be opened without the password.')) return;
  await wipeAll();
});

async function renderLock() {
  const lock = await store.lockStatus();
  show($('lock-off'), !lock.enabled);
  show($('lock-on'), lock.enabled);
  $('lock-blurb').textContent = lock.enabled ? 'On: your details are encrypted.' : 'Optional: lock your details with a password.';
}

$('lock-form').addEventListener('submit', async e => {
  e.preventDefault();
  const pw = $('lock-new').value;
  if (pw !== $('lock-repeat').value) { $('lock-result').textContent = 'The two passwords are not the same.'; return; }
  if (!confirm('Turn on the lock? If you forget this password, your details cannot be recovered.')) return;
  try {
    await store.enablePasswordLock(pw);
    $('lock-new').value = $('lock-repeat').value = '';
    $('lock-result').textContent = 'Locked with your password. phil will ask for it each time you open your browser.';
    renderLock();
  } catch (err) {
    $('lock-result').textContent = err.message;
  }
});

$('lock-now').addEventListener('click', async () => {
  await store.lockNow();
  location.reload();
});

$('lock-change').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    await store.changePassword($('lock-current').value, $('lock-next').value);
    $('lock-current').value = $('lock-next').value = '';
    $('lock-result').textContent = 'Password changed.';
  } catch (err) {
    $('lock-result').textContent = err.message;
  }
});

$('lock-off-btn').addEventListener('click', async () => {
  if (!$('lock-current').value) { $('lock-result').textContent = 'Enter your current password first.'; return; }
  try {
    await store.disableLock($('lock-current').value);
    $('lock-current').value = '';
    $('lock-result').textContent = 'The lock is off. Your details are stored as before.';
    renderLock();
  } catch (err) {
    $('lock-result').textContent = err.message;
  }
});

// --- the wallet's email (backend /v1/email) -------------------------------------------

async function renderAccount() {
  const settings = await store.getSettings();
  // Only a wallet on philform's service can be kept: with your own keys there is none.
  const block = document.querySelector('[data-block="d-account"]');
  if (settings.mode !== 'proxy') { block.hidden = true; return; }
  const status = await send(MSG.GET_STATUS).catch(() => null);
  const email = status?.wallet?.email;
  show($('account-linked'), !!email);
  show($('account-form'), !email);
  if (email) {
    $('account-linked').textContent = `Your wallet is kept under ${email}. Enter it on a new install to bring it back.`;
    $('account-blurb').textContent = `Kept under ${email}.`;
  }
}

$('email-form').addEventListener('submit', async e => {
  e.preventDefault();
  $('account-result').textContent = 'Sending...';
  try {
    await send(MSG.EMAIL_START, { email: $('account-email').value });
    $('account-result').textContent = 'We sent a 6-digit code. Check your inbox (and spam), then type it here.';
    show($('code-form'));
    $('account-code').focus();
  } catch (err) {
    $('account-result').textContent = err.message;
  }
});

$('code-form').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const r = await send(MSG.EMAIL_VERIFY, { email: $('account-email').value, code: $('account-code').value });
    $('account-result').textContent = r.restored
      ? 'Welcome back! Your old wallet is here again.'
      : 'Done. Your wallet is kept under this email.';
    show($('code-form'), false);
    renderAccount();
  } catch (err) {
    $('account-result').textContent = err.message;
  }
});

// --- boot -----------------------------------------------------------------

async function init() {
  // The password lock closed: only the lock screen, until the password is given.
  const lock = await store.lockStatus();
  if (lock.enabled && !lock.unlocked) {
    document.body.classList.add('locked');
    show($('lock-screen'));
    $('unlock-password').focus();
    return;
  }
  renderLock();
  renderAccount().catch(() => {});
  const [profile, settings, responses] = await Promise.all([
    send(MSG.GET_PROFILE), send(MSG.GET_SETTINGS), send(MSG.LIST_RESPONSES)
  ]);
  renderProfile(profile || {});
  renderSettings(settings);
  responsesDraft = (responses || []).map(r => ({ ...r }));
  await renderExportParts();
  const dev = await devConfig();
  // Parts only the dev build has are marked .dev-only and shown here.
  document.body.classList.toggle('dev', !!dev);
  if (dev?.build?.number) $('dev-badge').textContent = `Dev build ${dev.build.number}`;
  if (dev?.reportUrl) {
    $('export').textContent = 'Save to project (dev build)';
    $('export').title = 'Saves to .dev/personal-config.json in the Applicator project, without API keys';
  }
  await renderDocuments();
  // A CV uploaded before Phil could read files: read it now, once.
  const docs = await send(MSG.GET_DOCUMENTS);
  if (docs.resumes[0] && !resumeBox().value.trim() && await readResume(docs.resumes[0])) showResumeText(docs.resumes[0]);

  const hash = location.hash.replace('#', '');
  // The first install's guided tour (tour.js) is started from here.
  if (hash === 'tour') {
    showTab('profile');
    window.dispatchEvent(new CustomEvent('philform-tour', { detail: { showTab } }));
  } else if (hash === 'welcome') {
    $('welcome').hidden = false;
    showTab('profile');
  } else {
    showTab(hash || 'profile');
  }
}

init().catch(err => toast(err.message, true));

// --- reported issues ---------------------------------------------------------

async function renderIssues() {
  const issues = await send(MSG.LIST_ISSUES).catch(() => []);
  $('issues-count').textContent = issues.length
    ? `${issues.length} report${issues.length === 1 ? '' : 's'}, newest from ${new Date(issues[0].reportedAt).toLocaleString()}.`
    : 'None yet.';
  $('issues-download').disabled = !issues.length;
  $('issues-clear').disabled = !issues.length;
}

$('issues-download').addEventListener('click', async () => {
  const issues = await send(MSG.LIST_ISSUES);
  const blob = new Blob([JSON.stringify({ application: 'applicator', kind: 'issue-reports', issues }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `applicator-issues-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$('issues-clear').addEventListener('click', async () => {
  if (!confirm('Delete every saved report?')) return;
  await send(MSG.CLEAR_ISSUES);
  renderIssues();
});

renderIssues();

drawPhils();
