/**
 * The run: everything that happens between the user clicking Fill and the page
 * being ready for review.
 *
 * Order matters, and it is chosen to spend as little as possible:
 *   1. extract        - reduce the page to field descriptors
 *   2. site skill     - answer everything this site taught us, free
 *   3. heuristics     - match the standard fields locally, free
 *   4. TypeSafe       - place whatever is left, and check the local matches, cheap
 *   5. DeepSeek       - draft the open-ended answers, while the rest is filled
 *   6. fill           - write to the page and highlight for review
 *   7. again          - read the page again for fields that appeared, up to three passes
 *
 * "Analyze form" is not a separate button. Steps 1 to 3 are the analysis, and
 * they run on every click.
 */

import { getProfile, getSettings, getResponses, saveResponses, getDocuments, getRuns, pushRun, effectiveLongTextMode } from './storage.js';
import { getSkill, recordRun } from './skills/store.js';
import { applySkill, fieldKey, formFingerprint } from './skills/matcher.js';
import { partitionFields, matchField, HEURISTIC_ACCEPT } from './heuristics.js';
import { loadRulesPack, refreshRulesPack, usePlatform } from './rules.js';
import { detectPlatform, hostnameOf, contentRules, pattern } from '../common/rulespack.js';
import { classifyFields, reconcile, pickOptions, pickEquivalents, pickResume, settle, settleOption, planWithTypeSafe, GUESS_FLOOR, CONDITIONAL, SENSITIVE_QUESTION } from './classify.js';
import { WRITTEN, NONE } from './shortlist.js';
import { extractAll, runInFrames, injectAll, byFrame, trackRequests } from './frames.js';
import { trace, tracing, compactField } from './trace.js';
import { pageSnapshot } from './dev.js';
import { writeAnswers, attachAnswers, fitToLimit } from './write.js';
import {
  matchResponseLocally, matchResponsesWithModel, reconcileMatches, renderResponse
} from './responses.js';
import { chargeCompletion } from './quota.js';
import { startRun, finishRun } from './billing.js';
import { Meter, MAX_FILL_CENTS, affordableOutput } from './cost.js';
import { estimateSeconds, recordTimeSaved, recordSpent } from './timesaved.js';
import { STAGE } from '../common/messages.js';
import { siteKey, normalize, nowIso, truncate, cleanLabel, pageQuestions } from '../common/util.js';
import { DEMOGRAPHIC_KEYS, profileValue, FIELD_BY_KEY, listEntries, isFieldActive, dateParts, filledKeys, fieldDef, isIdentityQuestion, lowestPay } from '../common/schema.js';
import { scopeOf, scopeKey, dedupeAcrossSections } from './scope.js';
import { readStructure } from './structure.js';
import { textPdf } from '../common/textpdf.js';

/** Questions that want prose, not a lookup. */
const ESSAY_PATTERNS = [
  /why (do you |are you |would you )?(want|interested|applying|join|choose)/i,
  /tell us about|describe a (time|situation|project)|walk us through/i,
  /cover letter|what makes you|why should we|what interests you/i,
  /in your own words|anything else (you|we should)|additional information/i,
  /greatest (strength|weakness|achievement)|proudest/i
];

/**
 * A question that must be written rather than looked up.
 *
 * This is deliberately stricter than `looksLikeEssay`: it is what excludes a
 * field from the heuristic fast path. A "Cover letter" box matches a profile
 * key by name, and filling it from the profile would paste the raw template
 * with its {{company}} placeholders intact. Anything written belongs to the
 * writing model, which has the template as source material instead.
 */
/** Answers that are a word or a line, whatever size of box they are asked in. */
const SHORT_VALUE_KEYS = /^(identity|contact|address|links)\./;

export function isDefinitelyEssay(field) {
  if (field.forceLong) return true;
  const label = field.label || field.ariaLabel || '';
  if (ESSAY_PATTERNS.some(re => re.test(label))) return true;
  if (yesNoFact(field)) return false;
  if (!field.multiline) return false;
  // Workable asks for a GitHub or LinkedIn URL in a multi-line box. A box
  // whose question plainly names a short profile value is filled like any
  // other field, not drafted.
  // Only a short label names a value; "Share 2–3 of your open-source
  // contributions with links" mentions GitHub but asks for prose.
  const words = cleanLabel(label).split(/\s+/).filter(Boolean).length;
  const match = matchField(field);
  // "How did you hear about us?" in a big box (Clay) is still the saved source.
  if (match && match.confidence >= HEURISTIC_ACCEPT && match.key === 'preferences.howHeard' && words <= 8) return false;
  if (words > 4 || /\?/.test(label)) return true;
  return !(match && match.confidence >= HEURISTIC_ACCEPT && SHORT_VALUE_KEYS.test(match.key));
}

/**
 * A test rather than a question about the candidate: a puzzle to decode, a
 * secret to work out, a problem to solve. An autofill has no business
 * answering these, so they are left for the candidate.
 */
export function isChallenge(field) {
  const label = normalize(field.label || field.ariaLabel || '');
  // "What problems did you solve?" is about experience (Xaira's robotics essay was skipped as a test).
  return /figure out|decode|decrypt|\bsolve (this|the following|for [a-z]\b)|puzzle|riddle|coding (challenge|exercise|test)|encoded (in|with|text)|the (correct|right) (secret|answer|output)|what (is|was) the output/.test(label);
}

/**
 * An optional catch-all ("Additional information", "Anything else?"). An
 * empty box serves the candidate better than invented filler, so these are
 * left for them unless a saved response answers them.
 */
export function isOptionalCatchAll(field) {
  if (field.required) return false;
  const label = normalize(field.label || field.ariaLabel || '');
  // "Work hours — anything else to add?" (Wonderschool): a comment box after a question, not the question again.
  return /^(additional|other|further) (information|info|details|comments?)|^anything else|^(comments?|notes?)\b|^is there anything (else )?(you|we)|\banything else to add\b/.test(label);
}

/**
 * Routing for whatever the heuristics and the classifier could not place.
 *
 * A one-line box is never an essay because of its character limit: Greenhouse
 * gives every text input maxlength="255", and treating that as "write a
 * paragraph" sent "Please specify" to the writer, which invented an answer.
 * Only a box that is multi-line, or allows a page of text, counts.
 */
/**
 * One plain yes/no question about the candidate that a rule ties to a saved
 * yes/no answer ("Will you now or in the future require sponsorship?"),
 * whatever size of box it is asked in. Ashby asks it in a text area; drafted
 * as an essay, the writer, which is not given these facts, answered "Yes".
 */
function yesNoFact(field) {
  const label = cleanLabel(field.label || field.ariaLabel || '');
  if (!/^(are|do|does|will|would|have|has|can|could|is|did)\b/i.test(label)) return false;
  if (/\b(explain|describe|why|how|tell us|details?|elaborate|which|who|what)\b/i.test(label)) return false;
  const match = matchField(field);
  return !!match && match.confidence >= HEURISTIC_ACCEPT && FIELD_BY_KEY[match.key]?.type === 'boolean';
}

export function looksLikeEssay(field) {
  if (yesNoFact(field)) return false;
  if (isDefinitelyEssay(field)) return true;
  // A one-line box asking a real question ("Do you have any examples of
  // exceptional performance you want to highlight?") still wants an answer
  // written, not a stored value.
  const label = cleanLabel(field.label || field.ariaLabel || '');
  if (/\?/.test(label) && label.split(/\s+/).length >= 12 && !field.options?.length) return true;
  return field.tag !== 'input' && !!(field.maxLength && field.maxLength >= 1000);
}

/**
 * A box that only asks for more when the question before it was answered a
 * certain way: "Please specify", "If other, please explain", "If yes, which?".
 * Returns what the earlier answer must look like, or null.
 */
/** A label without the list marker numbering it ("a. If NO, ...", "2) If so"). */
const unnumbered = label => label.replace(/^\(?(?:[a-z]|\d{1,2}|[ivx]{1,4})[.)]\s+/, '');

