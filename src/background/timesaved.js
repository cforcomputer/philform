/**
 * How much time a fill saved the user, and the running total.
 *
 * Each field is timed the way a person would answer it, from the
 * Keystroke-Level Model's standard operator times (Card, Moran and Newell):
 * reading the question and deciding, moving to the field and clicking, then
 * typing at an average 40 words a minute, picking from a list, or ticking. A
 * long value is more likely copied than typed, so typing is capped at what
 * switching windows to copy and paste takes. A written answer is credited as
 * the time to compose it at the pace timed writing tests allow, less the time
 * to read and edit the draft.
 *
 * From that, what the user still spends is taken off: checking each filled
 * field, and waiting for the fill. A best guess outlined for review earns half,
 * since the user has to think about it anyway. The aim is a number a user who
 * timed themselves would believe, not a flattering one.
 *
 * The total only grows on a fill that counted as a completion, so filling the
 * same form again does not add to it.
 *
 * "Applications today" counts applications, not fills: the pages of one
 * multi-step application (Workday's five or six) are one application.
 *
 * What the user spent is kept too, on every fill that cost something, so the
 * popup can set it against what they saved: model cost (`spentCents`, own
 * keys) and what a wallet was charged (`spentWalletCents`). The day
 * streak counts days in a row, in the user's own time zone, with at least one
 * fill that counted.
 */

const KEY = 'timeSaved';

// Keystroke-Level Model operators, in seconds.
const MENTAL = 1.35;     // read and decide
const POINT = 1.1;       // move the pointer to a target
const CLICK = 0.2;
const HOME = 0.4;        // hand from mouse to keyboard
const KEY_PRESS = 0.28;  // an average typist, about 40 words a minute

const LOCATE = 1.5;           // scrolling to the next question, which the model leaves out
const READ_PER_WORD = 0.24;   // reading at about 250 words a minute
const PASTE = 12;             // switch to where it is kept, copy, come back, paste
const PICK_SCAN = 0.3;        // per option looked at, up to ...
const PICK_SCAN_MAX = 3;
const LONG_LIST = 30;         // past this, a list is searched by typing
const DATE = 8;               // a date picker, or a date in the form's format
const SAVED_RESPONSE = 35;    // find an answer already written, copy, paste
const UPLOAD = 20;            // the file dialog
// Writing an answer, planning and checking included: about 10 words a minute,
// the rate timed writing tests allow (TOEFL 30 min for ~300 words; IELTS
// 40 min for 250); strong writers on the GRE manage 15 to 20.
const COMPOSE_PER_WORD = 6;
const EDIT_PER_WORD = 1.5;    // reading a draft and editing it instead
const WRITTEN_MAX = 1800;     // a long cover letter, thirty minutes at most
const CHECK = 2;              // checking a filled field afterwards
const WAIT = 3;               // waiting for the fill

const words = text => String(text || '').split(/\s+/).filter(Boolean).length;

/** Finding the field and reading its question. */
function approach(f) {
  return LOCATE + MENTAL + Math.min(6, words(f.label) * READ_PER_WORD) + POINT + CLICK;
}

function typing(value) {
  const chars = String(value ?? '').length;
  return Math.min(HOME + chars * KEY_PRESS, PASTE);
}

function fieldSeconds(f) {
  const value = String(f.value ?? '');
  if (f.via === 'written') {
    // A one-line draft ("40") is typed, not composed.
    if (!f.multiline && words(value) <= 8) return approach(f) + typing(value);
    const n = words(value);
    return approach(f) + Math.min(WRITTEN_MAX, Math.max(45, n * (COMPOSE_PER_WORD - EDIT_PER_WORD)));
  }
  if (f.via === 'saved' || f.via === 'saved-model') return approach(f) + SAVED_RESPONSE;
  if (f.type === 'radio' || f.type === 'checkbox' || f.type === 'checkboxgroup') {
    return approach(f) + Math.min(PICK_SCAN_MAX, (f.options?.length || 1) * PICK_SCAN);
  }
  if (f.options?.length || f.widget === 'listbox' || f.tag === 'select' || f.combobox) {
    const n = f.options?.length || 10;
    // Open it, look down it (or type to search a long one), pick.
    const find = n > LONG_LIST ? HOME + 4 * KEY_PRESS + PICK_SCAN_MAX : Math.min(PICK_SCAN_MAX, n * PICK_SCAN);
    return approach(f) + find + POINT + CLICK;
  }
  if (f.type === 'date' || f.datePicker) return approach(f) + DATE;
  return approach(f) + typing(value);
}

/** Seconds saved by the fields filled and the files attached, net of checking them. */
export function estimateSeconds(fields, uploadsAttached = 0) {
  const list = fields || [];
  if (!list.length && !uploadsAttached) return 0;
  const saved = list.reduce((sum, f) => sum + fieldSeconds(f) * (f.via === 'guess' ? 0.5 : 1), 0) +
    uploadsAttached * UPLOAD;
  return Math.max(0, Math.round(saved - list.length * CHECK - WAIT));
}

