/**
 * Whose details a field is asking for.
 *
 * A form that asks for employment history repeats "City", "State" and "Start
 * date" inside every employer block, and one with references repeats "Name",
 * "Phone" and "Email" for each referee. Matched by label alone, all of those
 * look like the applicant's own details, and the applicant's home address ends
 * up typed into every block on the page.
 *
 * The extractor reports the trail of headings above each field, nearest first.
 * This module reads that trail, plus the field's own name and label, to decide
 * which block the field belongs to, and then adjusts the chosen profile key to
 * suit: an employer block's city gets that job's location, a referee's phone
 * gets nothing at all.
 */

import { normalize } from '../common/util.js';

/** Blocks, tested nearest heading first. The first cue that matches wins. */
const CUES = [
  // Someone other than the applicant. Nothing of the applicant's belongs here.
  ['emergency', /\bemergency\b|next of kin/],
  ['reference', /\breferences?\b(?!\s*(number|code|id)\b)|\breferee/],
  ['supervisor', /supervisor|\bmanager'?s?\s+(name|phone|email|title|contact)|reporting to|may we contact/],
  ['education', /education|\bschool|universit|college|academic|\bdegree|institution/],
  ['employment', /(?<!equal )employ|work\s*(experience|history)|professional\s*experience|previous\s*(job|position|role)|job\s*history|career\s*history|^experience\b|\bexperience\s*\d|\bposition\s*#?\s*\d|\bjob\s*#?\s*\d|\bcompany\s*#?\s*\d/],
  ['personal', /personal|my\s*(information|info|details|profile)|contact\s*(info|information|details)|about\s*you\b|your\s*(details|information|address|contact)|applicant|\bhome\b|mailing|residen|current\s*address|permanent\s*address/]
];

/** Name and id fragments that place a single field, whatever its heading says. */
const ATTR_CUES = [
  ['emergency', /emergency|next[-_ ]?of[-_ ]?kin/],
  ['reference', /(^|[^a-z])(references?|referee|reff)([^a-z]|$)/],
  ['supervisor', /supervisor|manager[-_ ]?(name|phone|email)/],
  ['education', /education|school|universit|college/],
  ['employment', /employ|work[-_ ]?(experience|history)|experiences?\[|jobs?\[|positions?\[|previous[-_ ]?(job|employer)/]
];

/** Label wording that places a single field, such as "Employer city". */
const LABEL_CUES = [
  ['emergency', /emergency contact/],
  ['reference', /\breferences?'?s?\s+(name|phone|email|relationship|company|title)|\breferee/],
  ['supervisor', /supervisor|\bmanager'?s?\s+(name|phone|email|title)|may we contact/],
  ['employment', /\b(employer|company)'?s?\s+(city|state|address|location|country|phone|zip)/],
  ['education', /\b(school|university|college)'?s?\s+(city|state|address|location|country)/]
];

/**
 * Decide which block a field belongs to.
 *
 * @returns {{scope: string, cue: string}}  scope is one of personal,
 *   employment, education, reference, supervisor, emergency or unknown.
 */
export function scopeOf(field) {
  const found = blockOf(field);
  // "Did you graduate from High School?" sits in an education section but asks
  // about the applicant, not about one school: tied to the first entry, the
  // model read it as "did the University of Portland graduate high school?".
  if (found.scope === 'education' && ABOUT_YOU.test(normalize(field.label || field.ariaLabel || ''))) {
    return { scope: 'personal', cue: 'asks about you' };
  }
  return found;
}

/** A question about the applicant's own status rather than one entry's details. */
const ABOUT_YOU = /^(did|do|have|are|were|will) you\b|\bhighest (level|degree)/;

function blockOf(field) {
  const trail = String(field.section || '').split(' › ').map(normalize).filter(Boolean);
  const attrs = normalize(`${field.name || ''} ${field.idAttr || ''} ${field.dataAttr || ''}`);
  for (const [scope, re] of ATTR_CUES) {
    if (!re.test(attrs)) continue;
    // A heading saying the block is about someone else beats an id that only
    // names the subject: PeopleSoft's reference form calls its box
    // HRS_REFF_SS_VW_EMPLOYER, and the applicant's own employer went in it.
    if (!OTHER_PERSON.has(scope)) {
      const other = otherPersonHeading(trail);
      if (other) return { scope: other, cue: 'heading over name' };
    }
    return { scope, cue: 'name' };
  }

  const label = normalize(field.label || field.ariaLabel || '');
  for (const [scope, re] of LABEL_CUES) {
    if (re.test(label)) return { scope, cue: 'label' };
  }

  // Nearest heading first: "Employer 2 > Address" is an employer's address.
  for (const heading of trail) {
    for (const [scope, re] of CUES) {
      if (re.test(heading)) return { scope, cue: heading };
    }
  }
  return { scope: 'unknown', cue: '' };
}

const OTHER_PERSON = new Set(['reference', 'supervisor', 'emergency']);

/** The other person a field's two nearest headings say its block is about, if any. */
function otherPersonHeading(trail) {
  for (const heading of trail.slice(0, 2)) {
    for (const [scope, re] of CUES) {
      if (re.test(heading)) {
        if (OTHER_PERSON.has(scope)) return scope;
        break; // the nearest heading that names a block decides
      }
    }
  }
  return null;
}

/** Keys that describe the applicant as a person: never right for someone else. */
const PERSONAL_GROUPS = /^(identity|contact|address|links)\./;

const JOB_KEYS = /^(employment\.|work\.current(Company|Title)$)/;
const EDUCATION_KEYS = /^(education\.|work\.(school|fieldOfStudy|highestDegree|graduationYear)$)/;

const ends = label => /\b(end|to|until|finish(ed)?|left|leaving|completion|completed)\b|graduat/.test(label);

/**
 * A date box labelled only "Month" or "Year" (Workday) is an end date when
 * the heading just above it says so ("To") or its id does
 * (`workExperience-4--endDate-dateSectionMonth-input`).
 */
function endsByPlace(field) {
  const nearest = normalize(String(field.section || '').split(' › ')[0]);
  if (/^(to|end|until|end date|date to)\b/.test(nearest)) return true;
  return /(^|[^a-z])(end|to)[-_ ]?date|enddate|date[-_ ]?to\b/i.test(`${field.idAttr || ''} ${field.name || ''}`);
}

/** What the applicant's own key means inside an employer block. */
const IN_JOB = {
  'work.currentCompany': 'employment.company',
  'work.currentTitle': 'employment.title',
  'address.line1': 'employment.address',
  'address.city': 'employment.city',
  'address.location': 'employment.city',
  'address.state': 'employment.state',
  'address.postalCode': 'employment.postalCode',
  'address.country': 'employment.country',
  'contact.phone': 'employment.phone',
  // A Summary box in an employer block is that job's saved duties, not the
  // profile summary: drafted afresh, it was most of a fill's cost.
  'documents.summary': 'employment.description'
};

/** ...and inside an education block. */
const IN_SCHOOL = {
  'work.school': 'education.school',
  'work.fieldOfStudy': 'education.major',
  'work.highestDegree': 'education.degree',
  'work.graduationYear': 'education.endYear',
  'address.city': 'education.city',
  'address.location': 'education.city',
  'address.state': 'education.state',
  'address.country': 'education.country'
};

const DATE_KEYS = new Set([
  'preferences.availableStartDate', 'employment.startDate', 'employment.endDate',
  'education.startYear', 'education.endYear', 'work.graduationYear'
]);

/**
 * What a field means inside a references block: the same words as the
 * applicant's own details, but about the reference. Nothing else of the
 * applicant's belongs there.
 */
const IN_REFERENCE = {
  'identity.fullName': 'references.fullName',
  'identity.firstName': 'references.firstName',
  'identity.lastName': 'references.lastName',
  'contact.phone': 'references.phone',
  'contact.email': 'references.email',
  'work.currentCompany': 'references.company',
  'work.currentTitle': 'references.title',
  'employment.company': 'references.company',
  'employment.title': 'references.title'
};

/** A supervisor block holds these things about the job, and nothing of yours. */
const SUPERVISOR_KEYS = new Set(['employment.supervisor', 'employment.mayContact', 'employment.phone']);

/**
 * Adjust a chosen profile key to the block the field sits in.
 *
 * Returns `{ key }` to fill with (possibly a different key), or
 * `{ key: null, reason }` when nothing in the profile belongs there. Keys that
 * are not about a person, place, date, school or employer pass through.
 */
const SIGN_UP = /\bnewsletter|\bsubscribe\b|\bstay (informed|in touch|up to date|in the loop)\b|\bmailing list\b|\b(latest|our) (news|updates|research findings)\b|\bjob alerts?\b|\bcreate (a )?(job )?alert\b/;

export function scopeKey(field, key) {
  if (!key) return { key };
  const { scope } = field.scope ? { scope: field.scope } : scopeOf(field);
  const label = normalize(field.label || field.ariaLabel || field.placeholder || '');

  // A pronunciation box wants how the name sounds, never the name itself.
  // Only a saved pronunciation goes there; without one it stays empty.
  if (/pronunc|phonetic/.test(label) && key !== 'identity.namePronunciation') {
    return { key: null, reason: 'Only your saved pronunciation goes here, and none is saved' };
  }

  // A newsletter or job-alert sign-up on the page around the form is not
  // the application: Saildrone's "Stay informed" box took the email, and the
  // form's own Email was then skipped as a repeat.
  if (SIGN_UP.test(normalize(`${field.section || ''} ${label}`))) {
    return { key: null, reason: 'A newsletter or alert sign-up, not part of the application' };
  }

  // Availability is never split into month and year boxes: "Start date
  // month" is a job's, even where no block was recognised (Lyft's Greenhouse
  // form got "Immediately" from the model).
  if (key === 'preferences.availableStartDate' && /\b(start|end)[\s_-]*date[\s_-]*(month|year)\b/.test(label)) {
    return { key: /\bend\b/.test(label) ? 'employment.endDate' : 'employment.startDate' };
  }

  // "Address line 2" is never the street line, whatever matched it.
  if (key === 'address.line1' && isSecondLine(field)) return { key: 'address.line2' };

  // A reference's details belong in a references block and nowhere else: an
  // emergency contact's "Relationship" is not a reference's.
  if (key.startsWith('references.')) {
    return scope === 'reference' ? { key } : { key: null, reason: 'Only a references block takes your saved references' };
  }
  if (scope === 'reference') {
    if (IN_REFERENCE[key]) return { key: IN_REFERENCE[key] };
  }

  if (scope === 'supervisor') {
    if (SUPERVISOR_KEYS.has(key)) return { key };
    if (key === 'identity.fullName') return { key: 'employment.supervisor' };
    // "Supervisor Phone": the number saved with the job, usually the employer's.
    if (key === 'contact.phone') return { key: 'employment.phone' };
  }
  if (OTHER_PERSON.has(scope)) {
    if (PERSONAL_GROUPS.test(key) || JOB_KEYS.test(key) || EDUCATION_KEYS.test(key)) {
      return { key: null, reason: `Belongs to a ${scope === 'emergency' ? 'emergency contact' : scope}, not to you` };
    }
    return { key };
  }

  // A block's own "Name" box names the employer or school, not the applicant.
  if (key === 'identity.fullName' && scope === 'employment' && /company|employer|organi[sz]ation|business/.test(label)) {
    return { key: 'employment.company' };
  }
  if (key === 'identity.fullName' && scope === 'education' && /institution|school|college|universit/.test(label)) {
    return { key: 'education.school' };
  }

  if (scope === 'employment') {
    if (DATE_KEYS.has(key)) return { key: ends(label) || endsByPlace(field) ? 'employment.endDate' : 'employment.startDate' };
    if (IN_JOB[key]) return { key: IN_JOB[key] };
    if (PERSONAL_GROUPS.test(key) || EDUCATION_KEYS.test(key)) {
      return { key: null, reason: 'Belongs to an employer block, not your own details' };
    }
    return { key };
  }

  if (scope === 'education') {
    if (DATE_KEYS.has(key)) return { key: ends(label) ? 'education.endYear' : 'education.startYear' };
    if (IN_SCHOOL[key]) return { key: IN_SCHOOL[key] };
    if (PERSONAL_GROUPS.test(key) || JOB_KEYS.test(key)) {
      return { key: null, reason: 'Belongs to an education block, not your own details' };
    }
    return { key };
  }

  return { key };
}

/** A second address line: "Address line 2", "Apt / suite", `address2`, `street_2`. */
export function isSecondLine(field) {
  const probe = normalize(`${field.name || ''} ${field.idAttr || ''} ${field.label || ''} ${field.ariaLabel || ''} ${field.placeholder || ''}`);
  return /(address|addr|street|line)[-_ ]?(line)?[-_ ]?(2|two)\b|\b(apt|apartment|suite|unit)\b|address\s*\(?cont/.test(probe);
}

/**
 * A backstop for blocks the cues above do not recognise.
 *
 * When the same personal key (home city, email, name) is planned for fields in
 * different sections, those sections are almost certainly different blocks,
 * and only one of them is the applicant's. The applicant's block is the one
 * whose heading says so, or failing that the first on the page. Repeats within
 * one section, such as "Confirm email", are left alone.
 *
 * @param {object[]} plan  Planned fields, in page order.
 * @returns {{kept: object[], dropped: object[]}}
 */
/** A box where the applicant signs by typing their name. */
const SIGNATURE = /\b(typing|type|enter) (my|your) (full |legal )?name\b|\b(e-?)?signature\b|\bsign(ed)? (below|here)\b/i;

export function dedupeAcrossSections(plan) {
  const bySection = new Map(); // key -> chosen section
  const groups = new Map();
  // A name beside a signature date is the applicant signing (Lever's
  // disability form: "Name", "Date"), not another person's block.
  const signed = new Set(plan.filter(f => f.profileKey === 'preferences.todaysDate').map(f => f.section || ''));
  for (const f of plan) {
    if (!PERSONAL_GROUPS.test(f.profileKey || '')) continue;
    if (/^identity\.(fullName|firstName|lastName)$/.test(f.profileKey) && signed.has(f.section || '')) continue;
    // "By typing my name below, I confirm..." (Cyberhaven) is the applicant signing too.
    if (/^identity\.(fullName|firstName|lastName)$/.test(f.profileKey) && SIGNATURE.test(`${f.label || ''} ${f.ariaLabel || ''}`)) continue;
    // A tick box ("I have a preferred name") is not the answer typed twice.
    if (f.type === 'checkbox') continue;
    // A phone's dial-code picker ("United States +1") is part of the phone,
    // not the address's Country asked again (Tailscale's was dropped for it).
    if (/\+\s?\d{1,4}\b/.test(String(f.value || ''))) continue;
    if (!groups.has(f.profileKey)) groups.set(f.profileKey, []);
    groups.get(f.profileKey).push(f);
  }

  for (const [key, fields] of groups) {
    const sections = [...new Set(fields.map(f => f.section || ''))];
    if (sections.length < 2) continue;
    const personal = fields.find(f => (f.scope || scopeOf(f).scope) === 'personal');
    bySection.set(key, personal ? personal.section || '' : fields[0].section || '');
  }

  const kept = [];
  const dropped = [];
  for (const f of plan) {
    const chosen = bySection.get(f.profileKey);
    if (chosen === undefined || (f.section || '') === chosen) kept.push(f);
    else dropped.push({ ...f, reason: `Looks like a different block from "${chosen || 'your details'}", so your own answer was not repeated here` });
  }
  return { kept, dropped };
}