export function followUpCondition(field) {
  const label = unnumbered(normalize(field.label || field.ariaLabel || field.placeholder || ''));
  // "If you will require sponsorship, please specify ...": it names its own
  // condition, so it may be long; it follows the yes/no that asks about it.
  // "If you are not located near San Francisco, are you open to relocating?"
  // (Pilot) applies after a No.
  if (followUpTopic(field)) return /^if (?:you )?(?:are|do|did|will|have|were|would)(?: not|n't)\b|^if not\b/.test(label) ? /^(no|n)\b/i : /^(yes|y)\b/i;
  // "If yes", "If so", 'If you answered "Yes" to the above question', however
  // long what follows is (Block's asks for dates and warns about reviews).
  if (/^if (yes|so)\b|^if (you )?(answered|selected|chose|checked) ["'“‘]?yes\b/.test(label)) return /^(yes|y)\b/i;
  if (/^if no\b|^if (you )?(answered|selected|chose|checked) ["'“‘]?no\b/.test(label)) return /^(no|n)\b/i;
  if (!label || label.length > 120) return null;
  if (/\bif\b.{0,20}\bother\b|other.{0,12}(please )?(specify|explain|describe)/.test(label)) return /\bother\b/i;
  // Only a short box is a follow-up: "Please elaborate on your experience
  // building software in AWS" is a question of its own.
  if (label.split(' ').length <= 5 && /^(please )?(specify|explain|describe|elaborate)\b|^please (provide|list) (details|more)/.test(label)) {
    return /\bother\b|^(yes|y)\b/i;
  }
  return null;
}

/**
 * The subject a follow-up names in its condition, as a word stem ("sponso"
 * for "If you will require sponsorship, please specify ..."), or null. Such
 * a box follows only an earlier choice whose question names the same thing.
 */
export function followUpTopic(field) {
  const label = unnumbered(normalize(field.label || field.ariaLabel || field.placeholder || ''));
  const m = /^if (?:you )?(?:will |would |do |did |are |were |have |had )?(?:not |n't )?(?:now |ever |currently |also |in the future )*(?:require|need|want|hold|have|be|are|were|plan to|intend to)\s+(?:an? |any |the |for )?([a-z][a-z /-]{2,40}?)\s*(?:,|\bplease\b|\bwhat\b|\bwhich\b|$)/.exec(label);
  // "If you currently work, or have previously worked, at Capital One or a
  // company acquired by it, please provide your Employee ID" (Brex): the employer.
  const at = m ? null : /^if you (?:currently |previously |have |ever |now )*work(?:ed)?\b.{0,40}?\b(?:at|for) ([a-z][a-z /-]{2,40}?)\s*(?:,|\bor\b|\bplease\b|$)/.exec(label);
  if (!m && !at) return null;
  const word = (m || at)[1].split(/[\s/-]+/).find(w => w.length >= 5);
  return word ? word.slice(0, 6) : null;
}

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];

/** Keys holding a date, which a form may split into a month and a year. */
const DATE_KEYS = new Set([
  'preferences.availableStartDate', 'employment.startDate', 'employment.endDate',
  'education.startYear', 'education.endYear', 'work.graduationYear', 'preferences.todaysDate'
]);

/**
 * Which part of a date this control wants: 'month', 'year', or null for the
 * whole thing. Read from the label first, then from what the options look like.
 */
export function datePartFor(field, profileKey) {
  if (!DATE_KEYS.has(profileKey)) return null;
  const probe = normalize(`${field.label || ''} ${field.name || ''}`);
  const month = /month|\bmm\b/.test(probe);
  const year = /year|\byyyy\b/.test(probe);
  const day = /^(day|dd)\b|\bday\b(?! of)/.test(probe);
  if (day && !month && !year) return 'day';
  if (month && !year) return 'month';
  if (year && !month) return 'year';
  const opts = (field.options || []).map(o => normalize(o.label));
  if (opts.length) {
    if (opts.filter(o => /^(19|20)\d{2}$/.test(o)).length >= opts.length / 2) return 'year';
    if (opts.filter(o => MONTH_NAMES.some(m => o.includes(m.slice(0, 3)))).length >= 6) return 'month';
  }
  return null;
}

/**
 * A whole date written the way this box reads it. A date picker misreads
 * "Mar 2021" or "03/2021" as January, so the format is taken from the box:
 * its type, its placeholder ("MM/YYYY"), or ISO for a picker. A plain text box
 * gets the date as the user wrote it.
 */
export function formatDate(field, value) {
  const parts = dateParts(value);
  if (!parts) return value;
  const y = String(parts.year);
  const m = parts.month ? String(parts.month).padStart(2, '0') : '';
  // The saved day when there is one, else the first: a signature date is
  // today's (Velo3D got 10/01 for the 25th), a job's start only a month.
  const iso = String(value).match(/^\d{4}[-/.]\d{1,2}[-/.](\d{1,2})\b/);
  const d = iso ? iso[1].padStart(2, '0') : '01';
  // A picker that declares its format (CalCareers: data-format="{0:MM/dd/yyyy}")
  // gets exactly that.
  const declared = String(field.dateFormat || '').replace(/^\{0:|\}$/g, '');
  if (/yyyy/i.test(declared)) {
    return declared.replace(/yyyy/i, y).replace(/MM/, m || '01').replace(/dd/i, d)
      .replace(/(^|[^a-z])M(?![a-z])/, `$1${Number(m || 1)}`).replace(/(^|[^a-z])d(?![a-z])/i, `$1${Number(d)}`);
  }
  const hint = `${field.placeholder || ''} ${field.label || ''}`.toLowerCase();
  if (field.type === 'date' || /yyyy-mm-dd/.test(hint)) return `${y}-${m || '01'}-${d}`;
  if (/mm\s*\/\s*dd\s*\/\s*yyyy/.test(hint)) return `${m || '01'}/${d}/${y}`;
  if (/mm\s*\/\s*yyyy/.test(hint)) return `${m || '01'}/${y}`;
  if (field.type === 'month' || field.datePicker || /yyyy-mm/.test(hint)) return m ? `${y}-${m}` : y;
  return value;
}

/** US states and Canadian provinces, so "CA" can pick "California". */
const REGIONS = {
  al: 'alabama', ak: 'alaska', az: 'arizona', ar: 'arkansas', ca: 'california', co: 'colorado',
  ct: 'connecticut', de: 'delaware', dc: 'district of columbia', fl: 'florida', ga: 'georgia',
  hi: 'hawaii', id: 'idaho', il: 'illinois', in: 'indiana', ia: 'iowa', ks: 'kansas', ky: 'kentucky',
  la: 'louisiana', me: 'maine', md: 'maryland', ma: 'massachusetts', mi: 'michigan', mn: 'minnesota',
  ms: 'mississippi', mo: 'missouri', mt: 'montana', ne: 'nebraska', nv: 'nevada', nh: 'new hampshire',
  nj: 'new jersey', nm: 'new mexico', ny: 'new york', nc: 'north carolina', nd: 'north dakota',
  oh: 'ohio', ok: 'oklahoma', or: 'oregon', pa: 'pennsylvania', ri: 'rhode island',
  sc: 'south carolina', sd: 'south dakota', tn: 'tennessee', tx: 'texas', ut: 'utah', vt: 'vermont',
  va: 'virginia', wa: 'washington', wv: 'west virginia', wi: 'wisconsin', wy: 'wyoming',
  pr: 'puerto rico', ab: 'alberta', bc: 'british columbia', mb: 'manitoba', nb: 'new brunswick',
  nl: 'newfoundland and labrador', ns: 'nova scotia', on: 'ontario', pe: 'prince edward island',
  qc: 'quebec', sk: 'saskatchewan'
};
const COUNTRIES = { us: 'united states', usa: 'united states', 'united states of america': 'united states', uk: 'united kingdom' };

/**
 * Turn a profile key into a value this particular control will accept.
 * Returns null when the profile has nothing to offer.
 */
// Major US metro areas by their cities, so an office list can be answered
// from where the user lives. Kept to the places most jobs are posted in.
const METROS = {
  'bay area': ['san francisco', 'sf', 'oakland', 'berkeley', 'emeryville', 'alameda', 'richmond', 'el cerrito', 'albany',
    'san leandro', 'hayward', 'castro valley', 'fremont', 'union city', 'newark', 'walnut creek', 'concord', 'pleasanton',
    'dublin', 'livermore', 'san ramon', 'daly city', 'south san francisco', 'san bruno', 'millbrae', 'burlingame',
    'san mateo', 'foster city', 'belmont', 'san carlos', 'redwood city', 'menlo park', 'palo alto', 'east palo alto',
    'mountain view', 'los altos', 'sunnyvale', 'cupertino', 'santa clara', 'san jose', 'milpitas', 'campbell',
    'los gatos', 'saratoga', 'brisbane', 'sausalito', 'mill valley', 'san rafael', 'novato', 'marin'],
  'new york': ['new york', 'nyc', 'manhattan', 'brooklyn', 'queens', 'bronx', 'jersey city', 'hoboken', 'newark nj', 'stamford'],
  'seattle': ['seattle', 'bellevue', 'redmond', 'kirkland', 'bothell', 'tacoma', 'everett'],
  'los angeles': ['los angeles', 'la', 'santa monica', 'culver city', 'venice', 'pasadena', 'burbank', 'glendale',
    'long beach', 'irvine', 'el segundo', 'playa vista', 'torrance'],
  'boston': ['boston', 'cambridge', 'somerville', 'waltham', 'brookline', 'newton', 'quincy'],
  'washington dc': ['washington dc', 'washington d c', 'arlington', 'alexandria', 'bethesda', 'reston', 'mclean', 'tysons'],
  'chicago': ['chicago', 'evanston', 'oak park'],
  'austin': ['austin', 'round rock'],
  'denver': ['denver', 'boulder', 'aurora'],
  'portland': ['portland', 'beaverton', 'hillsboro']
};
const METRO_OF = new Map(Object.entries(METROS).flatMap(([m, cities]) => cities.map(c => [c, m])));

/** The metro area a place's first part ("San Mateo, CA") is in, if it is a listed one. */
export function metroOf(place) {
  const first = String(place || '').toLowerCase().split(/[,(\/|-]/)[0].replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/bay area|silicon valley/.test(String(place).toLowerCase())) return 'bay area';
  // An office named after its city ("San Francisco HQ", "New York City office"): the longest city it starts with.
  const words = first.split(' ');
  for (let n = words.length; n > 0; n--) {
    const metro = METRO_OF.get(words.slice(0, n).join(' '));
    if (metro) return metro;
  }
  return null;
}

/**
 * Tick boxes that are the options of one question, each read as
 * "Which office are you applying to?: San Francisco HQ". Alone, a box like
 * that matches nothing saved; together they are a choice. Returns one field
 * per question, with the boxes' words as its options and the boxes as
 * `tickBoxes`, so the chosen option's box can be ticked.
 */
export function tickGroups(fields) {
  const groups = new Map();
  for (const f of fields) {
    if (f.type !== 'checkbox' || f.options?.length) continue;
    const label = String(f.label || '');
    const at = label.lastIndexOf(': ');
    if (at < 8) continue;
    const question = label.slice(0, at).trim();
    const option = label.slice(at + 2).trim();
    if (!option || !/\?|\b(which|select|choose|pick)\b/i.test(question)) continue;
    const k = `${f.frameId ?? 0}|${question}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ field: f, option });
  }
  return [...groups.values()].filter(g => g.length >= 2).map(g => {
    const first = g[0].field;
    const question = first.label.slice(0, first.label.lastIndexOf(': ')).trim();
    return {
      ...first, id: `group_${first.id}`, label: question, extractedLabel: question, type: 'radio', profileKey: null,
      required: g.some(x => x.field.required), options: g.map(x => ({ label: x.option, value: x.option })),
      tickBoxes: g.map(x => ({ field: x.field, option: x.option }))
    };
  });
}

/** An office question over a group's options: the office in the user's metro area, if one is. */
export function nearestOffice(group, profile) {
  if (!/\b(office|location|hub|site|city)\b/i.test(group.label || '')) return null;
  const metro = metroOf(String(profileValue(profile, 'address.city') || profileValue(profile, 'address.location') || ''));
  const hit = metro && group.options.find(o => metroOf(o.label) === metro);
  return hit ? hit.label : null;
}

/**
 * Options that say where the user lives ("Yes, and I currently live in the SF
 * Bay Area." / "Yes, and while I do not currently live in the SF Bay Area, I
 * am open to relocation."): the one true of the user's city, when exactly one
 * is and the metro is one the table knows (Sierra). Lever's "I'm local to the
 * San Francisco Bay Area" / "I'm not local but open to relocating" names the
 * place once: that option, for someone who lives there (Gridware). Null otherwise.
 */
export function livesInOption(field, profile) {
  const home = metroOf(String(profileValue(profile, 'address.city') || profileValue(profile, 'address.location') || ''));
  if (!home) return null;
  const fits = [];
  let spoken = 0;
  let notLocal = 0;
  for (const o of field.options || []) {
    const label = typeof o === 'string' ? o : o.label || '';
    const m = label.match(/\b(do not|don't|not)?\s*(?:currently\s+)?(?:(?:live|living|reside|residing|based|located)\s+(?:in|within|near)|local\s+to)\s+(?:the\s+)?([^,.;()]+)/i);
    const metro = m && metroOf(m[2]);
    if (!metro) {
      if (/\b(not|n't)\s+(currently\s+)?(local|living|based|located)\b/i.test(label)) notLocal++;
      continue;
    }
    spoken++;
    if ((metro === home) !== !!m[1]) fits.push(label);
  }
  if (fits.length !== 1) return null;
  if (spoken >= 2) return fits[0];
  // One option names the place and every other one says "not local": only someone living there takes it.
  const others = (field.options || []).length - 1;
  return spoken === 1 && others > 0 && notLocal === others && !/\bnot\b|n't/i.test(fits[0]) ? fits[0] : null;
}

/**
 * "Are you located in the San Francisco Bay Area?": yes or no from the
 * user's city, when both places are metros this table knows; else null.
 */
export function locatedInAnswer(field, profile) {
  const label = cleanLabel(field.label || field.extractedLabel || '');
  const m = label.match(/\b(?:are you|do you)\s+(?:currently\s+)?(?:located|based|living|live|reside|residing)\s+(?:in|within|near)\s+(?:the\s+)?(.+?)\s*\??\s*\*?$/i);
  if (!m) return null;
  const home = metroOf(profileValue(profile, 'address.city') || '') || metroOf(profileValue(profile, 'address.location') || '');
  if (!home) return null;
  // "the New York or SF area" (Middesk) names two: either one will do.
  const tidy = t => t.replace(/^(greater|the)\s+/i, '').replace(/\s+(areas?|regions?|metro(politan)?( areas?)?)$/i, '').replace(/\s+city$/i, '').trim();
  const places = m[1].split(/\s*(?:,|\/|\bor\b|\band\b)\s*/i).map(tidy).filter(Boolean);
  const metros = places.map(p => metroOf(p) || metroOf(`${p} area`)).filter(Boolean);
  if (!metros.length) return null;
  if (metros.includes(home)) return yesNoFor(field, true);
  // A place not in the table might still be home: say no only when all are known.
  return metros.length === places.length ? yesNoFor(field, false) : null;
}

/**
 * "Have you applied to or interviewed with X before?": yes when an earlier
 * fill (not this page) was for the same company, else no, outlined for review
 * since applications made without phil are unknown to it. Null for any
 * other question, or a choice with no yes or no.
 */
export function appliedBeforeAnswer(field, runs, company, url = '') {
  const label = cleanLabel(field.label || field.extractedLabel || '');
  // "Are you currently interviewing or being considered for a role at
  // Autodesk?" too: it was guessed Yes at 0.38 (MaintainX).
  if (!/\b(have|did) you\b[^?]{0,40}\b(applied|interviewed)\b|\bare you (currently |now |actively )*(interviewing|being considered|in (the )?(interview|hiring) process)\b/i.test(label)) return null;
  const key = t => normalize(t).replace(/\b(inc|llc|corp|the|ai|labs?|technologies)\b/g, ' ').replace(/[^a-z0-9]+/g, '');
  const here = key(company);
  const page = String(url).split('?')[0];
  const yes = !!here && (runs || []).some(r => key(r.company) === here && String(r.url || '').split('?')[0] !== page);
  const value = yesNoFor(field, yes);
  return value ? { value, thin: !yes } : null;
}

/**
 * "Have you previously worked for Voyager or one of its subsidiaries?": no
 * when no saved job names the company. The writer once answered it and once
 * left it empty. Null when a saved job does name it (the model says when and
 * where), or for "Have you worked with Python?".
 */
export function workedHereAnswer(field, profile, company) {
  const label = cleanLabel(field.label || field.extractedLabel || '');
  if (!/\b(have|did) you\b[^?]{0,30}\b(worked|been employed|interned)\b\s*(for|at|by|with|as an? \w+ (for|at))\b|\bformer(ly)? (an )?employee\b|\bpreviously employed\b/i.test(label)) return null;
  const key = t => normalize(t).replace(/\b(inc|llc|corp|the|ai|labs?|technologies|company|co)\b/g, ' ').replace(/[^a-z0-9]+/g, '');
  const here = key(company || '');
  const aboutUs = /\b(us|our (company|organi[sz]ation|firm)|this (company|organi[sz]ation|firm)|subsidiar|affiliat)/i.test(label);
  if (!here || (!aboutUs && !key(label).includes(here))) return null;
  const jobs = profileValue(profile, 'employment');
  const saved = (Array.isArray(jobs) ? jobs : []).map(j => key(j.company || ''));
  if (saved.some(s => s && (s.includes(here) || here.includes(s)))) return null;
  if ((field.options || []).length || field.type === 'checkbox') return yesNoFor(field, false);
  return 'No';
}

/**
 * A travel question answered from the most the user will travel
 * (`preferences.maxTravelPercent`): "Able to travel up to 25%?" is yes at 25
 * or more (Tulip), a list of ranges gets the one holding it, and "What
 * percentage can you travel?" gets the number. Null when nothing is saved or
 * the question is about something else.
 */
export function travelAnswer(field, profile) {
  const label = cleanLabel(field.label || field.extractedLabel || '');
  if (!/\btravel/i.test(label) || /\b(commute|time to (the|our) office|travel time|reimburs|expenses?)\b/i.test(label)) return null;
  const saved = String(profileValue(profile, 'preferences.maxTravelPercent') || '').trim();
  const max = parseFloat(saved.replace(/[^\d.]/g, ''));
  if (!saved || !Number.isFinite(max)) return null;
  const labels = (field.options || []).map(o => (typeof o === 'string' ? o : o.label || '').trim());
  const asked = Math.max(0, ...(label.match(/\d+(?=\s*%)/g) || []).map(Number));
  if (labels.some(l => /^(yes|no)\b/i.test(l)) || field.type === 'checkbox') return yesNoFor(field, asked ? max >= asked : max > 0);
  if (labels.length) {
    // "0-25%", "Up to 50%", "None": the range holding the saved figure, else the widest one under it.
    const ranges = labels.map(l => {
      const n = (l.match(/\d+(?:\.\d+)?/g) || []).map(Number);
      if (!n.length) return /\b(none|no travel|not willing|0)\b/i.test(l) ? { l, lo: 0, hi: 0 } : null;
      return { l, lo: n.length > 1 ? Math.min(...n) : (/\b(up to|less than|under|<)/i.test(l) ? 0 : n[0]), hi: /\+|\bor more\b|\babove\b|\bover\b/i.test(l) ? Infinity : Math.max(...n) };
    }).filter(Boolean);
    const holds = ranges.find(r => max >= r.lo && max <= r.hi);
    if (holds) return holds.l;
    const under = ranges.filter(r => r.hi <= max).sort((a, b) => b.hi - a.hi)[0];
    return under ? under.l : null;
  }
  if (/^(are|can|will|would|do|is)\b/i.test(label)) return null;
  return /\b(what|how much)\b|percent|%/i.test(label) ? `${max}%` : null;
}

/** The form's own way of saying yes or no. */
function yesNoFor(field, yes) {
  const choices = (field.options || []).map(o => (typeof o === 'string' ? o : o.label || ''));
  if (choices.length) return choices.find(c => (yes ? /^\s*(yes|y)\b/i : /^\s*(no|n)\b/i).test(c)) || null;
  return field.type === 'checkbox' ? String(yes) : null;
}

// Countries a work-authorization question may name ("authorized to work in Sweden?").
const NAMED_COUNTRY = new RegExp('\\b(' + ['united states', 'u\\.s\\.(a\\.)?', 'usa', 'america', 'canada', 'mexico', 'brazil', 'united kingdom', 'u\\.?k\\.?',
  'britain', 'england', 'ireland', 'france', 'germany', 'netherlands', 'belgium', 'luxembourg', 'switzerland', 'austria',
  'spain', 'portugal', 'italy', 'sweden', 'norway', 'denmark', 'finland', 'iceland', 'poland', 'czechia', 'czech republic',
  'estonia', 'greece', 'romania', 'israel', 'united arab emirates', 'uae', 'saudi arabia', 'india', 'singapore', 'japan',
  'south korea', 'korea', 'china', 'hong kong', 'taiwan', 'australia', 'new zealand', 'south africa', 'european union', 'eu',
  'bulgaria', 'croatia', 'cyprus', 'hungary', 'latvia', 'lithuania', 'malta', 'slovakia', 'slovenia', 'liechtenstein'
].join('|') + ')\\b', 'i');
const COUNTRY_ALIASES = { ...COUNTRIES, 'u.s.': 'united states', 'u.s': 'united states', 'u.s.a': 'united states', 'u.s.a.': 'united states',
  america: 'united states', 'u.k.': 'united kingdom', 'u.k': 'united kingdom', britain: 'united kingdom', england: 'united kingdom',
  korea: 'south korea', 'czech republic': 'czechia', uae: 'united arab emirates' };

const EU_FREE_MOVEMENT = ['austria', 'belgium', 'bulgaria', 'croatia', 'cyprus', 'czechia', 'denmark', 'estonia', 'finland',
  'france', 'germany', 'greece', 'hungary', 'ireland', 'italy', 'latvia', 'lithuania', 'luxembourg', 'malta', 'netherlands',
  'poland', 'portugal', 'romania', 'slovakia', 'slovenia', 'spain', 'sweden', 'norway', 'iceland', 'liechtenstein', 'switzerland'];

/**
 * A work-authorization or sponsorship question about one named country is
 * answered from the countries the user may work in, not from their general
 * answer: a US citizen asked "authorized to work in Sweden?" is not. Returns
 * the yes/no to use, or null when the question names no country or the list
 * is empty.
 */
export function authorizationFor(field, profileKey, profile) {
  if (profileKey !== 'authorization.authorizedToWork' && profileKey !== 'authorization.requiresSponsorship') return null;
  const list = String(profile['authorization.countriesAuthorized'] || '').trim();
  const m = NAMED_COUNTRY.exec([field.label, field.pageQuestion].filter(Boolean).join(' '));
  if (!list || !m) return null;
  const canon = t => { const k = t.toLowerCase().trim(); return COUNTRY_ALIASES[k] || k; };
  const named = canon(m[1]);
  const allowed = list.split(/[,;/\n]|\band\b/).map(canon).filter(Boolean);
  // An EU citizen may work anywhere in the EU and EEA, and in Switzerland.
  if (allowed.some(c => c === 'european union' || c === 'eu')) allowed.push('european union', ...EU_FREE_MOVEMENT);
  const may = allowed.includes(named);
  if (profileKey === 'authorization.authorizedToWork') return may ? null : 'no';
  return may ? null : 'yes';
}

/**
 * "Please share all countries for which you have valid work authorization"
 * over US / UK / EU / Other (MATS): every option the user may work in, from
 * the countries saved and their citizenship (an EU citizen may work in the
 * EU). One per line for a group of tick boxes, else the first. Null when the
 * question is about something else or nothing saved names a listed option.
 */
export function authorizedCountriesAnswer(field, profile) {
  const label = cleanLabel(field.label || field.extractedLabel || '');
  if (!field.options?.length || !/\bcountr(y|ies)\b/i.test(label) ||
      !/\b(work authori[sz]ation|authori[sz]ed to work|(legally|eligible to|allowed to|right to) work|work permit)\b/i.test(label)) return null;
  const saved = [profileValue(profile, 'authorization.countriesAuthorized'), profileValue(profile, 'authorization.citizenship')]
    .map(v => String(v || '')).join(',');
  const canon = t => { const k = t.toLowerCase().replace(/\bcitizen(ship)?\b|\bnational\b/g, '').trim(); return COUNTRY_ALIASES[k] || ({ uk: 'united kingdom', eu: 'european union' })[k] || k; };
  const allowed = new Set(saved.split(/[,;/\n]|\band\b/).map(canon).filter(Boolean));
  if (!allowed.size) return null;
  const inEU = allowed.has('european union') || EU_FREE_MOVEMENT.some(c => allowed.has(c));
  const picked = field.options.map(o => (typeof o === 'string' ? o : o.label || '').trim()).filter(l => {
    const c = canon(l);
    return allowed.has(c) || (inEU && /^(european union|eea|eu\/eea|eu)$/.test(c));
  });
  if (!picked.length) return null;
  return field.type === 'checkboxgroup' ? picked.join('\n') : picked[0];
}

/**
 * "Do you accept the listed salary range for this position?" (Samsara): yes. Applying is
 * agreeing to look at the posted range; the figure itself is never offered (see lowestPay).
 */
export function acceptsPayRange(field) {
  if (!field.options?.length) return null;
  return /\b(accept|comfortable with|okay with|agree (to|with))\b[^?]{0,30}\b(listed|posted|stated|advertised|above|this|the)\b[^?]{0,20}\b(salary|pay|compensation|base)( range| band)?\b/i
    .test(cleanLabel(field.label || '')) ? yesNoFor(field, true) : null;
}

const EU_MEMBERS = EU_FREE_MOVEMENT.filter(c => !['norway', 'iceland', 'liechtenstein', 'switzerland'].includes(c));

/**
 * "Are you a citizen of any country that is NOT included in the following
 * list: Argentina, Australia, ...?" (export control, 10 CFR Part 810: Kairos
 * Power) answered from the saved citizenship. The United States is never on
 * such a list: a US citizen with no other citizenship takes a "U.S. citizen
 * only" option where there is one, and a US citizen's other citizenships are
 * what the list is checked against. An EU citizen of an unnamed member state
 * is on the list only when every member is. Null when the question is not
 * one, nothing is saved, or no option says the answer.
 */
export function citizenshipListAnswer(field, profile) {
  const label = cleanLabel(field.label || field.extractedLabel || '');
  const m = /\bcitizen\w* of any countr(?:y|ies)\b.*?\b(not )?(?:included |listed )?(?:in|on) the (?:following|below|above) list\b[^:]*:?(.*)$/i.exec(label);
  if (!m || !field.options?.length) return null;
  const canon = t => {
    const k = t.toLowerCase().replace(/\bcitizen(ship)?s?\b|\bnational\b|^\s*(the|or|and)\s+|[?*.]+$/g, '').trim();
    return COUNTRY_ALIASES[k] || ({ uk: 'united kingdom', eu: 'european union', 'republic of korea': 'south korea' })[k] || k;
  };
  const listed = new Set(m[2].split(/,|\bor\b/).map(canon).filter(Boolean));
  const held = String(profileValue(profile, 'authorization.citizenship') || '').split(/[,;/\n]|\band\b/).map(canon).filter(Boolean);
  if (listed.size < 3 || !held.length) return null;
  const options = field.options.map(o => (typeof o === 'string' ? o : o.label || '').trim());
  const others = held.filter(c => c !== 'united states');
  if (!others.length) {
    const only = options.find(o => /\bu\.?s\.?(a\.?)?\b.*\bcitizen\b.*\bonly\b|\bonly\b.*\bu\.?s\.?\b/i.test(o));
    if (only) return only;
  }
  const onList = c => (c === 'european union' ? EU_MEMBERS.every(e => listed.has(e)) : listed.has(c));
  const offList = (others.length ? others : held).some(c => !onList(c));
  return yesNoFor({ ...field, options }, m[1] ? offList : !offList);
}

/**
 * "What is your address?" with no city or postal code box beside it wants the
 * whole address, not only the street (Voyager's Greenhouse form). A box that
 * says street or line 1 keeps the street.
 */
export function onlyAddressBox(field, fields) {
  if (/street|line\s*1|address\s*1\b/i.test(bothLabels(field))) return false;
  const PART = /\b(city|town|zip|postal|post\s*code|postcode|state|province)\b/i;
  return !(fields || []).some(f => f !== field && f.id !== field.id && (f.frameId || 0) === (field.frameId || 0) &&
    (PART.test(`${f.label || ''} ${f.ariaLabel || ''}`) || /(^|[^a-z])(city|zip|postal)/i.test(`${f.name || ''} ${f.idAttr || ''}`)));
}

const CLEARANCE_ELIGIBLE = /\b(eligible|eligibility|able|qualify)\b[^?]{0,30}\b(obtain|get|receive|be granted|for)\b[^?]{0,30}\bclearance\b|\bclearance eligib/i;

/** "2333 Main St, Portland, OR 97201": street, city, state code and postal code. */
export function oneLineAddress(profile) {
  const get = k => String(profileValue(profile, k) || '').trim();
  const street = [get('address.line1'), get('address.line2')].filter(Boolean).join(' ');
  if (!street || !get('address.city')) return '';
  const state = get('address.state');
  const code = Object.keys(REGIONS).find(k => k.length === 2 && REGIONS[k] === normalize(state));
  const region = [code ? code.toUpperCase() : state, get('address.postalCode')].filter(Boolean).join(' ');
  return [street, get('address.city'), region].filter(Boolean).join(', ');
}

export function resolveValue(field, profileKey, profile) {
  const forCountry = authorizationFor(field, profileKey, profile);
  if (forCountry) profile = { ...profile, [profileKey]: forCountry };
  // "Are you eligible for a US security clearance?" asks whether one could be granted, which
  // rests on US citizenship, not whether one is held (HavocAI got the saved "No").
  if (profileKey === 'screening.securityClearance' && CLEARANCE_ELIGIBLE.test(bothLabels(field))) {
    const citizen = /\b(u\.?s\.?a?|united states|american)\b/i.test(String(profileValue(profile, 'authorization.citizenship') || ''));
    return citizen ? 'yes' : null;
  }
  // A country code typed into a suggestion list finds the wrong place: "US"
  // matched "US Virgin Islands" before "United States" (ElevenLabs).
  if (/^(address|employment|education)\.country$/.test(profileKey) && !field.options?.length && (field.combobox || field.widget === 'listbox')) {
    const code = normalize(String(profileValue(profile, profileKey, { repeatIndex: field.repeatIndex || 0 }) || ''));
    const name = COUNTRIES[code];
    if (name) return name.replace(/\b\w/g, c => c.toUpperCase());
  }
  // A signature asking for the middle initial: "Pat Q. Brien".
  if (profileKey === 'identity.fullName' && /\bmiddle\s+initial\b/i.test(bothLabels(field))) {
    const part = k => String(profileValue(profile, k) || '').trim();
    const middle = part('identity.middleName');
    if (part('identity.firstName') && part('identity.lastName')) {
      return [part('identity.firstName'), middle ? `${middle[0].toUpperCase()}.` : '', part('identity.lastName')].filter(Boolean).join(' ');
    }
  }
  // "Preferred First & Last Name": the name the user goes by, then the last name.
  if (profileKey === 'identity.preferredName' && field.type !== 'checkbox' && /\b(last|full)\b/i.test(bothLabels(field))) {
    const first = String(profileValue(profile, 'identity.preferredName') || profileValue(profile, 'identity.firstName') || '').trim();
    const last = String(profileValue(profile, 'identity.lastName') || '').trim();
    return first && last ? `${first} ${last}` : null;
  }
  // "Feel free to share your preferred name and pronouns" (Samsara): both.
  if (profileKey === 'identity.preferredName' && !field.options?.length && /\bpronouns?\b/i.test(bothLabels(field))) {
    const name = String(profileValue(profile, 'identity.preferredName') || profileValue(profile, 'identity.firstName') || '').trim();
    const pronouns = String(profileValue(profile, 'identity.pronouns') || '').trim();
    if (name && pronouns) return `${name} (${pronouns})`;
  }
  const raw = profileValue(profile, profileKey, { repeatIndex: field.repeatIndex || 0 });
  if (raw === '' || raw === null || raw === undefined) return null;
  // A gender list in other words than the saved one: "Male" is "Man" or "Cis-man" (Samsara).
  if (profileKey === 'demographics.gender' && field.options?.length) {
    const labels = field.options.map(o => (typeof o === 'string' ? o : o.label || '').trim());
    const kind = /^(male|man|m)$/i.test(String(raw).trim()) ? 'man' : /^(female|woman|f)$/i.test(String(raw).trim()) ? 'woman' : '';
    const same = kind && !labels.some(l => normalize(l) === normalize(String(raw)));
    if (same) {
      const pick = labels.find(l => new RegExp(`^${kind}$`, 'i').test(l)) || labels.find(l => new RegExp(`^cis[- ]?(gender )?${kind}$`, 'i').test(l)) ||
        labels.find(l => (kind === 'man' ? /^(male|man)\b/i : /^(female|woman)\b/i).test(l));
      if (pick) return pick;
    }
  }

  let value = String(raw).trim();
  // "Graphic Design (Art History coursework; did not finish, ...)":
  // the user's note stays out of a one-line school, major or degree box.
  if (/^(education\.(school|major|degree)|work\.(school|fieldOfStudy|highestDegree))$/.test(profileKey) && field.tag === 'input' && !field.multiline) {
    value = value.replace(/\s*\([^()]*\)/g, '').trim() || value;
  }
  const def = FIELD_BY_KEY[profileKey];
  // "GitHub Username" (Mapbox) takes the handle, not the profile link.
  if (/^links\./.test(profileKey) && /\b(user ?name|handle)\b/i.test(bothLabels(field))) {
    const handle = value.match(/^(?:https?:\/\/)?(?:www\.)?[\w.-]+\.\w+\/(?:in\/|@)?([\w.-]+)\/?$/i);
    if (handle) return handle[1];
  }
  // Terms asked as a choice: the option that agrees, whatever its words
  // ("I have read and acknowledge Sentry's Applicant Privacy Policy.").
  if (profileKey === 'preferences.agreeToTerms' && field.options?.length && /^(yes|true)$/i.test(value)) {
    const labels = field.options.map(o => (typeof o === 'string' ? o : o.label || ''));
    const agrees = labels.filter(l => /\b(yes|agreed?|accept(ed)?|acknowledged?|consent(ed)?|understand|have read|confirm(ed)?)\b/i.test(l) &&
      !/\b(no|not|don'?t|decline|disagree|opt[- ]out|withdraw)\b/i.test(l));
    if (agrees.length === 1) return agrees[0];
  }
  // A saved "No" or "None" asked as a list with no plain "No": the one option
  // meaning none ("Active Security Clearance(s)": "Not Applicable", Rocket Lab).
  if (field.options?.length && /^(no|none|n\/?a|false)$/i.test(value) && !DEMOGRAPHIC_KEYS.has(profileKey)) {
    const labels = field.options.map(o => (typeof o === 'string' ? o : o.label || '').trim());
    if (!labels.some(l => l.toLowerCase() === value.toLowerCase())) {
      const none = labels.filter(l => /^(none|no\b|not applicable|n\/a|i (do not|don'?t) have\b|not (currently )?held)/i.test(l));
      if (none.length === 1) return none[0];
    }
  }
  // A number box takes digits only: "180,000" typed into one leaves it empty.
  if (field.type === 'number' && /^[^\d]{0,4}\d[\d,.]*\s?k?\s*[^\d]{0,8}$/i.test(value)) {
    const n = Number(value.replace(/[^\d.]/g, '').replace(/\.(?=\d{3}\b)/g, ''));
    if (Number.isFinite(n)) return String(/\dk\b|\d k\b/i.test(value) ? n * 1000 : n);
  }

  // A form that splits a date into month and year gets the part it asks for.
  const part = datePartFor(field, profileKey);
  let month = 0;
  if (part) {
    const parts = dateParts(value);
    if (!parts) return null;
    if (part === 'year') value = String(parts.year);
    else if (part === 'day') {
      const d = String(raw).match(/^\d{4}-\d{2}-(\d{2})/);
      if (!d) return null;
      value = d[1];
    } else {
      if (!parts.month) return null;
      month = parts.month;
      value = String(month).padStart(2, '0');
      // A month list read without its options (Greenhouse's react-select) is searched by name: "07" finds nothing.
      if (!field.options?.length && (field.combobox || field.widget === 'listbox')) {
        const name = MONTH_NAMES[month - 1];
        value = name.charAt(0).toUpperCase() + name.slice(1);
      }
    }
  }

  if (!part && DATE_KEYS.has(profileKey) && !field.options?.length) {
    // A date picker cannot take "Immediately"; it means today.
    if (field.datePicker && !dateParts(value) && /^(immediately|asap|now|available now|right away|today)\b/i.test(value)) {
      const today = new Date();
      const [y, m, d] = [today.getFullYear(), String(today.getMonth() + 1).padStart(2, '0'), String(today.getDate()).padStart(2, '0')];
      const hint = `${field.placeholder || ''} ${field.label || ''}`.toLowerCase();
      // A native date input takes ISO; a script picker parses its own
      // format, shown in its placeholder or, failing that, US month-first.
      if (field.type === 'date' || /yyyy-mm-dd/.test(hint)) return `${y}-${m}-${d}`;
      if (/dd\s*\/\s*mm/.test(hint)) return `${d}/${m}/${y}`;
      return `${m}/${d}/${y}`;
    }
    value = formatDate(field, value);
  }

  if (field.type === 'checkbox') {
    // A box that is one answer of a question ("Yes" under "Are you in the Bay
    // Area?") is ticked only when it is that answer.
    const box = String(field.optionText || '').trim();
    if (/^(yes|no)\b/i.test(box) && /^(yes|no|true|false|1|0)$/i.test(value)) {
      return /^yes/i.test(box) === /^(yes|true|1)$/i.test(value) ? 'true' : null;
    }
    // "I have a preferred name" is ticked when one is saved other than the
    // first name; the boxes it reveals get it on the next pass.
    if (profileKey === 'identity.preferredName') {
      const first = normalize(profileValue(profile, 'identity.firstName') || '');
      return value && normalize(value) !== first ? 'true' : null;
    }
    return /^(yes|true|1|on)$/i.test(value) ? 'true' : null;
  }

  if (field.options?.length) {
    const labels = field.options.map(o => ({ o, n: normalize(o.label) }));

    if (month) {
      const name = MONTH_NAMES[month - 1];
      const hit = labels.find(x => new RegExp(`(^|\\D)0?${month}(\\D|$)`).test(x.n)) ||
        labels.find(x => x.n.includes(name.slice(0, 3)));
      return hit ? hit.o.label : null;
    }

    const target = normalize(value);
    const exact = labels.find(x => x.n === target);
    if (exact) return exact.o.label;

    // A list of offices: the one in the user's metro area (Oakland: "San Mateo, CA").
    if (/^address\.(location|city)$/.test(profileKey)) {
      const metro = metroOf(String(profileValue(profile, 'address.city') || value));
      const near = metro && labels.find(x => metroOf(x.n) === metro);
      if (near) return near.o.label;
    }

    // "CA" for "California", "USA" for "United States", also where the
    // option carries more ("United States +1", "United States of America").
    const expanded = REGIONS[target] || COUNTRIES[target];
    if (expanded) {
      const hit = labels.find(x => x.n === expanded) ||
        labels.find(x => x.n.startsWith(`${expanded} `) || x.n.startsWith(`${expanded} (`));
      if (hit) return hit.o.label;
      // A long list read only in part (SuccessFactors' countries stop at
      // "Bulgaria" for 100) is searched by the full name: "US" finds nothing.
      if (field.searchable) return expanded.replace(/\b\w/g, c => c.toUpperCase());
    }

    // Boolean profile values have to be mapped onto whatever this form calls
    // yes and no.
    if (def?.type === 'boolean' || /^(yes|no|true|false)$/i.test(value)) {
      const affirmative = /^(yes|true|1)$/i.test(value);
      const wanted = affirmative
        ? /^(yes|y|true|i am|i do|i agree|i understand|i acknowledge|i accept|i can)\b/
        : /^(no|n|false|i am not|i do not|i don't|i cannot|i can't)\b/;
      const hit = labels.find(x => wanted.test(x.n));
      if (hit) return hit.o.label;
      return null;
    }

    // A start that several options share ("Northfield University -
    // Bothell", "- Seattle", "- Tacoma") is not an answer; the model decides.
    const starts = labels.filter(x => x.n.startsWith(target));
    if (starts.length > 1) return null;
    const partial = starts[0] || labels.find(x => target.length > 2 && x.n.includes(target));
    return partial ? partial.o.label : null;
  }

  // A yes/no answer typed into a text box reads as a word, not a stored flag.
  if (def?.type === 'boolean' && field.type !== 'checkbox') {
    if (/^(yes|true|1)$/i.test(value)) return 'Yes';
    if (/^(no|false|0)$/i.test(value)) return 'No';
  }

  // A phone box that starts with a dial code ("+31") reads what follows as
  // that country's number unless the number carries its own code.
  if (profileKey === 'contact.phone' && isPhoneBox(field) && /^\s*\+/.test(field.currentValue || '') && !value.startsWith('+')) {
    const national = value.replace(/\D/g, '');
    const code = String(profileValue(profile, 'contact.phoneCountryCode') || '').replace(/\D/g, '') ||
      (national.length === 10 && /^(us|usa|united states|canada|ca)/i.test(String(profileValue(profile, 'address.country') || 'us')) ? '1' : '');
    if (code) value = `+${code} ${national.startsWith(code) && national.length > 10 ? national.slice(code.length) : national}`;
  }

  if (field.maxLength && field.maxLength > 0 && value.length > field.maxLength) {
    // A two-letter box wants "CA", not "Ca" (CalCareers' state).
    const target = normalize(value);
    const code = Object.keys(REGIONS).find(k => REGIONS[k] === target) ||
      (Object.values(COUNTRIES).includes(target) && field.maxLength >= 2 ? (target === 'united states' ? 'us' : target === 'united kingdom' ? 'uk' : '') : '');
    if (code && code.length <= field.maxLength) return code.toUpperCase();
    // Otherwise shortened at a word, not cut mid-word.
    return fitToLimit(value, field.maxLength);
  }
  return value;
}

/** A free text box for a phone number. */
function isPhoneBox(field) {
  if (field.options?.length || field.tag === 'select' || field.type === 'radio' || field.type === 'checkbox') return false;
  return field.type === 'tel' || /\b(phone|mobile|cell|telephone)\b/i.test(`${field.label || ''} ${field.name || ''}`) &&
    !/type|code|extension|\bext\b/i.test(field.label || '');
}

/**
 * Turn the raw repeat numbers the extractor found into zero-based indexes.
 *
 * Some forms number their employer blocks from zero and some from one, and a
 * page using ordinal words ("most recent", "previous") reports 1 and 2. Taking
 * the smallest number actually present as the first entry handles all three
 * without guessing per site.
 */
export function normaliseRepeats(fields) {
  // A counter in an id (Workday's workExperience-4, -15, -28) only orders
  // the blocks of its kind: they are the first, second, third job.
  const rank = new Map();
  for (const f of fields) {
    if (!f.repeatGroup || typeof f.repeatRaw !== 'number') continue;
    if (!rank.has(f.repeatGroup)) rank.set(f.repeatGroup, new Set());
    rank.get(f.repeatGroup).add(f.repeatRaw);
  }
  for (const [group, raws] of rank) rank.set(group, [...raws].sort((a, b) => a - b));

  const raws = fields.filter(f => !f.repeatGroup).map(f => f.repeatRaw).filter(n => typeof n === 'number' && n >= 0);
  const base = raws.length ? Math.min(...raws) : 0;
  return fields.map(f => ({
    ...f,
    repeatIndex: f.repeatGroup && typeof f.repeatRaw === 'number' ? rank.get(f.repeatGroup).indexOf(f.repeatRaw)
      : typeof f.repeatRaw === 'number' ? Math.max(0, f.repeatRaw - base) : 0
  }));
}

/**
 * Fit a chosen key to the block the field sits in: an employer block's city is
 * that job's location, a referee's phone is not the applicant's. A mapping the
 * user locked in the skills editor is theirs and is left exactly as it is.
 *
 * @returns {object} the field with its adjusted key, or with `reason` set and
 *   no key when nothing in the profile belongs there.
 */
export function placeInScope(field) {
  if (field.locked) return field;
  const placed = scopeKey(field, field.profileKey);
  if (!placed.key) return { ...field, profileKey: null, blockedKey: field.profileKey, reason: placed.reason };
  return { ...field, profileKey: placed.key };
}

/**
 * Answers kept in the profile that happen to sit in a big text box. A "Duties"
 * box is multi-line, but the duties are already written down for that job;
 * sending it to the writer would invent new ones.
 */
const STORED_LONG = new Set([
  'employment.description', 'employment.reasonForLeaving',
  'screening.gapExplanation', 'screening.licenses', 'screening.equipment'
]);

function storedAnswer(field, profile) {
  if (field.forceLong) return false;
  const match = matchField(field);
  if (!match || match.confidence < HEURISTIC_ACCEPT) return false;
  const placed = placeInScope({ ...field, profileKey: match.key });
  return STORED_LONG.has(placed.profileKey) && resolveValue(placed, placed.profileKey, profile) !== null;
}

/** Which blocks belong to which list. A supervisor block is part of a job. */
const LIST_SCOPES = { employment: ['employment', 'supervisor'], education: ['education'], references: ['reference'] };
const LIST_NAME_PROP = { employment: 'company', education: 'school', references: 'fullName' };

/**
 * Split unnumbered reference fields into blocks by where a question repeats:
 * three blocks of Name, Phone, Email with no number on any of them are three
 * references, not one. Returns the block number (0, 1, 2...) per field id.
 */
function blocksByRepetition(fields) {
  const blocks = new Map();
  let block = 0;
  let seen = new Set();
  for (const f of fields) {
    const question = normalize(f.label || f.name || '');
    if (seen.has(question)) {
      block++;
      seen = new Set();
    }
    seen.add(question);
    blocks.set(f.id, block);
  }
  return blocks;
}

/** A text box asking for a name or detail, not a yes or no. */
/** A question asking the applicant to record or link a video. */
export const ASKS_FOR_VIDEO = /\b(provide|record|upload|share|submit|send|attach|link to) (us )?(a|an|your)? ?(short |brief |quick )?(\d+[-–]\d+[ -]minutes? |\d+[ -]minute )?(video|loom|recording)\b|\bvideo (introduction|intro|link|submission)\b/i;

const ASKS_FOR_DETAIL = /\b(who|which|whom|what|when|specify|name of|list|describe|explain|details?|timeline|how (long|soon|much|many))\b/i;

/**
 * The "Add ..." buttons on a page whose list the profile has saved entries
 * for, as `{text, list}`. A list the page already shows entries of still
 * counts: forms add one entry at a time.
 */
export function entriesToAdd(extraction, profile, historyDepth = Infinity) {
  const counts = blockCounts(extraction?.fields || []);
  const seen = new Set();
  return (extraction?.addButtons || []).filter(b => {
    if (seen.has(b.list) || (counts[b.list] || 0) >= entriesWanted(profile, b.list, historyDepth)) return false;
    seen.add(b.list);
    return true;
  }).map(({ text, list }) => ({ text, list }));
}

const LIST_SCOPE = { employment: 'employment', education: 'education', references: 'reference' };

/** How many blocks of a list the page should show: one per saved entry, as far as the settings go. */
function entriesWanted(profile, list, historyDepth = Infinity) {
  const saved = listEntries(profile, list).length;
  return list === 'employment' ? Math.min(saved, historyDepth) : saved;
}

/**
 * The blocks of each list on the page: by the form's numbering, or, on a
 * form that does not number them, by how often one question repeats (two
 * "Company" boxes in the employer section are two jobs).
 */
export function blockCounts(rawFields) {
  const fields = normaliseRepeats(rawFields).map(f => ({ ...f, scope: f.scope || scopeOf(f).scope }));
  const counts = {};
  for (const [list, scope] of Object.entries(LIST_SCOPE)) {
    const mine = fields.filter(f => f.scope === scope);
    if (!mine.length) { counts[list] = 0; continue; }
    const numbered = new Set(mine.map(f => f.repeatIndex || 0)).size;
    const byLabel = new Map();
    for (const f of mine) {
      const label = normalize(cleanLabel(f.label || f.ariaLabel || ''));
      if (label) byLabel.set(label, (byLabel.get(label) || 0) + 1);
    }
    // "Month" and "Year" repeat within one block (From and To): only a
    // question asked once per block counts.
    const repeats = [...byLabel.entries()].filter(([l]) => !/^(month|year|day|from|to)$/.test(l)).map(([, n]) => n);
    // Rows with a name box each are counted by it: a question asked once
    // under the heading (PG&E) made seven rows look like one, and "Add"
    // was pressed for rows the form then required.
    const names = pattern('rowName', list) ? mine.filter(f => isNameBox(f, pattern('rowName', list))).length : 0;
    counts[list] = Math.max(numbered, names || (repeats.length ? Math.min(...repeats) : 1));
  }
  return counts;
}

/**
 * Press each safe "Add another" button until the page shows a block for
 * every saved job, school or reference (Workday's "Add Another" under Work
 * Experience). One press at a time, each one checked: a press that adds no
 * boxes stops that button. Returns the page read again, or the same
 * extraction when nothing was pressed.
 */
const MAX_ADDS = 12;

async function addEntryBlocks(tabId, extraction, profile, historyDepth, read, signal) {
  let pressed = 0;
  const done = new Set();
  for (let round = 0; round < MAX_ADDS && !signal?.aborted; round++) {
    const counts = blockCounts(extraction.fields || []);
    const button = (extraction.addButtons || []).find(b => b.safe && !done.has(b.list) &&
      (counts[b.list] || 0) < entriesWanted(profile, b.list, historyDepth));
    if (!button) break;
    let reply = null;
    try {
      [reply] = await runInFrames(tabId, item => globalThis.__applicatorPressAdd?.(item) || { added: false },
        [{ selector: button.selector }], [button.frameId || 0]);
    } catch { /* the page went away: read it again below */ }
    if (!reply?.result?.added) { done.add(button.list); continue; }
    pressed++;
    const next = await read();
    if (!next?.ok) break;
    // Pressed, but the page counts no new block of that list (a dialog, a
    // different list): no more presses for it.
    if ((blockCounts(next.fields || [])[button.list] || 0) <= (counts[button.list] || 0)) done.add(button.list);
    extraction = next;
  }
  if (pressed) trace('added-entries', { pressed, counts: blockCounts(extraction.fields || []) });
  return { extraction, pressed };
}

/**
 * Pick the entry for each block of a list that the page does not number.
 *
 * Sites like CaselleHire open an "Add employer" dialog with one unnumbered
 * block, and list the employers already added beside it. Filling that dialog
 * with the newest job every time would add the same job five times. Instead
 * the first entry, newest first, whose name is not already on the page is
 * chosen. A page whose blocks are numbered is left to its numbering.
 *
 * References go one step further, because a site that asks for one reference
 * per page does not always list the ones already given. `used` holds, per
 * list, the entries already given on this site in this browser session, and
 * those are passed over too. Once every saved reference has been given, it
 * starts again from the first. Several unnumbered reference blocks on one
 * page take consecutive entries.
 *
 * @param {object[]} fields
 * @param {string} pageText
 * @param {object} profile
 * @param {object} [used]  { references: number[] } indexes given this session
 */
export function pickListEntries(fields, pageText, profile, used = {}) {
  const page = normalize(pageText || '');
  let out = fields;
  for (const [list, scopes] of Object.entries(LIST_SCOPES)) {
    const inList = out.filter(f => scopes.includes(f.scope));
    if (!inList.length || inList.some(f => typeof f.repeatRaw === 'number')) continue;
    const entries = listEntries(profile, list);
    const prop = LIST_NAME_PROP[list];
    const nameOf = e => normalize(e[prop]);
    const given = new Set(list === 'references' ? used.references || [] : []);
    // Rows of jobs or schools, each starting at its company or school box;
    // references, which can be one per page, split where a question repeats.
    const blocks = list === 'references' ? blocksByRepetition(inList) : blocksByName(inList, pattern('rowName', list));
    // What each row already holds. A saved job shown as a filled-in row
    // (workatastartup) is in a box's value, which page text never includes.
    const typed = new Map();
    for (const f of inList) {
      const value = normalize(f.currentValue || '');
      if (!value) continue;
      const block = blocks.get(f.id) || 0;
      typed.set(block, [...(typed.get(block) || []), value]);
    }
    const holds = (block, e) => !!nameOf(e) && (typed.get(block) || []).some(v => v.includes(nameOf(e)));
    const typedText = [...typed.values()].flat().join(' | ');
    // An employer that is also a school ("University of Portland" was in
    // PG&E's school list) is on the page only with its job title; any other
    // name on the page is a listed job (pages that show saved jobs as text).
    const schools = listEntries(profile, 'education').map(e => normalize(e.school || '')).filter(Boolean);
    const schoolish = name => /\b(university|college|school|institute|academy)\b/.test(name) || schools.some(s => s.includes(name) || name.includes(s));
    const listed = e => {
      const name = nameOf(e);
      if (!name) return false;
      if (typedText.includes(name)) return true;
      if (!page.includes(name)) return false;
      const title = list === 'employment' ? normalize(e.title || '') : '';
      return !(title && schoolish(name)) || page.includes(title);
    };

    // The first entry, in list order, not yet on the page nor given before.
    let start = entries.findIndex((e, i) => !given.has(i) && !listed(e));
    if (start < 0 && given.size) {
      // Every one has been given on this site already: start the list again.
      start = entries.findIndex(e => !listed(e));
    }
    if (start < 0) start = entries.length; // every saved entry is already listed

    const count = Math.max(0, ...blocks.values()) + 1;
    const own = Array.from({ length: count }, (_, b) => entries.findIndex(e => holds(b, e)));
    if (start === 0 && count === 1 && own[0] < 0) continue;

    // A row holding a saved entry is that entry; blank rows take the next
    // entries not on the page, in order, skipping any already given.
    const order = [];
    for (let i = start; i < entries.length; i++) if (!given.has(i) && !listed(entries[i])) order.push(i);
    if (!order.length || order[0] !== start) order.unshift(start);
    const assigned = [];
    let next = 0;
    for (let b = 0; b < count; b++) assigned[b] = own[b] >= 0 ? own[b] : (order[next++] ?? entries.length);
    trace('listEntries', { list, start, count, assigned, own, listed: entries.map((e, i) => (listed(e) ? i : -1)).filter(i => i >= 0),
      typed: [...typed.entries()].map(([b, v]) => [b, v.map(x => x.slice(0, 40))]) });
    out = out.map(f => {
      if (!scopes.includes(f.scope)) return f;
      return { ...f, repeatIndex: assigned[blocks.get(f.id) || 0] };
    });
  }
  return out;
}

// The box that starts a row of a list (a job's company, a school's name)
// is the rules pack's `rowName` pattern for the list.

/**
 * Split unnumbered rows of jobs or schools at each company or school box:
 * rows of Company, Title, Dates are one job each. Fields before the first
 * such box belong to the first row. With one name box or none, it is all one
 * block, so a single "Add employer" dialog is never split by a repeated
 * "Month" or "Year".
 */
/**
 * The box that takes a row's name: not a choice about it ("Current
 * Employer?" is Yes/No) nor a follow-up ("If you selected Other for
 * school..."); PG&E's rows split in two at each.
 */
function isNameBox(f, nameLabel) {
  // A question ("Current Employer?") is not the name box even when read
  // without its options (a later pass does not open a list read before).
  return nameLabel.test(f.label || '') && !/^\s*if\b|\?\s*$/i.test(f.label || '')
    && f.type !== 'radio' && f.type !== 'checkbox' && !(f.options?.length && f.options.length <= 5);
}

function blocksByName(fields, nameLabel) {
  const blocks = new Map();
  const isName = f => isNameBox(f, nameLabel);
  const names = fields.filter(isName);
  if (names.length < 2) {
    for (const f of fields) blocks.set(f.id, 0);
    return blocks;
  }
  // A row starts at its name box, unless the rows open with another question
  // that comes round once per row before the name: PG&E's rows open with
  // "Current Employer?" and the dates, the company box third, and the
  // dates belong to the row after them. Then that question starts each row.
  const labelOf = f => normalize(f.label || '');
  const firstName = fields.indexOf(names[0]);
  const times = label => fields.filter(f => labelOf(f) === label).length;
  const lead = fields.slice(0, firstName).map(labelOf).find(label => label && times(label) === names.length) || '';
  let block = 0;
  let seen = false;
  for (const f of fields) {
    const starts = lead ? labelOf(f) === lead : isName(f);
    if (starts && seen) block++;
    if (starts) seen = true;
    blocks.set(f.id, block);
  }
  return blocks;
}

/** Where this browser session keeps the references given, per site. */
const SESSION_KEY = 'applicator.listsGiven';

function sessionArea() {
  return globalThis.chrome?.storage?.session || null;
}

/** Entries given on `site` this browser session: { references: [0, 2] }. */
export async function givenThisSession(site) {
  const area = sessionArea();
  if (!area) return {};
  try {
    const all = (await area.get(SESSION_KEY))[SESSION_KEY] || {};
    return all[site] || {};
  } catch {
    return {};
  }
}

/** Remember the references just filled on `site`, for the next form there. */
async function rememberGiven(site, filled, { restart = false } = {}) {
  const area = sessionArea();
  const indexes = [...new Set(filled
    .filter(f => String(f.profileKey || '').startsWith('references.'))
    .map(f => f.repeatIndex || 0))];
  if (!area || !indexes.length) return;
  try {
    const all = (await area.get(SESSION_KEY))[SESSION_KEY] || {};
    const prior = restart ? [] : all[site]?.references || [];
    all[site] = { ...(all[site] || {}), references: [...new Set([...prior, ...indexes])].sort((a, b) => a - b) };
    await area.set({ [SESSION_KEY]: all });
  } catch {
    /* session storage unavailable: each form starts from the first reference */
  }
}

/** Which CV this browser session sent on each tab and site, so every page of one application sends the same. */
const CV_KEY = 'applicator.cvChosen';

/**
 * The CV for this application, and the text the fill writes from. With one
 * CV (or none) that is the main one. With several, TypeSafe picks the one
 * made for this kind of job; without TypeSafe, the one whose stated jobs
 * share the most words with the role; and on a later page of the same
 * application (no job named, or the same one) the one sent before.
 *
 * @returns {Promise<{doc: object|null, text: string, usage?: object}>}
 */
export async function chooseResume({ cvs, mainText, context = {}, settings, tabId, site, signal }) {
  const withText = (cvs || []).map((cv, i) => ({ ...cv, text: i === 0 ? mainText || cv.text || '' : cv.text || '' }));
  const result = cv => ({ doc: cv || null, text: cv?.text || mainText || '' });
  if (withText.length < 2) return result(withText[0]);

  const role = String(context.role || '').trim();
  const area = sessionArea();
  const slot = `${tabId}|${site}`;
  let before = null;
  try { before = area && ((await area.get(CV_KEY))[CV_KEY] || {})[slot]; } catch { /* no session storage */ }
  const earlier = before && withText.find(cv => cv.id === before.id);
  if (earlier && (!role || role === before.role)) return result(earlier);

  let id = null;
  let usage;
  if (role || context.jobDescription) {
    if (settings.classifier === 'typesafe' && settings.typesafeApiKey) {
      try {
        ({ id, usage } = await pickResume({ cvs: withText, context, settings, signal }));
      } catch { /* TypeSafe down: the words decide */ }
    }
    id = id || resumeByWords(withText, `${role} ${context.jobDescription || ''}`)?.id;
  }
  const chosen = withText.find(cv => cv.id === id) || earlier || withText[0];
  try {
    if (area) {
      const all = (await area.get(CV_KEY))[CV_KEY] || {};
      all[slot] = { id: chosen.id, role };
      await area.set({ [CV_KEY]: all });
    }
  } catch { /* the next page picks again */ }
  return { ...result(chosen), usage };
}

/** The CV whose stated jobs ("Marketing, sales") share the most words with the job, or none. */
export function resumeByWords(cvs, jobText) {
  const words = text => new Set(normalize(text).split(/[^a-z0-9+#]+/).filter(w => w.length > 2 && !/^(and|the|for|jobs?|roles?|work|cvs?|resume)$/.test(w)));
  const job = words(jobText);
  let best = null;
  let bestScore = 0;
  for (const cv of cvs || []) {
    const said = [...words(cv.category || '')];
    const score = said.filter(w => job.has(w)).length / Math.max(1, said.length);
    if (score > bestScore) { best = cv; bestScore = score; }
  }
  return best;
}

/** Extra words that pick the right suggestion: "Oakland" plus "CA, United States". */
export function suggestionHint(field, profile) {
  const key = field.profileKey || '';
  const i = { repeatIndex: field.repeatIndex || 0 };
  const [stateKey, countryKey] = key.startsWith('employment.')
    ? ['employment.state', 'employment.country']
    : key.startsWith('education.')
      ? ['education.state', 'education.country']
      : ['address.state', 'address.country'];
  const words = [];
  // Suggestions spell places their own way: "Portland, CA, USA" for a
  // profile saying California and US. Every spelling counts towards a match.
  const state = String(profileValue(profile, stateKey, i) || '').trim();
  if (state) {
    words.push(state);
    const n = normalize(state);
    const abbr = Object.keys(REGIONS).find(k => REGIONS[k] === n);
    if (abbr) words.push(abbr.toUpperCase());
    else if (REGIONS[n]) words.push(REGIONS[n]);
  }
  const country = String(profileValue(profile, countryKey, i) || '').trim();
  if (country) {
    words.push(country);
    if (/^(us|usa|united states( of america)?)$/i.test(country)) words.push('US', 'USA', 'United States');
  }
  return words.join(', ');
}

/**
 * A conditional question the model answers with a saved job's or school's
 * own detail: "If you served as an agency worker or consultant, please
 * indicate your actual employer" got the company (PG&E). Nothing saved says
 * whether the condition holds, and the row's own box already has the value.
 */
export function conditionalRowValue(field, key) {
  return /^(employment|education)\./.test(key || '') && CONDITIONAL.test(bothLabels(field));
}

/** Fields the user has already answered are left alone unless asked otherwise. */
function isAlreadyAnswered(field) {
  // A box the page itself marks as wrong is written again.
  if (field.invalid) return false;
  if (field.type === 'radio' || field.type === 'checkbox') return !!field.currentValue;
  if (field.tag === 'select') return !!field.currentValue && !field.pageDefault;
  // A phone box the page starts with its country's dial code ("+31") holds
  // no number yet.
  if (isPhoneBox(field)) return String(field.currentValue || '').replace(/\D/g, '').length >= 5;
  // A date picker showing today's date before anyone touched it is showing its
  // own default: Ashby displays one it never saves, then says it is missing.
  if ((field.datePicker || field.type === 'date') && showsToday(field.currentValue)) return false;
  return String(field.currentValue || '').trim() !== '';
}

/**
 * The product a yes/no "Have you used X?" asks about, or '' for any other
 * question. "Our product" is the company's.
 */
export function usedProduct(field, context = {}) {
  // "We're always curious - have you used Tailscale before?": the question after the lead-in.
  const label = cleanLabel(field.label || field.extractedLabel || '').replace(/^.*?[-\u2013\u2014:!.]\s+(?=(have|had|did) you\b)/i, '');
  const m = label.match(/^(?:have|had|did) you (?:ever )?(?:used|tried|worked with|built (?:with|on)|deployed|integrated)\s+(.+?)(?:\s+(?:before|previously|in the past|yet|at work|professionally|in production))*\s*\?*\s*\*?$/i);
  if (!m) return '';
  const choices = (field.options || []).map(o => (typeof o === 'string' ? o : o.label || '').trim());
  const yesNo = field.type === 'checkbox' || choices.some(c => NO_CHOICE.test(c));
  if (!yesNo) return '';
  const name = m[1].replace(/^(a|an|the|any)\s+/i, '').trim();
  if (/^(our|this|the) (product|platform|tool|app|api|service)s?$/i.test(name) || /^(it|us)$/i.test(name)) return context.company || '';
  // Only a named tool or product ("Sentry", "Salesforce", "dbt"): whether
  // someone has done a kind of work ("customer-facing demos") is a judgment
  // on their résumé and projects, which TypeSafe makes, not a word match.
  const named = name.split(/\s+/).length <= 4 && (/[A-Z0-9+#.]/.test(name) || /^[a-z]+$/.test(name) && name.length <= 12);
  return named && !/\b(demos?|prototypes?|proofs?|projects?|products?|experience|customers?|clients?|teams?|tools?|systems?|applications?)\b/i.test(name) ? name : '';
}

/** Everything the user wrote about what they have done: résumé, jobs, projects. */
export function experienceText(profile) {
  const entries = list => listEntries(profile, list).map(e => Object.values(e || {}).join(' '));
  return [profileValue(profile, 'documents.resumeText'), profileValue(profile, 'documents.achievements'),
    ...entries('employment'), ...entries('projects')].filter(Boolean).join('\n');
}

function mentions(text, name) {
  const filler = /^(in|on|at|of|or|and|for|with|the|an|any|your|their|previous|prior|past|current|roles?|jobs?|positions?|work|professional(ly)?|before|ever|experience|setting|context|environment)$/;
  const words = String(name).toLowerCase().split(/[^a-z0-9+#]+/).filter(w => w.length > 1 && !filler.test(w));
  const hay = String(text || '').toLowerCase();
  return words.length > 0 && words.every(w => hay.includes(w));
}

/** The option saying no: "No", "Never", "I haven’t used it, but I’m excited to learn more!" (Tailscale). */
const NO_CHOICE = /^\s*(no|n|never|i have not|i haven['\u2019]t|i have never|i've never|i\u2019ve never)\b/i;

function answerNo(field) {
  if (field.yesNoBox || field.type === 'checkbox') return 'false';
  const choices = (field.options || []).map(o => (typeof o === 'string' ? o : o.label || ''));
  return choices.find(c => NO_CHOICE.test(c)) || null;
}

/** Whether a date box's text is today's date, in any common order. */
export function showsToday(text, now = new Date()) {
  const t = String(text || '').trim();
  if (!t) return false;
  const [y, m, d] = [now.getFullYear(), now.getMonth() + 1, now.getDate()];
  const n = (t.match(/\d+/g) || []).map(Number);
  if (n.length === 3) return (n[0] === y && n[1] === m && n[2] === d) || (n[2] === y && ((n[0] === m && n[1] === d) || (n[0] === d && n[1] === m)));
  const parts = dateParts(t);
  return n.length === 2 && !!parts && parts.year === y && parts.month === m && n.includes(d);
}

/**
 * A field's identity across passes over the same page. Extraction numbers
 * fields afresh every time, so the number cannot be used; the frame, the id or
 * name the page gave the control, and its question can.
 */
export function fieldIdentity(field) {
  // The element, not its label: a label that changes as the box fills (a
  // counter, a message that comes and goes) made the same box a new field.
  // Boxes sharing one handle (every job's name="summary") are told apart by
  // their place among them (`handleIndex`, mergeExtractions).
  const handle = field.idAttr || field.name ? `${field.idAttr || ''}#${field.name || ''}` : field.selector;
  const nth = field.handleIndex ? `@${field.handleIndex}` : '';
  const group = field.tickBoxes ? '|ticks' : '';
  return `${field.frameId || 0}|${handle}${nth}|${field.repeatRaw ?? ''}${group}`;
}

const DEMOGRAPHICS_OFF = 'Demographic questions are turned off in settings';
// TypeSafe's question and the extractor's label: a guard that only read one
// let "Preferred Pronouns" through as "Let us know how you'd like to be addressed".
const bothLabels = f => `${f.label || ''} ${f.extractedLabel || ''}`.trim();
// What a box must say before "Tick agreement boxes" ticks it.
// Consent to an interview being recorded counts, however it is asked ("Can Metaview transcribe all your interviews?").
const AGREEMENT = /\b(agree|accept|acknowledge|consent|certify|attest|confirm|understand|declare|authori[sz]e)\b|terms|privacy|policy|read (and|the)|interview[^?]*\b(record|transcrib|note[- ]?tak)|\b(record|transcrib|note[- ]?tak)\w*[^?]*interview/i;
const IDENTITY_ONLY_SAVED = 'Identity questions are only answered from your saved answers';

/**
 * Whether the page undid a write: a box written with a value that now shows
 * nothing, or a choice that now shows another option. A text box the page
 * merely reformatted ("(415) 555-0134") still counts as kept.
 */
export function wasCleared(field, written) {
  if (!written || written.value === undefined || written.value === null || written.value === '') return false;
  if (field.type === 'file' || field.type === 'checkbox') return false;
  const now = normalize(field.currentValue || '');
  if (!now) return true;
  if (!field.options?.length) return false;
  // A group of tick boxes reads back "US; EU" for "US\nEU": kept while each written one is ticked.
  if (field.type === 'checkboxgroup') {
    const ticked = now.split(';').map(s => s.trim());
    return !String(written.value).split('\n').map(normalize).filter(Boolean).every(w => ticked.some(t => t === w || t.includes(w)));
  }
  const want = normalize(String(written.value));
  // A dropdown reads back its option's value ("US") for the label written ("United States").
  const shown = field.options.find(o => typeof o === 'object' && normalize(String(o.value ?? '')) === now);
  return ![now, shown ? normalize(String(shown.label || '')) : ''].filter(Boolean)
    .some(n => n === want || n.includes(want) || want.includes(n));
}

/**
 * A location box the page filled from the visitor's IP ("San Francisco,
 * United States of America" for a user in Portland, Workable) holds no answer
 * of the user's: it is cleared for deciding, so the saved location goes in.
 * Only a "City, Country" value that does not name the saved city.
 */
function guessedLocation(field, profile) {
  const city = normalize(profileValue(profile, 'address.city') || '');
  const now = String(field.currentValue || '').trim();
  if (!city || !now || field.options?.length || field.type === 'checkbox') return {};
  if (!/\b(address|location|city)\b/i.test(`${field.label || ''} ${field.name || ''} ${field.idAttr || ''}`)) return {};
  if (/\b(street|line\s*1|address\s*1)\b/i.test(field.label || '') || /\d/.test(now) || !now.includes(',')) return {};
  return normalize(now).includes(city) ? {} : { currentValue: '' };
}

/**
 * A preferred-name box the page filled with a copy of the legal first name
 * (Workday does, the moment "I have a preferred name" is ticked) holds no
 * answer of the user's: it is cleared for deciding, so the saved preferred
 * name goes in.
 */
function copiedLegalName(field, profile) {
  const preferred = normalize(profileValue(profile, 'identity.preferredName') || '');
  const first = normalize(profileValue(profile, 'identity.firstName') || '');
  if (!preferred || !first || preferred === first || field.type === 'checkbox') return {};
  if (normalize(field.currentValue || '') !== first) return {};
  const where = `${field.idAttr || ''} ${field.name || ''} ${field.label || ''} ${String(field.section || '').split(' › ')[0]}`;
  return /preferred|nick/i.test(where) ? { currentValue: '' } : {};
}

/** How many times the page is read again for fields that appeared. */
export const MAX_PASSES = 3;
const SETTLE_MS = 450;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Descriptors ready for deciding: whose block, which repeat, which list entry. */
// A box the form keeps for its own staff (PG&E's "For Employer Use Only"
// got a written answer) is the rules pack's `officeUse` pattern.

function prepareFields(extraction, profile, used = {}) {
  return pickListEntries(
    normaliseRepeats(extraction.fields || []).map(f => ({ ...f, scope: scopeOf(f).scope, ...copiedLegalName(f, profile), ...guessedLocation(f, profile),
      ...(pattern('officeUse').test(`${f.label || ''} ${f.extractedLabel || ''}`) ? { notPart: true } : {}) })),
    extraction.pageText,
    profile,
    used
  );
}

/**
 * Decide what goes in each field: site skill, local rules, one TypeSafe round,
 * saved responses and the writer, in that order of cost.
 *
 * With TypeSafe as the engine, everything a model should see goes in one
 * round (see planWithTypeSafe): text boxes, dropdowns and radio groups asked
 * against their own options, rule matches to check, and written questions to
 * match against saved answers. Only the writer, which drafts prose, is a
 * separate call, and only for written questions nothing else answered.
 *
 * Only the autocomplete attribute, which is the page author saying exactly
 * what the box is, and the site skill are trusted without that check.
 *
 * @returns {Promise<{plan: object[], unfilled: object[], stats: object}>}
 */
async function decide(incoming, ctx) {
  const { settings, profile, responses, longTextMode, skill, context, onProgress, signal, historyDepth } = ctx;

  // Identity questions the user switched off go no further: not to a rule,
  // not to a model, whatever their label (see isIdentityQuestion).
  const withheld = settings.fillDemographics ? [] : incoming.filter(isIdentityQuestion);
  const fresh = incoming.filter(f => !withheld.includes(f));

  // Follow-ups ("Please specify") wait for the question before them, which
  // may be decided in this same pass, so they are set aside until the end.
  const order = ctx.pageFields || fresh;
  const position = new Map(order.map((f, i) => [f.id, i]));
  const followUps = new Map();
  for (const field of fresh) {
    const condition = followUpCondition(field);
    if (!condition || isAlreadyAnswered(field)) continue;
    // A follow-up that is itself a choice is answered like any other choice
    // (Pilot's relocation dropdown waited for the writer and was left empty).
    if (field.options?.length || field.tag === 'select' || ['radio', 'checkbox'].includes(field.type)) continue;
    let parent = null;
    const topic = followUpTopic(field);
    // One that names its subject follows a nearby choice asking about it, not
    // simply the box before ("If you will require relocation, ..." under an
    // in-office question is a question of its own).
    for (let i = (position.get(field.id) ?? 0) - 1, seen = 0; i >= 0 && !parent && (!topic || seen < 4); i--) {
      if ((order[i].frameId || 0) !== (field.frameId || 0)) continue;
      seen++;
      const choice = order[i].options?.length || ['radio', 'checkbox'].includes(order[i].type) || order[i].tag === 'select';
      if (!topic || (choice && normalize(order[i].label || order[i].ariaLabel || '').includes(topic))) parent = order[i];
    }
    if (parent) followUps.set(field.id, { field, parent, condition });
  }
  const challenges = fresh.filter(f => isChallenge(f) && !followUps.has(f.id));
  const fields = fresh.filter(f => !followUps.has(f.id) && !challenges.includes(f));
  const stats = { known: 0, heuristic: 0, checked: 0, overruled: 0, modelCalls: 0, requests: 0, usage: {}, skipped: [] };
  const floor = typeof settings.classifierConfidence === 'number' ? settings.classifierConfidence : 0.6;

  const withinDepth = f => {
    const def = FIELD_BY_KEY[f.profileKey];
    // A derived question of a row ("Current Employer?", employment.current)
    // is the row's too: guessed "No" in PG&E's spare rows, it made them required.
    const section = def?.repeating ? def.section : (String(f.profileKey || '').match(/^(employment|education|references)\./) || [])[1];
    if (!section) return true;
    const depth = section === 'employment' ? historyDepth : listEntries(profile, section).length;
    return (f.repeatIndex || 0) < depth;
  };

  const plan = [];
  const unfilled = withheld.map(f => ({ ...f, reason: DEMOGRAPHICS_OFF }));
  /**
   * An identity answer is only ever the user's own saved one: a model's pick
   * for "Gender" from a first name, or a saved "Yes, I identify as LGBTQ+."
   * typed into "Sexual Orientation", is refused.
   */
  const identityRefused = (field, key) => isIdentityQuestion(field) && !DEMOGRAPHIC_KEYS.has(key);
  const savedDemographics = [...DEMOGRAPHIC_KEYS].some(k => String(profileValue(profile, k) || '').trim() !== '');

  /**
   * Every gate a profile key passes before its value is typed: whose block
   * the field is in, demographics, an existing answer, conditional fields,
   * saved list entries. Returns the placed field with its value, or null
   * after recording why not.
   */
  const resolveKey = (hit, { record = true } = {}) => {
    const field = placeInScope(hit);
    const fail = reason => {
      if (record) unfilled.push(reason ? { ...field, reason } : field);
      return null;
    };
    if (!field.profileKey) return fail();
    const sensitive = DEMOGRAPHIC_KEYS.has(field.profileKey) || !!fieldDef(field.profileKey, profile)?.sensitive;
    if (sensitive && !settings.fillDemographics) return fail(DEMOGRAPHICS_OFF);
    if (identityRefused(field, field.profileKey)) return fail(IDENTITY_ONLY_SAVED);
    // A tick box is only ticked for words a person can read: UC's status boxes
    // ("Retired from UC", "In a layoff") had blank labels and were ticked as
    // terms to agree to.
    if (field.type === 'checkbox' && !/[a-z]/i.test(cleanLabel(field.label || field.ariaLabel || ''))) return fail('This tick box has no question to read');
    if (field.profileKey === 'preferences.agreeToTerms' && !AGREEMENT.test(`${field.label || ''} ${field.ariaLabel || ''}`)) {
      return fail('This does not read as terms to agree to');
    }
    if (isAlreadyAnswered(field) && !settings.overwriteExisting) return fail('Already answered on the page');
    if (!isFieldActive(profile, field.profileKey)) return fail('That answer does not apply, given your other answers');
    if (!withinDepth(field)) return fail('No saved entry left for this block (every saved one is already listed, or none is saved)');
    let value = resolveValue(field, field.profileKey, profile);
    if (value === null) return fail(`Nothing saved for ${FIELD_BY_KEY[field.profileKey]?.label || field.profileKey}`);
    if (field.profileKey === 'address.line1' && onlyAddressBox(field, order)) value = oneLineAddress(profile) || value;
    if (/^links\./.test(field.profileKey)) value = severalLinks(field, profile) || value;
    return { ...field, value, fieldKey: field.fieldKey || fieldKey(field) };
  };
  const place = hit => {
    const placed = resolveKey(hit);
    if (placed) plan.push(placed);
  };

  for (const field of challenges) unfilled.push({ ...field, reason: 'A test question, left for you to answer' });

  const { known, unknown, skipped } = applySkill(skill, fields);
  stats.known = known.length;
  stats.skipped = skipped;

  // Written questions skip the heuristics entirely. A heuristic match on one
  // would paste stored source material verbatim, and would undo a skill's
  // saved decision to treat the field as a written answer.
  const stored = new Set(unknown.filter(f => isDefinitelyEssay(f) && storedAnswer(f, profile)).map(f => f.id));
  // A long box in a job or school block is about that entry, so it is never
  // drafted: in a block past the saved entries (a half-done extra school the
  // site added) it stays empty, as does a school's description (SmartRecruiters
  // got a career summary there).
  const LIST_OF = { employment: 'employment', supervisor: 'employment', education: 'education' };
  const inEntry = f => {
    const list = LIST_OF[f.scope];
    if (!list) return '';
    const depth = list === 'employment' ? historyDepth : listEntries(profile, list).length;
    if ((f.repeatIndex || 0) >= depth) return 'No saved entry left for this block (every saved one is already listed, or none is saved)';
    // Only a school's own Description box: a question asked under an
    // Education heading ("Tell us about a project at school") is still written.
    const ownBox = /^(description|summary|details|notes|activities|achievements|accomplishments)\b/i.test(cleanLabel(f.label || ''));
    return list === 'education' && ownBox ? 'About one school, which your profile does not describe: left for you' : '';
  };
  for (const f of unknown) {
    const why = isDefinitelyEssay(f) && !stored.has(f.id) && inEntry(f);
    if (why) unfilled.push({ ...f, reason: why });
  }
  const forcedLong = unknown.filter(f => isDefinitelyEssay(f) && !stored.has(f.id) && !inEntry(f));
  const heuristicCandidates = unknown.filter(f => !isDefinitelyEssay(f) || stored.has(f.id));

  const { resolved: heuristicHits, unresolved: heuristicMisses } = settings.useHeuristicsFirst
    ? partitionFields(heuristicCandidates)
    : { resolved: [], unresolved: heuristicCandidates };
  stats.heuristic = heuristicHits.length;

  const typesafe = settings.classifier === 'typesafe';
  const open = f => !(isAlreadyAnswered(f) && !settings.overwriteExisting);
  // Not put to the model: what the page author declared, stored long answers,
  // fields already answered, and demographic questions the user switched off,
  // which are refused below whatever the model says.
  // The date a form is signed is today's whatever the model reads into it.
  const isTrusted = f => f.via === 'autocomplete' || stored.has(f.id) || !open(f) || f.profileKey === 'preferences.todaysDate' ||
    (DEMOGRAPHIC_KEYS.has(f.profileKey) && !settings.fillDemographics) ||
    // A preferred-name box is a first-name box to a model, which then answers
    // with the legal first name (Workday's revealed Preferred Name boxes).
    f.profileKey === 'identity.preferredName' ||
    // A choice the user made about in-office requirements, not a fact to check.
    (f.profileKey === 'preferences.acceptOnsite' && !!profileValue(profile, 'preferences.acceptOnsite')) ||
    // The same for consent asked as a choice, once the user said to agree.
    (f.profileKey === 'preferences.agreeToTerms' && !!f.options?.length && profileValue(profile, 'preferences.agreeToTerms') === 'yes');
  const trusted = typesafe ? heuristicHits.filter(isTrusted) : heuristicHits;
  // A mapping the site skill learned is checked like a rule's: a mapping that
  // was right on one Greenhouse form can be wrong on the next one. Only what
  // the user locked in the skills editor is taken as it stands.
  const learned = typesafe ? known.filter(f => !f.locked && open(f)) : [];
  const checked = [...learned, ...(typesafe ? heuristicHits.filter(f => !isTrusted(f)) : [])];
  stats.checked = checked.length;

  // A question a rule only half-recognised as demographic ("Please identify
  // your race") is still one the user switched off.
  const offDemographic = f => !settings.fillDemographics && DEMOGRAPHIC_KEYS.has(f.hint);
  for (const f of heuristicMisses.filter(offDemographic)) unfilled.push({ ...f, reason: 'Demographic questions are turned off in settings' });
  const openFields = [...forcedLong, ...heuristicMisses.filter(f => !offDemographic(f))].filter(open);
  const essayFields = openFields.filter(looksLikeEssay);
  const shortFields = openFields.filter(f => !looksLikeEssay(f));

  // Saved answers matched by a phrase the user listed cost nothing.
  const canned = [];
  let toDraft = [];
  const useResponse = (field, response, score, via) => {
    if (response.adapt) {
      // Tailoring is the writer's job, with the saved text as the basis.
      toDraft.push({ ...field, basis: renderResponse(response.text, { profile, context }), responseId: response.id, responseName: response.name });
      return;
    }
    const value = fitToLimit(renderResponse(response.text, { profile, context }), field.maxLength);
    if (!value) {
      toDraft.push(field);
      return;
    }
    canned.push({ ...field, fieldKey: field.fieldKey || fieldKey(field), value, via, responseId: response.id, responseName: response.name, confidence: score });
  };
  const hasResponses = responses.some(r => r.enabled && String(r.text || '').trim());
  let unmatchedEssays = [];
  if (longTextMode === 'skip') {
    for (const field of essayFields) unfilled.push({ ...field, reason: 'Long text fields are turned off in settings' });
  } else {
    for (const field of essayFields) {
      const hit = matchResponseLocally(field, responses);
      if (hit) useResponse(field, hit.response, hit.score, 'saved');
      else unmatchedEssays.push(field);
    }
  }

  for (const hit of [...known.filter(f => !learned.includes(f)), ...trusted.map(f => ({ ...f, fieldKey: f.fieldKey || fieldKey(f) }))]) place(hit);

  const hasOptions = f => f.options?.length > 0 && (f.type !== 'checkbox' || f.yesNoBox);
  const yesNoBox = f => f.type === 'checkbox' && !f.profileKey && !f.options?.length &&
    /^(are|do|does|have|has|had|will|would|is|can|could|did)\s+you\b.*\?\s*\*?$/i.test(cleanLabel(f.label || ''));

  if (typesafe) {
    // --- one round for the whole form ---------------------------------------
    // A yes/no question drawn as a tick box (Ashby) is a Yes/No choice, not
    // a box a saved value goes in.
    // Tick boxes that are the options of one question are asked as that
    // question; an office list is answered from where the user lives.
    // A keyword rule's reading of one box ("1 Market Street" as a street
    // address) does not take it out of its group.
    const groups = tickGroups([...checked, ...shortFields]);
    const grouped = new Set(groups.flatMap(g => g.tickBoxes.map(b => b.field.id)));
    const tick = (group, option, via, thin) => {
      const box = group.tickBoxes.find(b => b.option === option);
      if (box) plan.push({ ...box.field, profileKey: null, value: 'true', via, thin: thin || undefined, fieldKey: box.field.fieldKey || fieldKey(box.field) });
      return !!box;
    };
    const openGroups = groups.filter(g => !tick(g, nearestOffice(g, profile), 'label'));
    const asked = [...checked, ...shortFields].filter(f => !grouped.has(f.id)).concat(openGroups)
      .map(f => (yesNoBox(f) ? { ...f, options: [{ label: 'Yes' }, { label: 'No' }], yesNoBox: true } : f));
    const optionFields = asked.filter(hasOptions).map(f => {
      if (!f.profileKey) return f;
      const placed = placeInScope(f);
      const saved = placed.profileKey ? profileValue(profile, placed.profileKey, { repeatIndex: f.repeatIndex || 0 }) : '';
      return saved ? { ...f, savedValue: String(saved) } : f;
    });
    const keyFields = asked.filter(f => !hasOptions(f));
    const responseFields = hasResponses ? unmatchedEssays : [];
    let result = { keyReads: new Map(), optionReads: new Map(), responseMatches: [], usage: {}, requests: 0 };
    let failed = '';
    if (asked.length || responseFields.length) {
      onProgress(STAGE.CLASSIFYING, { count: asked.length + responseFields.length });
      try {
        if (!ctx.meter.allows(0.5)) throw new Error('This fill reached its cost cap');
        result = await planWithTypeSafe({ keyFields, optionFields, responseFields, profile, responses, settings, context, signal });
        ctx.meter.add('typesafe', settings.typesafeModel, result.usage, 'plan');
        stats.modelCalls++;
        stats.requests += result.requests;
        stats.usage.plan = result.usage;
      } catch (err) {
        if (signal?.aborted) throw err;
        // The local matches still stand; only the model's own answers are lost.
        failed = err?.message || String(err);
      }
    }
    const available = new Set(filledKeys(profile));
    const checkedIds = new Set(checked.map(f => f.id));

    for (const field of keyFields) {
      const read = result.keyReads.get(field.id);
      // An optional comment box is never a saved value, whatever word it shares
      // with one ("Current location — anything else to add?" got the city).
      if (isOptionalCatchAll(field)) {
        if (longTextMode === 'write') toDraft.push({ ...field, profileKey: null });
        else unfilled.push({ ...field, profileKey: null, reason: 'Optional and open-ended, so left for you rather than drafted' });
        continue;
      }
      if (checkedIds.has(field.id)) {
        // A yes or no never answers a box asking who, which or to specify,
        // unless the detail is only wanted "if so" and the answer is No
        // ("...require visa sponsorship, and if so which type?", Vizcom).
        const [asked, ifSo] = bothLabels(field).split(/\bif (?:so|yes)\b/i);
        const plainNo = ifSo !== undefined && !ASKS_FOR_DETAIL.test(asked) &&
          /^no$/i.test(String(resolveValue(field, field.profileKey, profile) ?? ''));
        if (FIELD_BY_KEY[field.profileKey]?.type === 'boolean' && !field.options?.length && field.type !== 'checkbox' &&
            ASKS_FOR_DETAIL.test(bothLabels(field)) && !plainNo) {
          unfilled.push({ ...field, profileKey: null, reason: 'Asks for a detail, which a yes or no does not give' });
          continue;
        }
        const outcome = settle(field.profileKey, read, floor, { offered: available.has(field.profileKey), label: bothLabels(field) });
        if (outcome.via === 'model') stats.overruled++;
        if (!outcome.key) unfilled.push({ ...field, profileKey: null, reason: outcome.reason });
        else place({ ...field, profileKey: outcome.key, via: outcome.via === 'model' ? 'model' : field.via });
        continue;
      }
      if (read && read.choice === WRITTEN && read.confidence >= floor) {
        // Handed back as a written question: the writer takes it.
        if (longTextMode === 'write') toDraft.push(field);
        else unfilled.push({ ...field, reason: 'Needs a written answer, and drafting is turned off' });
        continue;
      }
      if (read && read.choice !== NONE && read.choice !== WRITTEN && read.confidence >= floor) {
        if (identityRefused(field, read.choice)) { unfilled.push({ ...field, reason: IDENTITY_ONLY_SAVED }); continue; }
        if (conditionalRowValue(field, read.choice)) { unfilled.push({ ...field, reason: 'Only applies in some cases, so left for you' }); continue; }
        place({ ...field, profileKey: read.choice, via: 'model', confidence: read.confidence });
        continue;
      }
      // The most likely saved value, though below the gate: filled as a
      // best guess, outlined for the user to check.
      if (read && read.choice !== NONE && read.choice !== WRITTEN && read.confidence >= GUESS_FLOOR &&
          !CONDITIONAL.test(bothLabels(field)) && !SENSITIVE_QUESTION.test(bothLabels(field)) && !DEMOGRAPHIC_KEYS.has(read.choice)) {
        place({ ...field, profileKey: read.choice, via: 'guess', confidence: read.confidence, thin: true });
        continue;
      }
      unfilled.push({ ...field, reason: failed ? `The matching model failed: ${failed}` : 'No confident match in your profile' });
    }

    for (const field of optionFields) {
      // A required list with one real option has one possible answer: Lyft's
      // "Please enter your employment ... using + Add" offers only "Thank you"
      // (it had been read as the veteran question for saying "military").
      const only = (field.options || []).map(o => (typeof o === 'string' ? o : o.label || '').trim())
        .filter(o => o && !/^(select|choose|please select|--|—)/i.test(o));
      if (field.required && only.length === 1 && !isIdentityQuestion(field) && !(isAlreadyAnswered(field) && !settings.overwriteExisting)) {
        plan.push({ ...field, profileKey: null, value: only[0], via: 'only-option', fieldKey: field.fieldKey || fieldKey(field) });
        continue;
      }
      // What the rule would select: its key's value, spelled as one of the
      // page's options. Resolved without recording, since the model may still
      // answer where the rule cannot.
      const rule = field.profileKey && checkedIds.has(field.id) ? resolveKey(field, { record: false }) : null;
      let outcome = settleOption(rule?.value ?? null, result.optionReads.get(field.id), floor, { label: bothLabels(field) });
      // A school, degree or major the saved answer names in full ("General
      // Studies" in "General Studies (Associate of Arts, ...)") is what the
      // user saved, whatever the model reads into the résumé (Lyft: it chose
      // "Computer Science" at 0.61).
      if (!isIdentityQuestion(field) && field.profileKey) {
        const key = placeInScope(field).profileKey;
        const saved = CLOSEST_KEYS.has(key) ? String(profileValue(profile, key, { repeatIndex: field.repeatIndex || 0 }) || '').trim() : '';
        const named = saved && namedOption((field.options || []).map(o => o.label || o), saved);
        if (named && named !== outcome.value) outcome = { value: named, via: 'saved' };
      }
      if (outcome.via === 'model' && rule?.value && outcome.value !== rule.value) stats.overruled++;
      // A school, degree or major the list does not hold under its own words
      // ("Computer Science & Game Design"): the closest option, as a
      // best guess. A long list the page showed only part of is searched for
      // it instead, and the filler picks the closest entry it finds.
      if (!outcome.value && field.profileKey && !isIdentityQuestion(field) && !CONDITIONAL.test(bothLabels(field))) {
        const placed = placeInScope(field);
        if (CLOSEST_KEYS.has(placed.profileKey)) {
          const saved = String(profileValue(profile, placed.profileKey, { repeatIndex: field.repeatIndex || 0 }) || '').trim();
          const near = saved && closestLabel((field.options || []).map(o => o.label || o), saved);
          if (near) outcome = { value: near, via: 'guess' };
          else if (saved && (field.searchable || field.combobox)) outcome = { value: saved, via: 'guess' };
        }
      }
      // "How did you hear about us?" is never worth leaving empty: the
      // option nearest a company site or job board, else "Other" (Whatnot
      // listed neither, and its required box stayed empty).
      if (!outcome.value && HOW_HEARD.test(bothLabels(field))) {
        const near = heardOption((field.options || []).map(o => (typeof o === 'string' ? o : o.label || '')));
        if (near) outcome = { value: near, via: 'guess' };
      }
      // An identity option is the user's saved answer: the one the rule
      // spelled, or the model's confident reading of saved answers it was
      // shown. Never a guess, and never with nothing saved to read from (a
      // gender picked from a first name).
      // A name suffix or salutation is never guessed: most people have none
      // (PG&E's Suffix list offered "Jr.", and a guess went in).
      if (outcome.via === 'guess' && /\b(suffix|salutation|honorific|prefix)\b/i.test(bothLabels(field))) outcome = { value: null, via: null };
      const fromRule = rule?.value && outcome.value === rule.value && DEMOGRAPHIC_KEYS.has(rule.profileKey);
      // A question with its own key needs that key saved: "Male" says nothing about transgender experience.
      const ownKeyEmpty = DEMOGRAPHIC_KEYS.has(field.profileKey) && !String(profileValue(profile, field.profileKey) || '').trim();
      const fromSaved = outcome.via === 'model' && settings.fillDemographics && savedDemographics && !ownKeyEmpty;
      // "None of the above" over several kinds of identity (disability,
      // parent, refugee) speaks for ones nothing saved says (Clay): declined.
      const decline = (isIdentityQuestion(field) || DEMOGRAPHIC_KEYS.has(field.profileKey)) && /^none of the above\b/i.test(String(outcome.value || '')) && declineOption(field);
      if (decline) {
        plan.push({ ...field, profileKey: null, value: decline, via: 'decline', fieldKey: field.fieldKey || fieldKey(field) });
        continue;
      }
      if (outcome.value && isIdentityQuestion(field) && !fromRule && !fromSaved) {
        unfilled.push({ ...field, reason: settings.fillDemographics ? IDENTITY_ONLY_SAVED : DEMOGRAPHICS_OFF });
        continue;
      }
      if (outcome.value && field.tickBoxes) {
        tick(field, outcome.value, outcome.via === 'guess' ? 'guess' : 'model-option', outcome.via === 'guess');
        continue;
      }
      if (outcome.value) {
        const via = outcome.via === 'model' ? 'model-option' : outcome.via === 'guess' ? 'guess' : (rule?.via || field.via);
        // The model's answer carries the model's confidence, not the rule's
        // 0.9, and not the rule's reading when it chose something else.
        const read = result.optionReads.get(field.id);
        const byModel = outcome.via === 'model' || outcome.via === 'guess';
        const entry = { ...(rule && !(byModel && outcome.value !== rule.value) ? rule : field), value: outcome.value, via,
          thin: outcome.via === 'guess' || undefined, fieldKey: field.fieldKey || fieldKey(field),
          ...(byModel && read ? { confidence: read.confidence } : {}) };
        if (field.yesNoBox) Object.assign(entry, { value: String(/^yes$/i.test(outcome.value)), options: undefined });
        plan.push(entry);
        continue;
      }
      // A searchable list shows only its first page ("Acadia University",
      // "Adamson University"...), so "none of these" from the model means only
      // "not among those shown". Type the saved value and let it search.
      const raw = field.profileKey && field.searchable
        ? profileValue(profile, placeInScope(field).profileKey || field.profileKey, { repeatIndex: field.repeatIndex || 0 }) : '';
      if (raw && !(DEMOGRAPHIC_KEYS.has(field.profileKey) && !settings.fillDemographics)) {
        plan.push({ ...field, value: String(raw), via: 'typed-search', fieldKey: field.fieldKey || fieldKey(field) });
        continue;
      }
      unfilled.push({ ...field, reason: failed ? `The matching model failed: ${failed}` : (outcome.reason || 'No confident match in your profile') });
    }

    // Saved answers matched by meaning, from the same round.
    if (responseFields.length) {
      const accepted = reconcileMatches(result.responseMatches, responseFields, responses);
      const placed = new Set(accepted.map(m => m.field.id));
      for (const m of accepted) useResponse(m.field, m.response, m.score, m.via);
      toDraft.push(...responseFields.filter(f => !placed.has(f.id)));
    } else {
      toDraft.push(...unmatchedEssays);
    }
  } else {
    // --- DeepSeek or the hosted backend: the model returns values --------------
    if (shortFields.length) {
      onProgress(STAGE.CLASSIFYING, { count: shortFields.length });
      let assignments = [];
      let failed = '';
      try {
        const res = await classifyFields({ fields: shortFields, profile, settings, context, signal });
        ctx.meter.add(res.engine === 'typesafe' ? 'typesafe' : 'deepseek', res.engine === 'typesafe' ? settings.typesafeModel : settings.deepseekModel, res.usage, 'classify');
        assignments = res.assignments || [];
        stats.modelCalls++;
        stats.usage.classify = res.usage;
      } catch (err) {
        if (signal?.aborted) throw err;
        failed = err?.message || String(err);
      }
      const { accepted, needsWriting } = reconcile(assignments, shortFields);
      for (const assigned of accepted) {
        if (assigned.value === null || assigned.value === undefined) place(assigned);
        else {
          const field = placeInScope(assigned);
          if (!field.profileKey && assigned.profileKey) unfilled.push(field);
          // An identity key only for an identity question: TypeSafe once read
          // "Do you have any initial compensation expectations?" as one.
          else if (DEMOGRAPHIC_KEYS.has(field.profileKey) && !isIdentityQuestion(field) && !DEMOGRAPHIC_KEYS.has(field.hint) && !/pronoun/i.test(`${field.label} ${field.extractedLabel || ''}`)) unfilled.push({ ...field, reason: 'No confident match in your profile' });
          else if (DEMOGRAPHIC_KEYS.has(field.profileKey) && !settings.fillDemographics) unfilled.push({ ...field, reason: 'Demographic questions are turned off in settings' });
          else plan.push({ ...field, fieldKey: field.fieldKey || fieldKey(field) });
        }
      }
      unmatchedEssays.push(...needsWriting);
      const seen = new Set([...accepted.map(f => f.id), ...needsWriting.map(f => f.id)]);
      for (const field of shortFields) {
        if (!seen.has(field.id)) unfilled.push({ ...field, reason: failed ? `The matching model failed: ${failed}` : 'No confident match in your profile' });
      }
    }
    if (longTextMode !== 'skip' && unmatchedEssays.length && hasResponses) {
      onProgress(STAGE.MATCHING_RESPONSES, { count: unmatchedEssays.length });
      const { matches, usage } = await matchResponsesWithModel({ fields: unmatchedEssays, responses, settings, signal });
      ctx.meter.add('deepseek', settings.deepseekModel, usage, 'response matching');
      stats.modelCalls++;
      stats.usage.responseMatching = usage;
      const accepted = reconcileMatches(matches, unmatchedEssays, responses);
      const placed = new Set(accepted.map(m => m.field.id));
      for (const m of accepted) useResponse(m.field, m.response, m.score, m.via);
      toDraft.push(...unmatchedEssays.filter(f => !placed.has(f.id)));
    } else if (longTextMode !== 'skip') {
      toDraft.push(...unmatchedEssays);
    }
  }

  plan.push(...canned);

  if (longTextMode === 'canned') {
    for (const field of toDraft) {
      unfilled.push({
        ...field,
        reason: field.basis
          ? 'Tailoring a saved response needs the writer, which is turned off'
          : 'No saved response matched, and drafting is turned off'
      });
    }
    toDraft = [];
  }

  // "Have you used Sentry before?" or "Have you built customer-facing demos?"
  // with nothing saved and TypeSafe unsure: No, unless the résumé, a saved
  // job or a project names it (the user's rule: what they do not mention
  // was not done).
  for (let i = unfilled.length - 1; i >= 0; i--) {
    const f = unfilled[i];
    if (!/^(Nothing saved|No confident match)/.test(f.reason || '')) continue;
    const product = usedProduct(f, context);
    if (!product || mentions(experienceText(profile), product)) continue;
    const value = answerNo(f);
    if (!value) continue;
    plan.push({ ...f, fieldKey: f.fieldKey || fieldKey(f), value, reason: undefined });
    unfilled.splice(i, 1);
  }

  // A required salary question on a page that posts no pay: "Market rate"
  // where words fit, the box left for the user where only a number does.
  for (let i = unfilled.length - 1; i >= 0; i--) {
    const f = unfilled[i];
    if (f.profileKey !== 'compensation.desired' || !f.required || f.options?.length || f.type === 'number') continue;
    if (!/^Nothing saved for/.test(f.reason || '')) continue;
    plan.push({ ...f, fieldKey: f.fieldKey || fieldKey(f), value: 'Market rate', reason: undefined });
    unfilled.splice(i, 1);
  }
  for (const f of unfilled) {
    if (f.profileKey === 'compensation.desired' && /^Nothing saved for/.test(f.reason || '')) {
      f.reason = f.required ? 'This page posts no pay range, and this box takes only a number' : 'Optional, and this page posts no pay range';
    }
  }

  // A required one-line question left empty because nothing saved answers it
  // ("How many hours per week are you available?") gets a short draft from
  // the profile, outlined for review, rather than a gap the user must find.
  if (longTextMode === 'write') {
    const drafting = new Set(toDraft.map(f => f.id));
    for (let i = unfilled.length - 1; i >= 0; i--) {
      const f = unfilled[i];
      if (!f.required || drafting.has(f.id) || f.options?.length || f.type === 'checkbox' || f.type === 'radio') continue;
      if (!/^(Nothing saved for|No confident match)/.test(f.reason || '')) continue;
      if (CONDITIONAL.test(bothLabels(f)) || SENSITIVE_QUESTION.test(bothLabels(f)) || DEMOGRAPHIC_KEYS.has(f.profileKey)) continue;
      toDraft.push({ ...f, short: true, reason: undefined });
      drafting.add(f.id);
      unfilled.splice(i, 1);
    }
  }

  // A video (Wispr Flow: "Please provide a 1-2 minute video ...") is something
  // only the user can make: the box is theirs, never a paragraph about a video.
  toDraft = toDraft.filter(field => {
    if (!ASKS_FOR_VIDEO.test(bothLabels(field)) || field.basis) return true;
    unfilled.push({ ...field, reason: 'Asks for a video, which only you can record' });
    return false;
  });

  // Optional catch-alls are not drafted; a saved response may still fill them.
  toDraft = toDraft.filter(field => {
    if (!isOptionalCatchAll(field) || field.basis) return true;
    unfilled.push({ ...field, reason: 'Optional and open-ended, so left for you rather than drafted' });
    return false;
  });

  // Living in a named metro is the user's city against the metro table,
  // whatever the model read (Deepgram: Oakland is in the Bay Area).
  for (const field of fields) {
    // "Have you applied to or interviewed with us before?": from phil's own
    // record of fills (CZI's was left empty). A "no" is only what phil knows
    // of, so it is outlined for review.
    const worked = workedHereAnswer(field, profile, ctx.context?.company);
    const before = appliedBeforeAnswer(field, ctx.pastRuns || [], ctx.context?.company, ctx.url) ||
      (worked ? { value: worked, thin: false } : null);
    // Only phil's record knows this: it replaces a model's answer or guess
    // (MaintainX: "currently interviewing at Autodesk?" guessed Yes), never one the user saved.
    const prior = plan.findIndex(p => p.id === field.id);
    if (before && (prior < 0 || plan[prior].via === 'guess' || plan[prior].via === 'model')) {
      if (prior >= 0) plan.splice(prior, 1);
      const gap = unfilled.findIndex(u => u.id === field.id);
      if (gap >= 0) unfilled.splice(gap, 1);
      toDraft = toDraft.filter(d => d.id !== field.id);
      if (!isAlreadyAnswered(field) || settings.overwriteExisting) plan.push({ ...field, fieldKey: field.fieldKey || fieldKey(field), value: before.value, via: 'history', thin: before.thin });
      continue;
    }
    let value = locatedInAnswer(field, profile) || travelAnswer(field, profile) || authorizedCountriesAnswer(field, profile) || acceptsPayRange(field) ||
      citizenshipListAnswer(field, profile);
    // Options saying where the user lives replace only another such option
    // (never a "No" the user's answers led to).
    const lives = !value && livesInOption(field, profile);
    if (lives) {
      const chosen = plan.find(p => p.id === field.id);
      if (!chosen || /\b(live|living|reside|residing|based|located)\s+(in|within|near)\b/i.test(String(chosen.value))) value = lives;
    }
    if (!value) continue;
    const at = plan.findIndex(p => p.id === field.id);
    if (at >= 0) plan[at] = { ...plan[at], value };
    else {
      const gap = unfilled.findIndex(u => u.id === field.id);
      if (gap >= 0) unfilled.splice(gap, 1);
      if (!isAlreadyAnswered(field) || settings.overwriteExisting) plan.push({ ...field, fieldKey: field.fieldKey || fieldKey(field), value });
    }
  }

  // Follow-ups: written only when the earlier answer calls for them.
  const deferred = [];
  for (const { field, parent, condition } of followUps.values()) {
    const planned = plan.find(p => p.id === parent.id);
    // The parent decided in an earlier pass: its key and block, for a saved answer.
    const earlier = !planned && (ctx.earlier || []).find(p => p.identity === fieldIdentity(parent));
    let answer = String(planned ? planned.value : (parent.currentText || parent.currentValue || '')).trim();
    // A parent not decided yet (a dropdown whose options the first read had
    // no time for: PG&E's visa question) leaves its follow-up for the next
    // pass, not empty for good.
    if (!planned && !answer && !ctx.finalPass && !toDraft.some(d => d.id === parent.id)) {
      deferred.push(field);
      continue;
    }
    // "Other" chosen for a school or major the list lacks: the box asking
    // for its name ("If you selected Other, enter the school name") gets the
    // saved name, not a draft.
    // A parent answered before this fill is read by the rules for its key.
    const parentKey = earlier?.profileKey || (!planned ? matchField(parent)?.key : null);
    if (/^other\b/i.test(answer) && condition.test(answer) && parentKey && !field.options?.length && field.type !== 'checkbox' && field.type !== 'radio') {
      const placed = placeInScope({ ...(earlier || parent), profileKey: parentKey });
      const saved = String(profileValue(profile, placed.profileKey, { repeatIndex: (earlier || parent).repeatIndex || 0 }) || '').trim();
      if (saved) {
        plan.push({ ...field, fieldKey: field.fieldKey || fieldKey(field), value: saved, via: 'saved' });
        continue;
      }
    }
    // A yes/no tick box (Ashby) answers "true" or "false".
    if (parent.type === 'checkbox') answer = /^(true|on|yes)$/i.test(answer) ? 'Yes' : /^(false|no)$/i.test(answer) ? 'No' : answer;
    // "If yes to above" under a written question: the question was answered, or is being written.
    const written = !parent.options?.length && parent.type !== 'checkbox' && parent.type !== 'radio' && parent.tag !== 'select' &&
      (toDraft.some(d => d.id === parent.id) || (answer && !/^(yes|no|y|n)$/i.test(answer)));
    if (!written && (!answer || !condition.test(answer))) {
      // A required box takes an entry whatever the answer was: say it does
      // not apply, but only after a definite answer to a yes/no question. A
      // wrong "N/A" tells the employer something false; a guessed parent
      // leaves the follow-up for the user.
      // A list answered with one of its own options counts too: "If Citizenship
      // Status Other, please explain" after "U.S. citizen", "Please specify"
      // after "Company Website" (Rocket Lab refused both empty).
      const chosen = (parent.options || []).some(o => normalize(typeof o === 'string' ? o : o.label || '') === normalize(answer));
      const definite = (/^(yes|no)$/i.test(answer) || chosen) && !(planned && (planned.via === 'guess' || planned.thin));
      if (field.required && definite && !field.options?.length && field.type !== 'checkbox' && field.type !== 'radio') {
        plan.push({ ...field, fieldKey: field.fieldKey || fieldKey(field), value: 'N/A' });
      } else unfilled.push({ ...field, reason: `Only needed for some answers to "${truncate(parent.label || '', 60)}"` });
    } else if (longTextMode === 'write') {
      toDraft.push({ ...field, followsQuestion: parent.label, followsAnswer: answer });
    } else {
      unfilled.push({ ...field, reason: 'Follows up on an earlier answer, and drafting is turned off' });
    }
  }

  // The writer is the slow part of a fill. It is started here and not
  // waited for: everything else on the page is written meanwhile, and the
  // drafts are filled when they arrive (runFill awaits `drafting`).
  let drafting = null;
  if (toDraft.length) {
    onProgress(STAGE.WRITING, { count: toDraft.length });
    const drafts = toDraft;
    // The writer may spend only what is left under the fill's cost cap.
    const afford = (provider, model, inputTokens, wanted) => {
      const allowed = affordableOutput(provider, model, inputTokens, ctx.meter.remaining());
      if (allowed < wanted) ctx.meter.capped = true;
      return allowed;
    };
    stats.modelCalls++;
    drafting = writeAnswers({
      fields: drafts,
      profile,
      settings,
      context: { ...context, siteNotes: skill?.notes || '' },
      signal,
      afford
    }).then(res => {
      const out = { plan: [], unfilled: [] };
      if (res.skipped) {
        out.unfilled = drafts.map(f => ({ ...f, reason: 'Not drafted: this fill reached its cost cap' }));
        return out;
      }
      for (const u of res.usages || [{ usage: res.usage, model: res.model }]) ctx.meter.add(res.provider, u.model || res.model, u.usage, 'writer');
      if (res.checkUsage) ctx.meter.add('typesafe', settings.typesafeModel, res.checkUsage, 'fact check');
      for (const u of res.editUsages || []) ctx.meter.add('deepseek', 'deepseek-flash', u, 'fact edit');
      if (res.researchUsage) ctx.meter.add('deepseek', 'deepseek-flash', res.researchUsage, 'company research');
      stats.usage.writer = res.usage;
      const written = attachAnswers(res.answers, drafts);
      trace('written', { usage: res.usage, answers: written.map(f => ({ label: f.label, value: String(f.value ?? ''), thin: !!f.thin })) });
      for (const field of written) {
        // A follow-up the material says nothing about stays empty; any other
        // thin draft is kept, outlined in amber for the candidate to finish.
        if (field.followsQuestion && !String(field.value || '').trim()) continue;
        // A number box takes a number, not the sentence around it (Offstream's
        // "smallest team size" got a paragraph the page refused).
        if (field.type === 'number') {
          const n = String(field.value || '').match(/-?\d+(?:\.\d+)?/);
          if (!n) { out.unfilled.push({ ...field, value: undefined, reason: 'Nothing in your profile answers this' }); continue; }
          field.value = n[0];
        }
        // A short answer drafted where nothing was saved is always for the
        // user to check.
        // A one-line answer the writer drafted is a guess about the user.
        out.plan.push({ ...field, thin: field.thin || !!field.short || !field.multiline, fieldKey: field.fieldKey || fieldKey(field) });
      }
      const drafted = new Set(written.map(f => f.id));
      for (const field of drafts) {
        if (!drafted.has(field.id)) {
          out.unfilled.push({ ...field, reason: field.short ? 'Nothing in your profile answers this' : 'The writer returned no answer for this question' });
        }
      }
      return out;
    }).catch(err => {
      if (signal?.aborted) throw err;
      return { plan: [], unfilled: drafts.map(f => ({ ...f, reason: `The writer failed: ${err?.message || err}` })) };
    });
  }

  // Without TypeSafe, a known key with no literal match among the page's
  // options gets one more request, choosing among the options the page
  // offers. With TypeSafe those were already asked directly, above.
  const needsOption = typesafe ? [] : unfilled.filter(
    f => f.options?.length && f.profileKey && /^Nothing saved for /.test(f.reason || '')
  );
  if (needsOption.length) {
    const { picks, usage: pickUsage } = await pickOptions({ fields: needsOption, profile, settings, signal })
      .catch(err => {
        if (signal?.aborted) throw err;
        return { picks: new Map(), usage: {} };
      });
    ctx.meter.add('typesafe', settings.typesafeModel, pickUsage, 'option picking');
    if (picks.size) {
      stats.modelCalls++;
      stats.usage.optionPicking = pickUsage;
      for (const field of needsOption) {
        const value = picks.get(field.id);
        if (value) plan.push({ ...field, value, via: 'model-option', fieldKey: field.fieldKey || fieldKey(field) });
      }
      for (let i = unfilled.length - 1; i >= 0; i--) {
        if (picks.has(unfilled[i].id)) unfilled.splice(i, 1);
      }
    }
  }

  // An identity question nothing saved answers gets the form's own "prefer
  // not to say", never a guess; required ones would otherwise block Submit.
  // Only with voluntary demographic questions ticked in settings.
  if (settings.fillDemographics && settings.declineUnsaved !== false) {
    for (let i = unfilled.length - 1; i >= 0; i--) {
      const f = unfilled[i];
      if (f.reason === DEMOGRAPHICS_OFF || f.currentValue || !isIdentityQuestion(f) || CONDITIONAL.test(bothLabels(f))) continue;
      const decline = declineOption(f);
      if (!decline) continue;
      plan.push({ ...f, profileKey: null, value: decline, via: 'decline', fieldKey: f.fieldKey || fieldKey(f) });
      unfilled.splice(i, 1);
    }
  }

  return { plan, unfilled, stats, drafting, deferred };
}

const DECLINE = /prefer not|decline|do not wish|don'?t wish|wish not|choose not|rather not|not to (answer|disclose|say|identify|self[- ]identify)|no answer/i;

/** Answers a list may hold under other words: the closest entry is a fair guess. */
const CLOSEST_KEYS = new Set(['education.school', 'education.major', 'education.degree', 'work.school', 'work.fieldOfStudy', 'work.highestDegree']);

const closestWords = t => normalize(t).split(/[^a-z0-9]+/).filter(w => w.length > 2 && !['the', 'and', 'for'].includes(w));
// Words half of any school or degree list shares: "University" alone made
// "University of Portland" the first entry of Lyft's list, "Aalborg University".
const GENERIC_WORDS = new Set(['university', 'college', 'community', 'institute', 'school', 'academy', 'polytechnic', 'degree', 'state', 'campus']);

/**
 * The option sharing the most words with a saved answer, if it shares at
 * least half of them; among equals, the one with fewest other words.
 * "Computer Science & Game Design" finds "Computer Science". Words every
 * school or degree has count only when the answer has nothing else.
 */
export function closestLabel(labels, saved) {
  const all = closestWords(saved);
  const own = all.filter(w => !GENERIC_WORDS.has(w));
  const want = own.length ? own : all;
  if (!want.length) return null;
  let best = null, score = 0, extra = Infinity;
  for (const label of labels) {
    const have = closestWords(label);
    const s = want.filter(w => have.includes(w)).length / want.length;
    const x = have.filter(w => !want.includes(w)).length;
    if (s > score || (s === score && s > 0 && x < extra)) { best = label; score = s; extra = x; }
  }
  return score >= 0.5 ? best : null;
}

/**
 * The option a saved answer names in full: every distinctive word of the
 * option is in the answer ("General Studies" in "General Studies (Associate
 * of Arts)"); the one naming most, if several. Null if none.
 */
export function namedOption(labels, saved) {
  const order = closestWords(saved);
  const have = new Set(order);
  let best = null, most = 0, first = Infinity;
  for (const label of labels) {
    const words = closestWords(label);
    const own = words.filter(w => !GENERIC_WORDS.has(w));
    if (!own.length || !words.every(w => have.has(w))) continue;
    // Among equals, the one the answer names first: "Graphic Design
    // (Art History coursework)" is Graphic Design.
    const at = Math.min(...words.map(w => order.indexOf(w)));
    if (words.length > most || (words.length === most && at < first)) { best = label; most = words.length; first = at; }
  }
  return best;
}

const HOW_HEARD = /\bhow did you (first |originally )?(hear|find|learn)\b|\bwhere did you (first |originally )?(hear|find|see|learn)\b|\b(referral|application|candidate) source\b/i;

/** The answer to "How did you hear about us?" when nothing saved matches: a company site or job board, else "Other". */
export function heardOption(labels) {
  return labels.find(l => /\b(company|corporate|careers?|our)\s*(web\s*)?(site|page)\b|\bwebsite\b/i.test(l)) ||
    labels.find(l => /\bjob (board|site|posting)s?\b|\bonline job\b/i.test(l)) ||
    labels.find(l => /^\s*other\b/i.test(l)) || null;
}

// The kinds of link a box can ask for, by the words naming them.
const LINK_KINDS = [
  ['links.linkedin', /linked\s*in/i],
  ['links.github', /git\s*hub/i],
  ['links.portfolio', /portfolio|personal (web)?site|website|hardware projects|projects?\b/i]
];

/**
 * One box asking for several kinds of link ("GitHub, portfolio,
 * publications, or hardware projects", 1X) gets every saved one it names,
 * not only the first: a hardware role's portfolio is the link that counts.
 * A url box holds one, so it gets the portfolio, which links to the rest.
 */
export function severalLinks(field, profile) {
  const label = `${field.label || ''} ${field.ariaLabel || ''}`;
  // "If you have any projects on GitHub, please provide a link to your GH
  // profile" (Astera) asks for one link: the GitHub profile.
  if (/\b(git\s*hub|gh) (profile|account|user\s*name|handle)\b/i.test(label)) return null;
  const named = LINK_KINDS.filter(([, re]) => re.test(label));
  if (named.length < 2) return null;
  if (field.type === 'url') return named.some(([key]) => key === 'links.portfolio') ? String(profileValue(profile, 'links.portfolio') || '').trim() || null : null;
  const urls = [...new Set(named.map(([key]) => String(profileValue(profile, key) || '').trim()).filter(Boolean))];
  return urls.length > 1 ? urls.join(field.tag === 'textarea' ? '\n' : ', ') : null;
}

/** The option of a choice that declines to answer ("I prefer not to say"), if it has one. */
export function declineOption(field) {
  const hit = (field.options || []).find(o => DECLINE.test(typeof o === 'string' ? o : o.label || ''));
  return hit ? (typeof hit === 'string' ? hit : hit.label) : null;
}

/** What the content script needs to write one planned field. */
function fillItem(f) {
  return {
    id: f.id,
    selector: f.selector,
    tag: f.tag,
    type: f.type,
    widget: f.widget,
    name: f.name,
    options: f.options,
    label: f.label,
    value: f.value,
    via: f.via,
    combobox: f.combobox,
    prompt: f.prompt,
    // Several entries go into one box: Workday's skills.
    multi: f.profileKey === 'work.skills' || undefined,
    // A searched list that lacks the saved answer hands back what it found,
    // for the model to choose from (askModel); a second round then takes
    // exactly that entry (exact).
    askModel: f.askModel || undefined,
    exact: f.exact || undefined,
    datePicker: f.datePicker,
    dateFormat: f.dateFormat,
    searchable: f.searchable,
    suggests: f.suggests,
    placeHint: f.placeHint,
    savedValue: f.savedValue,
    thin: !!f.thin
  };
}

/**
 * Write a plan into the page, each field in its own frame. Dropdowns and
 * boxes that suggest as you type are chosen from inside the filler itself.
 *
 * @returns {Promise<Map<string, object>>} fill result by field id
 */
async function fillPlan(tabId, plan, settings, profile, { scroll }) {
  const results = new Map();
  // A place chosen from a list ("Portland") needs the rest of the address to
  // pick the right one.
  for (const f of plan) {
    if (f.combobox || f.widget === 'listbox') {
      f.placeHint = /city|location|town|where|based|located|live/i.test(`${f.label} ${f.name}`) ? suggestionHint(f, profile) : '';
      // Any site's searched list: when it lacks the saved answer, the model
      // says which of its entries means it. Not places, and never who you are.
      f.askModel = settings.classifier === 'typesafe' && !f.placeHint && !f.exact && f.profileKey !== 'work.skills' &&
        !isIdentityQuestion(f) && !SENSITIVE_QUESTION.test(bothLabels(f));
    }
  }
  for (const [frameId, items] of byFrame(plan)) {
    const [reply] = await runInFrames(
      tabId,
      p => globalThis.__applicatorFill(p),
      [{ items: items.map(fillItem), highlight: settings.highlightFilled, scroll: scroll && frameId === 0 }],
      [frameId]
    );
    for (const r of reply?.result?.results || []) results.set(r.id, r);
    if (reply?.result?.network) trace('network', reply.result.network);
  }

  return results;
}

/**
 * Execute one fill run against a tab.
 *
 * The page is read, decided and filled, then read again: answering one
 * question often reveals the next ("If yes, which visa?"), and a custom
 * dropdown only shows its options once opened. Each further pass handles only
 * fields that are new, or whose options were just discovered, and the run
 * stops when a pass finds nothing new.
 *
 * @param {object} args
 * @param {number} args.tabId
 * @param {string} args.url
 * @param {(stage: string, detail?: object) => void} args.onProgress
 * @param {AbortSignal} args.signal
 */
export async function runFill({ tabId, url, onProgress, signal }) {
  const startedAt = Date.now();
  // Cancel stops the page's own work at once (typing, searching, pressing),
  // and the fill at its next step.
  signal?.addEventListener('abort', () => {
    runInFrames(tabId, () => globalThis.__applicatorStop?.()).catch(() => {});
  }, { once: true });
  const halt = () => { if (signal?.aborted) throw new Error('Fill cancelled.'); };
  let settings = await getSettings();
  let profile = await getProfile();
  const responses = await getResponses();
  const longTextMode = effectiveLongTextMode(settings);
  const site = siteKey(url);
  // The rules pack (what phil knows about forms as data, fetched from the
  // service when stale) and the platform this page runs on, by its host
  // for now: the page's own markers can still name it after the first read.
  await refreshRulesPack(settings).catch(() => {});
  const pack = await loadRulesPack();
  let platform = detectPlatform(pack, { hostname: hostnameOf(url) });
  let pageRules = contentRules(pack, usePlatform(platform?.id || null));
  trace('platform', { platform: platform?.id || null, by: platform ? 'host' : null, rules: pack.version });
  // A demographic answer the user typed on the Profile tab is theirs to give:
  // it is used even with the box unticked, which then only keeps the form's
  // "prefer not to say" off the questions nothing saved answers.
  if (!settings.fillDemographics && [...DEMOGRAPHIC_KEYS].some(k => String(profileValue(profile, k) || '').trim())) {
    settings = { ...settings, fillDemographics: true, declineUnsaved: false };
  }

  // The Settings box answers "Can you pass a background check?"; unticked, the question is the user's.
  profile = { ...profile, 'screening.backgroundCheck': settings.passBackgroundCheck === false ? '' : 'yes' };

  // The wallet first: an empty one stops the fill before anything is spent.
  const billing = await startRun({ url });
  // Through philform's service the relay holds the provider keys; these stand
  // in for them, so every "is there a key?" check reads the same as with your own.
  // A DeepSeek key of the user's own is used instead of the relay's for writing.
  if (billing.kind === 'remote') {
    settings = { ...settings, typesafeApiKey: 'relay', deepseekApiKey: settings.ownDeepseekKey || 'relay' };
  }

  // --- 1. extract ---------------------------------------------------------
  onProgress(STAGE.INJECTING);
  // In development, the page as it was before anything was touched.
  if (tracing()) trace('page-before', { frames: await pageSnapshot(tabId) });
  onProgress(STAGE.EXTRACTING);
  // Every model call this fill makes is priced here, against the per-fill cap.
  const meter = new Meter(MAX_FILL_CENTS);
  // TypeSafe reads which line is each field's question (structure.js).
  const structured = settings.structure !== 'off' &&
    settings.classifier === 'typesafe' && !!settings.typesafeApiKey;
  const structureCache = new Map();
  const withStructure = async ex => {
    if (!structured || !ex.structures?.length) return ex;
    const unseen = ex.fields.filter(f => !structureCache.has(fieldIdentity(f)));
    if (unseen.length) {
      const read = await readStructure({ extraction: ex, fields: unseen, settings, signal });
      for (const used of read.requests) meter.add('typesafe', settings.typesafeModel, used, 'page structure');
      for (const f of read.fields) {
        structureCache.set(fieldIdentity(f), {
          label: f.label, extractedLabel: f.extractedLabel, optionText: f.optionText, notPart: f.notPart, pageQuestion: f.pageQuestion,
          optionLabels: (f.options || []).map(o => o.label)
        });
      }
    }
    return {
      ...ex,
      fields: ex.fields.map(f => {
        const s = structureCache.get(fieldIdentity(f));
        if (!s || s.extractedLabel === undefined && !s.notPart && !s.pageQuestion && !s.optionLabels.some(Boolean)) return f;
        const options = (f.options || []).map((o, i) => (!/[A-Za-z0-9]/.test(o.label || '') && s.optionLabels[i] ? { ...o, label: s.optionLabels[i] } : o));
        return { ...f, ...(s.extractedLabel !== undefined ? { label: s.label, extractedLabel: s.extractedLabel } : {}),
          ...(s.optionText ? { optionText: s.optionText } : {}), ...(s.notPart ? { notPart: true } : {}),
          ...(s.pageQuestion ? { pageQuestion: s.pageQuestion } : {}), options };
      })
    };
  };
  // Started first, so the saves the page makes while being filled are counted.
  await trackRequests(tabId);
  let extraction = await withStructure(await extractAll(tabId, { probe: true, structure: structured, rules: pageRules }));
  if (!extraction?.ok) throw new Error('Could not read this page.');
  if (!platform && extraction.platformMarkers?.length) {
    platform = detectPlatform(pack, { hostname: hostnameOf(url), markers: extraction.platformMarkers });
    if (platform) {
      pageRules = contentRules(pack, usePlatform(platform.id));
      trace('platform', { platform: platform.id, by: 'markers' });
    }
  }
  // With a CV for each kind of job, the one for this job is chosen while
  // "Add another" is pressed: it is the file attached and the text written from.
  const cvs = (await getDocuments()).resumes || [];
  const choosingCv = chooseResume({ cvs, mainText: profileValue(profile, 'documents.resumeText'),
    context: extraction.context || {}, settings, tabId, site, signal })
    .catch(() => ({ doc: cvs[0] || null, text: profileValue(profile, 'documents.resumeText') || '' }));

  // How many past jobs to fill. A form asking for five employers is otherwise
  // filled with the same job five times, or with nothing.
  const historyDepth = settings.fillEmploymentHistory === 'first'
    ? 1
    : Math.max(1, listEntries(profile, 'employment').length);

  // A block for every saved job and school: "Add another" is pressed first,
  // then the page is read again with the new boxes.
  const added = await addEntryBlocks(tabId, extraction, profile, historyDepth, () => extractAll(tabId), signal);
  halt();
  const typing = longTextMode !== 'skip' && await openTypedDocuments(tabId, added.extraction || extraction);
  halt();
  if (added.pressed || typing) extraction = await withStructure(await extractAll(tabId, { probe: true, structure: structured, rules: pageRules }));
  const cv = await choosingCv;
  halt();
  if (cv.usage) meter.add('typesafe', settings.typesafeModel, cv.usage, 'CV choice');
  if (cv.text) profile = { ...profile, 'documents.resumeText': cv.text };

  // References already given on this site this session go to the back of the queue.
  let given = await givenThisSession(site);
  // Every saved reference already given here: this form starts the cycle again.
  const cycleOver = (given.references?.length || 0) >= listEntries(profile, 'references').length && given.references?.length > 0;
  if (cycleOver) given = {};
  let fields = prepareFields(extraction, profile, given);
  if (!fields.length) {
    throw new Error(extraction.blocked?.length
      ? `The form is inside a frame from ${extraction.blocked[0]}. Allow phil to read it from the popup, then run again.`
      : 'No fillable form fields found on this page. Open the application form first.');
  }

  const context = extraction.context || {};
  const firstUploads = extraction.uploads || [];
  // Documents go in first, while the answers are being decided, and nothing is
  // written until their uploads finish: a form that saves an upload over a copy
  // of itself taken when it started (Ashby) would otherwise drop the answers,
  // and one that fills fields from the CV has them overwritten by the user's own.
  const attaching = settings.attachDocuments && firstUploads.length
    ? attachDocuments(tabId, firstUploads, settings, cv.doc).catch(() => [])
    : Promise.resolve([]);
  const fingerprint = formFingerprint(site, fields);

  // --- 2. site skill ------------------------------------------------------
  onProgress(STAGE.ANALYZING, { fieldCount: fields.length });
  const skill = await getSkill(site);
  if (skill) onProgress(STAGE.MATCHING_SKILL, { site, known: Object.keys(skill.fields || {}).length });

  // A salary question gets the bottom of the range this page posts, not a
  // figure saved for every job; with no range it is left empty, or answered
  // "market rate" when required (see decide).
  const pay = lowestPay(`${context.payText || ''}\n${context.jobDescription || ''}`);
  const pastRuns = await getRuns().catch(() => []);
  const ctx = { settings, profile: { ...profile, 'compensation.desired': pay }, responses, longTextMode, skill, context, onProgress, signal, historyDepth, meter, pastRuns, url };

  // Everything decided and written, across every pass.
  const plan = [];
  const unfilled = [];
  const results = new Map();
  const everyField = new Map();
  const seen = new Set();
  const discovered = new Map();
  const redecided = new Set();
  const probedSelectors = new Set();
  // What each field was last written with, and the ones written a second time
  // after the page cleared them (see restoring below).
  const lastWritten = new Map();
  const retried = new Set();
  const lost = new Set();
  let onlyByChoice = null;
  const totals = { known: 0, heuristic: 0, checked: 0, overruled: 0, modelCalls: 0, requests: 0, skipped: [], usage: {} };
  let passes = 0;

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    halt();
    if (pass > 0) {
      await sleep(SETTLE_MS);
      halt();
      // Only dropdowns not seen before are opened again.
      extraction = await withStructure(await extractAll(tabId, { probe: true, skip: [...probedSelectors], structure: structured, rules: pageRules }));
      fields = prepareFields(extraction, profile, given);
    }

    // Fields not yet decided, plus dropdowns whose options were just read.
    const fresh = [];
    let deferred = 0;
    for (const f of fields) {
      // Read means opened: a dropdown the read had no time for is opened next pass.
      if (f.probe || (f.widget === 'listbox' && f.options?.length)) probedSelectors.add(f.selector);
      const id = fieldIdentity(f);
      // Site furniture (a step menu, a site search) is not asked about or counted.
      if (f.notPart) {
        if (!seen.has(id)) unfilled.push({ ...f, reason: 'Not part of the application form' });
        seen.add(id);
        continue;
      }
      // Not decided before its options are read: held for the next pass,
      // which opens it first. On the last pass it is decided as it is.
      if (f.probePending && !discovered.has(id) && pass < MAX_PASSES - 1) {
        deferred++;
        continue;
      }
      const options = discovered.get(id);
      if (options) {
        discovered.delete(id);
        // A list now, as the first read would have made it had it opened the box.
        fresh.push({ ...f, options: options.map(label => ({ value: label, label })), widget: 'listbox', combobox: false,
          searchable: f.searchable || f.tag === 'input' });
      } else if (!seen.has(id)) {
        fresh.push(f);
      }
      seen.add(id);
      if (!everyField.has(id)) everyField.set(id, f);
    }
    // Fields the page cleared after they were written: Greenhouse resets the
    // boxes typed before its location pick settles, PeopleSoft redraws a
    // section when its server answers. Each is written again once from the
    // plan, with no new model call; cleared again, it is reported, not counted.
    const reverted = pass > 0 ? fields.filter(f => wasCleared(f, lastWritten.get(fieldIdentity(f)))) : [];
    const retry = reverted.filter(f => !retried.has(fieldIdentity(f)));
    for (const f of reverted) if (retried.has(fieldIdentity(f))) lost.add(fieldIdentity(f));
    trace('extraction', { pass, frames: extraction.frames, blocked: extraction.blocked, fields: fields.map(compactField), fresh: fresh.map(f => f.id), reverted: reverted.map(f => f.id) });
    if (retry.length) {
      const again = retry.map(f => {
        const before = lastWritten.get(fieldIdentity(f));
        retried.add(before.identity);
        // The first write no longer stands; the second one is what counts.
        const at = plan.findIndex(p => p.id === before.id);
        if (at >= 0) plan.splice(at, 1);
        return { ...f, value: before.value, via: before.via, profileKey: before.profileKey, thin: before.thin, fieldKey: before.fieldKey };
      });
      await writeOut(again, 'r', pass);
    }
    if (!fresh.length) {
      if ((retry.length || deferred) && pass < MAX_PASSES - 1) continue;
      break;
    }
    passes++;

    ctx.pageFields = fields;
    ctx.finalPass = pass >= MAX_PASSES - 1;
    ctx.earlier = plan;
    const decided = await decide(fresh, ctx);
    // A follow-up whose question is not answered yet is read again next pass.
    for (const f of decided.deferred || []) seen.delete(fieldIdentity(f));
    deferred += (decided.deferred || []).length;
    trace('decided', {
      pass,
      plan: decided.plan.map(f => ({ id: f.id, label: f.label, profileKey: f.profileKey || null, via: f.via, value: String(f.value ?? '').slice(0, 300), confidence: f.confidence ?? null })),
      unfilled: decided.unfilled.map(f => ({ id: f.id, label: f.label, profileKey: f.profileKey || null, reason: f.reason }))
    });
    totals.known += decided.stats.known;
    totals.heuristic += decided.stats.heuristic;
    totals.checked += decided.stats.checked;
    totals.overruled += decided.stats.overruled;
    totals.modelCalls += decided.stats.modelCalls;
    totals.requests += decided.stats.requests;
    totals.skipped.push(...decided.stats.skipped);
    for (const [k, v] of Object.entries(decided.stats.usage)) {
      if (v && typeof v === 'object' && totals.usage[k]) {
        totals.usage[k] = { input_tokens: (totals.usage[k].input_tokens || 0) + (v.input_tokens || 0), output_tokens: (totals.usage[k].output_tokens || 0) + (v.output_tokens || 0) };
      } else totals.usage[k] = v;
    }

    // One home address, one name, one email: if the same personal answer is
    // about to go into two different sections, only the applicant's section
    // gets it. Earlier passes count, since those answers are already typed.
    const pageOrder = new Map(fields.map((f, i) => [f.id, i]));
    decided.plan.sort((a, b) => (pageOrder.get(a.id) ?? 0) - (pageOrder.get(b.id) ?? 0));
    const { kept, dropped } = dedupeAcrossSections([...plan.filter(f => results.get(f.id)?.ok), ...decided.plan]);
    const thisPass = kept.filter(f => decided.plan.includes(f));
    unfilled.push(...decided.unfilled, ...dropped.filter(f => decided.plan.some(p => p.id === f.id)));

    if (!thisPass.length && !decided.drafting) {
      if (deferred && pass < MAX_PASSES - 1) continue;
      // A self-identification page with demographics off, or one already
      // answered: nothing to do, by the user's own choice. Not an error, and
      // more profile detail would not change it.
      const byChoice = unfilled.length > 0 && unfilled.every(f => f.reason === DEMOGRAPHICS_OFF || f.reason === 'Already answered on the page');
      // A page filled before (by phil or by hand) with a box or two nothing
      // saved answers (a GPA): done, not "nothing matched".
      const mostlyDone = unfilled.filter(f => f.reason === 'Already answered on the page').length >= unfilled.length * 0.75;
      if (pass === 0 && (byChoice || mostlyDone)) {
        onlyByChoice = unfilled.some(f => f.reason === DEMOGRAPHICS_OFF) ? 'demographics' : 'answered';
        break;
      }
      // The page's entries sit behind an "Add Employment Record" button: the
      // popup says to click it, which more profile detail would not fix.
      if (pass === 0 && entriesToAdd(extraction, profile, historyDepth).length) break;
      if (pass === 0) {
        throw new Error('Nothing on this page matched your profile. Add more detail in philform settings.');
      }
      break;
    }

    // --- 6. fill ------------------------------------------------------------
    await writeOut(thisPass, '', pass);
    // The drafts were being written meanwhile; they go in as they arrive.
    if (decided.drafting) {
      const drafted = await decided.drafting;
      halt();
      unfilled.push(...drafted.unfilled);
      await writeOut(drafted.plan, 'd', pass);
    }
  }

  // Ids are per extraction; keep each pass's under a pass prefix so a later
  // pass cannot overwrite them.
  async function writeOut(items, tag, pass) {
    if (!items.length) return;
    await attaching;
    halt();
    onProgress(STAGE.FILLING, { count: items.length });
    const batch = items.map(f => ({ ...f, passId: `${pass}${tag}/${f.id}`, identity: fieldIdentity(f) }));
    const batchResults = await fillPlan(tabId, batch, settings, profile, { scroll: pass === 0 && !tag });
    trace('filled', { pass, results: batch.map(f => ({ id: f.id, label: f.label, value: String(f.value ?? '').slice(0, 300), ...(batchResults.get(f.id) || { ok: false, reason: 'no result' }) })) });
    for (const f of batch) {
      const r = batchResults.get(f.id);
      results.set(f.passId, r);
      plan.push({ ...f, id: f.passId });
      if (r?.ok) lastWritten.set(f.identity, { ...f, id: f.passId });
      // A dropdown whose options were only readable once opened: decide
      // again next pass, among the options it really has.
      // So is one the read saw only part of (Workday adds options in stages),
      // or a category whose own list opened: once per field.
      // A dropdown the first read had no time to open (Greenhouse's in a slow
      // frame, ~2 s each) was decided blind: "Male" typed for "Man", a Yes/No
      // question drafted as prose. What it showed when filled decides it again.
      const known = new Set((f.options || []).map(o => normalize(o.label)));
      // Only a fixed list: a search box's results (Workday's schools, skills) go to the closest-entry step below.
      const shown = r?.options?.length ? r.options : (!f.options?.length && f.combobox && !f.searchable && !f.prompt ? r?.candidates : null);
      const more = shown?.some(label => !known.has(normalize(label)));
      if (r && !r.ok && shown?.length && (f.widget === 'listbox' || f.combobox) && (!f.options?.length || more) && !redecided.has(f.identity)) {
        if (f.options?.length || f.combobox) redecided.add(f.identity);
        discovered.set(f.identity, shown);
        plan.pop();
      }
    }
    unfilled.push(...batch.filter(f => {
      const r = batchResults.get(f.id);
      return !r?.ok && !discovered.has(f.identity);
    }).map(f => ({ ...f, reason: batchResults.get(f.id)?.reason || 'Could not write to this field' })));

    // Answers a searched list holds under no name of their own: the model
    // says which entry, if any, means them (a major, a school, a skill), in
    // one request, and those entries are chosen. Amber, for the user to check.
    const asks = [];
    for (const f of batch) {
      const r = batchResults.get(f.id);
      if (r?.unmatched?.length) for (const u of r.unmatched) asks.push({ f, skill: u.skill, options: u.options });
      if (!r?.ok && r?.candidates?.length && !discovered.has(f.identity)) asks.push({ f, skill: String(f.value), options: r.candidates, question: cleanLabel(f.label || '') });
    }
    if (asks.length && settings.classifier === 'typesafe' && !signal?.aborted) {
      asks.forEach((a, n) => { a.key = n; });
      const { picks, usage } = await pickEquivalents({ items: asks, settings, signal })
        .catch(err => { if (signal?.aborted) throw err; return { picks: new Map(), usage: {} }; });
      meter.add('typesafe', settings.typesafeModel, usage, 'closest entries');
      trace('equivalents', { asked: asks.map(a => [a.f.label, a.skill, a.options.length]), picks: [...picks].map(([k, v]) => [asks[k].skill, v]) });
      // A single answer nothing listed means: the list's own "Other".
      for (const a of asks) {
        const other = a.question && !picks.has(a.key) && a.options.find(o => /^other\b\.?$/i.test(o.trim()));
        if (other) picks.set(a.key, other);
      }
      for (const f of batch) {
        const mine = asks.filter(a => a.f === f && picks.has(a.key)).map(a => picks.get(a.key));
        if (!mine.length) continue;
        const r = batchResults.get(f.id);
        const item = r?.candidates ? { ...f, value: mine[0], exact: true, thin: true } : { ...f, value: mine.join('\n'), thin: true };
        const more = await fillPlan(tabId, [item], settings, profile, { scroll: false });
        const done = more.get(f.id);
        if (done?.ok && !r?.ok) {
          results.set(f.passId, { ...done, altered: true });
          const at = unfilled.findIndex(u => u.passId === f.passId);
          if (at >= 0) unfilled.splice(at, 1);
          const planned = plan.find(p => p.id === f.passId);
          if (planned) planned.value = item.value;
          lastWritten.set(f.identity, { ...f, value: item.value, id: f.passId });
          // Its follow-up ("If you selected Other for school, enter the
          // name") was decided against the saved name: decided again next
          // pass, now that the page shows the choice.
          for (let i = unfilled.length - 1; i >= 0; i--) {
            if (unfilled[i].reason === `Only needed for some answers to "${truncate(f.label || '', 60)}"`) {
              seen.delete(fieldIdentity(unfilled[i]));
              unfilled.splice(i, 1);
            }
          }
        }
      }
    }
  }

  // Written twice and cleared twice: not filled, and the user is told.
  for (const identity of lost) {
    const entry = lastWritten.get(identity);
    if (!entry) continue;
    results.set(entry.id, { ...(results.get(entry.id) || {}), ok: false, reason: 'The page cleared this field' });
    unfilled.push({ ...entry, reason: 'The page cleared this field after it was filled' });
  }

  const uploads = await attaching;
  // A required cover letter upload with nothing saved and no box to type it
  // into (Astera's Ashby form refused the application without one): written
  // and attached as a PDF.
  if (longTextMode !== 'skip' && settings.attachDocuments && !signal?.aborted) {
    const letter = await attachWrittenLetter(tabId, extraction, profile, settings, context, signal, ctx.meter).catch(() => null);
    if (letter) uploads.push(letter);
  }

  const durationMs = Date.now() - startedAt;
  const successful = plan.filter(f => results.get(f.id)?.ok);
  const filledIdentities = new Set(successful.map(f => f.identity));

  // A field decided in one pass and filled in a later one is not "unfilled".
  const finalUnfilled = [];
  const reported = new Set();
  for (const f of unfilled) {
    const id = fieldIdentity(f);
    if (filledIdentities.has(id) || reported.has(id)) continue;
    reported.add(id);
    finalUnfilled.push(f);
  }

  // --- learn --------------------------------------------------------------
  // Every field the page offered is reported, filled or not. A field that could
  // not be placed is the one worth seeing in the editor.
  const plannedByIdentity = new Map(plan.map(f => [f.identity, f]));
  const unfilledByIdentity = new Map(finalUnfilled.map(f => [fieldIdentity(f), f]));
  const skippedIds = new Set(totals.skipped.map(fieldIdentity));

  const observations = [...everyField.entries()].map(([identity, field]) => {
    const planned = plannedByIdentity.get(identity);
    const missed = unfilledByIdentity.get(identity);
    const result = planned ? results.get(planned.id) : null;
    const ok = !!result?.ok;

    let kind = 'unresolved';
    if (planned?.via === 'written' || planned?.via === 'saved' || planned?.via === 'saved-model') kind = 'long';
    else if (planned?.profileKey) kind = 'profile';
    else if (skippedIds.has(identity)) kind = 'skip';

    return {
      fieldKey: field.fieldKey || fieldKey(field),
      label: field.label || field.name || '',
      section: field.section || '',
      kind,
      profileKey: planned?.profileKey || null,
      via: planned?.via || '',
      ok,
      reason: ok ? '' : (result?.reason || missed?.reason || 'Not matched to anything in your profile')
    };
  });

  await rememberGiven(site, successful, { restart: cycleOver });
  await recordRun(site, {
    fingerprint,
    durationMs,
    fieldCount: everyField.size,
    modelCalls: totals.modelCalls,
    observations
  });

  // A fill that wrote nothing is not a completion.
  const { charged } = successful.length
    ? await chargeCompletion({ formId: fingerprint, site, fieldsFilled: successful.length })
    : { charged: false };

  // The reward: what the fill saved the user, added to the running total
  // only when it counted as a completion.
  const timeSavedSeconds = estimateSeconds(successful, uploads.filter(u => u.ok).length);
  // What the fill cost, and what the wallet was charged for it (a free
  // application, or three times the cost). Both go into the total either
  // way, to set against what it saved.
  const cost = meter.summary();
  const wallet = await finishRun(billing, { costCents: cost.cents, filled: successful.length });
  const allTime = charged && timeSavedSeconds > 0
    ? await recordTimeSaved(timeSavedSeconds, url, cost, wallet)
    : await recordSpent(cost, wallet);

  const summary = {
    at: nowIso(),
    onlyByChoice,
    // Voluntary questions skipped because the user turned them off: the
    // popup says so, or they read as questions Applicator never found.
    demographicsOff: finalUnfilled.filter(f => f.reason === DEMOGRAPHICS_OFF).length,
    site,
    url: truncate(url, 300),
    role: context.role || '',
    company: context.company || '',
    durationMs,
    fieldsFound: everyField.size,
    filled: successful.length,
    passes,
    platform: platform?.id || null,
    frames: extraction.frames || 1,
    blockedFrames: extraction.blocked || [],
    // Questions on the page no field was read for, as of the last read: what
    // the popup asks the user to report, so the next version reads them.
    possiblyMissed: extraction.unread || [],
    // Required questions still empty, which the page will not submit without:
    // the user is pointed to them by name.
    requiredEmpty: finalUnfilled
      .filter(f => f.required && f.reason !== 'Already answered on the page' && f.reason !== DEMOGRAPHICS_OFF && !isAlreadyAnswered(f))
      .map(f => truncate(cleanLabel(f.label || f.ariaLabel || f.placeholder || '').replace(/\s*:\s*$/, ''), 90)).filter(Boolean).slice(0, 5),
    // "Add Employment Record" buttons whose entries the profile holds: the
    // user clicks one and fills again.
    addEntries: entriesToAdd(extraction, profile, historyDepth),
    entriesAdded: added.pressed,
    needsReview: successful.filter(f => f.thin || results.get(f.id)?.altered).length,
    guessed: successful.filter(f => f.via === 'guess').length,
    written: successful.filter(f => f.via === 'written').length,
    fromSavedResponses: successful.filter(f => f.via === 'saved' || f.via === 'saved-model').length,
    documentsAttached: uploads.filter(u => u.ok).length,
    // An upload the page refused, or still going when the fill ended.
    uploadsUnsure: uploads.filter(u => u.unconfirmed || u.reason === 'The page did not accept the upload')
      .map(u => ({ kind: u.kind, failed: !u.ok })),
    uploadsOffered: firstUploads.length,
    // Which of several CVs went with this job (attached, and written from).
    cvUsed: cvs.length > 1 && cv.doc ? { filename: cv.doc.filename, category: cv.doc.category || '' } : undefined,
    adaptedResponses: successful.filter(f => f.via === 'written' && f.responseId).length,
    fromSkill: totals.known,
    fromHeuristics: totals.heuristic,
    checkedByModel: totals.checked,
    overruledByModel: totals.overruled,
    modelCalls: totals.modelCalls,
    modelRequests: totals.requests,
    // What the fill cost in model calls, what it would be charged, and
    // whether it hit the cap (which offers to report the page).
    cost,
    // What the wallet was charged, when there is one: { free, cents, freeLeft, balanceCents }.
    wallet,
    charged,
    timeSavedSeconds,
    allTime,
    multiStep: !!context.multiStep,
    // What the page asked, for a reopened popup to tell a new step from it.
    questions: pageQuestions([...everyField.values()]),
    slow: durationMs > settings.slowRunThresholdMs,
    usage: totals.usage,
    // Store what was decided, not what was typed, unless the user opted in.
    decisions: plan.map(f => ({
      label: truncate(f.label || '', 120),
      profileKey: f.profileKey || null,
      via: f.via,
      ok: !!results.get(f.id)?.ok,
      value: settings.redactHistory ? undefined : truncate(String(f.value), 200)
    })),
    unfilled: finalUnfilled.map(f => ({
      label: truncate(f.label || f.name || '', 120),
      reason: f.reason
    }))
  };

  halt();
  // The required questions left empty are marked on the page for the user
  // to answer there; what they tick is saved for next time.
  summary.asked = await askUser(tabId, url, finalUnfilled);

  await pushRun(summary);
  await recordResponseUses(successful.filter(f => f.responseId));
  onProgress(STAGE.DONE, summary);
  return summary;
}

/**
 * Attach the CV (the one chosen for this job) or cover letter the user stored
 * in settings to the matching upload field. Only documents the user saved themselves are ever sent.
 */
async function attachDocuments(tabId, uploads, settings, cv) {
  const documents = await getDocuments();
  const items = [];

  for (const upload of uploads) {
    const doc = upload.kind === 'resume' ? cv || documents.resumes[0] : documents[upload.kind];
    if (!doc?.data) continue;
    items.push({
      kind: upload.kind,
      frameId: upload.frameId || 0,
      selector: upload.selector,
      filename: doc.filename,
      mimeType: doc.mimeType,
      data: doc.data
    });
  }
  if (!items.length) return [];

  const out = [];
  for (const [frameId, group] of byFrame(items)) {
    const [reply] = await runInFrames(
      tabId,
      plan => globalThis.__applicatorAttachFiles(plan),
      [{ items: group, highlight: settings.highlightFilled, replaceExisting: false }],
      [frameId]
    );
    out.push(...(reply?.result?.results || []));
  }
  return out;
}

/**
 * A required cover letter upload with no saved file and no "Enter manually"
 * button: one writer request drafts the letter, which goes in as a PDF
 * (or plain text where the box takes only that). Returns the attach result,
 * or null when there is no such upload or nothing was written.
 */
async function attachWrittenLetter(tabId, extraction, profile, settings, context, signal, meter) {
  const documents = await getDocuments();
  const upload = (extraction.uploads || []).find(u => u.kind === 'coverLetter' && u.required && !u.manualSelector &&
    !u.alreadyHasFile && !documents.coverLetter?.data);
  if (!upload) return null;
  const field = { id: 'cover-letter-file', label: 'Cover letter', tag: 'textarea', type: 'textarea', required: true, multiline: true };
  const afford = (provider, model, inputTokens, wanted) => {
    const allowed = affordableOutput(provider, model, inputTokens, meter.remaining());
    if (allowed < wanted) meter.capped = true;
    return allowed;
  };
  const res = await writeAnswers({ fields: [field], profile, settings, context, signal, afford });
  for (const u of res.usages || []) meter.add(res.provider, u.model || res.model, u.usage, 'cover letter');
  if (res.checkUsage) meter.add('typesafe', settings.typesafeModel, res.checkUsage, 'fact check');
  for (const u of res.editUsages || []) meter.add('deepseek', 'deepseek-flash', u, 'fact edit');
  if (res.researchUsage) meter.add('deepseek', 'deepseek-flash', res.researchUsage, 'company research');
  const body = String((res.answers || []).find(a => a.id === field.id)?.answer || '').trim();
  if (!body) return null;
  const name = [profileValue(profile, 'identity.firstName'), profileValue(profile, 'identity.lastName')].filter(Boolean).join(' ');
  // A letter, not an answer: the writer's draft opened mid-thought and was never signed (Astera).
  const text = [/^(dear|hello|hi|to)\b/i.test(body) ? '' : `Dear ${context.company ? `${context.company} ` : ''}hiring team,`, body,
    /\b(regards|sincerely|best|thank you|thanks),?\s*\n.*$/i.test(body) ? '' : `Kind regards,\n${name}`].filter(Boolean).join('\n\n');
  const plain = upload.accept && !/pdf/i.test(upload.accept) && /\btxt\b|text\/plain/i.test(upload.accept);
  const item = {
    kind: 'coverLetter', frameId: upload.frameId || 0, selector: upload.selector,
    filename: `Cover letter${name ? ` - ${name}` : ''}.${plain ? 'txt' : 'pdf'}`,
    mimeType: plain ? 'text/plain' : 'application/pdf',
    data: plain ? btoa(unescape(encodeURIComponent(text))) : textPdf(text)
  };
  trace('written-letter', { text, file: item.filename });
  const [reply] = await runInFrames(tabId, plan => globalThis.__applicatorAttachFiles(plan),
    [{ items: [item], highlight: settings.highlightFilled, replaceExisting: false }], [item.frameId]).catch(() => []);
  return reply?.result?.results?.[0] || null;
}

/**
 * A required cover letter with no saved file, where the page offers to type
 * it instead (Greenhouse's "Enter manually"): that button is pressed, so the
 * box it opens is written like any other cover letter (Tailscale refused the
 * application without one). Returns how many were opened.
 */
async function openTypedDocuments(tabId, extraction) {
  const documents = await getDocuments();
  const wanted = (extraction.uploads || []).filter(u => u.kind === 'coverLetter' && u.required && u.manualSelector &&
    !u.alreadyHasFile && !documents.coverLetter?.data);
  let opened = 0;
  for (const u of wanted) {
    const [reply] = await runInFrames(tabId, item => globalThis.__applicatorPressAdd?.(item) || { added: false },
      [{ selector: u.manualSelector }], [u.frameId || 0]).catch(() => []);
    if (reply?.result?.added) opened++;
  }
  if (opened) trace('typed-documents', { opened });
  return opened;
}

/** Bump the use counter on each saved response that was filled. */
async function recordResponseUses(used) {
  if (!used.length) return;
  const responses = await getResponses();
  const counts = new Map();
  for (const field of used) counts.set(field.responseId, (counts.get(field.responseId) || 0) + 1);

  let changed = false;
  const next = responses.map(response => {
    const extra = counts.get(response.id);
    if (!extra) return response;
    changed = true;
    return { ...response, uses: (response.uses || 0) + extra, lastUsed: Date.now() };
  });
  if (changed) await saveResponses(next);
}

/** Remove Applicator's review highlights from every frame of a tab. */
/**
 * Mark the required questions a fill left empty, so the user answers them on
 * the page and ticks to save the answer (fill.js `askUser`). Identity
 * questions and uploads are not saved answers, and are left alone. Returns
 * how many were marked; never fails the fill.
 */
async function askUser(tabId, url, unfilled) {
  const items = unfilled.filter(f => f.required && f.selector && f.type !== 'file' && !isAlreadyAnswered(f) &&
    f.reason !== 'Already answered on the page' && f.reason !== DEMOGRAPHICS_OFF && !isIdentityQuestion(f))
    .map(f => ({ frameId: f.frameId || 0, selector: f.selector,
      question: cleanLabel(f.label || f.ariaLabel || f.placeholder || '').replace(/\s*[:*]+\s*$/, '') }))
    .filter(i => /[a-z]/i.test(i.question));
  let marked = 0;
  for (const [frameId, group] of byFrame(items)) {
    try {
      const [reply] = await runInFrames(tabId, plan => globalThis.__applicatorAsk?.(plan) || { marked: 0 },
        [{ items: group, site: siteKey(url) }], [frameId]);
      marked += reply?.result?.marked || 0;
    } catch { /* a frame gone since the fill: nothing to mark */ }
  }
  return marked;
}

/** Bring the first marked question into view (the popup's "Show me"). */
export async function showAsked(tabId) {
  const replies = await runInFrames(tabId, () => globalThis.__applicatorShowAsked?.() || { shown: false });
  return { shown: replies.some(r => r?.result?.shown) };
}

export async function clearHighlights(tabId) {
  await injectAll(tabId, ['/src/content/fill.js']);
  await runInFrames(tabId, () => globalThis.__applicatorClearHighlights());
  return { ok: true };
}