/** A day as "2026-10-19", in local time: a streak runs on the user's calendar. */
export function dayOf(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const today = () => dayOf();

function dayBefore(day) {
  const [y, m, d] = day.split('-').map(Number);
  return dayOf(new Date(y, m - 1, d - 1));
}

/** The streak after a fill that counted on `day`: one more for the next day, back to one after a gap. */
export function nextStreak(streak, day) {
  if (!streak || !streak.last) return { days: 1, last: day };
  if (streak.last === day) return streak;
  return { days: streak.last === dayBefore(day) ? streak.days + 1 : 1, last: day };
}

/** Days in a row as of `day`: still alive the day after the last fill, gone after that. */
export function currentStreak(streak, day) {
  if (!streak || !streak.last) return 0;
  return streak.last === day || streak.last === dayBefore(day) ? streak.days : 0;
}

// Query parameters that name the job, kept so two jobs on one page address
// (Taleo's ?job=, Greenhouse's ?gh_jid=) stay apart. The rest are tracking
// and step state.
const JOB_PARAM = /^(job|jobid|job_id|jobreq|req|reqid|requisition(id)?|posting(id)?|gh_jid|id)$/i;

/**
 * Which application a page belongs to: its address up to the job, without
 * the step. Workday keeps ".../job/<title>_R123/apply/..." on every page, Lever
 * and Ashby add "/apply" or "/application" to the job's address, so anything
 * from such a segment on is dropped. Plain string work, since URL is missing
 * in some JavaScript hosts.
 */
export function applicationKey(url) {
  const m = String(url || '').match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)([^?#]*)(\?[^#]*)?/i);
  if (!m) return String(url || '');
  const host = m[1].replace(/^[^@]*@/, '').replace(/^www\./, '').toLowerCase();
  const segments = m[2].split('/').filter(Boolean);
  const step = segments.findIndex(seg => /^(apply|application|applymanually|autofillwithresume)$/i.test(seg));
  const path = (step < 0 ? segments : segments.slice(0, step)).join('/').toLowerCase();
  const params = (m[3] || '').slice(1).split('&')
    .filter(pair => JOB_PARAM.test(pair.split('=')[0]))
    .sort();
  return `${host}/${path}${params.length ? `?${params.join('&')}` : ''}`;
}

/** The running total, and how many applications were filled today. */
export async function getTimeSaved() {
  const res = await chrome.storage.local.get(KEY);
  return totals(res[KEY] || {});
}

function totals(t, application) {
  const day = today();
  const apps = t.day === day ? t.todayApps || [] : [];
  return {
    seconds: t.seconds || 0,
    fills: t.fills || 0,
    spentCents: t.spentCents || 0,
    spentWalletCents: t.spentWalletCents || 0,
    streakDays: currentStreak(t.streak, day),
    // Whether today already counts towards the streak.
    streakToday: !!t.streak && t.streak.last === day,
    today: apps.length,
    // Pages of this application filled today, counting this one.
    pages: application ? (apps.find(a => a.key === application) || {}).pages || 0 : 0
  };
}

/** Add a fill that counted, on a page at `url`, what it cost and what a wallet was charged. Returns the new total. */
export async function recordTimeSaved(seconds, url, cost, charge) {
  const res = await chrome.storage.local.get(KEY);
  const t = res[KEY] || {};
  const day = today();
  const key = applicationKey(url);
  const apps = (t.day === day ? t.todayApps || [] : []).map(a => ({ ...a }));
  const known = apps.find(a => a.key === key);
  if (known) known.pages += 1; else apps.push({ key, pages: 1 });
  const next = {
    ...withSpent(t, cost, charge),
    seconds: (t.seconds || 0) + Math.max(0, Math.round(seconds || 0)),
    fills: (t.fills || 0) + 1,
    day,
    todayApps: apps,
    streak: nextStreak(t.streak, day)
  };
  await chrome.storage.local.set({ [KEY]: next });
  return totals(next, key);
}

/** A fill that did not count still cost what it cost. Returns the total. */
export async function recordSpent(cost, charge) {
  const res = await chrome.storage.local.get(KEY);
  const t = res[KEY] || {};
  if (!(cost?.cents > 0 || charge?.cents > 0)) return totals(t);
  const next = withSpent(t, cost, charge);
  await chrome.storage.local.set({ [KEY]: next });
  return totals(next);
}

function withSpent(t, cost, charge) {
  return {
    ...t,
    spentCents: (t.spentCents || 0) + (Number(cost?.cents) || 0),
    spentWalletCents: (t.spentWalletCents || 0) + (Number(charge?.cents) || 0)
  };
}
